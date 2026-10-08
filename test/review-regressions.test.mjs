// Review regressions use the real MCP -> controller -> worker -> published SDK
// path. Only the remote Droid JSON-RPC peer is controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

test('compatibility: omitted default autonomy respects an explicit off ceiling', async (t) => {
  const h = await fixture(t, { maxAutonomy: 'off', defaultAutonomy: undefined });
  const policy = (await call(h, 'droid_list_workspaces', {})).policy;
  assert.equal(policy.defaultAutonomy, 'off');
  assert.equal(policy.maxAutonomy, 'off');
  const a = await h.create('off', 'permission-once');
  await h.settle(a.metadata.session);
  assert.ok(audit(h).some((x) => x.id === 'permission-1' && x.result?.selectedOption === 'cancel'));
});

test('R3: actual SDK permission path scopes reply handles to successful sends in this run', async (t) => {
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
  // Retargeting and detaching also start fresh per-run capability sets.
  for (const replyTo of ['T-22222222-2222-4222-8222-222222222222', null]) {
    const start = audit(h).length;
    await h.send(session, `retarget-${replyTo}`, 'puck-handle:stale', { replyTo }); await h.settle(session);
    assert.equal(audit(h).slice(start).find((x) => x.id === 'permission-handle')?.result.selectedOption, 'cancel');
  }
  const start = audit(h).length;
  await h.send(session, 'high-policy', 'puck-handle:missing', { replyTo: recipient, autonomy: 'high' }); await h.settle(session);
  assert.equal(audit(h).slice(start).find((x) => x.id === 'permission-handle')?.result.selectedOption, 'proceed_once', 'high retains its general single-use approval policy, not route-scoped authorization');
  await stop(h);
  const again = await boot({ ampMcp: {} }, {}, h.dir);
  try {
    const start = audit(again).length;
    await call(again, 'droid_send_message', { session, requestKey: 'after-restart', message: 'puck-handle:stale', model: 'mock-model', autonomy: 'off' });
    await call(again, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 });
    assert.equal(audit(again).slice(start).find((x) => x.id === 'permission-handle')?.result.selectedOption, 'cancel');
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

for (const version of [1, 2]) test(`migration v${version}: original fingerprint retries preserve outcome and never submit again`, async (t) => {
  const h = await fixture(t);
  const prompt = 'no-echo:LEGACY_PRIVATE_PROMPT';
  const puckConversationId = version === 2 ? 'T-11111111-1111-4111-8111-111111111111' : undefined;
  const a = await h.create('legacy-key', prompt); await h.settle(a.metadata.session);
  const b = await h.send(a.metadata.session, 'legacy-followup', `${prompt}-followup`); await h.settle(a.metadata.session);
  await stop(h);
  const good = readState(h);
  const runs = [a.latestRun.runId, b.runId].map((runId, index) => {
    const old = { ...good.runs[runId], parentRunId: index ? a.latestRun.runId : null };
    for (const key of ['sessionId', 'replyTo', 'disposition', 'preview', 'submissionIntentAt']) delete old[key];
    if (puckConversationId) old.puckConversationId = puckConversationId;
    const input = index ? `${prompt}-followup` : prompt;
    // Independent fixture from the original 7b4a816 accept() serialization order.
    old.fingerprint = createHash('sha256').update(JSON.stringify({ workspace: old.workspace, prompt: input, autonomy: old.autonomy, model: old.model, parentRunId: old.parentRunId, reasoningEffort: old.reasoningEffort, ...(puckConversationId ? { puckConversationId } : {}) })).digest('hex');
    if (version === 1) old.prompt = input;
    return old;
  });
  const [old, followup] = runs;
  const legacy = { version, host: good.host, home: good.home, factoryHomeOverride: good.factoryHomeOverride, runs: Object.fromEntries(runs.map((run) => [run.runId, run])), ...(version === 2 ? { sessionHeads: { [old.droidSessionId]: followup.runId } } : {}) };
  const bytes = JSON.stringify(legacy);
  writeFileSync(join(h.dir, 'state/state.json'), bytes);
  const again = await boot({}, {}, h.dir);
  try {
    assert.equal(readFileSync(join(h.dir, `state/state.json.v${version}.bak`), 'utf8'), bytes);
    const count = audit(again).filter((x) => x.method === 'droid.add_user_message').length;
    const replay = await call(again, 'droid_start', { requestKey: 'legacy-key', prompt, workspace: old.workspace, model: old.model, ...(puckConversationId ? { puckConversationId } : {}) });
    assert.equal(replay.runId, old.runId); assert.equal(replay.state, 'succeeded');
    if (puckConversationId) await assert.rejects(call(again, 'droid_start', { requestKey: 'legacy-key', prompt, workspace: old.workspace, model: old.model }), (e) => e.code === 'request_key_conflict');
    const resumed = await call(again, 'droid_continue', { runId: old.runId, requestKey: 'legacy-followup', prompt: `${prompt}-followup`, model: old.model });
    assert.equal(resumed.runId, followup.runId);
    assert.equal(Object.values(readState(again).sessions)[0].headRunId, followup.runId);
    await assert.rejects(call(again, 'droid_start', { requestKey: 'legacy-key', prompt: `${prompt}-changed`, workspace: old.workspace, model: old.model }), (e) => e.code === 'request_key_conflict');
    assert.equal(audit(again).filter((x) => x.method === 'droid.add_user_message').length, count);
    assert.ok(!readFileSync(join(h.dir, 'state/state.json'), 'utf8').includes(prompt));
    assert.ok(!readFileSync(join(h.dir, 'state', `${old.runId}.result.json`), 'utf8').includes(prompt));
  } finally { await stop(again); }
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
