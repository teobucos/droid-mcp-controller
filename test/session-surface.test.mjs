// E2E for the Puck session surface: real controller process, real MCP client,
// real Factory SDK process transport, protocol-peer mock `droid exec`.
// Written before the implementation; each case names the wrong implementation it catches.
import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { boot, stop, call, audit, readState, writeCatalog, sleep, token, root } from './harness.mjs';

const PUCK = 'T-11111111-1111-4111-8111-111111111111';
const PUCK2 = 'T-22222222-2222-4222-8222-222222222222';
const PUCK3 = 'T-33333333-3333-4333-8333-333333333333';
const AMP_URL = 'https://ampcode.com/mcp?profile=external-agent';
const CATALOG = [
  { id: 'mock-model', displayName: 'Mock', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'model-b', displayName: 'B' },
];
const NEW_TOOLS = ['droid_create_session', 'droid_send_message', 'droid_get_session_status', 'droid_read_session', 'droid_wait_for_sessions', 'droid_find_sessions', 'droid_update_session', 'droid_cancel_session', 'droid_get_usage', 'droid_list_workspaces', 'droid_models'];
const REMOVED_TOOLS = ['droid_start', 'droid_continue', 'droid_status', 'droid_result', 'droid_list', 'droid_cancel'];

async function fixture(extra = {}, env = {}, existing) {
  return decorate(await boot(extra, env, existing));
}
function decorate(h) {
  writeCatalog(h, CATALOG);
  h.ws = (name = '') => { const path = join(h.dir, 'workspace', name); mkdirSync(path, { recursive: true }); return path; };
  h.create = (key, prompt, more = {}) => call(h, 'droid_create_session', { requestKey: key, workspace: h.ws(), prompt, model: 'mock-model', replyTo: null, ...more });
  h.send = (session, key, message, more = {}) => call(h, 'droid_send_message', { session, requestKey: key, message, model: 'mock-model', ...more });
  h.status = (session) => call(h, 'droid_get_session_status', { session });
  h.settle = async (sessions, seconds = 15) => {
    const end = Date.now() + seconds * 1000;
    for (;;) {
      const result = await call(h, 'droid_wait_for_sessions', { sessions, timeoutSeconds: 3 });
      if (result.settled) return result;
      if (Date.now() > end) throw new Error('Sessions did not settle');
    }
  };
  h.turns = (prefix) => audit(h).filter((x) => x.method === 'droid.add_user_message' && x.params.text.startsWith(prefix));
  h.waitFor = async (predicate, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await predicate(); if (v) return v; await sleep(25); }
    throw new Error(`Timed out waiting for ${what}`);
  };
  h.capacity = async () => (await call(h, 'droid_list_workspaces', {})).capacity;
  return h;
}
const done = async (h) => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); };
const rejectsWith = (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });

test('surface: exactly eleven strict tools, removed names are not callable, polished errors', async (t) => {
  const h = await fixture({ maxAutonomy: 'medium' });
  t.after(() => done(h));
  const tools = (await h.client.listTools()).tools;
  await t.test('exact tool inventory, strict object schemas', () => {
    assert.deepEqual(tools.map((x) => x.name).sort(), NEW_TOOLS.toSorted());
    for (const name of NEW_TOOLS) {
      const tool = tools.find((x) => x.name === name);
      assert.equal(tool.inputSchema.type, 'object', name);
      assert.equal(tool.inputSchema.additionalProperties, false, `${name} must reject unknown arguments`);
      assert.ok(tool.description.length > 150 && /Example/.test(tool.description), `${name} needs a real description with an example`);
    }
    for (const name of ['droid_get_session_status', 'droid_read_session', 'droid_wait_for_sessions', 'droid_find_sessions', 'droid_get_usage', 'droid_list_workspaces', 'droid_models']) {
      assert.equal(tools.find((x) => x.name === name).annotations.readOnlyHint, true, name);
    }
    const create = tools.find((x) => x.name === 'droid_create_session');
    assert.ok(create.inputSchema.required.includes('replyTo') && create.inputSchema.required.includes('model'));
    assert.match(tools.find((x) => x.name === 'droid_send_message').description, /interrupt:\s*true/);
    assert.match(tools.find((x) => x.name === 'droid_send_message').description, /not Amp's|does not interrupt by default|default.*interrupt:\s*false/i);
  });

  await t.test('removed tools fail at dispatch even with formerly valid arguments', async () => {
    const created = await h.create('removal-fixture', 'normal');
    await h.settle([created.metadata.session]);
    const args = [
      { requestKey: 'removed-create', workspace: h.ws(), prompt: 'must not run' },
      { runId: created.latestRun.runId, requestKey: 'removed-send', prompt: 'must not run' },
      { runId: created.latestRun.runId }, { runId: created.latestRun.runId }, {}, { runId: created.latestRun.runId },
    ];
    const before = readState(h);
    for (const [i, name] of REMOVED_TOOLS.entries()) {
      const result = await h.client.callTool({ name, arguments: args[i] });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /not found/i, name);
    }
    assert.deepEqual(readState(h), before, 'removed calls cannot change durable state');
    await call(h, 'droid_update_session', { session: created.metadata.session, archived: true });
  });

  await t.test('invalid input fails with an actionable structured error and no leaked internals', async () => {
    const base = { requestKey: 'v', workspace: h.ws(), prompt: 'x', model: 'mock-model', replyTo: null };
    const cases = [
      [{ ...base, replyTo: undefined }, 'invalid_argument', /replyTo/],
      [{ ...base, bogus: 1 }, 'invalid_argument', /bogus|unrecognized/i],
      [{ ...base, workspace: 'relative/path' }, 'invalid_argument', /workspace/],
      [{ ...base, replyTo: 'not-a-thread' }, 'invalid_argument', /replyTo/],
      [{ ...base, labels: ['Bad Label'] }, 'invalid_argument', /labels/],
      [{ ...base, workspace: join(h.dir, 'workspace-sibling') }, 'workspace_not_approved', /approved/],
      [{ ...base, model: 'no-such-model' }, 'model_unavailable', /droid_models/],
      [{ ...base, reasoningEffort: 'max' }, 'reasoning_unsupported', /low.*high/],
      [{ ...base, autonomy: 'high' }, 'autonomy_exceeds_ceiling', /medium/],
      [{ ...base, replyTo: PUCK }, 'reply_back_unavailable', /ampMcp|Amp MCP/],
    ];
    for (const [args, code, message] of cases) {
      const raw = await h.client.callTool({ name: 'droid_create_session', arguments: args });
      assert.equal(raw.isError, true, code);
      const body = JSON.parse(raw.content[0].text);
      assert.equal(body.error.code, code);
      assert.match(body.error.message + body.error.action, message);
      assert.equal(typeof body.error.retryable, 'boolean');
      assert.ok(body.error.action.length > 10, 'error must say what to do next');
      assert.ok(!raw.content[0].text.includes(h.dir.replace(/\/workspace.*/, '')) || code === 'workspace_not_approved' || code === 'invalid_argument', 'no state or private paths in errors');
    }
    assert.equal((await call(h, 'droid_find_sessions', {})).sessions.length, 0, 'rejected requests create nothing');
    await rejectsWith(call(h, 'droid_get_session_status', { session: randomUUID() }), 'unknown_session');
    await rejectsWith(call(h, 'droid_get_session_status', { session: 'not-a-uuid' }), 'invalid_argument');
  });

  await t.test('list_workspaces reports roots, default capacity 4 and policy', async () => {
    const result = await call(h, 'droid_list_workspaces', {});
    assert.deepEqual(result.workspaces, h.config.approvedDirectories);
    assert.deepEqual(result.capacity, { maximum: 4, active: 0, queued: 0, available: 4 });
    assert.equal(result.policy.maxAutonomy, 'medium');
    assert.equal(result.policy.defaultAutonomy, 'off');
    assert.equal(result.policy.replyBack, false);
  });
});

test('session lifecycle: create, status, read, send, steer, cancel, update, find, usage', async (t) => {
  const h = await fixture();
  t.after(() => done(h));
  let a;

  await t.test('create returns at once with a controller handle; replay is idempotent; changed intent conflicts', async () => {
    const first = await h.create('life-a', 'sleep:400 first', { title: 'Alpha', labels: ['review', 'alpha'] });
    a = first.metadata.session;
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.equal(first.agentState.state, 'working');
    assert.notEqual(first.latestRun.runId, a);
    assert.equal(first.metadata.title, 'Alpha');
    assert.deepEqual(first.metadata.labels, ['alpha', 'review']);
    assert.equal(first.metadata.replyTo, null);
    assert.equal(first.notification.state, 'disabled');
    assert.equal((await h.create('life-a', 'sleep:400 first', { title: 'Alpha', labels: ['review', 'alpha'] })).metadata.session, a);
    await rejectsWith(h.create('life-a', 'sleep:400 changed', { title: 'Alpha', labels: ['review', 'alpha'] }), 'request_key_conflict');
    const settled = await h.settle([a]);
    assert.equal(settled.settled, true);
    const status = settled.sessions[0];
    assert.equal(status.agentState.state, 'idle');
    assert.equal(status.latestRun.state, 'succeeded');
    assert.equal(status.latestRun.terminal, true);
    assert.equal(status.latestRun.needsAttention, false);
    assert.equal(status.preview.text, 'answer:sleep:400 first');
  });

  await t.test('no Factory/Droid session UUID, fingerprint or prompt leaks through any new tool', async () => {
    const droidId = readState(h).sessions[a].droidSessionId;
    assert.match(droidId, /^[0-9a-f-]{36}$/);
    // The mock echoes ordinary prompts as assistant output; a no-echo prompt isolates real retention.
    const quiet = await h.create('leak-quiet', 'no-echo:LEAK_MARKER_9', { title: 'Quiet' });
    await h.settle([quiet.metadata.session]);
    const outputs = [await h.status(a), await call(h, 'droid_read_session', { session: a }), await call(h, 'droid_find_sessions', {}), await call(h, 'droid_wait_for_sessions', { sessions: [a, quiet.metadata.session], timeoutSeconds: 0 }), await call(h, 'droid_get_usage', { session: a }), await call(h, 'droid_read_session', { session: quiet.metadata.session })];
    const text = JSON.stringify(outputs);
    for (const secret of [droidId, 'fingerprint', 'droidSessionId', 'stderrTail', 'textTail', 'LEAK_MARKER_9']) assert.ok(!text.includes(secret), secret);
  });

  await t.test('read paginates, never fabricates the user prompt, and rejects bad cursors', async () => {
    const all = await call(h, 'droid_read_session', { session: a, limit: 100 });
    assert.equal(all.historyAvailable, true);
    assert.ok(all.messages.some((m) => m.role === 'assistant' && m.text === 'answer:sleep:400 first'));
    assert.ok(all.messages.every((m) => m.role !== 'user'), 'prompts are never retained');
    assert.equal(all.nextCursor, null);
    const seen = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const page = await call(h, 'droid_read_session', { session: a, limit: 1, ...(cursor ? { cursor } : {}) });
      assert.ok(page.messages.length <= 1);
      seen.push(...page.messages);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, all.messages);
    await rejectsWith(call(h, 'droid_read_session', { session: a, cursor: 'garbage' }), 'invalid_cursor');
  });

  await t.test('send to an idle session resumes the same Droid session (disposition started)', async () => {
    const sent = await h.send(a, 'life-a-2', 'second');
    assert.equal(sent.disposition, 'started');
    assert.equal(sent.status.metadata.session, a);
    assert.equal(sent.runId, sent.status.latestRun.runId);
    assert.equal((await h.send(a, 'life-a-2', 'second')).runId, sent.runId, 'replay returns the accepted run');
    await rejectsWith(h.send(a, 'life-a-2', 'different'), 'request_key_conflict');
    await h.settle([a]);
    assert.equal((await h.status(a)).preview.text, 'answer:second');
    const droidId = readState(h).sessions[a].droidSessionId;
    assert.equal(audit(h).filter((x) => x.method === 'droid.load_session').at(-1).params.sessionId, droidId);
    // model is required for every new turn.
    await assert.rejects(call(h, 'droid_send_message', { session: a, requestKey: 'no-model', message: 'x' }), /model/);
    await rejectsWith(h.send(a, 'bad-model', 'x', { model: 'nope' }), 'model_unavailable');
  });

  await t.test('default send queues behind the active turn without interrupting it', async () => {
    const first = await h.create('queue-a', 'sleep:600 q1');
    const sid = first.metadata.session;
    await h.waitFor(() => h.turns('sleep:600 q1').length, 'first turn');
    const queued = await h.send(sid, 'queue-a-2', 'q2');
    assert.equal(queued.disposition, 'queued');
    assert.equal(queued.status.latestRun.state, 'queued');
    assert.equal(queued.status.agentState.state, 'working');
    await h.settle([sid]);
    assert.equal((await h.status(sid)).preview.text, 'answer:q2');
    assert.ok(!audit(h).some((x) => x.method === 'droid.interrupt_session' && h.turns('sleep:600 q1').some((y) => y.mockPid === x.mockPid)), 'queue must not interrupt');
    const [t1, t2] = [h.turns('sleep:600 q1')[0], h.turns('q2')[0]];
    assert.ok(t2.ts - t1.ts >= 500, 'second turn starts only after the first completed');
    assert.notEqual(t1.mockPid, t2.mockPid, 'serial turns, never two on one Droid process');
  });

  await t.test('interrupt:true is a serial interrupt-and-resume: interrupt, cleanup, then run', async () => {
    const first = await h.create('steer-a', 'slow');
    const sid = first.metadata.session;
    await h.waitFor(() => h.turns('slow').length, 'slow turn');
    const steered = await h.send(sid, 'steer-a-2', 'new-direction', { interrupt: true });
    assert.equal(steered.disposition, 'interrupting');
    await h.settle([sid]);
    const status = await h.status(sid);
    assert.equal(status.latestRun.state, 'succeeded');
    assert.equal(status.preview.text, 'answer:new-direction');
    const wire = audit(h);
    const slowPid = h.turns('slow')[0].mockPid;
    const interrupt = wire.find((x) => x.method === 'droid.interrupt_session' && x.mockPid === slowPid);
    assert.ok(interrupt, 'first turn was interrupted through the protocol');
    assert.ok(h.turns('new-direction')[0].ts >= interrupt.ts, 'steering message submitted after the interrupt');
    assert.notEqual(h.turns('new-direction')[0].mockPid, slowPid);
    const runs = Object.values(readState(h).runs).filter((r) => r.sessionId === sid);
    assert.deepEqual(runs.map((r) => r.state), ['interrupted', 'succeeded']);
  });

  await t.test('cancel stops the active turn and drops queued follow-ups; repeating is safe', async () => {
    const first = await h.create('cancel-a', 'slow');
    const sid = first.metadata.session;
    await h.waitFor(() => h.turns('slow').length >= 2, 'turn started');
    await h.send(sid, 'cancel-a-2', 'follow-1');
    await h.send(sid, 'cancel-a-3', 'follow-2');
    const cancelled = await call(h, 'droid_cancel_session', { session: sid });
    assert.ok(['working', 'idle'].includes(cancelled.agentState.state));
    await h.settle([sid]);
    assert.equal(h.turns('follow-1').length + h.turns('follow-2').length, 0, 'queued intent never reached Droid');
    const runs = Object.values(readState(h).runs).filter((r) => r.sessionId === sid).map((r) => r.state);
    assert.deepEqual(runs, ['interrupted', 'cancelled', 'cancelled']);
    assert.equal((await call(h, 'droid_cancel_session', { session: sid })).agentState.state, 'idle');
    assert.equal((await call(h, 'droid_cancel_session', { session: a })).latestRun.state, 'succeeded', 'cancel never rewrites a finished outcome');
  });

  await t.test('update: title, labels, archive; conflicts and busy archive are rejected; replyTo untouched', async () => {
    const updated = await call(h, 'droid_update_session', { session: a, title: 'Renamed', labels: { add: ['new'], remove: ['alpha'] } });
    assert.equal(updated.metadata.title, 'Renamed');
    assert.deepEqual(updated.metadata.labels, ['new', 'review']);
    assert.equal(updated.metadata.replyTo, null);
    await rejectsWith(call(h, 'droid_update_session', { session: a }), 'invalid_argument');
    await rejectsWith(call(h, 'droid_update_session', { session: a, labels: { add: ['x'], remove: ['x'] } }), 'invalid_argument');
    const busy = await h.create('busy-a', 'sleep:500 busy');
    await rejectsWith(call(h, 'droid_update_session', { session: busy.metadata.session, archived: true }), 'session_busy');
    await h.settle([busy.metadata.session]);
    const archived = await call(h, 'droid_update_session', { session: a, archived: true });
    assert.equal(archived.metadata.archived, true);
    assert.ok(!(await call(h, 'droid_find_sessions', {})).sessions.some((s) => s.metadata.session === a));
    assert.deepEqual((await call(h, 'droid_find_sessions', { archived: true })).sessions.map((s) => s.metadata.session), [a]);
    assert.equal((await call(h, 'droid_update_session', { session: a, archived: false })).metadata.archived, false);
    await call(h, 'droid_update_session', { session: a, archived: true });
    const restored = await h.send(a, 'restore-a', 'wake');
    assert.equal(restored.status.metadata.archived, false, 'a normal message restores an archived session');
    await h.settle([a]);
  });

  await t.test('find: text, state, label, workspace, dates, archived; cursor stable under new activity', async () => {
    const sub = h.ws('proj/sub');
    const x = await h.create('find-x', 'sleep:50 zebra', { workspace: sub, title: 'Zebra hunt', labels: ['animals'] });
    await h.settle([x.metadata.session]);
    const ids = async (args) => (await call(h, 'droid_find_sessions', args)).sessions.map((s) => s.metadata.session);
    assert.deepEqual(await ids({ query: 'zebra' }), [x.metadata.session], 'matches retained output and title, case-insensitively');
    assert.deepEqual(await ids({ query: 'ZEBRA HUNT' }), [x.metadata.session]);
    assert.deepEqual(await ids({ labels: ['animals'] }), [x.metadata.session]);
    assert.deepEqual(await ids({ labels: ['animals', 'review'] }), [], 'labels are ANDed');
    assert.deepEqual(await ids({ workspace: h.ws('proj') }), [x.metadata.session], 'workspace filter includes descendants');
    assert.ok((await ids({ state: 'idle' })).includes(x.metadata.session));
    assert.deepEqual(await ids({ state: 'working' }), []);
    assert.deepEqual(await ids({ after: new Date(Date.now() + 60000).toISOString() }), []);
    assert.deepEqual(await ids({ before: new Date(Date.now() - 3600000).toISOString() }), []);
    await rejectsWith(call(h, 'droid_find_sessions', { after: '2026-10-02T00:00:00Z', before: '2026-10-01T00:00:00Z' }), 'invalid_argument');
    const page1 = await call(h, 'droid_find_sessions', { limit: 2 });
    assert.equal(page1.sessions.length, 2);
    assert.ok(page1.nextCursor);
    const fresh = await h.create('find-fresh', 'sleep:10 fresh');
    const page2 = await call(h, 'droid_find_sessions', { limit: 100, cursor: page1.nextCursor });
    const all = [...page1.sessions, ...page2.sessions].map((s) => s.metadata.session);
    assert.equal(new Set(all).size, all.length, 'no duplicates when a newer session appears between pages');
    assert.ok(!all.includes(fresh.metadata.session), 'a session created after page 1 never shifts later pages');
    await h.settle([fresh.metadata.session]);
    await rejectsWith(call(h, 'droid_find_sessions', { cursor: 'bad' }), 'invalid_cursor');
  });

  await t.test('usage sums each accepted turn once; nulls are never zero; ranges validated', async () => {
    const fresh = await h.create('usage-a', 'sleep:10 u1');
    const sid = fresh.metadata.session;
    await h.settle([sid]);
    await h.send(sid, 'usage-a-2', 'u2');
    await h.send(sid, 'usage-a-2', 'u2');
    await h.settle([sid]);
    const usage = await call(h, 'droid_get_usage', { session: sid });
    assert.equal(usage.session, sid);
    assert.equal(usage.turns, 2);
    assert.equal(usage.turnsWithUsage, 2);
    assert.deepEqual(usage.tokens, { inputTokens: 14, outputTokens: 6, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 });
    assert.equal(usage.factoryCredits, null);
    const everything = await call(h, 'droid_get_usage', {});
    assert.equal(everything.session, null);
    assert.ok(everything.turns > usage.turns);
    assert.equal((await call(h, 'droid_get_usage', { before: new Date(Date.now() - 3600000).toISOString() })).turns, 0);
    await rejectsWith(call(h, 'droid_get_usage', { after: '2026-10-02T00:00:00Z', before: '2026-10-01T00:00:00Z' }), 'invalid_argument');
    await rejectsWith(call(h, 'droid_get_usage', { session: randomUUID() }), 'unknown_session');
  });
});

test('concurrency: parallel sessions, capacity queue, reader/writer workspace locks', async (t) => {
  const h = await fixture();
  t.after(() => done(h));

  await t.test('four sessions in distinct workspaces really run at once and finish in parallel', async () => {
    const started = Date.now();
    const sessions = [];
    for (let i = 1; i <= 4; i++) sessions.push((await h.create(`par-${i}`, `sleep:1500 par${i}`, { workspace: h.ws(`p${i}`), autonomy: 'high' })).metadata.session);
    await h.waitFor(async () => (await h.capacity()).active === 4, 'four active runs');
    const capacity = await h.capacity();
    assert.deepEqual(capacity, { maximum: 4, active: 4, queued: 0, available: 0 });
    const result = await h.settle(sessions);
    assert.ok(result.sessions.every((s) => s.latestRun.state === 'succeeded'));
    assert.ok(Date.now() - started < 4300, 'sequential execution would take about 6s');
    assert.deepEqual(result.sessions.map((s) => s.preview.text), [1, 2, 3, 4].map((i) => `answer:sleep:1500 par${i}`), 'each session keeps its own output, in input order');
    assert.equal(new Set(h.turns('sleep:1500').map((x) => x.mockPid)).size, 4);
  });

  await t.test('capacity exhaustion queues FIFO with visible capacity, then drains', async () => {
    const small = await fixture({ maxConcurrentRuns: 2 });
    try {
      const ids = [];
      for (let i = 1; i <= 3; i++) ids.push(await small.create(`cap-${i}`, `sleep:700 c${i}`, { workspace: small.ws(`c${i}`) }));
      assert.deepEqual(ids.map((s) => s.latestRun.state === 'queued'), [false, false, true]);
      assert.equal(ids[2].agentState.state, 'working');
      assert.deepEqual(await small.capacity(), { maximum: 2, active: 2, queued: 1, available: 0 });
      assert.equal(small.turns('sleep:700 c3').length, 0, 'queued work is not submitted early');
      await small.settle(ids.map((s) => s.metadata.session));
      assert.ok(small.turns('sleep:700 c3')[0].ts - small.turns('sleep:700 c1')[0].ts >= 600);
      assert.deepEqual(await small.capacity(), { maximum: 2, active: 0, queued: 0, available: 2 });
    } finally { await done(small); }
  });

  await t.test('writers exclude overlapping runs in both directions while disjoint workspaces proceed', async () => {
    const api = h.ws('api/v1'); h.ws('web');
    symlinkSync(h.ws('api'), join(h.dir, 'workspace/api-link'));
    const writer = await h.create('lock-w', 'sleep:900 writer', { workspace: h.ws('api'), autonomy: 'medium' });
    const nestedReader = await h.create('lock-r', 'sleep:100 nested-reader', { workspace: api });
    const viaSymlink = await h.create('lock-s', 'sleep:100 via-symlink', { workspace: join(h.dir, 'workspace/api-link'), autonomy: 'low' });
    const disjoint = await h.create('lock-d', 'sleep:100 disjoint', { workspace: h.ws('web'), autonomy: 'high' });
    assert.equal(writer.latestRun.state === 'queued', false);
    assert.equal(nestedReader.latestRun.state, 'queued', 'reader nested under a writer waits');
    assert.equal(viaSymlink.latestRun.state, 'queued', 'symlink spelling resolves to the same canonical lock');
    assert.equal(disjoint.latestRun.state === 'queued', false, 'distinct workspace is not blocked');
    await sleep(400);
    assert.equal(h.turns('sleep:100 nested-reader').length, 0);
    assert.equal(h.turns('sleep:100 disjoint').length, 1);
    await h.settle([writer, nestedReader, viaSymlink, disjoint].map((s) => s.metadata.session));
    const writerStart = h.turns('sleep:900 writer')[0].ts;
    for (const p of ['sleep:100 nested-reader', 'sleep:100 via-symlink']) assert.ok(h.turns(p)[0].ts - writerStart >= 800, `${p} ran only after the writer finished`);
    // Reverse direction: a reader holds the tree, a parent writer must wait.
    const reader = await h.create('lock-rr', 'sleep:700 holding-reader', { workspace: api });
    const parentWriter = await h.create('lock-pw', 'sleep:50 parent-writer', { workspace: h.ws(), autonomy: 'high' });
    assert.equal(parentWriter.latestRun.state, 'queued');
    await h.settle([reader, parentWriter].map((s) => s.metadata.session));
    assert.ok(h.turns('sleep:50 parent-writer')[0].ts - h.turns('sleep:700 holding-reader')[0].ts >= 600);
  });

  await t.test('readers share a workspace; a queued writer is not starved by later readers', async () => {
    const shared = h.ws('shared');
    const r1 = await h.create('share-1', 'sleep:900 r1', { workspace: shared });
    const r2 = await h.create('share-2', 'sleep:900 r2', { workspace: shared });
    assert.equal(r1.latestRun.state === 'queued' || r2.latestRun.state === 'queued', false, 'two readers may overlap');
    await h.waitFor(async () => (await h.capacity()).active >= 2, 'readers concurrently active');
    const writer = await h.create('share-w', 'sleep:100 w', { workspace: shared, autonomy: 'high' });
    const late = await h.create('share-3', 'sleep:100 late-reader', { workspace: shared });
    assert.equal(writer.latestRun.state, 'queued');
    assert.equal(late.latestRun.state, 'queued', 'a reader arriving after a queued writer queues behind it');
    await h.settle([r1, r2, writer, late].map((s) => s.metadata.session));
    assert.ok(h.turns('sleep:100 w')[0].ts < h.turns('sleep:100 late-reader')[0].ts, 'FIFO: the writer runs before the later reader');
    assert.ok(h.turns('sleep:100 late-reader')[0].ts - h.turns('sleep:100 w')[0].ts >= 90, 'and the reader waits for the writer');
  });

  await t.test('mixed autonomy sessions keep their own settings and permission policy', async () => {
    const levels = ['off', 'low', 'medium', 'high'];
    const sessions = [];
    for (const level of levels) sessions.push((await h.create(`mix-${level}`, 'permission-once', { workspace: h.ws(`mix-${level}`), autonomy: level })).metadata.session);
    const result = await h.settle(sessions);
    const wire = audit(h);
    const byPid = new Map(wire.filter((x) => x.method === 'droid.initialize_session' && x.params.cwd.includes('mix-')).map((x) => [x.mockPid, x]));
    assert.equal(byPid.size, 4);
    for (const init of byPid.values()) {
      const level = levels.find((l) => init.params.cwd.endsWith(`mix-${l}`));
      assert.equal(init.params.autonomyLevel, level);
      assert.equal(init.params.interactionMode, level === 'off' ? 'spec' : 'auto');
      const answer = wire.find((x) => x.mockPid === init.mockPid && x.id === 'permission-1' && x.type === 'response');
      assert.equal(answer.result.selectedOption, level === 'high' ? 'proceed_once' : 'cancel', `permissions for ${level}`);
    }
    assert.deepEqual(result.sessions.map((s) => s.latestRun.state), ['interrupted', 'interrupted', 'interrupted', 'succeeded']);
    assert.deepEqual(result.sessions.map((s) => s.latestRun.autonomy), levels);
    assert.ok(result.sessions.slice(0, 3).every((s) => s.latestRun.needsAttention && s.latestRun.permissionsDeclined === 1), 'declined permission needs attention');
    assert.equal(result.sessions[3].latestRun.permissionsDeclined, 0);
  });

  await t.test('cancel and steer touch only their own session', async () => {
    const mk = async (name) => (await h.create(`iso-${name}`, `sleep:2000 iso-${name}`, { workspace: h.ws(`iso-${name}`), autonomy: 'high' })).metadata.session;
    const [A, B, C] = [await mk('a'), await mk('b'), await mk('c')];
    await h.waitFor(() => ['a', 'b', 'c'].every((n) => h.turns(`sleep:2000 iso-${n}`).length), 'three active turns');
    await call(h, 'droid_cancel_session', { session: B });
    await h.send(C, 'iso-steer', 'steered', { interrupt: true });
    const result = await h.settle([A, B, C]);
    assert.deepEqual(result.sessions.map((s) => s.latestRun.state), ['succeeded', 'interrupted', 'succeeded']);
    assert.equal(result.sessions[0].preview.text, 'answer:sleep:2000 iso-a');
    assert.equal(result.sessions[2].preview.text, 'answer:steered');
    const wire = audit(h);
    const interrupted = new Set(wire.filter((x) => x.method === 'droid.interrupt_session').map((x) => x.mockPid));
    const pid = (n) => h.turns(`sleep:2000 iso-${n}`)[0].mockPid;
    assert.ok(!interrupted.has(pid('a')), 'the untouched session was never interrupted');
    assert.ok(interrupted.has(pid('b')) && interrupted.has(pid('c')));
  });

  await t.test('wait: bounded to ten distinct known sessions, timeout is not failure, attention settles', async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push((await h.create(`w10-${i}`, 'sleep:300 w10', { workspace: h.ws('w10') })).metadata.session);
    const ten = await call(h, 'droid_wait_for_sessions', { sessions: ids, timeoutSeconds: 0 });
    assert.equal(ten.settled, false);
    assert.equal(ten.timedOut, true);
    assert.equal(ten.sessions.length, 10);
    assert.deepEqual(ten.sessions.map((s) => s.metadata.session), ids, 'input order');
    const joined = await h.settle(ids, 20);
    assert.ok(joined.sessions.every((s) => s.latestRun.state === 'succeeded'), 'ten sessions at capacity 4 all complete; the timeout never cancelled work');
    const extra = await h.create('w10-extra', 'sleep:10 e');
    await rejectsWith(call(h, 'droid_wait_for_sessions', { sessions: [...ids, extra.metadata.session], timeoutSeconds: 0 }), 'invalid_argument');
    await rejectsWith(call(h, 'droid_wait_for_sessions', { sessions: [ids[0], ids[0]], timeoutSeconds: 0 }), 'invalid_argument');
    await rejectsWith(call(h, 'droid_wait_for_sessions', { sessions: [ids[0], randomUUID()], timeoutSeconds: 0 }), 'unknown_session');
    const asked = await h.create('w-ask', 'ask', { autonomy: 'high', workspace: h.ws('ask') });
    const began = Date.now();
    const result = await call(h, 'droid_wait_for_sessions', { sessions: [asked.metadata.session], timeoutSeconds: 30 });
    assert.equal(result.settled, true);
    assert.ok(Date.now() - began < 5000, 'returns as soon as the session settles');
    assert.equal(result.sessions[0].latestRun.needsAttention, true);
    assert.match(result.sessions[0].latestRun.questions[0].question, /Deploy\?/);
    assert.deepEqual(result.sessions[0].latestRun.questions[0].options, ['yes', 'no']);
  });
});

test('reply-back: per-session recipient, generic endpoint, misroute detection, preflight', async (t) => {
  const h = await fixture({ ampMcp: { url: AMP_URL } });
  t.after(() => done(h));

  await t.test('concurrent sessions each carry only their own recipient on one thread-free endpoint', async () => {
    const recipients = [PUCK, PUCK2, PUCK3];
    const created = [];
    for (const [i, replyTo] of recipients.entries()) created.push(await h.create(`rb-${i}`, 'puck-report', { replyTo, workspace: h.ws(`rb${i}`) }));
    assert.deepEqual(created.map((s) => s.metadata.replyTo), recipients);
    const result = await h.settle(created.map((s) => s.metadata.session));
    assert.deepEqual(result.sessions.map((s) => s.notification.state), ['accepted', 'accepted', 'accepted']);
    const wire = audit(h);
    const inits = wire.filter((x) => x.method === 'droid.initialize_session' && x.params.mcpServers);
    assert.equal(inits.length, 3);
    for (const init of inits) {
      assert.deepEqual(init.params.mcpServers, [{ name: 'amp-puck', type: 'http', url: AMP_URL, headers: [], oauth: { resource: 'https://ampcode.com/mcp' } }]);
      assert.ok(!JSON.stringify(init.params).includes('threadID'), 'endpoint is never bound to a thread');
      assert.deepEqual(init.params.disabledToolIds, ['amp-puck___manage_amp', 'amp-puck___find_thread', 'amp-puck___read_thread'], 'admin and thread-reading tools stay denied');
    }
    for (const [i, replyTo] of recipients.entries()) {
      const turn = h.turns('puck-report').find((x) => x.params.text.includes(replyTo));
      assert.ok(turn, `turn for ${replyTo}`);
      for (const other of recipients.filter((r) => r !== replyTo)) assert.ok(!turn.params.text.includes(other), 'no recipient bleed between sessions');
      assert.ok(turn.params.text.includes(created[i].metadata.session) && turn.params.text.includes(created[i].latestRun.runId));
      assert.match(turn.params.text, /amp-puck___puck/);
      assert.match(turn.params.text, /pre-approved/);
    }
  });

  await t.test('notification flags a missing, rejected or misrouted agent report', async () => {
    const quiet = await h.create('rb-quiet', 'normal', { replyTo: PUCK });
    const wrong = await h.create('rb-wrong', 'puck-wrong', { replyTo: PUCK });
    const failed = await h.create('rb-error', 'puck-error', { replyTo: PUCK });
    const result = await h.settle([quiet, wrong, failed].map((s) => s.metadata.session));
    const [q, w, f] = result.sessions;
    assert.equal(q.notification.state, 'not_sent');
    assert.equal(q.latestRun.needsAttention, false);
    assert.equal(w.notification.state, 'failed');
    assert.equal(w.notification.error.code, 'reply_misrouted');
    assert.equal(w.latestRun.needsAttention, true);
    assert.equal(f.notification.state, 'failed');
    assert.equal(f.notification.error.code, 'reply_failed');
    assert.equal(f.latestRun.state, 'succeeded', 'a notification failure never turns a done run into a failed run');
  });

  await t.test('send can explicitly retarget or detach; omission keeps the session recipient', async () => {
    const s = await h.create('rb-retarget', 'normal', { replyTo: PUCK });
    await h.settle([s.metadata.session]);
    assert.equal((await h.send(s.metadata.session, 'rt-1', 'puck-report')).status.metadata.replyTo, PUCK);
    await h.settle([s.metadata.session]);
    const moved = await h.send(s.metadata.session, 'rt-2', 'puck-report', { replyTo: PUCK2 });
    assert.equal(moved.status.metadata.replyTo, PUCK2);
    await h.settle([s.metadata.session]);
    assert.equal((await h.status(s.metadata.session)).notification.state, 'accepted');
    const detached = await h.send(s.metadata.session, 'rt-3', 'normal', { replyTo: null });
    assert.equal(detached.status.metadata.replyTo, null);
    await h.settle([s.metadata.session]);
    assert.equal((await h.status(s.metadata.session)).notification.state, 'disabled');
  });

  await t.test('a read-only routed session may approve only its own single-use report; anything else stays denied', async () => {
    const ok = await h.create('rb-perm-ok', 'puck-permission', { replyTo: PUCK, autonomy: 'off', workspace: h.ws('perm-ok') });
    const wrong = await h.create('rb-perm-wrong', 'puck-permission-wrong', { replyTo: PUCK, autonomy: 'off', workspace: h.ws('perm-wrong') });
    const result = await h.settle([ok, wrong].map((s) => s.metadata.session));
    const answerFor = (session) => {
      const wire = audit(h);
      const pid = wire.find((x) => x.method === 'droid.initialize_session' && x.params.cwd.endsWith(session)).mockPid;
      return wire.find((x) => x.mockPid === pid && x.id === 'permission-puck' && x.type === 'response').result.selectedOption;
    };
    assert.equal(answerFor('perm-ok'), 'proceed_once');
    assert.equal(answerFor('perm-wrong'), 'cancel', 'a report to any other conversation is never approved');
    assert.equal(result.sessions[0].latestRun.state, 'succeeded');
    assert.equal(result.sessions[0].notification.state, 'accepted');
    assert.equal(result.sessions[1].latestRun.state, 'interrupted');
    assert.equal(result.sessions[1].latestRun.needsAttention, true);
  });

  await t.test('detached sessions never touch the Amp MCP endpoint', async () => {
    const before = audit(h).filter((x) => x.method === 'droid.initialize_session').length;
    const s = await h.create('rb-detached', 'normal', { replyTo: null, workspace: h.ws('detached') });
    await h.settle([s.metadata.session]);
    const init = audit(h).filter((x) => x.method === 'droid.initialize_session').slice(before).find((x) => x.params.cwd.endsWith('detached'));
    assert.equal(init.params.mcpServers, undefined);
    assert.equal(init.params.disabledToolIds, undefined);
  });
});

test('preflight: actionable Amp MCP failures replace the masked unknown-tool error', async (t) => {
  const cases = [
    ['archived', 'amp_mcp_unreachable', /archived/i],
    ['unlisted', 'amp_mcp_not_started', /OAuth|sign-in|endpoint URL/i],
    ['undeniable', 'amp_mcp_admin_tool_exposed', /could not be denied/],
    ['leaky', 'amp_mcp_unreachable', /failed/],
    ['unauthenticated', 'amp_mcp_auth_required', /authoriz|sign/i],
    ['puck-missing', 'amp_mcp_tool_missing', /puck/],
    ['admin-allowed', 'amp_mcp_admin_tool_exposed', /manage_amp|admin/i],
  ];
  for (const [mode, code, message] of cases) {
    await t.test(mode, async () => {
      const h = await fixture({ ampMcp: { url: AMP_URL }, runTimeoutMs: 30000 }, { MOCK_PUCK_FAILURE: mode });
      try {
        const created = await h.create(`pre-${mode}`, 'no-echo:must not run', { replyTo: PUCK });
        const status = (await h.settle([created.metadata.session])).sessions[0];
        assert.equal(status.latestRun.state, 'failed');
        assert.equal(status.latestRun.error.code, code);
        assert.match(status.latestRun.error.message + status.latestRun.error.action, message);
        assert.ok(!/Unknown tool identifier/.test(JSON.stringify(status)), 'the disabled-tool masking error must not surface');
        assert.ok(status.latestRun.error.action.length > 10);
        assert.equal(audit(h).filter((x) => x.method === 'droid.add_user_message').length, 0, 'no task prompt is submitted');
        assert.ok(!JSON.stringify(status).includes('pendingAuth'));
        assert.ok(!/11111111-2222|\/home\/box|SECRETSTATE|example\.invalid/.test(JSON.stringify(status)), 'no ids, paths or OAuth state from server text');
        const detached = await h.create(`pre-${mode}-detached`, 'normal', { replyTo: null });
        assert.equal((await h.settle([detached.metadata.session])).sessions[0].latestRun.state, 'succeeded', 'detached work does not depend on the Amp endpoint');
      } finally { await done(h); }
    });
  }
});

test('configuration: no default recipient, no thread-bound endpoint, capacity bounds', async () => {
  const invalid = [
    [{ puck: { conversationId: PUCK } }, /puck|ampMcp/i],
    [{ ampMcp: { url: `${AMP_URL}&threadID=${PUCK}` } }, /threadID|thread/i],
    [{ ampMcp: { url: AMP_URL, conversationId: PUCK } }, /conversationId|unrecognized/i],
    [{ maxConcurrentRuns: 17 }, /maxConcurrentRuns/],
    [{ maxConcurrentRuns: 0 }, /maxConcurrentRuns/],
  ];
  for (const [extra, message] of invalid) await assert.rejects(boot(extra), message);
  const sixteen = await fixture({ maxConcurrentRuns: 16, ampMcp: {} });
  try {
    const result = await call(sixteen, 'droid_list_workspaces', {});
    assert.equal(result.capacity.maximum, 16);
    assert.equal(result.policy.replyBack, true);
  } finally { await done(sixteen); }
});

test('durability: restart, crash fail-closed, queue loss', async (t) => {
  const h0 = await fixture({ maxConcurrentRuns: 1 });
  const dir = h0.dir;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await stop(h0);

  await t.test('crash: running becomes unknown, queued never starts or replays, titles/labels persist', async () => {
    const h = decorate(await boot({ maxConcurrentRuns: 1 }, {}, dir));
    const mk = (key, prompt, more, handle = h) => call(handle, 'droid_create_session', { requestKey: key, workspace: join(dir, 'workspace'), prompt, model: 'mock-model', replyTo: null, ...more });
    const running = await mk('crash-run', 'slow', { title: 'Keep me', labels: ['persist'] });
    const queued = await mk('crash-queued', 'queued-never-submitted', { autonomy: 'high' });
    assert.equal(queued.latestRun.state, 'queued');
    await h.waitFor(() => audit(h).some((x) => x.method === 'droid.add_user_message' && x.params.text === 'slow'), 'running turn');
    const before = audit(h).filter((x) => x.method === 'droid.add_user_message').length;
    await stop(h, 'SIGKILL'); await sleep(300);
    const again = decorate(await boot({ maxConcurrentRuns: 1 }, {}, dir));
    try {
      const r = await call(again, 'droid_get_session_status', { session: running.metadata.session });
      assert.equal(r.agentState.state, 'unknown');
      assert.equal(r.latestRun.state, 'unknown');
      assert.equal(r.latestRun.needsAttention, true);
      assert.equal(r.metadata.title, 'Keep me');
      assert.deepEqual(r.metadata.labels, ['persist']);
      const q = await call(again, 'droid_get_session_status', { session: queued.metadata.session });
      assert.equal(q.latestRun.state, 'cancelled');
      assert.equal(q.latestRun.error.code, 'queue_lost');
      assert.equal(audit(again).filter((x) => x.method === 'droid.add_user_message').length, before, 'nothing was replayed or started on recovery');
      assert.equal((await mk('crash-run', 'slow', { title: 'Keep me', labels: ['persist'] }, again)).metadata.session, running.metadata.session, 'idempotency survives the crash');
      await rejectsWith(call(again, 'droid_send_message', { session: running.metadata.session, requestKey: 'after-crash', message: 'x', model: 'mock-model' }), 'session_unknown_outcome');
      const resumed = await call(again, 'droid_send_message', { session: queued.metadata.session, requestKey: 'retry-queued', message: 'retry', model: 'mock-model' });
      await again.settle([resumed.status.metadata.session]);
    } finally { await stop(again); }
  });
});

test('review fixes: default-deny, revoked workspace, scrubbing, reporting and pagination hardening', async (t) => {
  await t.test('a brand-new Amp tool is denied automatically; an undeniable one fails the run closed', async () => {
    const h = await fixture({ ampMcp: { url: AMP_URL } }, { MOCK_PUCK_FAILURE: 'new-tool' });
    try {
      const s = await h.create('deny-new', 'normal', { replyTo: PUCK });
      assert.equal((await h.settle([s.metadata.session])).sessions[0].latestRun.state, 'succeeded');
      const wire = audit(h);
      const update = wire.find((x) => x.method === 'droid.update_session_settings' && x.params.disabledToolIds);
      assert.ok(update.params.disabledToolIds.includes('amp-puck___brand_new_tool'), 'the unknown tool is added to the deny list');
      assert.ok(!update.params.disabledToolIds.includes('amp-puck___puck'));
      assert.ok(update.ts <= wire.find((x) => x.method === 'droid.add_user_message').ts, 'denied before the prompt is submitted');
    } finally { await done(h); }
  });

  await t.test('resume re-authorizes the recorded workspace before touching Droid', async () => {
    const h = await fixture();
    const s = await h.create('revoke-a', 'normal');
    await h.settle([s.metadata.session]);
    const loads = audit(h).filter((x) => x.method === 'droid.load_session').length;
    await stop(h);
    const again = decorate(await boot({ approvedDirectories: [join(h.dir, 'workspace-sibling')] }, {}, h.dir));
    try {
      await rejectsWith(again.send(s.metadata.session, 'revoke-b', 'x'), 'workspace_not_approved');
      assert.equal(audit(again).filter((x) => x.method === 'droid.load_session').length, loads, 'Droid never started in the revoked workspace');
    } finally { await done(again); }
  });

  await t.test('read_reply never fabricates a misroute; history keeps declined questions and permissions', async () => {
    const h = await fixture({ ampMcp: { url: AMP_URL } });
    try {
      const s = await h.create('readreply', 'puck-report-read', { replyTo: PUCK });
      const status = (await h.settle([s.metadata.session])).sessions[0];
      assert.equal(status.notification.state, 'accepted');
      assert.equal(status.notification.error, null);
      const asked = await h.create('ask-history', 'ask', { autonomy: 'high', workspace: h.ws('ask-h') });
      await h.settle([asked.metadata.session]);
      await h.send(asked.metadata.session, 'ask-history-2', 'normal', { autonomy: 'high' });
      await h.settle([asked.metadata.session]);
      const history = await call(h, 'droid_read_session', { session: asked.metadata.session, limit: 100 });
      assert.ok(history.messages.some((m) => m.role === 'controller' && /Declined AskUser question: Deploy\?/.test(m.text)), 'the question survives a later turn');
    } finally { await done(h); }
  });

  await t.test('dates need a real UTC offset; admitted vs queued disposition', async () => {
    const h = await fixture({ maxConcurrentRuns: 1 });
    try {
      for (const bad of ['2026-10-01T00:00:00+25:00', '2026-10-01T00:00:00+00:99']) {
        await rejectsWith(call(h, 'droid_find_sessions', { after: bad }), 'invalid_argument');
        await rejectsWith(call(h, 'droid_get_usage', { before: bad }), 'invalid_argument');
      }
      const idle = await h.create('disp-idle', 'normal', { workspace: h.ws('disp-a') });
      await h.settle([idle.metadata.session]);
      const busy = await h.create('disp-busy', 'sleep:700 busy', { workspace: h.ws('disp-b') });
      const sent = await h.send(idle.metadata.session, 'disp-send', 'later');
      assert.equal(sent.status.latestRun.state, 'queued');
      assert.equal(sent.disposition, 'queued', 'a turn waiting for capacity is not "started"');
      assert.equal((await h.send(idle.metadata.session, 'disp-send', 'later')).disposition, 'queued', 'replays keep it');
      await h.settle([busy.metadata.session, idle.metadata.session]);
    } finally { await done(h); }
  });

  await t.test('corrupt state is refused without rewriting: duplicate session sequence numbers', async () => {
    const h = await fixture();
    const s1 = await h.create('seq-1', 'normal');
    const s2 = await h.create('seq-2', 'normal', { workspace: h.ws('seq2') });
    await h.settle([s1.metadata.session, s2.metadata.session]);
    await stop(h);
    const path = join(h.dir, 'state/state.json');
    const good = JSON.parse(readFileSync(path, 'utf8'));
    const dup = structuredClone(good);
    const [first, second] = Object.values(dup.sessions);
    second.seq = first.seq;
    writeFileSync(path, JSON.stringify(dup));
    await assert.rejects(boot({}, {}, h.dir), /sequence/);
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(dup));
    const lowNext = structuredClone(good); lowNext.nextSeq = 1;
    writeFileSync(path, JSON.stringify(lowNext));
    await assert.rejects(boot({}, {}, h.dir), /nextSeq/);
    rmSync(h.dir, { recursive: true, force: true });
  });
});

test('adversarial fixes: unexpected worker death, default-deny aliases, admission, usage, durability, scrubbing', async (t) => {
  await t.test('a worker killed after submission fails the turn and DROPS queued follow-ups instead of resuming them', async () => {
    const h = await fixture();
    try {
      const s = await h.create('kill-a', 'slow');
      const sid = s.metadata.session;
      await h.waitFor(() => h.turns('slow').length, 'turn submitted');
      const queued = await h.send(sid, 'kill-b', 'follow-after-kill');
      assert.equal(queued.disposition, 'queued');
      process.kill(audit(h).find((x) => x.method === 'droid.add_user_message' && x.params.text.startsWith('slow')).workerPid, 'SIGKILL');
      const status = (await h.settle([sid])).sessions[0];
      assert.equal(status.latestRun.state, 'cancelled');
      assert.equal(status.latestRun.error.code, 'predecessor_failed');
      assert.equal(status.latestRun.needsAttention, true);
      assert.equal(status.latestRun.predecessorFailure.runId, s.latestRun.runId);
      const runs = Object.values(readState(h).runs).filter((r) => r.sessionId === sid);
      assert.deepEqual(runs.map((r) => r.state), ['failed', 'cancelled']);
      assert.equal(h.turns('follow-after-kill').length, 0, 'the queued turn was never submitted');
      assert.equal((await call(h, 'droid_get_usage', { session: sid })).turns, 1, 'only the submitted turn counts');
    } finally { await done(h); }
  });

  await t.test('an Amp tool whose llmId differs from its protocol id is still found and denied; usage excludes preflight failures', async () => {
    const h = await fixture({ ampMcp: { url: AMP_URL } }, { MOCK_PUCK_FAILURE: 'alias' });
    try {
      const s = await h.create('alias-a', 'normal', { replyTo: PUCK });
      assert.equal((await h.settle([s.metadata.session])).sessions[0].latestRun.state, 'succeeded');
      const update = audit(h).find((x) => x.method === 'droid.update_session_settings' && x.params.disabledToolIds);
      assert.ok(update.params.disabledToolIds.includes('amp-puck___brand_new_tool'));
    } finally { await done(h); }
    const f = await fixture({ ampMcp: { url: AMP_URL } }, { MOCK_PUCK_FAILURE: 'puck-missing' });
    try {
      const s = await f.create('preflight-usage', 'no-echo:never', { replyTo: PUCK });
      assert.equal((await f.settle([s.metadata.session])).sessions[0].latestRun.state, 'failed');
      assert.equal((await call(f, 'droid_get_usage', { session: s.metadata.session })).turns, 0, 'no prompt was submitted, so no turn');
    } finally { await done(f); }
  });

  await t.test('a timed-out turn also drops queued follow-ups; a steering message survives its interrupted predecessor', async () => {
    // The peer ignores the interrupt, so the process group is killed and no terminal result exists.
    const h = await fixture({ runTimeoutMs: 1500, cancelGraceMs: 300 }, { MOCK_IGNORE_INTERRUPT: '1' });
    try {
      const s = await h.create('to-a', 'silent');
      const sid = s.metadata.session;
      await h.waitFor(() => h.turns('silent').length, 'turn submitted');
      await h.send(sid, 'to-b', 'follow-after-timeout');
      const status = (await h.settle([sid])).sessions[0];
      assert.equal(status.latestRun.error.code, 'predecessor_failed');
      assert.deepEqual(Object.values(readState(h).runs).filter((r) => r.sessionId === sid).map((r) => r.state), ['timed_out', 'cancelled']);
      assert.equal(h.turns('follow-after-timeout').length, 0);
    } finally { await done(h); }
    const g = await fixture();
    try {
      const steer = await g.create('to-c', 'slow');
      await g.waitFor(() => g.turns('slow').length, 'slow turn');
      await g.send(steer.metadata.session, 'to-d', 'steered-survives', { interrupt: true });
      assert.equal((await g.settle([steer.metadata.session])).sessions[0].preview.text, 'answer:steered-survives');
    } finally { await done(g); }
  });

  await t.test('without puck in the server registry the deny list cannot be trusted: fail closed', async () => {
    const h = await fixture({ ampMcp: { url: AMP_URL }, runTimeoutMs: 30000 }, { MOCK_PUCK_FAILURE: 'alias-blind' });
    try {
      const s = await h.create('blind-a', 'no-echo:never', { replyTo: PUCK });
      const status = (await h.settle([s.metadata.session], 30)).sessions[0];
      assert.equal(status.latestRun.state, 'failed');
      assert.equal(status.latestRun.error.code, 'amp_mcp_tool_missing');
      assert.equal(audit(h).filter((x) => x.method === 'droid.add_user_message').length, 0);
    } finally { await done(h); }
  });

  await t.test('a directory fsync failure after the state rename stops the controller; recovery never starts the accepted turn', async () => {
    const flag = join(tmpdir(), `droid-fsync-fault-${randomUUID()}`);
    const h = await fixture({}, { FSYNC_FAULT_FLAG: flag, NODE_OPTIONS: `--import=${join(root, 'test/fs-fault.mjs')}` });
    try {
      writeFileSync(flag, '');
      const failed = await h.create('fsync-a', 'normal').then(() => 'accepted', () => 'rejected');
      await once(h.proc, 'exit');
      assert.equal(h.proc.exitCode, 70, `fail-stop on unknown durability (${failed})`);
      rmSync(flag, { force: true });
      await sleep(200);
      const again = decorate(await boot({}, {}, h.dir));
      try {
        assert.equal(audit(again).filter((x) => x.method === 'droid.add_user_message').length, 0, 'the turn was never submitted');
        const found = await call(again, 'droid_find_sessions', {});
        for (const s of found.sessions) assert.notEqual(s.latestRun.state, 'running');
        // The same intent is a replay of whatever recovery decided; a fresh key starts clean.
        const fresh = await again.create('fsync-b', 'normal', { workspace: again.ws('fsync-b') });
        assert.equal((await again.settle([fresh.metadata.session])).sessions[0].latestRun.state, 'succeeded');
      } finally { await done(again); }
    } finally { rmSync(flag, { force: true }); rmSync(h.dir, { recursive: true, force: true }); }
  });

  await t.test('a rejected admission does not block later queued turns', async () => {
    const h = await fixture({ maxConcurrentRuns: 1 });
    try {
      const busy = await h.create('adm-busy', 'sleep:600 busy', { workspace: h.ws('adm-a') });
      const doomed = await h.create('adm-doomed', 'normal', { workspace: h.ws('adm-b') });
      const later = await h.create('adm-later', 'normal', { workspace: h.ws('adm-b') });
      assert.deepEqual([doomed, later].map((x) => x.latestRun.state), ['queued', 'queued']);
      rmSync(join(h.dir, 'workspace/adm-b'), { recursive: true });
      const result = await h.settle([busy, doomed, later].map((x) => x.metadata.session));
      assert.equal(result.sessions[1].latestRun.error.code, 'workspace_not_approved');
      assert.equal(result.sessions[2].latestRun.error.code, 'workspace_not_approved', 'the next turn is judged on its own and is not stranded');
      assert.deepEqual(await h.capacity(), { maximum: 1, active: 0, queued: 0, available: 1 });
    } finally { await done(h); }
  });

  await t.test('a request already in flight when shutdown begins cannot admit work', async () => {
    const h = await fixture({ runTimeoutMs: 6000 });
    // A hung model discovery keeps shutdown busy: the window in which the old ordering still admitted work.
    writeCatalog(h, { mode: 'hang' });
    h.client.callTool({ name: 'droid_models', arguments: {} }).catch(() => {});
    await sleep(300);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'droid_create_session', arguments: { requestKey: 'after-shutdown', workspace: h.ws(), prompt: 'normal', model: 'mock-model', replyTo: null } } });
    const outcome = new Promise((resolve) => {
      const req = httpRequest(h.url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) } }, (res) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve(text)); });
      req.on('error', () => resolve('connection-error'));
      req.write(body.slice(0, 40));
      setTimeout(() => { h.proc.kill('SIGTERM'); setTimeout(() => req.end(body.slice(40)), 150); }, 100);
    });
    const text = await outcome;
    if (h.proc.exitCode === null) { h.proc.kill('SIGKILL'); await once(h.proc, 'exit'); }
    const state = JSON.parse(readFileSync(join(h.dir, 'state/state.json'), 'utf8'));
    assert.equal(Object.values(state.runs).filter((r) => r.requestKey === 'after-shutdown').length, 0, `nothing was accepted: ${text.slice(0, 300)}`);
    assert.equal(audit(h).filter((x) => x.method === 'droid.add_user_message').length, 0);
    rmSync(h.dir, { recursive: true, force: true });
  });

  await t.test('read_session scrubs SDK error text like status does', async () => {
    const h = await fixture();
    try {
      const s = await h.create('scrub-a', 'leaky-error');
      await h.settle([s.metadata.session]);
      const text = JSON.stringify(await call(h, 'droid_read_session', { session: s.metadata.session, limit: 100 }));
      assert.match(text, /boom/, 'the error is still reported');
      assert.ok(!/11111111-2222|private\/mock|example\.invalid|MOCK_ONLY/.test(text), 'ids, paths and URLs are removed');
    } finally { await done(h); }
  });

  await t.test('durability: failed write leaves nothing accepted; unsupported and corrupt state refuse without rewriting', async () => {
    const h = await fixture();
    const a = await h.create('dur-a', 'normal');
    await h.settle([a.metadata.session]);
    await stop(h);
    const path = join(h.dir, 'state/state.json');
    const good = JSON.parse(readFileSync(path, 'utf8'));
    const refuse = async (mutate, pattern) => {
      const bad = structuredClone(good); mutate(bad);
      const bytes = JSON.stringify(bad); writeFileSync(path, bytes);
      await assert.rejects(boot({}, {}, h.dir), pattern);
      assert.equal(readFileSync(path, 'utf8'), bytes, 'refused state is never rewritten');
    };
    const [run] = Object.values(good.runs);
    await refuse((s) => { Object.values(s.runs)[0].createdAt = '2026-10-01T00:00:00+25:00'; }, /createdAt/);
    await refuse((s) => { const copy = { ...Object.values(s.runs)[0], runId: randomUUID() }; s.runs[copy.runId] = copy; }, /duplicate requestKey/);
    await refuse((s) => { s.sessions[run.sessionId].droidSessionId = randomUUID(); }, /different from its controller session/);
    await refuse((s) => { s.sessions[run.sessionId].droidSessionId = null; }, /different from its controller session/);
    for (const version of [1, 2, 4]) await refuse((s) => { s.version = version; }, /version/);
    for (const field of ['replyHandles', 'replyRouteId']) await refuse((s) => { delete s.runs[run.runId][field]; }, new RegExp(field));
    // An incomplete terminal result is never promoted to an outcome.
    writeFileSync(path, JSON.stringify(good));
    const resultPath = join(h.dir, 'state', `${run.runId}.result.json`);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    const crashed = structuredClone(good); Object.values(crashed.runs)[0].state = 'running'; writeFileSync(path, JSON.stringify(crashed));
    writeFileSync(resultPath, JSON.stringify({ sessionId: result.sessionId, subtype: 'success', success: true, messages: [], text: '' }));
    const again = decorate(await boot({}, {}, h.dir));
    try {
      const status = await call(again, 'droid_get_session_status', { session: a.metadata.session });
      assert.equal(status.latestRun.state, 'unknown', 'an incomplete result is unknown, not succeeded');
      assert.equal(status.latestRun.needsAttention, true);
      assert.equal((await call(again, 'droid_read_session', { session: a.metadata.session })).historyAvailable, false);
      // Failed durable write: nothing stays accepted in memory.
      const ro = join(again.dir, 'state');
      const created = await again.create('dur-ok', 'normal', { workspace: again.ws('dur-ok') });
      await again.settle([created.metadata.session]);
      chmodSync(ro, 0o500);
      let denied = false;
      try { await again.create('dur-fail', 'normal', { workspace: again.ws('dur-fail') }); } catch (error) { denied = error.code === 'internal_error'; }
      chmodSync(ro, 0o700);
      if (process.getuid?.() !== 0) {
        assert.ok(denied, 'a failed durable write rejects the request');
        const retry = await again.create('dur-fail', 'normal', { workspace: again.ws('dur-fail') });
        assert.equal(retry.latestRun.state === 'queued' ? 'queued' : 'started', 'started', 'the retry is a fresh acceptance');
        assert.equal((await again.settle([retry.metadata.session])).sessions[0].latestRun.state, 'succeeded', 'and it really runs (no phantom key)');
        assert.equal(Object.values(readState(again).runs).filter((r) => r.requestKey === 'dur-fail').length, 1);
      }
    } finally { await done(again); }
  });
});
