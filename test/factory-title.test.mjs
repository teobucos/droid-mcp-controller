// E2E for Factory session titles and tags through the public MCP surface (real
// controller, SDK transport, protocol-peer droid). The wrong alternatives this
// separates: never renaming (dashboard shows the auto title), renaming before the
// first turn (the generated title would replace it), renaming on every turn,
// an update_session that spawns Droid outside admission, a rename failure that
// fails the turn or (near the deadline) times it out, and title sync leaking into
// request-key fingerprints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, stop, call, audit, readState } from './harness.mjs';

const MODEL = [{ id: 'std-model', displayName: 'Standard', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' }];

async function fixture(env = {}, extra = {}) {
  const h = await boot({ defaultModel: 'std-model', runTimeoutMs: 8000, ...extra }, env);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(h.dir, 'mock/catalog.json'), JSON.stringify(MODEL));
  h.create = (key, prompt, more = {}) => call(h, 'droid_create_session', { requestKey: key, workspace: join(h.dir, 'workspace'), prompt, replyTo: null, ...more });
  h.send = (session, key, message) => call(h, 'droid_send_message', { session, requestKey: key, message });
  h.settle = async (session) => {
    const result = await call(h, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 });
    assert.equal(result.settled, true);
    return result.sessions[0];
  };
  return h;
}
const cleanup = async (h) => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); };
// Requests sent by the Droid process that ran the turn whose prompt starts with marker.
function turnWire(h, marker) {
  const all = audit(h);
  const turn = all.find((x) => x.method === 'droid.add_user_message' && x.params.text.startsWith(marker));
  assert.ok(turn, `turn ${marker} was submitted`);
  return all.filter((x) => x.mockPid === turn.mockPid && x.method);
}
const renamesIn = (requests) => requests.filter((x) => x.method === 'droid.rename_session').map((x) => x.params.title);
const droidProcesses = (h) => audit(h).filter((x) => ['droid.initialize_session', 'droid.load_session'].includes(x.method) && !x.params.cwd?.endsWith('/state')).length;
const runOf = (h, runId) => readState(h).runs[runId];

test('an explicit title reaches Factory after the first turn of a new session, once', async () => {
  const h = await fixture();
  try {
    const created = await h.create('titled', 'first', { title: 'Diff review', labels: ['review', 'sdk'] });
    const id = created.metadata.session;
    assert.equal((await h.settle(id)).latestRun.state, 'succeeded');
    const first = turnWire(h, 'first');
    const methods = first.map((x) => x.method);
    assert.deepEqual(renamesIn(first), ['Diff review']);
    assert.ok(methods.indexOf('droid.rename_session') > methods.indexOf('droid.add_user_message'), 'rename follows the first turn so the generated title cannot replace it');
    assert.ok(methods.indexOf('droid.rename_session') < methods.indexOf('droid.close_session'));
    assert.deepEqual(runOf(h, created.latestRun.runId).titleSync, { state: 'applied', title: 'Diff review' });

    // Labels become creation-time Factory tags beside the SDK's own tag.
    const init = first.find((x) => x.method === 'droid.initialize_session');
    const tags = init.params.tags.map((tag) => tag.name).sort();
    assert.deepEqual(tags, ['review', 'sdk']);
    assert.equal(init.params.tags.filter((tag) => tag.name === 'sdk').length, 1);

    // Already applied: a resumed turn does not rename again.
    await h.send(id, 'second', 'second');
    await h.settle(id);
    assert.deepEqual(renamesIn(turnWire(h, 'second')), []);
    assert.equal(turnWire(h, 'second').some((x) => x.method === 'droid.initialize_session'), false);
  } finally { await cleanup(h); }
});

test('a session without a title keeps the Factory generated title', async () => {
  const h = await fixture();
  try {
    const created = await h.create('untitled', 'plain');
    await h.settle(created.metadata.session);
    assert.deepEqual(renamesIn(turnWire(h, 'plain')), []);
    assert.equal(turnWire(h, 'plain').find((x) => x.method === 'droid.initialize_session').params.tags.map((tag) => tag.name).join(), 'sdk');
    assert.equal(runOf(h, created.latestRun.runId).titleSync, undefined);
  } finally { await cleanup(h); }
});

test('droid_update_session titles propagate on the next resumed turn without spawning Droid', async () => {
  const h = await fixture();
  try {
    const created = await h.create('later', 'start');
    const id = created.metadata.session;
    await h.settle(id);
    const before = droidProcesses(h);
    const updated = await call(h, 'droid_update_session', { session: id, title: 'Renamed later' });
    assert.equal(updated.metadata.title, 'Renamed later');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(droidProcesses(h), before, 'metadata updates never run Droid outside admission');

    await h.send(id, 'next', 'next');
    await h.settle(id);
    const next = turnWire(h, 'next');
    assert.ok(next.some((x) => x.method === 'droid.load_session'));
    assert.deepEqual(renamesIn(next), ['Renamed later']);

    // Labels changed after creation are controller metadata only (no SDK tag update).
    await call(h, 'droid_update_session', { session: id, labels: { add: ['later'] } });
    await h.send(id, 'third', 'third');
    await h.settle(id);
    assert.deepEqual(renamesIn(turnWire(h, 'third')), []);

    // Factory already shows the last applied title, so a round trip back to it needs no rename.
    await call(h, 'droid_update_session', { session: id, title: 'Second name' });
    await call(h, 'droid_update_session', { session: id, title: 'Renamed later' });
    await h.send(id, 'fourth', 'fourth');
    await h.settle(id);
    assert.deepEqual(renamesIn(turnWire(h, 'fourth')), []);
  } finally { await cleanup(h); }
});

for (const mode of ['error', 'hang']) {
  test(`a rename ${mode} is recorded, never fails the turn, and is retried on the next turn`, async () => {
    const h = await fixture({ MOCK_RENAME_FAILURE: mode });
    try {
      const args = { title: 'Will not stick' };
      const created = await h.create('fails', 'work', args);
      const id = created.metadata.session;
      const status = await h.settle(id);
      assert.equal(status.latestRun.state, 'succeeded');
      assert.equal(status.latestRun.error, null);
      assert.equal(status.latestRun.needsAttention, false);
      assert.equal(status.preview.text, 'answer:work');
      const run = runOf(h, created.latestRun.runId);
      assert.equal(run.titleSync.state, 'failed');
      assert.equal(run.titleSync.title, 'Will not stick');
      assert.ok(run.events.some((event) => event.type === 'title_sync_failed'));
      assert.doesNotMatch(JSON.stringify(run.titleSync), /\/private\//, 'raw SDK text is scrubbed');

      // Exact replay still matches its original fingerprint, also after a title change.
      const fingerprint = run.fingerprint;
      assert.equal((await h.create('fails', 'work', args)).latestRun.runId, created.latestRun.runId);
      await call(h, 'droid_update_session', { session: id, title: 'Another' });
      assert.equal((await h.create('fails', 'work', args)).latestRun.runId, created.latestRun.runId);
      assert.equal(runOf(h, created.latestRun.runId).fingerprint, fingerprint);

      await h.send(id, 'retry', 'retry');
      assert.equal((await h.settle(id)).latestRun.state, 'succeeded');
      assert.deepEqual(renamesIn(turnWire(h, 'retry')), ['Another']);
    } finally { await cleanup(h); }
  });
}

// Review regression: the optional rename ran before the authoritative result was
// delivered, while the execution deadline was still armed, so a successful turn
// that finished near the deadline became timed_out with needsAttention.
test('a successful turn near the deadline stays successful when the best-effort rename hangs', async (t) => {
  // Review repro: 4000 ms deadline, 3100 ms turn. Scaled to 8000/6500 (title window
  // 2000 ms) so host load cannot turn the successful turn itself into a real timeout.
  const deadline = { runTimeoutMs: 8000 };
  const resultOf = (h, runId) => JSON.parse(readFileSync(join(h.dir, 'state', `${runId}.result.json`), 'utf8'));

  await t.test('titled 6500 ms turn with a hanging rename', async () => {
    const h = await fixture({ MOCK_RENAME_FAILURE: 'hang' }, deadline);
    try {
      const created = await h.create('near', 'sleep:6500 near', { title: 'Near deadline' });
      const status = await h.settle(created.metadata.session);
      const durable = resultOf(h, created.latestRun.runId);
      assert.equal(durable.success, true);
      assert.equal(durable.subtype, 'success');
      assert.equal(status.latestRun.state, 'succeeded', 'a slow optional rename must not turn a successful turn into timed_out');
      assert.equal(status.latestRun.needsAttention, false);
      assert.equal(status.latestRun.error, null);
      const run = runOf(h, created.latestRun.runId);
      assert.equal(run.titleSync.state, 'failed');
      assert.equal(run.stopReason, undefined);
      assert.ok(run.events.some((event) => event.type === 'title_sync_failed'));
      assert.deepEqual(renamesIn(turnWire(h, 'sleep:6500 near')), ['Near deadline']);
    } finally { await cleanup(h); }
  });

  await t.test('a slow but successful rename after a near-deadline turn is applied, not cut off', async () => {
    const h = await fixture({ MOCK_RENAME_FAILURE: 'slow' }, deadline);
    try {
      const created = await h.create('slow', 'sleep:6500 slow', { title: 'Slow rename' });
      const status = await h.settle(created.metadata.session);
      assert.equal(status.latestRun.state, 'succeeded');
      assert.deepEqual(runOf(h, created.latestRun.runId).titleSync, { state: 'applied', title: 'Slow rename' });
    } finally { await cleanup(h); }
  });

  await t.test('control: untitled 6500 ms turn', async () => {
    const h = await fixture({ MOCK_RENAME_FAILURE: 'hang' }, deadline);
    try {
      const created = await h.create('plain', 'sleep:6500 plain');
      assert.equal((await h.settle(created.metadata.session)).latestRun.state, 'succeeded');
      assert.deepEqual(renamesIn(turnWire(h, 'sleep:6500 plain')), []);
    } finally { await cleanup(h); }
  });

  await t.test('control: titled 700 ms turn with a hanging rename', async () => {
    const h = await fixture({ MOCK_RENAME_FAILURE: 'hang' }, deadline);
    try {
      const created = await h.create('short', 'sleep:700 short', { title: 'Short' });
      const status = await h.settle(created.metadata.session);
      assert.equal(status.latestRun.state, 'succeeded');
      assert.equal(status.latestRun.needsAttention, false);
      assert.equal(runOf(h, created.latestRun.runId).titleSync.state, 'failed');
    } finally { await cleanup(h); }
  });

  await t.test('a genuinely overrunning titled turn still times out and is never renamed', async () => {
    const h = await fixture({}, deadline);
    try {
      const created = await h.create('over', 'sleep:11000 over', { title: 'Overrun' });
      const status = await h.settle(created.metadata.session);
      assert.equal(status.latestRun.state, 'timed_out');
      assert.equal(status.latestRun.needsAttention, true);
      assert.deepEqual(renamesIn(turnWire(h, 'sleep:11000 over')), []);
      assert.equal(runOf(h, created.latestRun.runId).titleSync, undefined);
    } finally { await cleanup(h); }
  });

  await t.test('slot and workspace lock are held until the renaming worker has cleaned up', async () => {
    const h = await fixture({ MOCK_RENAME_FAILURE: 'hang' }, { maxConcurrentRuns: 2 });
    try {
      const first = await h.create('lock-a', 'sleep:1000 lock-a', { title: 'Locked', autonomy: 'low' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await h.create('lock-b', 'lock-b', { autonomy: 'low' });
      assert.equal(second.latestRun.state, 'queued', 'a writer on the same tree waits');
      await h.settle(second.metadata.session);
      assert.equal((await h.settle(first.metadata.session)).latestRun.state, 'succeeded');
      const all = audit(h);
      const firstPid = all.find((x) => x.method === 'droid.add_user_message' && x.params.text.startsWith('sleep:1000 lock-a')).mockPid;
      const closed = all.find((x) => x.mockPid === firstPid && x.method === 'droid.close_session');
      const renamed = all.find((x) => x.mockPid === firstPid && x.method === 'droid.rename_session');
      const nextInit = all.find((x) => x.method === 'droid.initialize_session' && x.ts > renamed.ts && x.mockPid !== firstPid && !x.params.cwd.endsWith('/state'));
      assert.ok(closed && renamed && nextInit);
      assert.ok(nextInit.ts >= closed.ts, 'the queued writer starts only after the first worker closed its Droid session');
    } finally { await cleanup(h); }
  });
});
