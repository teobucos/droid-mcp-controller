import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root, token, sleep, boot, stop, audit as auditLog, processRunning } from './harness.mjs';
const audit = (handle = h) => auditLog(handle);

// Legacy-alias suite: the seven deprecated tools keep their original contract.
let h;
// Legacy tools report `error` as a plain string with optional code fields.
async function call(name, args, handle = h) {
  const result = await handle.client.callTool({ name, arguments: args });
  const value = JSON.parse(result.content[0].text);
  if (result.isError) throw Object.assign(new Error(typeof value.error === 'string' ? value.error : value.error.message), typeof value.error === 'string' ? value : value.error);
  return value;
}
async function finish(runId, handle = h) {
  for (let i = 0; i < 300; i++) {
    const state = await call('droid_status', { runId }, handle);
    if (state.terminal) return state;
    await sleep(30);
  }
  throw new Error('Run did not terminate');
}
const start = (key, prompt, extra = {}) => call('droid_start', { requestKey: key, prompt, workspace: join(h.dir, 'workspace'), ...extra });
test('Puck MCP lifecycle, protocol, persistence and security E2E', async (t) => {
  h = await boot();
  t.after(async () => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); });

  await t.test('seven legacy tools remain discoverable beside the session tools; async/idempotent start and configured read-only defaults', async () => {
    const names = (await h.client.listTools()).tools.map((x) => x.name);
    for (const name of ['droid_cancel', 'droid_continue', 'droid_list', 'droid_models', 'droid_result', 'droid_start', 'droid_status']) assert.ok(names.includes(name), name);
    assert.equal(names.length, 17);
    const first = await start('start-one', 'slow');
    assert.equal(first.terminal, false);
    const duplicate = await start('start-one', 'slow');
    assert.equal(first.runId, duplicate.runId);
    await assert.rejects(start('start-one', 'different'), /requestKey.*different/i);
    const done = await finish(first.runId);
    assert.equal(done.state, 'succeeded');
    assert.notEqual(done.runId, done.droidSessionId);
    assert.match(done.droidSessionId, /^[0-9a-f-]{36}$/);
    const result = await call('droid_result', { runId: done.runId });
    assert.equal(result.text, 'answer:slow');
    assert.ok(result.stderrTail.includes('mock diagnostic'));
    assert.ok(!result.text.includes('mock diagnostic'));
    const init = audit().find((x) => x.method === 'droid.initialize_session');
    assert.equal(init.params.autonomyLevel, 'off');
    assert.equal(init.params.interactionMode, 'spec');
    assert.equal(init.params.reasoningEffort, 'high');
    h.first = done;
  });

  await t.test('discovery exposes host launch policy and status preserves explicit reasoning', async () => {
    const tools = (await h.client.listTools()).tools;
    for (const name of ['droid_start', 'droid_continue']) {
      const description = tools.find((tool) => tool.name === name).description;
      assert.ok(description.includes(join(h.dir, 'workspace')));
      assert.ok(description.includes('Autonomy ceiling: high'));
      assert.ok(description.includes('Host reasoning effort: high'));
    }
    assert.equal((await call('droid_status', { runId: h.first.runId })).reasoningEffort, 'high');
  });

  await t.test('per-turn reasoning overrides host defaults on start and resume', async () => {
    const first = await start('reasoning-start', 'reasoning', { reasoningEffort: 'low', model: 'model-a' });
    await finish(first.runId);
    assert.equal(first.reasoningEffort, 'low');
    assert.equal(audit().filter((x) => x.method === 'droid.initialize_session').at(-1).params.reasoningEffort, 'low');
    await assert.rejects(start('reasoning-start', 'reasoning', { reasoningEffort: 'high', model: 'model-a' }), /different/i);
    const resumed = await call('droid_continue', { runId: first.runId, requestKey: 'reasoning-resume', prompt: 'next', reasoningEffort: 'medium', model: 'model-b' });
    await finish(resumed.runId);
    assert.equal(resumed.reasoningEffort, 'medium');
    const settings = audit().filter((x) => x.method === 'droid.update_session_settings').at(-1).params;
    assert.equal(settings.reasoningEffort, 'medium');
    assert.equal(settings.modelId, 'model-b');
    assert.equal(settings.autonomyLevel, 'off');
  });

  await t.test('configured high default approves only offered single-use permissions; off overrides it', async () => {
    const separate = await boot({ defaultAutonomy: 'high' });
    try {
      const args = { requestKey: 'high-default', prompt: 'permission-once', workspace: join(separate.dir, 'workspace') };
      const first = await call('droid_start', args, separate);
      assert.equal((await finish(first.runId, separate)).state, 'succeeded');
      assert.equal(first.autonomy, 'high');
      const wire = audit(separate);
      assert.equal(wire.find((x) => x.method === 'droid.initialize_session').params.interactionMode, 'auto');
      assert.equal(wire.find((x) => x.id === 'permission-1' && x.type === 'response').result.selectedOption, 'proceed_once');
      for (const autonomy of ['off', 'medium']) {
        const run = await call('droid_start', { ...args, requestKey: `override-${autonomy}`, autonomy }, separate);
        assert.equal((await finish(run.runId, separate)).state, 'interrupted');
      }
      const tools = (await separate.client.listTools()).tools;
      assert.ok(tools.find((x) => x.name === 'droid_start').description.includes('Default autonomy: high'));
    } finally { await stop(separate); rmSync(separate.dir, { recursive: true, force: true }); }
  });

  await t.test('tool-only assistant messages preserve events without corrupting progress text', async () => {
    const done = await finish((await start('textless', 'textless-assistant')).runId);
    assert.equal(done.state, 'succeeded');
    assert.ok(done.events.some((event) => event.type === 'assistant' && !Object.hasOwn(event, 'text')));
    assert.ok(done.events.some((event) => event.type === 'tool_call' && event.tool === 'LS'));
    assert.equal(done.textTail, 'progress:textless-assistant\nanswer:textless-assistant\n');
    assert.equal((await call('droid_result', { runId: done.runId })).text, 'answer:textless-assistant');
  });

  await t.test('serial continuation retains UUID; model/autonomy use settings RPC; per-turn result paging', async () => {
    const next = await call('droid_continue', { runId: h.first.runId, requestKey: 'continue-one', prompt: 'follow-up', autonomy: 'low', model: 'chosen-model' });
    assert.notEqual(next.runId, h.first.runId);
    assert.equal(next.droidSessionId, h.first.droidSessionId);
    await assert.rejects(call('droid_continue', { runId: h.first.runId, requestKey: 'overlap', prompt: 'conflict' }), /active|busy/i);
    assert.equal((await call('droid_continue', { runId: h.first.runId, requestKey: 'continue-one', prompt: 'follow-up', autonomy: 'low', model: 'chosen-model' })).runId, next.runId);
    const done = await finish(next.runId);
    assert.equal(done.state, 'succeeded');
    const wire = audit();
    assert.equal(wire.filter((x) => x.method === 'droid.load_session').at(-1).params.sessionId, h.first.droidSessionId);
    const settings = wire.filter((x) => x.method === 'droid.update_session_settings').at(-1);
    assert.equal(settings.params.autonomyLevel, 'low');
    assert.equal(settings.params.interactionMode, 'auto');
    assert.equal(settings.params.modelId, 'chosen-model');
    assert.equal(settings.params.reasoningEffort, 'high');
    const page = await call('droid_result', { runId: next.runId, offset: 3, limit: 11 });
    assert.equal(page.text, 'wer:follow-');
    assert.equal(page.nextOffset, 14);
    h.next = done;
  });

  await t.test('permission and AskUser fail closed with retrievable context', async () => {
    for (const prompt of ['permission', 'ask']) {
      const run = await start(prompt, prompt, { autonomy: 'high' });
      const done = await finish(run.runId);
      assert.equal(done.state, 'interrupted');
      assert.ok(done.events.some((x) => x.type === (prompt === 'ask' ? 'ask_user_declined' : 'permission_declined')));
    }
    assert.equal(audit().find((x) => x.id === 'permission-1' && x.type === 'response').result.selectedOption, 'cancel');
  });

  await t.test('cancel targets active work and does not rewrite completed results', async () => {
    const run = await start('cancel', 'slow');
    const other = await start('independent', 'slow');
    for (let i = 0; i < 100; i++) {
      if ((await call('droid_status', { runId: run.runId })).events.some((e) => e.type === 'assistant')) break;
      await sleep(20);
    }
    await call('droid_cancel', { runId: run.runId });
    assert.equal((await finish(run.runId)).state, 'interrupted');
    assert.equal((await call('droid_cancel', { runId: h.first.runId })).state, 'succeeded');
    const steered = await call('droid_continue', { runId: run.runId, requestKey: 'steer', prompt: 'new-direction' });
    assert.equal((await finish(steered.runId)).state, 'succeeded');
    assert.equal((await finish(other.runId)).state, 'succeeded');
  });

  await t.test('terminal agent errors and unexpected process exit are not successes', async () => {
    for (const prompt of ['agent-error', 'crash']) {
      assert.equal((await finish((await start(prompt, prompt)).runId)).state, 'failed');
    }
  });

  await t.test('workspace prefix siblings, traversal and symlink escapes fail closed', async () => {
    symlinkSync(join(h.dir, 'workspace-sibling'), join(h.dir, 'workspace/escape'));
    for (const workspace of [join(h.dir, 'workspace-sibling'), join(h.dir, 'workspace/../workspace-sibling'), join(h.dir, 'workspace/escape')]) {
      await assert.rejects(call('droid_start', { requestKey: workspace, prompt: 'no', workspace }), /approved/i);
    }
  });

  await t.test('HTTP requires bearer authentication and checks Host, Origin, body bounds and route', async () => {
    assert.equal((await fetch(h.url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(h.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(h.url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
    // Fetch may rewrite Host. Use the native HTTP client to exercise the header.
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(h.url, { method: 'POST', headers: { ...headers, Host: 'evil.test' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(h.url, { method: 'POST', headers, body: 'x'.repeat(1048577) })).status, 413);
    assert.equal((await fetch(h.url.replace('/mcp', '/other'), { headers })).status, 404);
  });

  await t.test('state survives restart: result/UUID/deduplication; single-owner lock', async () => {
    const second = spawn(process.execPath, ['src/server.mjs', '--config', h.configPath], { cwd: root, env: h.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = ''; second.stderr.on('data', (b) => { log += b; });
    assert.notEqual((await once(second, 'exit'))[0], 0);
    assert.match(log, /already.*running|locked/i);
    const old = h;
    await stop(old);
    h = await boot({ defaultAutonomy: 'high', reasoningEffort: 'low' }, {}, old.dir);
    h.first = old.first; h.next = old.next;
    assert.equal((await start('start-one', 'slow')).runId, h.first.runId);
    assert.equal((await start('start-one', 'slow')).autonomy, 'off');
    assert.equal((await start('start-one', 'slow')).reasoningEffort, 'high');
    await assert.rejects(start('start-one', 'slow', { reasoningEffort: 'low' }), /different/i);
    assert.equal((await call('droid_result', { runId: h.next.runId })).text, 'answer:follow-up');
    assert.equal((await call('droid_status', { runId: h.next.runId })).reasoningEffort, 'high');
    assert.equal(statSync(join(h.dir, 'state/state.json')).mode & 0o777, 0o600);
    const again = await call('droid_continue', { runId: h.next.runId, requestKey: 'after-restart', prompt: 'remember' });
    assert.equal((await finish(again.runId)).droidSessionId, h.first.droidSessionId);
    const reset = audit().filter((x) => x.method === 'droid.update_session_settings').at(-1);
    assert.equal(reset.params.autonomyLevel, 'high');
    assert.equal(reset.params.interactionMode, 'auto');
    assert.equal(reset.params.reasoningEffort, 'low');
    assert.ok((await call('droid_list', {})).runs.length >= 8);
  });

  await t.test('controller crash records unknown, never replays, and orphan worker exits', async () => {
    const run = await start('crash-controller', 'slow');
    let status;
    for (let i = 0; i < 100; i++) {
      status = await call('droid_status', { runId: run.runId });
      if (status.events.some((e) => e.type === 'assistant')) break;
      await sleep(20);
    }
    const last = audit().filter((x) => x.method === 'droid.add_user_message').at(-1);
    const before = audit().filter((x) => x.method === 'droid.add_user_message').length;
    const old = h; await stop(old, 'SIGKILL'); await sleep(300);
    assert.equal(processRunning(last.mockPid), false, 'Droid child must stop on controller death');
    assert.equal(processRunning(last.workerPid), false, 'Worker must stop on controller death');
    h = await boot({}, {}, old.dir); h.first = old.first; h.next = old.next;
    const recovered = await call('droid_status', { runId: run.runId });
    assert.equal(recovered.state, 'unknown');
    assert.equal(recovered.droidSessionId, status.droidSessionId);
    assert.equal((await start('crash-controller', 'slow')).runId, run.runId);
    assert.equal(audit().filter((x) => x.method === 'droid.add_user_message').length, before);
    await assert.rejects(call('droid_continue', { runId: run.runId, requestKey: 'unsafe-replay', prompt: 'again' }), /unknown|reconcile/i);
  });

  await t.test('terminal result survives controller crash during slow SDK cleanup', async () => {
    let separate = await boot({ cancelGraceMs: 3000 }, { MOCK_SLOW_CLOSE: '1' });
    try {
      const run = await call('droid_start', { requestKey: 'terminal-before-cleanup', prompt: 'done', autonomy: 'high', workspace: join(separate.dir, 'workspace') }, separate);
      let result;
      for (let i = 0; i < 100; i++) {
        result = await call('droid_result', { runId: run.runId }, separate);
        if (result.resultAvailable) break;
        await sleep(20);
      }
      assert.equal(result.resultAvailable, true);
      assert.equal(result.terminal, false, 'Serial slot is held until process cleanup');
      // Conflicting work no longer fails: it queues behind the lock until cleanup finishes.
      assert.equal((await call('droid_start', { requestKey: 'cleanup-lock', prompt: 'queued-behind-cleanup', workspace: join(separate.dir, 'workspace') }, separate)).state, 'queued');
      await stop(separate, 'SIGKILL'); await sleep(200);
      separate = await boot({ cancelGraceMs: 3000 }, {}, separate.dir);
      const recovered = await call('droid_result', { runId: run.runId }, separate);
      assert.equal(recovered.state, 'succeeded');
      assert.equal(recovered.text, 'answer:done');
    } finally { await stop(separate); rmSync(separate.dir, { recursive: true, force: true }); }
  });

  await t.test('silence, malformed output and unrelated completion time out, not succeed', async () => {
    const separate = await boot({ runTimeoutMs: 1000 });
    try {
      for (const prompt of ['silent', 'malformed', 'wrong-turn']) {
        const run = await call('droid_start', { requestKey: prompt, prompt, workspace: join(separate.dir, 'workspace') }, separate);
        assert.equal((await finish(run.runId, separate)).state, 'timed_out');
      }
    } finally { await stop(separate); rmSync(separate.dir, { recursive: true, force: true }); }
  });

  await t.test('autonomy ceiling, changed resumed cwd and setup cancellation', async () => {
    const separate = await boot({ maxAutonomy: 'off' }, { MOCK_RESUME_CWD: h.dir });
    try {
      await assert.rejects(call('droid_start', { requestKey: 'high', prompt: 'no', workspace: join(separate.dir, 'workspace'), autonomy: 'high' }, separate), /autonomy/i);
      const run = await call('droid_start', { requestKey: 'normal', prompt: 'normal', workspace: join(separate.dir, 'workspace') }, separate);
      await finish(run.runId, separate);
      const resumed = await call('droid_continue', { runId: run.runId, requestKey: 'moved', prompt: 'no' }, separate);
      assert.equal((await finish(resumed.runId, separate)).state, 'failed');
      assert.equal(audit(separate).filter((x) => x.method === 'droid.add_user_message').length, 1);
    } finally { await stop(separate); rmSync(separate.dir, { recursive: true, force: true }); }
    const slow = await boot({}, { MOCK_SLOW_INIT: '1' });
    try {
      const run = await call('droid_start', { requestKey: 'init', prompt: 'no', workspace: join(slow.dir, 'workspace') }, slow);
      await call('droid_cancel', { runId: run.runId }, slow);
      assert.equal((await finish(run.runId, slow)).state, 'cancelled');
    } finally { await stop(slow); rmSync(slow.dir, { recursive: true, force: true }); }
  });

  await t.test('STDIO MCP smoke and fail-closed corrupt state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'droid-mcp-stdio-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ approvedDirectories: [dir], stateDirectory: join(dir, 'state'), droidPath: join(root, 'test/mock-droid.mjs') }));
    const client = new Client({ name: 'puck-stdio', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/server.mjs'), '--config', path], stderr: 'pipe' }));
      assert.equal((await client.listTools()).tools.length, 17);
      await client.close();
      await sleep(100);
      writeFileSync(join(dir, 'catalog.json'), JSON.stringify([{ id: 'mock-selected', displayName: 'Selected Mock' }]));
      const smoke = spawn(process.execPath, [join(root, 'scripts/smoke.mjs'), '--config', path, '--model', 'mock-selected', '--out', join(dir, 'acceptance.json')], { env: { ...process.env, MOCK_DROID_HOME: dir, MOCK_AUDIT: join(dir, 'audit.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let smokeLog = ''; smoke.stdout.on('data', (b) => { smokeLog += b; }); smoke.stderr.on('data', (b) => { smokeLog += b; });
      assert.equal((await once(smoke, 'exit'))[0], 0, smokeLog);
      const evidence = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
      assert.equal(evidence.passed, true);
      assert.equal(evidence.runs.length, 2);
      assert.ok(evidence.runs.every((r) => r.markerMatched && r.state === 'succeeded' && r.historyAvailable));
      assert.equal(evidence.runs[0].session, evidence.runs[1].session);
      assert.equal(evidence.catalog.selectedModelAvailable, true);
      assert.equal(evidence.model, 'mock-selected');
      const wire = audit({ dir });
      const settings = wire.filter((x) => (x.method === 'droid.initialize_session' || x.method === 'droid.update_session_settings') && x.params.modelId);
      assert.equal(settings.length, 2);
      assert.ok(settings.every((x) => x.params.modelId === 'mock-selected' && x.params.autonomyLevel === 'off'));
      if (process.env.DROID_E2E_ARTIFACT) writeFileSync(process.env.DROID_E2E_ARTIFACT, `${JSON.stringify({ source: 'mock-protocol-e2e-not-live-acceptance', ...evidence }, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(join(dir, 'state/state.json'), '{broken');
      const proc = spawn(process.execPath, [join(root, 'src/server.mjs'), '--config', path], { stdio: ['ignore', 'ignore', 'pipe'] });
      let log = ''; proc.stderr.on('data', (b) => { log += b; });
      assert.notEqual((await once(proc, 'exit'))[0], 0);
      assert.match(log, /JSON|state|corrupt/i);
      // HTTP must fail before listening when no bearer credential is configured.
      writeFileSync(path, JSON.stringify({ approvedDirectories: [dir], stateDirectory: join(dir, 'http-state'), droidPath: join(root, 'test/mock-droid.mjs'), transport: 'http' }));
      const unauthenticated = spawn(process.execPath, [join(root, 'src/server.mjs'), '--config', path], { stdio: ['ignore', 'ignore', 'pipe'] });
      let authLog = ''; unauthenticated.stderr.on('data', (b) => { authLog += b; });
      assert.notEqual((await once(unauthenticated, 'exit'))[0], 0);
      assert.match(authLog, /HTTP requires tokenFile/);
      assert.ok(!authLog.includes('Listening'));
    } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

test('revision: authoritative heads, prompt-free migration and canonical workspace locks', async (t) => {
  let handle = await boot();
  t.after(async () => { await stop(handle); rmSync(handle.dir, { recursive: true, force: true }); });
  const submit = (key, prompt, extra = {}) => call('droid_start', { requestKey: key, prompt, workspace: join(handle.dir, 'workspace'), ...extra }, handle);
  const resume = (id, key, prompt = 'next') => call('droid_continue', { runId: id, requestKey: key, prompt }, handle);
  const statePath = () => join(handle.dir, 'state/state.json');
  const state = () => JSON.parse(readFileSync(statePath(), 'utf8'));
  const stale = (head) => (error) => error.code === 'not_session_head' && error.headRunId === head;
  let a, b;

  const headOf = (runId) => { const st = state(); return st.sessions[st.runs[runId].sessionId].headRunId; };
  await t.test('ancestor rejection, simultaneous continuation, failed head, and replay', async () => {
    a = await finish((await submit('linear-a', 'normal')).runId, handle);
    const attempts = await Promise.allSettled([resume(a.runId, 'linear-b', 'agent-error'), resume(a.runId, 'linear-race', 'agent-error')]);
    assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
    b = await finish(attempts.find((x) => x.status === 'fulfilled').value.runId, handle);
    assert.equal(b.state, 'failed');
    assert.equal(state().version, 3);
    assert.equal(headOf(a.runId), b.runId);
    await assert.rejects(resume(a.runId, 'stale-failed'), stale(b.runId));
    assert.equal((await resume(a.runId, b.requestKey, 'agent-error')).runId, b.runId, 'Accepted intent replay precedes stale-head rejection');
    const old = handle; await stop(old); handle = await boot({}, {}, old.dir);
    await assert.rejects(resume(a.runId, 'stale-restart'), stale(b.runId));
    const c = await finish((await resume(b.runId, 'linear-c')).runId, handle);
    assert.equal(c.droidSessionId, a.droidSessionId);
    b = c;
  });

  await t.test('accepted/completed original prompts absent, echoes permitted, fingerprint survives restart', async () => {
    const secret = 'VERY_SECRET_PROMPT_12345';
    const first = await submit('secret', `no-echo:${secret}`);
    assert.ok(!readFileSync(statePath(), 'utf8').includes(secret));
    await finish(first.runId, handle);
    assert.ok(!readFileSync(statePath(), 'utf8').includes(secret));
    assert.ok(!readFileSync(join(handle.dir, 'state', `${first.runId}.result.json`), 'utf8').includes(secret), 'SDK user-message copy is original input, not an independent assistant echo');
    const old = handle; await stop(old); handle = await boot({ defaultAutonomy: 'high', reasoningEffort: 'low' }, {}, old.dir);
    assert.equal((await submit('secret', `no-echo:${secret}`)).runId, first.runId);
    await assert.rejects(submit('secret', 'no-echo:changed'), /different/i);
    const echo = await finish((await submit('echo', 'ASSISTANT_ECHO_MARKER')).runId, handle);
    assert.ok(readFileSync(statePath(), 'utf8').includes('ASSISTANT_ECHO_MARKER'));
    assert.equal(Object.hasOwn(state().runs[echo.runId], 'prompt'), false);
    const previous = handle; await stop(previous); handle = await boot({}, {}, previous.dir);
  });

  await t.test('v1 migration uses acceptance time, removes prompts and preserves results/IDs/unknowns', async () => {
    const old = handle; await stop(old);
    const legacy = state();
    // Rebuild the v1 shape from the v3 state: no sessions, per-run prompts, no heads.
    const sessionOf = Object.fromEntries(Object.values(legacy.runs).map((r) => [r.runId, r.sessionId]));
    legacy.version = 1; delete legacy.sessions; delete legacy.nextSeq;
    // Reverse insertion order and erase parent metadata: migration must use timestamps.
    legacy.runs = Object.fromEntries(Object.entries(legacy.runs).reverse());
    for (const run of Object.values(legacy.runs)) { run.prompt = 'PRIVATE_V1_ORIGINAL_PROMPT'; delete run.sessionId; delete run.replyTo; delete run.disposition; delete run.preview; }
    legacy.runs[b.runId].parentRunId = null;
    legacy.runs[b.runId].createdAt = '2026-10-04T15:00:00.000Z';
    legacy.runs[a.runId].createdAt = '2026-10-04T14:00:00.000Z';
    // Make the other older member unambiguously older as well.
    for (const run of Object.values(legacy.runs)) if (run.droidSessionId === a.droidSessionId && run.runId !== b.runId) run.createdAt = '2026-10-04T14:00:00.000Z';
    const unknownId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    legacy.runs[unknownId] = { ...legacy.runs[a.runId], runId: unknownId, requestKey: 'legacy-unknown', droidSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'unknown', result: false };
    const unknownDescendant = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    legacy.runs[unknownDescendant] = { ...legacy.runs[unknownId], runId: unknownDescendant, requestKey: 'unknown-descendant', state: 'succeeded', createdAt: '2026-10-04T15:00:00.000Z' };
    const bytes = JSON.stringify(legacy);
    writeFileSync(statePath(), bytes);
    const beforeTurns = audit(old).filter((x) => x.method === 'droid.add_user_message').length;
    handle = await boot({}, {}, old.dir);
    const migrated = state();
    assert.equal(migrated.version, 3);
    assert.equal(readFileSync(`${statePath()}.v1.bak`, 'utf8'), bytes, 'the v1 file is retained byte-identically');
    assert.equal(headOf(a.runId), b.runId);
    assert.equal(headOf(unknownId), unknownDescendant);
    assert.deepEqual(Object.keys(migrated.runs), Object.keys(legacy.runs));
    assert.ok(!readFileSync(statePath(), 'utf8').includes('PRIVATE_V1_ORIGINAL_PROMPT'));
    assert.equal((await call('droid_result', { runId: a.runId }, handle)).text, 'answer:normal');
    assert.equal((await submit('linear-a', 'normal')).runId, a.runId);
    await assert.rejects(resume(a.runId, 'stale-migration'), stale(b.runId));
    await assert.rejects(resume(unknownId, 'unknown-migration'), /unknown/i);
    await assert.rejects(resume(unknownDescendant, 'unknown-family-head'), /unknown/i);
    assert.equal(audit(handle).filter((x) => x.method === 'droid.add_user_message').length, beforeTurns);
    b = await finish((await resume(b.runId, 'migrated-head')).runId, handle);
  });

  await t.test('v3 head is authoritative; corrupt/missing/wrong-session heads and malformed v1 reject without rewriting', async () => {
    const old = handle; await stop(old);
    const saved = state();
    const sessionId = saved.runs[a.runId].sessionId;
    saved.sessions[sessionId].headRunId = a.runId;
    writeFileSync(statePath(), JSON.stringify(saved));
    handle = await boot({}, {}, old.dir);
    await assert.rejects(resume(b.runId, 'not-inferred'), stale(a.runId));
    await stop(handle);
    const other = (s) => Object.values(s.runs).find((r) => r.sessionId !== sessionId).runId;
    for (const mutate of [
      (s) => { delete s.sessions[sessionId].headRunId; },
      (s) => { s.sessions[sessionId].headRunId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; },
      (s) => { s.sessions[sessionId].headRunId = other(s); },
      (s) => { s.runs[a.runId].sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; },
      (s) => { s.version = 1; delete s.sessions; delete s.nextSeq; for (const r of Object.values(s.runs)) { r.prompt = 'old'; delete r.sessionId; } s.runs[a.runId].createdAt = 'not-a-date'; },
    ]) {
      const corrupt = structuredClone(saved); mutate(corrupt);
      const bytes = JSON.stringify(corrupt); writeFileSync(statePath(), bytes);
      await assert.rejects(boot({}, {}, handle.dir), /state|head|createdAt|date|session/i);
      assert.equal(readFileSync(statePath(), 'utf8'), bytes);
    }
    writeFileSync(statePath(), JSON.stringify(saved));
    handle = await boot({}, {}, handle.dir);
  });

  await t.test('conflicting work queues instead of failing: readers share, writers exclude in both orders, nested/symlink/siblings', async () => {
    const api = join(handle.dir, 'workspace/packages/api');
    const web = join(handle.dir, 'workspace/packages/web');
    mkdirSync(api, { recursive: true }); mkdirSync(web, { recursive: true });
    symlinkSync(api, join(handle.dir, 'workspace/api-link'));
    const readers = await Promise.all([submit('reader-a', 'slow'), submit('reader-b', 'slow', { workspace: api })]);
    assert.ok(readers.every((r) => r.state !== 'queued'), 'readers overlap');
    const blocked = await submit('reader-blocks-writer', 'normal', { autonomy: 'medium', workspace: api });
    assert.equal(blocked.state, 'queued');
    for (const r of readers) { await call('droid_cancel', { runId: r.runId }, handle); await finish(r.runId, handle); }
    assert.equal((await finish(blocked.runId, handle)).state, 'succeeded', 'the queued writer runs once the readers are gone');
    for (const autonomy of ['low', 'medium', 'high']) {
      const writer = await submit(`writer-${autonomy}`, 'slow', { autonomy, workspace: api });
      for (const [suffix, workspace, next] of [
        ['same-reader', api, 'off'], ['same-writer', api, 'high'],
        ['parent', join(handle.dir, 'workspace'), 'off'], ['symlink', join(handle.dir, 'workspace/api-link'), 'off'],
      ]) {
        const waiting = await submit(`${autonomy}-${suffix}`, 'normal', { autonomy: next, workspace });
        assert.equal(waiting.state, 'queued', `${autonomy} writer blocks ${suffix}`);
        await call('droid_cancel', { runId: waiting.runId }, handle);
        assert.equal((await call('droid_status', { runId: waiting.runId }, handle)).state, 'cancelled', 'a queued turn cancels without ever starting');
      }
      const sibling = await submit(`${autonomy}-sibling`, 'normal', { autonomy: 'high', workspace: web });
      assert.equal((await finish(sibling.runId, handle)).state, 'succeeded');
      await call('droid_cancel', { runId: writer.runId }, handle); await finish(writer.runId, handle);
    }
    const parent = await submit('parent-writer', 'slow', { autonomy: 'medium' });
    assert.equal((await submit('nested-reader', 'normal', { workspace: api })).state, 'queued');
    await call('droid_cancel', { runId: parent.runId }, handle); await finish(parent.runId, handle);
    const released = await submit('released', 'normal', { autonomy: 'medium', workspace: api });
    assert.equal((await finish(released.runId, handle)).state, 'succeeded');
  });

  await t.test('global capacity queues shared readers and disjoint writers instead of rejecting', async () => {
    const separate = await boot({ maxConcurrentRuns: 1 });
    try {
      const api = join(separate.dir, 'workspace/api'), web = join(separate.dir, 'workspace/web');
      mkdirSync(api); mkdirSync(web);
      for (const autonomy of ['off', 'high']) {
        const args = { requestKey: `one-slot-${autonomy}`, prompt: 'slow', autonomy, workspace: api };
        const run = await call('droid_start', args, separate);
        const waiting = await call('droid_start', { ...args, requestKey: `two-slots-${autonomy}`, prompt: 'normal', workspace: autonomy === 'off' ? api : web }, separate);
        assert.equal(waiting.state, 'queued');
        await call('droid_cancel', { runId: run.runId }, separate); await finish(run.runId, separate);
        assert.equal((await finish(waiting.runId, separate)).state, 'succeeded', 'the queued turn starts when the slot frees');
      }
    } finally { await stop(separate); rmSync(separate.dir, { recursive: true, force: true }); }
  });
});

test('revision: live catalog protocol, replacement cache, cleanup and HTTP error classification', async (t) => {
  let handle = await boot({ modelCacheTtlMs: 5000 });
  t.after(async () => { await stop(handle); rmSync(handle.dir, { recursive: true, force: true }); });
  const catalogPath = join(handle.dir, 'mock/catalog.json');
  const catalogs = [
    { id: 'z-current', displayName: 'Alpha', modelProvider: 'anthropic', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', noImageSupport: true },
    { id: 'a-current', displayName: 'Alpha' },
    { id: 'b-current', displayName: 'Beta', supportsImages: true, supportsPdfs: false },
    { id: 'disabled-model', displayName: 'Disabled', disabled: true, disabledReason: 'Unavailable' },
  ];
  const writeCatalog = (value) => writeFileSync(catalogPath, JSON.stringify(value));

  await t.test('seventh read-only tool; single-flight live initialization; disabled filtering, stable sorting, no guessed metadata', async () => {
    const tool = (await handle.client.listTools()).tools.find((x) => x.name === 'droid_models');
    assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.annotations.openWorldHint, false);
    for (const name of ['droid_start', 'droid_continue']) assert.match((await handle.client.listTools()).tools.find((x) => x.name === name).description, /droid_models/);
    writeCatalog(catalogs);
    const first = await Promise.all([call('droid_models', {}, handle), call('droid_models', {}, handle)]);
    assert.deepEqual(first[0].models.map((m) => m.id), ['a-current', 'z-current', 'b-current']);
    assert.deepEqual(first[0].models[0], { id: 'a-current', displayName: 'Alpha' });
    assert.equal(first[0].models[1].provider, 'anthropic');
    assert.equal(first[0].models[1].supportsImages, false);
    assert.deepEqual(first[0].models[1].supportedReasoningEfforts, ['low', 'high']);
    assert.equal(first[0].models[2].supportsPdfs, false);
    assert.ok(Number.isFinite(Date.parse(first[0].fetchedAt)));
    assert.deepEqual((await call('droid_models', {}, handle)).models, first[0].models);
    const wire = audit(handle);
    assert.equal(wire.filter((x) => x.method === 'droid.initialize_session').length, 1);
    assert.equal(wire.filter((x) => x.method === 'droid.close_session').length, 1);
    assert.ok(!wire.some((x) => x.method === 'droid.add_user_message' || x.type === 'response'));
    assert.equal(wire[0].params.autonomyLevel, 'off');
    assert.equal(wire[0].params.interactionMode, 'spec');
    assert.equal(wire[0].params.machineId, 'default', 'Match the required SDK initialization contract');
    assert.equal(processRunning(wire[0].mockPid), false);
  });

  await t.test('TTL refresh replaces catalog; historical runs never merge; failed refresh refuses expired data', async () => {
    const run = await call('droid_start', { requestKey: 'historical', prompt: 'normal', model: 'old-legacy-model', workspace: join(handle.dir, 'workspace') }, handle);
    await finish(run.runId, handle);
    writeCatalog([{ id: 'new-current', displayName: 'New' }]);
    assert.ok(!(await call('droid_models', {}, handle)).models.some((m) => m.id === 'old-legacy-model'));
    await sleep(5100);
    const refreshed = await call('droid_models', {}, handle);
    assert.deepEqual(refreshed.models, [{ id: 'new-current', displayName: 'New' }]);
    assert.equal(audit(handle).filter((x) => x.method === 'droid.initialize_session' && x.params.disableBuiltinSkills).length, 3, 'One start and two discovery initializations');
    writeCatalog({ error: 'Catalog unavailable' }); await sleep(5100);
    await assert.rejects(call('droid_models', {}, handle), (error) => error.code === 'model_discovery_failed' && error.message === 'Unable to retrieve the current Factory model catalog');
    writeCatalog([]);
    assert.deepEqual((await call('droid_models', {}, handle)).models, []);
  });

  await t.test('snake-case catalog and discovery denial/timeout clean up without authorizing or submitting a turn', async () => {
    const old = handle; await stop(old);
    handle = await boot({ modelCacheTtlMs: 5000 }, { MOCK_CATALOG_SNAKE: '1' }, old.dir);
    writeCatalog([{ id: 'snake-current', displayName: 'Snake' }]);
    assert.deepEqual((await call('droid_models', {}, handle)).models, [{ id: 'snake-current', displayName: 'Snake' }]);
    for (const mode of ['permission', 'hang', 'missing']) {
      let separate = await boot({ runTimeoutMs: 1000, cancelGraceMs: 100 });
      try {
        writeFileSync(join(separate.dir, 'mock/catalog.json'), JSON.stringify({ mode }));
        await assert.rejects(call('droid_models', {}, separate), (error) => error.code === 'model_discovery_failed');
        const wire = audit(separate);
        assert.ok(!wire.some((x) => x.method === 'droid.add_user_message'));
        if (mode === 'permission') assert.equal(wire.find((x) => x.id === 'catalog-permission').result.selectedOption, 'cancel');
        assert.equal(processRunning(wire[0].mockPid), false);
      } finally { await stop(separate); rmSync(separate.dir, { recursive: true, force: true }); }
    }
  });

  await t.test('HTTP malformed input is 400, tool rejections remain MCP errors, unexpected setup/dispatch are generic 500', async () => {
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Accept: 'application/json, text/event-stream' };
    for (const body of ['{broken', '{}', 'null', '[]']) assert.equal((await fetch(handle.url, { method: 'POST', headers, body })).status, 400);
    assert.equal((await fetch(handle.url, { method: 'GET', headers })).status, 405);
    await assert.rejects(call('droid_status', { runId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, handle), /Unknown controller/);
    for (const fault of ['connect', 'dispatch']) {
      const separate = await boot({}, { MOCK_HTTP_FAULT: fault, NODE_OPTIONS: `--import=${join(root, 'test/http-fault.mjs')}` });
      try {
        const response = await fetch(separate.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
        assert.equal(response.status, 500, fault);
        assert.equal(await response.text(), 'Internal MCP server error');
        assert.match(separate.diagnostics(), /PRIVATE_INTERNAL_PATH/);
      } finally { await stop(separate); rmSync(separate.dir, { recursive: true, force: true }); }
    }
  });

  await t.test('catalog TTL bounds are validated before listening', async () => {
    for (const modelCacheTtlMs of [4999, 600001]) await assert.rejects(boot({ modelCacheTtlMs }, {}, handle.dir), /modelCacheTtlMs/);
  });
});

test('owner-authorized high fallback is Auto/high with single-use approval; explicit off and independent reasoning survive', async () => {
  const handle = await boot({ defaultAutonomy: undefined, maxAutonomy: undefined, reasoningEffort: 'low' });
  try {
    const args = { requestKey: 'schema-high', prompt: 'permission-once', workspace: join(handle.dir, 'workspace') };
    const first = await call('droid_start', args, handle);
    assert.equal(first.autonomy, 'high');
    assert.equal(first.reasoningEffort, 'low');
    assert.equal((await finish(first.runId, handle)).state, 'succeeded');
    const init = audit(handle).find((x) => x.method === 'droid.initialize_session');
    assert.equal(init.params.interactionMode, 'auto');
    assert.equal(init.params.autonomyLevel, 'high');
    assert.equal(audit(handle).find((x) => x.id === 'permission-1').result.selectedOption, 'proceed_once');
    const next = await call('droid_continue', { runId: first.runId, requestKey: 'schema-off', prompt: 'permission-once', autonomy: 'off', reasoningEffort: 'medium' }, handle);
    assert.equal((await finish(next.runId, handle)).state, 'interrupted');
    const settings = audit(handle).find((x) => x.method === 'droid.update_session_settings').params;
    assert.equal(settings.autonomyLevel, 'off'); assert.equal(settings.interactionMode, 'spec');
    assert.equal(settings.reasoningEffort, 'medium');
    const asked = await call('droid_continue', { runId: next.runId, requestKey: 'schema-ask', prompt: 'ask' }, handle);
    const interrupted = await finish(asked.runId, handle);
    assert.equal(interrupted.state, 'interrupted');
    assert.ok(interrupted.events.some((e) => e.type === 'ask_user_declined' && e.details.includes('Deploy?')));
    assert.ok((await handle.client.listTools()).tools.find((x) => x.name === 'droid_start').description.includes('Default autonomy: high'));
  } finally { await stop(handle); rmSync(handle.dir, { recursive: true, force: true }); }
});

test('legacy aliases: explicit recipient, generic Amp MCP attachment and admin filtering survive create/resume', async () => {
  const conversationId = 'T-11111111-1111-4111-8111-111111111111';
  const other = 'T-22222222-2222-4222-8222-222222222222';
  const url = 'https://ampcode.com/mcp?profile=external-agent';
  const handle = await boot({ ampMcp: { url } });
  try {
    const args = { requestKey: 'puck-start', prompt: 'no-echo:report required', workspace: join(handle.dir, 'workspace'), model: 'mock-model', puckConversationId: conversationId };
    const first = await call('droid_start', args, handle);
    assert.equal((await finish(first.runId, handle)).state, 'succeeded');
    assert.equal(first.puckConversationId, conversationId);
    assert.equal((await call('droid_start', args, handle)).runId, first.runId);
    await assert.rejects(call('droid_start', { ...args, puckConversationId: other }, handle), /different arguments/);
    const next = await call('droid_continue', { runId: first.runId, requestKey: 'puck-next', prompt: 'no-echo:ask Puck', model: 'mock-model', autonomy: 'off' }, handle);
    assert.equal((await finish(next.runId, handle)).state, 'succeeded');
    assert.equal(next.puckConversationId, conversationId, 'continuation keeps the session recipient');
    const wire = audit(handle);
    for (const method of ['droid.initialize_session', 'droid.load_session']) {
      const params = wire.find((r) => r.method === method).params;
      assert.deepEqual(params.mcpServers, [{ name: 'amp-puck', type: 'http', url, headers: [], oauth: { resource: 'https://ampcode.com/mcp' } }]);
      assert.deepEqual(params.disabledToolIds, ['amp-puck___manage_amp', 'amp-puck___find_thread', 'amp-puck___read_thread']);
    }
    const turns = wire.filter((r) => r.method === 'droid.add_user_message');
    for (const [index, run] of [first, next].entries()) {
      assert.ok(turns[index].params.text.includes(conversationId));
      assert.ok(turns[index].params.text.includes(run.runId));
      assert.match(turns[index].params.text, /amp-puck___puck/);
      assert.match(turns[index].params.text, /replyHandle/);
    }
    assert.ok(!readFileSync(join(handle.dir, 'state/state.json'), 'utf8').includes('report required'));
    // No recipient is ever inferred: an omitted puckConversationId is detached and never touches the endpoint.
    const detached = await call('droid_start', { requestKey: 'puck-detached', prompt: 'normal', workspace: join(handle.dir, 'workspace') }, handle);
    assert.equal(detached.puckConversationId, undefined);
    await finish(detached.runId, handle);
    assert.equal(audit(handle).filter((r) => r.method === 'droid.initialize_session').at(-1).params.mcpServers, undefined);
    if (process.env.DROID_E2E_ARTIFACT) writeFileSync(`${process.env.DROID_E2E_ARTIFACT}.puck.json`, JSON.stringify({ live: false, kind: 'mock-protocol', start: first.runId, continuation: next.runId, mcpAttachedOnCreateAndResume: true, adminToolDenied: true, recipientCorrelated: true }, null, 2));
  } finally { await stop(handle); rmSync(handle.dir, { recursive: true, force: true }); }
});

test('Amp MCP preflight cannot silently route without auth or leave the admin tool usable (legacy create)', async () => {
  for (const mode of ['unauthenticated', 'admin-allowed', 'puck-missing', 'archived']) {
    const handle = await boot({ ampMcp: {} }, { MOCK_PUCK_FAILURE: mode });
    try {
      const run = await call('droid_start', { requestKey: mode, prompt: 'no-echo:do not execute', workspace: join(handle.dir, 'workspace'), puckConversationId: 'T-11111111-1111-4111-8111-111111111111' }, handle);
      const done = await finish(run.runId, handle);
      assert.equal(done.state, 'failed');
      assert.ok(!/Unknown tool identifier/.test(done.error), 'the real cause, not the masked disabled-tool error');
      assert.ok(!audit(handle).some((r) => r.method === 'droid.add_user_message'));
    } finally { await stop(handle); rmSync(handle.dir, { recursive: true, force: true }); }
  }
  const handle = await boot();
  try {
    await assert.rejects(call('droid_start', { requestKey: 'no-puck', prompt: 'no-echo:do not route', workspace: join(handle.dir, 'workspace'), puckConversationId: 'T-11111111-1111-4111-8111-111111111111' }, handle), /Amp MCP.*configured/);
  } finally { await stop(handle); rmSync(handle.dir, { recursive: true, force: true }); }
});
