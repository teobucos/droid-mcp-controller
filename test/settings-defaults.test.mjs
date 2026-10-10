// E2E for launch defaults and follow-up inheritance through the public MCP surface
// (real controller process, MCP client, Factory SDK transport, protocol-peer droid).
// Written before the implementation. Each assertion separates the intended
// behavior from a plausible wrong one: host defaults silently replacing session
// settings, an old model's reasoning carried to a new model, silent downgrades of
// explicit requests, automatic Fast defaults, and replays that re-resolve settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot, stop, call, audit, readState, writeCatalog, root } from './harness.mjs';

const CATALOG = [
  { id: 'std-model', displayName: 'Standard', supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
  { id: 'alt-model', displayName: 'Alternate', supportedReasoningEfforts: ['medium', 'max'], defaultReasoningEffort: 'max' },
  { id: 'std-model-fast', displayName: 'Standard Fast Mode', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' },
  { id: 'turbo', displayName: 'Turbo Fast Mode' },
  { id: 'sparse-model', displayName: 'Sparse' },
];
const PUCK = 'T-11111111-1111-4111-8111-111111111111';

async function fixture(extra = {}, existing) {
  const h = await boot({ defaultAutonomy: 'high', maxAutonomy: 'high', reasoningEffort: 'high', modelCacheTtlMs: 5000, ...extra }, {}, existing);
  if (!existing) writeCatalog(h, CATALOG);
  h.ws = (name = '') => { const path = join(h.dir, 'workspace', name); mkdirSync(path, { recursive: true }); return path; };
  h.create = (key, prompt, more = {}) => call(h, 'droid_create_session', { requestKey: key, workspace: h.ws(more.ws ?? ''), prompt, replyTo: null, ...Object.fromEntries(Object.entries(more).filter(([k]) => k !== 'ws')) });
  h.send = (session, key, message, more = {}) => call(h, 'droid_send_message', { session, requestKey: key, message, ...more });
  h.settle = async (session) => {
    const result = await call(h, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 });
    assert.equal(result.settled, true);
    return result.sessions[0];
  };
  return h;
}
const rejectsWith = (promise, code, message) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code, error.message);
  if (message) assert.match(`${error.message} ${error.action}`, message);
  return true;
});
const settingsOf = (run) => ({ model: run.model, autonomy: run.autonomy, reasoningEffort: run.reasoningEffort });
// What the controller actually sent to Droid for the turn whose prompt starts with marker.
function wire(h, marker) {
  const all = audit(h);
  const turn = all.find((x) => x.method === 'droid.add_user_message' && x.params.text.startsWith(marker));
  assert.ok(turn, `turn ${marker} was submitted`);
  const sent = all.filter((x) => x.mockPid === turn.mockPid && ['droid.initialize_session', 'droid.update_session_settings'].includes(x.method) && 'autonomyLevel' in x.params);
  const merged = Object.assign({}, ...sent.map((x) => x.params));
  return { model: merged.modelId, autonomy: merged.autonomyLevel, mode: merged.interactionMode, reasoningEffort: merged.reasoningEffort };
}
// A wrong implementation that boots must not leave its controller running.
async function refusesStartup(extra, message) {
  let h;
  try { h = await boot(extra); } catch (error) { assert.match(error.message, message); return; }
  await stop(h); rmSync(h.dir, { recursive: true, force: true });
  assert.fail(`startup was not refused for ${JSON.stringify(extra)}`);
}
const submittedTurns = (h) => audit(h).filter((x) => x.method === 'droid.add_user_message').length;

test('create model: explicit, live-validated host default, actionable rejection, Fast refusal', async (t) => {
  await t.test('no explicit model and no host default rejects actionably and creates nothing', async () => {
    const h = await fixture();
    try {
      await rejectsWith(h.create('none', 'x'), 'model_required', /droid_models|defaultModel/);
      assert.equal((await call(h, 'droid_find_sessions', {})).sessions.length, 0);
      assert.equal((await call(h, 'droid_list_workspaces', {})).policy.defaultModel, null);
      // A caller may still explicitly choose any catalog model, including a Fast one.
      const fast = await h.create('explicit-fast', 'explicit-fast', { model: 'std-model-fast' });
      assert.equal(fast.latestRun.model, 'std-model-fast');
      await h.settle(fast.metadata.session);
      assert.equal(wire(h, 'explicit-fast').model, 'std-model-fast');
    } finally { await stop(h); rmSync(h.dir, { recursive: true, force: true }); }
  });

  await t.test('an omitted model uses the host default, validated against the current catalog', async () => {
    const h = await fixture({ defaultModel: 'std-model' });
    try {
      assert.equal((await call(h, 'droid_list_workspaces', {})).policy.defaultModel, 'std-model');
      const first = await h.create('host-default', 'host-default');
      assert.deepEqual(settingsOf(first.latestRun), { model: 'std-model', autonomy: 'high', reasoningEffort: 'high' });
      await h.settle(first.metadata.session);
      assert.deepEqual(wire(h, 'host-default'), { model: 'std-model', autonomy: 'high', mode: 'auto', reasoningEffort: 'high' });
      // An explicit model wins over the host default.
      const explicit = await h.create('explicit-alt', 'explicit-alt', { model: 'alt-model', ws: 'alt' });
      assert.equal(explicit.latestRun.model, 'alt-model');
      // Unsupported host reasoning falls back to the model default instead of rejecting.
      assert.equal(explicit.latestRun.reasoningEffort, 'max');
      // A sparse catalog entry accepts the host effort (support is unknown, not refused).
      const sparse = await h.create('sparse', 'sparse', { model: 'sparse-model', ws: 'sparse' });
      assert.equal(sparse.latestRun.reasoningEffort, 'high');
      // Explicit reasoning stays strict for the selected model.
      await rejectsWith(h.create('strict', 'x', { model: 'alt-model', reasoningEffort: 'low' }), 'reasoning_unsupported', /medium, max/);
      // The host default disappearing from the live catalog is an actionable rejection.
      writeCatalog(h, CATALOG.filter((m) => m.id !== 'std-model'));
      await new Promise((r) => setTimeout(r, 5100));
      await rejectsWith(h.create('gone', 'x'), 'model_unavailable', /defaultModel|host default/);
    } finally { await stop(h); rmSync(h.dir, { recursive: true, force: true }); }
  });

  await t.test('a Fast host default is refused; an explicit Fast choice is preserved', async () => {
    await refusesStartup({ defaultModel: 'std-model-fast' }, /defaultModel/);
    // The id hides it, the live display name reveals it: refused when resolved.
    const h = await fixture({ defaultModel: 'turbo' });
    try {
      await rejectsWith(h.create('auto-fast', 'x'), 'default_model_refused', /Fast/);
      assert.equal((await call(h, 'droid_find_sessions', {})).sessions.length, 0);
      const chosen = await h.create('chosen-fast', 'chosen-fast', { model: 'turbo' });
      assert.equal(chosen.latestRun.model, 'turbo');
      await h.settle(chosen.metadata.session);
    } finally { await stop(h); rmSync(h.dir, { recursive: true, force: true }); }
  });
});

test('follow-ups inherit the last accepted session settings, never host defaults', async (t) => {
  const h = await fixture({ defaultModel: 'std-model' });
  t.after(async () => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); });
  let s;
  const turn = async (key, more = {}) => {
    const sent = await h.send(s, key, key, more);
    await h.settle(s);
    return sent.status.latestRun;
  };

  await t.test('omitted model, autonomy and reasoning keep the session values', async () => {
    const created = await h.create('inherit-1', 'inherit-1', { model: 'alt-model', autonomy: 'off', reasoningEffort: 'medium' });
    s = created.metadata.session;
    await h.settle(s);
    // Wrong alternative: host std-model / high / high.
    assert.deepEqual(settingsOf(await turn('inherit-2')), { model: 'alt-model', autonomy: 'off', reasoningEffort: 'medium' });
    assert.deepEqual(wire(h, 'inherit-2'), { model: 'alt-model', autonomy: 'off', mode: 'spec', reasoningEffort: 'medium' });
  });

  await t.test('a model change does not carry the old model reasoning', async () => {
    // Session effort medium belonged to alt-model; std-model takes the supported host effort.
    assert.deepEqual(settingsOf(await turn('inherit-3', { model: 'std-model' })), { model: 'std-model', autonomy: 'off', reasoningEffort: 'high' });
    assert.deepEqual(settingsOf(await turn('inherit-4', { reasoningEffort: 'low' })), { model: 'std-model', autonomy: 'off', reasoningEffort: 'low' });
    // Same model: reuse the session effort, not the host one.
    assert.deepEqual(settingsOf(await turn('inherit-5')), { model: 'std-model', autonomy: 'off', reasoningEffort: 'low' });
    assert.equal(wire(h, 'inherit-5').reasoningEffort, 'low');
    // low is unsupported by alt-model and so is host high: the live model default applies.
    assert.deepEqual(settingsOf(await turn('inherit-6', { model: 'alt-model' })), { model: 'alt-model', autonomy: 'off', reasoningEffort: 'max' });
    assert.deepEqual(wire(h, 'inherit-6'), { model: 'alt-model', autonomy: 'off', mode: 'spec', reasoningEffort: 'max' });
    const before = submittedTurns(h);
    await rejectsWith(h.send(s, 'inherit-bad', 'x', { reasoningEffort: 'low' }), 'reasoning_unsupported', /medium, max/);
    assert.equal(submittedTurns(h), before);
  });

  await t.test('explicit autonomy changes apply and are then inherited', async () => {
    assert.equal((await turn('inherit-7', { autonomy: 'low' })).autonomy, 'low');
    assert.deepEqual(wire(h, 'inherit-7'), { model: 'alt-model', autonomy: 'low', mode: 'auto', reasoningEffort: 'max' });
    assert.equal((await turn('inherit-8')).autonomy, 'low');
  });

  await t.test('settings of accepted queued work are inherited in FIFO order', async () => {
    const q = (await h.create('queue-1', 'sleep:700 queue-1', { ws: 'queue', model: 'alt-model', autonomy: 'high', reasoningEffort: 'medium' })).metadata.session;
    const second = await h.send(q, 'queue-2', 'queue-2', { model: 'std-model', autonomy: 'medium', reasoningEffort: 'low' });
    assert.equal(second.disposition, 'queued');
    const third = await h.send(q, 'queue-3', 'queue-3');
    assert.equal(third.disposition, 'queued');
    assert.deepEqual(settingsOf(third.status.latestRun), { model: 'std-model', autonomy: 'medium', reasoningEffort: 'low' });
    await h.settle(q);
    assert.deepEqual(wire(h, 'queue-3'), { model: 'std-model', autonomy: 'medium', mode: 'auto', reasoningEffort: 'low' });
    const order = audit(h).filter((x) => x.method === 'droid.add_user_message' && /queue-\d/.test(x.params.text)).map((x) => x.params.text.match(/queue-\d/)[0]);
    assert.deepEqual(order, ['queue-1', 'queue-2', 'queue-3']);
  });
});

test('ceiling caps inherited autonomy, rejects explicit excess; accepted keys replay original settings', async (t) => {
  const h = await fixture({ defaultModel: 'std-model' });
  const dir = h.dir;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const high = (await h.create('cap-high', 'cap-high')).metadata.session;
  const low = (await h.create('cap-low', 'cap-low', { ws: 'low', autonomy: 'low' })).metadata.session;
  await h.settle(high); await h.settle(low);
  const sent = await h.send(low, 'cap-low-2', 'cap-low-2');
  // Asymmetric case: host default and ceiling are high, the session stays low.
  assert.equal(sent.status.latestRun.autonomy, 'low');
  await h.settle(low);
  assert.equal(wire(h, 'cap-low-2').autonomy, 'low');
  const original = readState(h);
  await stop(h);

  // Lower ceiling, different defaults, and a catalog without the original model.
  const again = await fixture({ defaultModel: 'alt-model', defaultAutonomy: 'off', maxAutonomy: 'medium', reasoningEffort: 'max' }, dir);
  try {
    writeCatalog(again, CATALOG.filter((m) => m.id !== 'std-model'));
    await t.test('replays return the original acceptance despite changed defaults, catalog and ceiling', async () => {
      const before = submittedTurns(again);
      const replay = await again.create('cap-high', 'cap-high');
      assert.equal(replay.metadata.session, high);
      assert.deepEqual(settingsOf(replay.latestRun), { model: 'std-model', autonomy: 'high', reasoningEffort: 'high' });
      assert.equal((await again.send(low, 'cap-low-2', 'cap-low-2')).runId, original.sessions[low].headRunId);
      // Spelling out the original effective settings is the same intent.
      assert.equal((await again.create('cap-high', 'cap-high', { model: 'std-model', autonomy: 'high', reasoningEffort: 'high' })).metadata.session, high);
      await rejectsWith(again.create('cap-high', 'cap-high', { model: 'alt-model' }), 'request_key_conflict');
      await rejectsWith(again.send(low, 'cap-low-2', 'cap-low-2', { autonomy: 'off' }), 'request_key_conflict');
      assert.equal(submittedTurns(again), before);
      assert.deepEqual(readState(again).runs, original.runs, 'replay does not rewrite accepted settings');
    });

    writeCatalog(again, CATALOG);
    await t.test('inherited autonomy above the new ceiling is capped; an explicit request is rejected', async () => {
      await rejectsWith(again.send(high, 'cap-explicit', 'x', { autonomy: 'high' }), 'autonomy_exceeds_ceiling', /medium/);
      const capped = await again.send(high, 'cap-inherited', 'cap-inherited');
      assert.deepEqual(settingsOf(capped.status.latestRun), { model: 'std-model', autonomy: 'medium', reasoningEffort: 'high' });
      await again.settle(high);
      assert.deepEqual(wire(again, 'cap-inherited'), { model: 'std-model', autonomy: 'medium', mode: 'auto', reasoningEffort: 'high' });
    });

    await t.test('a fresh key resolves the new host defaults', async () => {
      const fresh = await again.create('fresh', 'fresh', { ws: 'fresh' });
      assert.deepEqual(settingsOf(fresh.latestRun), { model: 'alt-model', autonomy: 'off', reasoningEffort: 'max' });
      await again.settle(fresh.metadata.session);
    });
  } finally { await stop(again); }
});

test('server identifies as droid-mcp with the package version', async (t) => {
  const h = await fixture();
  t.after(async () => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); });
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(h.client.getServerVersion(), { name: 'droid-mcp', version });
});

test('current Amp endpoint contract: profile=puck only; detached work never needs Amp', async (t) => {
  for (const url of ['https://ampcode.com/mcp?profile=external-agent', 'https://ampcode.com/mcp', 'https://example.com/mcp?profile=puck', `https://ampcode.com/mcp?profile=puck&threadID=${PUCK}`]) {
    await refusesStartup({ ampMcp: { url } }, /ampMcp\.url/);
  }
  const h = await fixture({ defaultModel: 'std-model', ampMcp: {} });
  t.after(async () => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); });
  const routed = await h.create('routed', 'routed', { replyTo: PUCK });
  await h.settle(routed.metadata.session);
  const init = audit(h).find((x) => x.method === 'droid.initialize_session' && x.params.mcpServers);
  assert.deepEqual(init.params.mcpServers, [{ name: 'amp-puck', type: 'http', url: 'https://ampcode.com/mcp?profile=puck', headers: [], oauth: { resource: 'https://ampcode.com/mcp' } }]);
  const detached = await h.create('detached', 'detached', { ws: 'detached' });
  await h.settle(detached.metadata.session);
  const pid = audit(h).find((x) => x.method === 'droid.add_user_message' && x.params.text === 'detached').mockPid;
  assert.ok(audit(h).filter((x) => x.mockPid === pid).every((x) => !x.params?.mcpServers && !String(x.method).includes('mcp')), 'detached turns never touch the Amp MCP');
});
