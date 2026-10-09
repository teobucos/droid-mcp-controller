// Transport, SDK and persistence contracts exercised through the session API.
// Session scheduling, routing and metadata cases live in session-surface.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root, token, sleep, boot, stop, call, audit, readState, writeCatalog, processRunning } from './harness.mjs';

async function fixture(t, config = {}, env = {}) {
  const h = await boot(config, env);
  t.after(async () => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); });
  writeCatalog(h, [{ id: 'mock-model', displayName: 'Mock' }, { id: 'model-b', displayName: 'B' }]);
  return h;
}
const create = (h, key, prompt, extra = {}) => call(h, 'droid_create_session', { requestKey: key, prompt, workspace: join(h.dir, 'workspace'), model: 'mock-model', replyTo: null, ...extra });
const send = (h, session, key, message, extra = {}) => call(h, 'droid_send_message', { session, requestKey: key, message, model: 'mock-model', ...extra });
const settle = async (h, session) => {
  const result = await call(h, 'droid_wait_for_sessions', { sessions: [session], timeoutSeconds: 15 });
  assert.equal(result.settled, true);
  return result.sessions[0];
};
async function until(check) {
  for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await sleep(20); }
  throw new Error('Timed out waiting for protocol observation');
}

test('HTTP authenticates and bounds requests; malformed input and internal errors stay distinct', async (t) => {
  const h = await fixture(t);
  assert.equal((await fetch(h.url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(h.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(h.url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(h.url, { method: 'POST', headers: { ...headers, Host: 'evil.test' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(h.url, { method: 'POST', headers, body: 'x'.repeat(1048577) })).status, 413);
  assert.equal((await fetch(h.url.replace('/mcp', '/other'), { headers })).status, 404);
  for (const body of ['{broken', '{}', 'null', '[]']) assert.equal((await fetch(h.url, { method: 'POST', headers, body })).status, 400);
  assert.equal((await fetch(h.url, { method: 'GET', headers })).status, 405);
  await assert.rejects(call(h, 'droid_get_session_status', { session: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }), (e) => e.code === 'unknown_session');
  for (const fault of ['connect', 'dispatch']) {
    const broken = await fixture(t, {}, { MOCK_HTTP_FAULT: fault, NODE_OPTIONS: `--import=${join(root, 'test/http-fault.mjs')}` });
    const response = await fetch(broken.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    assert.equal(response.status, 500, fault);
    assert.equal(await response.text(), 'Internal MCP server error');
    assert.match(broken.diagnostics(), /PRIVATE_INTERNAL_PATH/);
  }
});

test('session restart retains identity, history and accepted defaults without retaining original prompts', async (t) => {
  const h = await fixture(t);
  const prompt = 'no-echo:PRIVATE_ORIGINAL_PROMPT';
  const first = await create(h, 'persist-create', prompt);
  const session = first.metadata.session;
  await settle(h, session);
  const next = await send(h, session, 'persist-send', 'follow-up', { model: 'model-b', reasoningEffort: 'low' });
  await settle(h, session);
  const state = readState(h), uuid = state.sessions[session].droidSessionId;
  assert.ok(!readFileSync(join(h.dir, 'state/state.json'), 'utf8').includes(prompt));
  assert.ok(!readFileSync(join(h.dir, 'state', `${first.latestRun.runId}.result.json`), 'utf8').includes(prompt));
  const second = spawn(process.execPath, ['src/server.mjs', '--config', h.configPath], { cwd: root, env: h.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; second.stderr.on('data', (b) => { log += b; });
  assert.notEqual((await once(second, 'exit'))[0], 0); assert.match(log, /already.*running|locked/i);
  await stop(h);
  const again = await boot({ defaultAutonomy: 'high', reasoningEffort: 'low' }, {}, h.dir);
  try {
    const before = audit(again).filter((x) => x.method === 'droid.add_user_message').length;
    assert.equal((await create(again, 'persist-create', prompt)).metadata.session, session);
    assert.equal((await send(again, session, 'persist-send', 'follow-up', { model: 'model-b', reasoningEffort: 'low' })).runId, next.runId);
    assert.equal(audit(again).filter((x) => x.method === 'droid.add_user_message').length, before);
    assert.deepEqual(readState(again), state, 'replay does not rewrite accepted settings');
    await assert.rejects(create(again, 'persist-create', prompt, { reasoningEffort: 'low' }), (e) => e.code === 'request_key_conflict');
    const history = await call(again, 'droid_read_session', { session });
    assert.ok(history.messages.some((m) => m.text === 'answer:follow-up'));
    assert.equal(statSync(join(h.dir, 'state/state.json')).mode & 0o777, 0o600);
    await send(again, session, 'after-restart', 'remember', { autonomy: 'off' });
    assert.equal((await settle(again, session)).latestRun.state, 'succeeded');
    assert.equal(readState(again).sessions[session].droidSessionId, uuid);
    const settings = audit(again).filter((x) => x.method === 'droid.update_session_settings').at(-1).params;
    assert.equal(settings.autonomyLevel, 'off'); assert.equal(settings.reasoningEffort, 'low');
  } finally { await stop(again); }
});

test('SDK permissions use Auto/single-use or Spec/off independently of reasoning; AskUser remains declined', async (t) => {
  const h = await fixture(t, { defaultAutonomy: undefined, maxAutonomy: undefined, reasoningEffort: 'low' });
  const first = await create(h, 'policy-high', 'permission-once');
  const session = first.metadata.session;
  assert.equal(first.latestRun.autonomy, 'high');
  assert.equal((await settle(h, session)).latestRun.state, 'succeeded');
  const init = audit(h).find((x) => x.method === 'droid.initialize_session' && x.params.modelId).params;
  assert.equal(init.interactionMode, 'auto'); assert.equal(init.autonomyLevel, 'high');
  assert.equal(audit(h).find((x) => x.id === 'permission-1').result.selectedOption, 'proceed_once');
  await send(h, session, 'policy-off', 'permission-once', { autonomy: 'off', reasoningEffort: 'medium', model: 'model-b' });
  assert.equal((await settle(h, session)).latestRun.state, 'interrupted');
  const settings = audit(h).find((x) => x.method === 'droid.update_session_settings').params;
  assert.equal(settings.autonomyLevel, 'off'); assert.equal(settings.interactionMode, 'spec');
  assert.equal(settings.reasoningEffort, 'medium'); assert.equal(settings.modelId, 'model-b');
  await send(h, session, 'policy-question', 'ask');
  const asked = await settle(h, session);
  assert.equal(asked.latestRun.state, 'interrupted');
  assert.equal(asked.latestRun.questions[0].question, 'Deploy?');
  for (const autonomy of ['off', 'low', 'medium', 'high']) {
    const denied = await create(h, `permission-${autonomy}`, 'permission', { autonomy });
    const status = await settle(h, denied.metadata.session);
    assert.equal(status.latestRun.state, 'interrupted', 'no offered proceed_once means decline');
    assert.equal(status.latestRun.permissionsDeclined, 1);
  }
});

test('SDK tool-only assistant messages do not corrupt text; errors and unrelated completions cannot succeed', async (t) => {
  const h = await fixture(t, { runTimeoutMs: 1100 });
  const first = await create(h, 'textless', 'textless-assistant');
  const status = await settle(h, first.metadata.session);
  assert.equal(status.latestRun.state, 'succeeded');
  assert.equal(status.preview.text, 'answer:textless-assistant');
  const history = await call(h, 'droid_read_session', { session: first.metadata.session });
  assert.ok(history.messages.some((m) => m.type === 'tool_call' && m.text.startsWith('LS ')));
  assert.ok(!JSON.stringify(history).includes('mock diagnostic'));
  for (const prompt of ['agent-error', 'crash', 'silent', 'malformed', 'wrong-turn']) {
    const s = await create(h, prompt, prompt);
    assert.equal((await settle(h, s.metadata.session)).latestRun.state, ['agent-error', 'crash'].includes(prompt) ? 'failed' : 'timed_out');
  }
});

test('workspace escapes and a changed Factory resume cwd fail closed', async (t) => {
  const h = await fixture(t, { maxAutonomy: 'off' }, { MOCK_RESUME_CWD: tmpdir() });
  symlinkSync(join(h.dir, 'workspace-sibling'), join(h.dir, 'workspace/escape'));
  for (const workspace of [join(h.dir, 'workspace-sibling'), join(h.dir, 'workspace/../workspace-sibling'), join(h.dir, 'workspace/escape')]) {
    await assert.rejects(create(h, workspace, 'no', { workspace }), (e) => e.code === 'workspace_not_approved');
  }
  const s = await create(h, 'resume-cwd', 'normal'); await settle(h, s.metadata.session);
  await send(h, s.metadata.session, 'moved', 'must not run');
  assert.equal((await settle(h, s.metadata.session)).latestRun.state, 'failed');
  assert.equal(audit(h).filter((x) => x.method === 'droid.add_user_message').length, 1);
});

test('terminal result survives crash during SDK cleanup; slots are held and orphans exit', async (t) => {
  const h = await fixture(t, { cancelGraceMs: 3000 }, { MOCK_SLOW_CLOSE: '1' });
  const s = await create(h, 'cleanup', 'done', { autonomy: 'high' });
  await until(() => readState(h).runs[s.latestRun.runId].result);
  assert.equal((await call(h, 'droid_get_session_status', { session: s.metadata.session })).latestRun.terminal, false);
  const waiting = await create(h, 'cleanup-lock', 'must not run');
  assert.equal(waiting.latestRun.state, 'queued');
  const turn = audit(h).find((x) => x.method === 'droid.add_user_message');
  await stop(h, 'SIGKILL');
  await until(() => !processRunning(turn.mockPid) && !processRunning(turn.workerPid));
  const again = await boot({}, {}, h.dir);
  try {
    const recovered = await call(again, 'droid_get_session_status', { session: s.metadata.session });
    assert.equal(recovered.latestRun.state, 'succeeded'); assert.equal(recovered.preview.text, 'answer:done');
    assert.equal((await call(again, 'droid_get_session_status', { session: waiting.metadata.session })).latestRun.error.code, 'queue_lost');
    assert.equal(audit(again).filter((x) => x.method === 'droid.add_user_message').length, 1);
  } finally { await stop(again); }
});

test('live catalog single-flight, replacement cache, sparse metadata, cleanup and denial', async (t) => {
  const h = await fixture(t, { modelCacheTtlMs: 5000 });
  writeCatalog(h, [
    { id: 'z-current', displayName: 'Alpha', modelProvider: 'anthropic', supportedReasoningEfforts: ['low', 'high'], noImageSupport: true },
    { id: 'a-current', displayName: 'Alpha' },
    { id: 'b-current', displayName: 'Beta', supportsPDFs: false },
    { id: 'disabled-model', displayName: 'Disabled', disabled: true },
  ]);
  const [first, shared] = await Promise.all([call(h, 'droid_models', {}), call(h, 'droid_models', {})]);
  assert.deepEqual(first, shared);
  assert.deepEqual(first.models.map((m) => m.id), ['a-current', 'z-current', 'b-current']);
  assert.deepEqual(first.models[0], { id: 'a-current', displayName: 'Alpha' });
  assert.equal(first.models[1].provider, 'anthropic'); assert.equal(first.models[1].supportsImages, false);
  assert.equal(first.models[2].supportsPdfs, false);
  assert.deepEqual(audit(h).map((x) => x.method), ['droid.initialize_session', 'droid.close_session']);
  assert.equal(processRunning(audit(h)[0].mockPid), false);
  const s = await create(h, 'catalog-history', 'normal', { model: 'a-current' }); await settle(h, s.metadata.session);
  writeCatalog(h, [{ id: 'replacement', displayName: 'Replacement' }]);
  assert.deepEqual((await call(h, 'droid_models', {})).models, first.models);
  await sleep(5100);
  assert.deepEqual((await call(h, 'droid_models', {})).models, [{ id: 'replacement', displayName: 'Replacement' }]);
  writeCatalog(h, { error: 'Catalog unavailable' }); await sleep(5100);
  await assert.rejects(call(h, 'droid_models', {}), (e) => e.code === 'model_discovery_failed');
  writeCatalog(h, []); assert.deepEqual((await call(h, 'droid_models', {})).models, []);
  for (const mode of ['permission', 'hang', 'missing']) {
    const bad = await fixture(t, { runTimeoutMs: 1000, cancelGraceMs: 100 });
    writeCatalog(bad, { mode });
    await assert.rejects(call(bad, 'droid_models', {}), (e) => e.code === 'model_discovery_failed');
    assert.ok(!audit(bad).some((x) => x.method === 'droid.add_user_message'));
    if (mode === 'permission') assert.equal(audit(bad).find((x) => x.id === 'catalog-permission').result.selectedOption, 'cancel');
    assert.equal(processRunning(audit(bad)[0].mockPid), false);
  }
  for (const modelCacheTtlMs of [4999, 600001]) await assert.rejects(boot({ modelCacheTtlMs }, {}, h.dir), /modelCacheTtlMs/);
});

test('MCP lockdown on create/resume preserves native disables and verifies denial before submission', async (t) => {
  const h = await fixture(t, { ampMcp: {} }, { MOCK_PUCK_FAILURE: 'new-tool' });
  const s = await create(h, 'lock-create', 'no-echo:first', { replyTo: 'T-11111111-1111-4111-8111-111111111111' });
  assert.equal((await settle(h, s.metadata.session)).latestRun.state, 'succeeded');
  const path = join(h.dir, 'mock', `${readState(h).sessions[s.metadata.session].droidSessionId}.json`);
  const saved = JSON.parse(readFileSync(path, 'utf8')); saved.settings.disabledToolIds.push('Execute'); writeFileSync(path, JSON.stringify(saved));
  await send(h, s.metadata.session, 'lock-send', 'no-echo:next');
  assert.equal((await settle(h, s.metadata.session)).latestRun.state, 'succeeded');
  const wire = audit(h);
  for (const [method, nativeDisabled] of [['droid.initialize_session', false], ['droid.load_session', true]]) {
    const begin = wire.findIndex((r) => r.method === method && (r.params.modelId || method === 'droid.load_session'));
    const end = wire.findIndex((r, i) => i > begin && r.method === 'droid.add_user_message');
    const before = wire.slice(begin, end);
    assert.ok(end > begin);
    const update = before.findLastIndex((r) => r.method === 'droid.update_session_settings' && r.params.disabledToolIds);
    const inventory = before.findLastIndex((r) => r.method === 'mock.tool_inventory');
    assert.ok(before.findIndex((r) => r.method === 'mock.tool_inventory') < update && update < inventory);
    const expected = ['amp-puck___manage_amp', 'amp-puck___find_thread', 'amp-puck___read_thread', 'amp-puck___brand_new_tool', ...(nativeDisabled ? ['Execute'] : [])];
    assert.deepEqual(before[update].params.disabledToolIds.toSorted(), expected.sort());
    const tools = before[inventory].tools;
    assert.deepEqual(tools.filter((r) => r.id.startsWith('amp-puck___') && r.currentlyAllowed).map((r) => r.id), ['amp-puck___puck']);
    assert.equal(tools.find((r) => r.id === 'Read').currentlyAllowed, true);
    assert.equal(tools.find((r) => r.id === 'Execute').currentlyAllowed, !nativeDisabled);
  }
});

test('MCP discovery/settings failures, saved Puck denial and cancellation submit no work', async (t) => {
  for (const mode of ['discovery-error', 'settings-error', 'puck-disabled', 'discovery-pending']) {
    const h = await fixture(t, { ampMcp: {} }, { MOCK_PUCK_FAILURE: mode });
    const s = await create(h, mode, mode === 'puck-disabled' ? 'normal' : 'must not run', { replyTo: 'T-11111111-1111-4111-8111-111111111111' });
    let prior = 0;
    if (mode === 'puck-disabled') {
      await settle(h, s.metadata.session);
      const path = join(h.dir, 'mock', `${readState(h).sessions[s.metadata.session].droidSessionId}.json`);
      const saved = JSON.parse(readFileSync(path, 'utf8')); saved.settings.disabledToolIds.push('amp-puck___puck'); writeFileSync(path, JSON.stringify(saved));
      await send(h, s.metadata.session, 'disabled-resume', 'must not run'); prior = 1;
    }
    if (mode === 'discovery-pending') {
      await until(() => audit(h).some((x) => x.method === 'droid.list_tools'));
      await call(h, 'droid_cancel_session', { session: s.metadata.session });
    }
    assert.equal((await settle(h, s.metadata.session)).latestRun.state, mode === 'discovery-pending' ? 'cancelled' : 'failed');
    assert.equal(audit(h).filter((x) => x.method === 'droid.add_user_message').length, prior);
  }
});

test('STDIO smoke uses the eleven tools; corrupt state and unauthenticated HTTP refuse startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droid-mcp-stdio-'));
  const path = join(dir, 'config.json');
  const config = { approvedDirectories: [dir], stateDirectory: join(dir, 'state'), droidPath: join(root, 'test/mock-droid.mjs') };
  writeFileSync(path, JSON.stringify(config));
  const client = new Client({ name: 'session-stdio', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/server.mjs'), '--config', path], stderr: 'pipe' }));
    assert.equal((await client.listTools()).tools.length, 11);
    await client.close(); await sleep(100);
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify([{ id: 'mock-selected', displayName: 'Selected Mock', supportedReasoningEfforts: ['low'] }]));
    const smoke = spawn(process.execPath, [join(root, 'scripts/smoke.mjs'), '--config', path, '--model', 'mock-selected', '--out', join(dir, 'acceptance.json')], { env: { ...process.env, MOCK_DROID_HOME: dir, MOCK_AUDIT: join(dir, 'audit.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; smoke.stdout.on('data', (b) => { log += b; }); smoke.stderr.on('data', (b) => { log += b; });
    assert.equal((await once(smoke, 'exit'))[0], 0, log);
    const evidence = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
    assert.equal(evidence.passed, true); assert.equal(evidence.runs.length, 2);
    assert.ok(evidence.runs.every((r) => r.markerMatched && r.state === 'succeeded' && r.historyAvailable));
    assert.equal(evidence.runs[0].session, evidence.runs[1].session);
    for (const r of audit({ dir }).filter((x) => x.params?.modelId)) {
      assert.equal(r.params.autonomyLevel, 'off'); assert.equal(r.params.reasoningEffort, 'low');
    }
    writeFileSync(join(dir, 'state/state.json'), '{broken');
    for (const [cfg, pattern] of [[config, /JSON|state|corrupt/i], [{ ...config, transport: 'http' }, /HTTP requires tokenFile/]]) {
      writeFileSync(path, JSON.stringify(cfg));
      const proc = spawn(process.execPath, [join(root, 'src/server.mjs'), '--config', path], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; proc.stderr.on('data', (b) => { stderr += b; });
      assert.notEqual((await once(proc, 'exit'))[0], 0); assert.match(stderr, pattern); assert.ok(!stderr.includes('Listening'));
    }
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
