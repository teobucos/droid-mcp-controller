// Review regressions use the real MCP -> controller -> worker -> published SDK
// path. Only the remote Droid JSON-RPC peer is controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, stop, call, audit, readState, writeCatalog, sleep, processRunning, root } from './harness.mjs';

async function fixture(t, config = {}, env = {}) {
  const h = await boot(config, env);
  t.after(async () => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); });
  writeCatalog(h, [{ id: 'mock-model', displayName: 'Mock' }]);
  h.create = (key, prompt) => call(h, 'droid_create_session', { requestKey: key, prompt, model: 'mock-model', replyTo: null, workspace: join(h.dir, 'workspace') });
  h.send = (session, key, message, extra = {}) => call(h, 'droid_send_message', { session, requestKey: key, message, model: 'mock-model', ...extra });
  h.settle = (session) => call(h, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 });
  h.turns = () => audit(h).filter((x) => x.method === 'droid.add_user_message');
  return h;
}
async function until(check) {
  for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await sleep(20); }
  throw new Error('Timed out waiting for protocol observation');
}

test('R1: steering supersedes queued intent durably, once, without touching other sessions', async (t) => {
  const h = await fixture(t, {}, { MOCK_SLOW_CLOSE: '1' });
  const a = await h.create('A', 'slow');
  const session = a.metadata.session;
  await until(() => h.turns().length === 1);
  const b = await h.send(session, 'B', 'must never submit');
  const other = await h.create('other', 'unrelated');
  const c = await h.send(session, 'C', 'STOP', { interrupt: true });
  const retry = await h.send(session, 'C', 'STOP', { interrupt: true });
  assert.equal(retry.runId, c.runId);
  const stored = readState(h).runs[b.runId];
  assert.equal(stored.state, 'cancelled');
  assert.equal(stored.errorCode, 'superseded');
  assert.equal(stored.supersededBy, c.runId);
  await h.settle(session); await h.settle(other.metadata.session);
  assert.equal(h.turns().filter((x) => x.params.text === 'must never submit').length, 0);
  assert.equal(h.turns().filter((x) => x.params.text === 'STOP').length, 1);
  assert.equal(h.turns().filter((x) => x.params.text === 'unrelated').length, 1);
  const first = h.turns()[0];
  assert.equal(processRunning(first.workerPid), false);
  assert.equal(processRunning(first.mockPid), false);
  const records = audit(h);
  assert.ok(records.findIndex((x) => x.method === 'droid.close_session' && x.mockPid === first.mockPid)
    < records.findIndex((x) => x.method === 'droid.add_user_message' && x.params.text === 'STOP'));
  assert.equal((await h.send(session, 'B', 'must never submit')).runId, b.runId);
});

test('R1: a full session queue still admits STOP by superseding pending turns', async (t) => {
  const h = await fixture(t);
  const a = await h.create('full-A', 'silent');
  const session = a.metadata.session;
  await until(() => h.turns().length === 1);
  for (let i = 0; i < 7; i++) await h.send(session, `queued-${i}`, `must-not-run-${i}`);
  await assert.rejects(h.send(session, 'overflow', 'must-not-run-overflow'), (e) => e.code === 'queue_full');
  await h.send(session, 'full-STOP', 'STOP', { interrupt: true });
  await h.settle(session);
  assert.deepEqual(h.turns().map((request) => request.params.text), ['silent', 'STOP']);
  assert.equal(Object.values(readState(h).runs).filter((run) => run.errorCode === 'superseded').length, 7);
});

for (const failure of ['death', 'timeout']) test(`R4: ${failure} predecessor remains actionable through queued head, clears after resolution`, async (t) => {
  const h = await fixture(t, { runTimeoutMs: 1100 }, { MOCK_IGNORE_INTERRUPT: '1' });
  const a = await h.create(`A-${failure}`, 'silent');
  const session = a.metadata.session;
  await until(() => h.turns().length === 1);
  const b = await h.send(session, `B-${failure}`, 'not submitted');
  if (failure === 'death') process.kill(h.turns()[0].workerPid, 'SIGKILL');
  const status = (await h.settle(session)).sessions[0];
  assert.equal(status.latestRun.runId, b.runId);
  assert.equal(status.latestRun.error.code, 'predecessor_failed');
  assert.equal(status.latestRun.needsAttention, true);
  assert.equal(status.latestRun.predecessorFailure.runId, a.latestRun.runId);
  assert.equal(status.latestRun.predecessorFailure.state, failure === 'death' ? 'failed' : 'timed_out');
  assert.equal(h.turns().length, 1);
  await h.send(session, `resolve-${failure}`, 'resolved');
  const resolved = (await h.settle(session)).sessions[0];
  assert.equal(resolved.latestRun.state, 'succeeded');
  assert.equal(resolved.latestRun.needsAttention, false);
  assert.equal(resolved.latestRun.predecessorFailure, null);
});

test('policy: omitted default autonomy respects an explicit off ceiling', async (t) => {
  const h = await fixture(t, { maxAutonomy: 'off', defaultAutonomy: undefined });
  const policy = (await call(h, 'droid_list_workspaces', {})).policy;
  assert.equal(policy.defaultAutonomy, 'off');
  assert.equal(policy.maxAutonomy, 'off');
  const a = await h.create('off', 'permission-once');
  await h.settle(a.metadata.session);
  assert.ok(audit(h).some((x) => x.id === 'permission-1' && x.result?.selectedOption === 'cancel'));
});

test('R3: actual SDK permission path requires an observed owned reply handle', async (t) => {
  const h = await fixture(t, { ampMcp: {} });
  const recipient = 'T-11111111-1111-4111-8111-111111111111';
  const a = await h.create('route-base', 'base');
  const session = a.metadata.session; await h.settle(session);
  for (const mode of ['valid', 'stale', 'missing', 'foreign', 'failed', 'misrouted', 'blocks']) {
    const start = audit(h).length;
    await h.send(session, `handle-${mode}`, `puck-handle:${mode}`, { replyTo: recipient });
    await h.settle(session);
    const result = audit(h).slice(start).find((x) => x.id === 'permission-handle' && x.result);
    assert.equal(result?.result.selectedOption, ['valid', 'blocks'].includes(mode) ? 'proceed_once' : 'cancel', mode);
  }
  // Retargeting and detaching must never grant an unobserved handle.
  for (const replyTo of ['T-22222222-2222-4222-8222-222222222222', null]) {
    const start = audit(h).length;
    await h.send(session, `retarget-${replyTo}`, 'puck-handle:stale', { replyTo }); await h.settle(session);
    assert.equal(audit(h).slice(start).find((x) => x.id === 'permission-handle')?.result.selectedOption, 'cancel');
  }
  const start = audit(h).length;
  await h.send(session, 'high-policy', 'puck-handle:missing', { replyTo: recipient, autonomy: 'high' }); await h.settle(session);
  assert.equal(audit(h).slice(start).find((x) => x.id === 'permission-handle')?.result.selectedOption, 'cancel', 'even high cannot invent reply ownership');
  await stop(h);
  const again = await boot({ ampMcp: {} }, {}, h.dir);
  try {
    const start = audit(again).length;
    await call(again, 'droid_send_message', { session, requestKey: 'after-restart', message: 'puck-handle:stale', model: 'mock-model', autonomy: 'off' });
    await call(again, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 });
    assert.equal(audit(again).slice(start).find((x) => x.id === 'permission-handle')?.result.selectedOption, 'cancel');
  } finally { await stop(again); }
});

async function sentHandle(h, session) {
  const history = await call(h, 'droid_read_session', { session, limit: 100 });
  return JSON.parse(history.messages.find((m) => m.type === 'tool_result' && m.text.startsWith('{"status":"queued"')).text).replyHandle;
}

test('delayed reply: same-session continuation retrieves an owned handle before and after restart without resending', async (t) => {
  const h = await fixture(t, { ampMcp: {} });
  const a = await call(h, 'droid_create_session', { requestKey: 'checkpoint', prompt: 'puck-handle:valid', model: 'mock-model', autonomy: 'off', workspace: join(h.dir, 'workspace'), replyTo: 'T-11111111-1111-4111-8111-111111111111' });
  const session = a.metadata.session; await h.settle(session);
  const handle = await sentHandle(h, session);
  await h.send(session, 'delayed-read', `puck-read:${handle}`, { autonomy: 'off' });
  const status = (await h.settle(session)).sessions[0];
  assert.equal(status.latestRun.permissionsDeclined, 0);
  assert.equal(status.latestRun.needsAttention, false);
  assert.equal(status.preview.text, 'DELAYED_ACK');
  assert.equal(status.notification.state, 'not_sent', 'a read does not claim another report');
  await stop(h);
  const again = await boot({ ampMcp: {} }, {}, h.dir);
  try {
    await call(again, 'droid_send_message', { session, requestKey: 'restored-read', message: `puck-read:${handle}`, model: 'mock-model', autonomy: 'off' });
    const restored = (await call(again, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 })).sessions[0];
    assert.equal(restored.preview.text, 'DELAYED_ACK');
    assert.equal(restored.latestRun.permissionsDeclined, 0);
    const history = await call(again, 'droid_read_session', { session, limit: 100 });
    assert.equal(history.messages.filter((m) => m.type === 'tool_call' && m.text.startsWith('amp-puck___puck') && m.text.includes('"action":"send"')).length, 1);
    assert.equal(history.messages.filter((m) => m.type === 'tool_result' && m.text.includes('"reply":"DELAYED_ACK"')).length, 3);
  } finally { await stop(again); }
});

test('delayed reply: replayed send without current approval cannot revive cancelled-detach ownership, including reopen', async (t) => {
  const h = await fixture(t, { ampMcp: {} });
  const recipient = 'T-11111111-1111-4111-8111-111111111111';
  const a = await call(h, 'droid_create_session', { requestKey: 'original-send', prompt: 'puck-handle:valid', model: 'mock-model', autonomy: 'off', workspace: join(h.dir, 'workspace'), replyTo: recipient });
  const session = a.metadata.session; await h.settle(session);
  const handle = await sentHandle(h, session);
  await h.send(session, 'active', 'silent');
  await until(() => h.turns().some((request) => request.params.text.startsWith('silent')));
  const detached = await h.send(session, 'queued-detach', 'must never run', { replyTo: null });
  assert.equal(detached.status.latestRun.state, 'queued');
  await call(h, 'droid_cancel_session', { session }); await h.settle(session);
  assert.equal((await h.send(session, 'queued-detach', 'must never run', { replyTo: null })).runId, detached.runId);
  await h.send(session, 'reattach', `puck-read:${handle}`, { replyTo: recipient, autonomy: 'high' });
  assert.equal((await h.settle(session)).sessions[0].latestRun.permissionsDeclined, 1);
  const replays = [];
  for (const mode of ['replay-historical-send', 'replay-other-approval', 'replay-foreign-approval']) {
    await h.send(session, mode, mode, { autonomy: mode === 'replay-foreign-approval' ? 'high' : 'low' });
    replays.push((await h.settle(session)).sessions[0]);
  }
  await stop(h);
  const again = await boot({ ampMcp: {} }, {}, h.dir);
  try {
    await call(again, 'droid_send_message', { session, requestKey: 'reopened', message: `puck-read:${handle}`, model: 'mock-model', autonomy: 'off' });
    const restored = (await call(again, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 })).sessions[0];
    for (const status of [...replays, restored]) {
      assert.equal(status.latestRun.permissionsDeclined, 1, 'replay without matching approval and reopened read must be denied');
      assert.equal(status.latestRun.needsAttention, true);
      assert.ok(!status.preview.text.includes('DELAYED_ACK'));
    }
    const history = await call(again, 'droid_read_session', { session, limit: 100 });
    assert.equal(history.messages.filter((message) => message.type === 'tool_result' && message.text.includes('"reply":"DELAYED_ACK"')).length, 1, 'only the original approved turn can retrieve its ACK');
  } finally { await stop(again); }
});

test('delayed reply: ownership excludes foreign sessions, bad handles and detached or stale routing, including high', async (t) => {
  const h = await fixture(t, { ampMcp: {} });
  const recipient = 'T-11111111-1111-4111-8111-111111111111';
  const a = await h.create('owner', 'base'); const session = a.metadata.session; await h.settle(session);
  await h.send(session, 'send-checkpoint', 'puck-handle:valid', { replyTo: recipient }); await h.settle(session);
  const handle = await sentHandle(h, session);
  const b = await h.create('foreign', 'base'); await h.settle(b.metadata.session);
  for (const [key, target, token, route, autonomy] of [
    ['foreign-session', b.metadata.session, handle, recipient, 'off'],
    ['malformed', session, 'not-a-handle', recipient, 'off'],
    ['foreign-handle', session, `v1:${recipient}:M-abcdefghijkl0123456789`, recipient, 'off'],
    ['detached', session, handle, null, 'off'],
    ['reattached', session, handle, recipient, 'off'],
    ['foreign-recipient', session, handle, 'T-22222222-2222-4222-8222-222222222222', 'off'],
    ['retargeted-back', session, handle, recipient, 'high'],
  ]) {
    await h.send(target, key, `puck-read:${token}`, { replyTo: route, autonomy });
    const status = (await h.settle(target)).sessions[0];
    assert.equal(status.latestRun.permissionsDeclined, 1, key);
    assert.equal(status.latestRun.needsAttention, true, key);
    const history = await call(h, 'droid_read_session', { session: target, limit: 100 });
    assert.ok(history.messages.some((m) => m.runId === status.latestRun.runId && m.role === 'controller' && /reply handle.*ownership/i.test(m.text)), key);
  }
  // A fresh checkpoint in the new route grants only its new handle, not the old one.
  await h.send(session, 'fresh-checkpoint', 'puck-handle:valid', { replyTo: recipient }); await h.settle(session);
  await h.send(session, 'old-after-fresh', `puck-read:${handle}`); await h.settle(session);
  assert.equal((await call(h, 'droid_get_session_status', { session })).latestRun.permissionsDeclined, 1);
  await stop(h);
  const state = readState(h);
  // A clock adjustment must not revive the old route when history is sorted.
  Object.values(state.runs).find((r) => r.requestKey === 'send-checkpoint').createdAt = '2099-01-01T00:00:00Z';
  writeFileSync(join(h.dir, 'state/state.json'), JSON.stringify(state));
  const again = await boot({ ampMcp: {} }, {}, h.dir);
  try {
    await call(again, 'droid_send_message', { session, requestKey: 'restored-stale', message: `puck-read:${handle}`, model: 'mock-model', autonomy: 'off' });
    const status = (await call(again, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 })).sessions[0];
    assert.equal(status.latestRun.permissionsDeclined, 1);
  } finally { await stop(again); }
});

for (const unrelated of [false, true]) test(`catalog: verified lifecycle metadata, initialization correlation (unrelated=${unrelated})`, async (t) => {
  const h = await fixture(t, {}, unrelated ? { MOCK_CATALOG_UNRELATED: '1' } : {});
  writeCatalog(h, [
    { id: 'enabled-old', displayName: 'Old', disabled: false, deprecated: true },
    { id: 'disabled-new', displayName: 'Disabled', disabled: true, deprecated: false },
    { id: 'current', displayName: 'A current', deprecated: false, supportsPDFs: true },
    { id: 'unknown-lifecycle', displayName: 'Z sparse' },
  ]);
  const result = await call(h, 'droid_models', {});
  assert.deepEqual(result.models, [
    { id: 'current', displayName: 'A current', deprecated: false, supportsPdfs: true },
    { id: 'unknown-lifecycle', displayName: 'Z sparse' },
  ]);
  assert.deepEqual(audit(h).map((x) => x.method), ['droid.initialize_session', 'droid.close_session']);
});

for (const phase of ['session', 'submission_intent']) for (const mode of ['delay', 'fail']) test(`R2: real controller ${phase} directory fsync ${mode} gates SDK submission`, async (t) => {
  const gates = mkdtempSync(join(tmpdir(), 'droid-fsync-'));
  t.after(() => rmSync(gates, { recursive: true, force: true }));
  const marker = join(gates, 'marker'), release = join(gates, 'release');
  const h = await fixture(t, {}, { NODE_OPTIONS: `--import=${join(root, 'test/fs-fault.mjs')}`, PERSIST_FAULT_PHASE: phase, PERSIST_FAULT_MODE: mode, PERSIST_FAULT_MARKER: marker, PERSIST_FAULT_RELEASE: release });
  const a = await h.create(`fsync-${phase}`, 'no-echo:FSYNC_PRIVATE');
  await until(() => existsSync(marker));
  await sleep(200);
  assert.equal(h.turns().length, 0, 'even after rename, fsync must finish before add_user_message');
  if (mode === 'delay') {
    writeFileSync(release, 'release');
    assert.equal((await h.settle(a.metadata.session)).sessions[0].latestRun.state, 'succeeded');
    assert.equal(h.turns().length, 1);
    const run = readState(h).runs[a.latestRun.runId];
    assert.ok(run.droidSessionId && run.submissionIntentAt);
    assert.equal(run.submittedAt, undefined, 'intent is not an exact acceptance timestamp');
  } else {
    await until(() => h.proc.exitCode !== null);
    assert.equal(h.proc.exitCode, 70);
    const again = await boot({}, {}, h.dir);
    try {
      const status = await call(again, 'droid_get_session_status', { session: a.metadata.session });
      assert.equal(status.latestRun.state, 'unknown');
      assert.equal(audit(again).filter((x) => x.method === 'droid.add_user_message').length, 0);
      assert.ok(readState(again).sessions[a.metadata.session].droidSessionId, 'UUID is available for reconciliation');
      assert.equal((await call(again, 'droid_create_session', { requestKey: `fsync-${phase}`, prompt: 'no-echo:FSYNC_PRIVATE', model: 'mock-model', workspace: join(h.dir, 'workspace'), replyTo: null })).latestRun.runId, a.latestRun.runId);
    } finally { await stop(again); }
  }
});

test('R1: crash at supersession durability keeps B cancelled and C unreplayed', async (t) => {
  const gates = mkdtempSync(join(tmpdir(), 'droid-supersede-'));
  t.after(() => rmSync(gates, { recursive: true, force: true }));
  const h = await fixture(t, {}, { NODE_OPTIONS: `--import=${join(root, 'test/fs-fault.mjs')}`, PERSIST_FAULT_PHASE: 'supersede', PERSIST_FAULT_MODE: 'fail', PERSIST_FAULT_MARKER: join(gates, 'marker') });
  const a = await h.create('crash-A', 'slow'); await until(() => h.turns().length === 1);
  const b = await h.send(a.metadata.session, 'crash-B', 'never-B');
  await assert.rejects(h.send(a.metadata.session, 'crash-C', 'STOP-C', { interrupt: true }));
  await until(() => h.proc.exitCode !== null);
  assert.equal(h.proc.exitCode, 70);
  const again = await boot({}, {}, h.dir);
  try {
    assert.equal(readState(again).runs[b.runId].errorCode, 'superseded');
    const c = Object.values(readState(again).runs).find((r) => r.requestKey === 'crash-C');
    assert.equal(c.errorCode, 'queue_lost');
    const retry = await call(again, 'droid_send_message', { session: a.metadata.session, requestKey: 'crash-C', message: 'STOP-C', model: 'mock-model', interrupt: true });
    assert.equal(retry.runId, c.runId);
    assert.equal(audit(again).filter((x) => x.method === 'droid.add_user_message').length, 1);
  } finally { await stop(again); }
});
