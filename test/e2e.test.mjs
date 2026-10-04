import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const token = 'test-only-token-0123456789-abcdefghijkl';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h;

async function boot(extra = {}, envExtra = {}, existing) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'droid-mcp-e2e-'));
  for (const sub of ['workspace', 'workspace-sibling', 'mock']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
  const config = {
    approvedDirectories: [join(dir, 'workspace')], stateDirectory: join(dir, 'state'),
    droidPath: join(root, 'test/mock-droid.mjs'), transport: 'http', port: 0,
    tokenFile: join(dir, 'token'), maxAutonomy: 'high', runTimeoutMs: 8000,
    cancelGraceMs: 400, reasoningEffort: 'high', ...extra,
  };
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  chmodSync(config.droidPath, 0o755);
  const env = { ...process.env, MOCK_DROID_HOME: join(dir, 'mock'), MOCK_AUDIT: join(dir, 'audit.jsonl'), ...envExtra };
  delete env.FACTORY_API_KEY; // Existing CLI auth must not require an SDK API key.
  const proc = spawn(process.execPath, ['src/server.mjs', '--config', configPath], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  proc.stderr.on('data', (b) => { diagnostics += b; });
  let url;
  for (let i = 0; i < 150; i++) {
    url = diagnostics.match(/Listening (http:\/\/127\.0\.0\.1:\d+\/mcp)/)?.[1];
    if (url) break;
    if (proc.exitCode !== null) throw new Error(`Startup failed: ${diagnostics}`);
    await sleep(30);
  }
  assert.ok(url, `No listener ready: ${diagnostics}`);
  const client = new Client({ name: 'puck-e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return { dir, config, configPath, env, proc, url, client, diagnostics: () => diagnostics };
}
async function stop(handle, signal = 'SIGTERM') {
  await handle.client.close();
  if (handle.proc.exitCode === null) {
    handle.proc.kill(signal);
    await once(handle.proc, 'exit');
  }
}
async function call(name, args, handle = h) {
  const result = await handle.client.callTool({ name, arguments: args });
  const value = JSON.parse(result.content[0].text);
  if (result.isError) throw new Error(value.error);
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
function audit(handle = h) {
  return readFileSync(join(handle.dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}
function processRunning(pid) {
  try {
    process.kill(pid, 0);
    // An unreaped zombie in an orb cannot execute any work.
    if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z ')) return false;
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}

test('Puck MCP lifecycle, protocol, persistence and security E2E', async (t) => {
  h = await boot();
  t.after(async () => { await stop(h); rmSync(h.dir, { recursive: true, force: true }); });

  await t.test('six discoverable tools; async/idempotent start and safe protocol defaults', async () => {
    assert.deepEqual((await h.client.listTools()).tools.map((x) => x.name).sort(), ['droid_cancel', 'droid_continue', 'droid_list', 'droid_result', 'droid_start', 'droid_status']);
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
    assert.equal(wire.find((x) => x.method === 'droid.load_session').params.sessionId, h.first.droidSessionId);
    const settings = wire.find((x) => x.method === 'droid.update_session_settings');
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
    h = await boot({}, {}, old.dir);
    h.first = old.first; h.next = old.next;
    assert.equal((await start('start-one', 'slow')).runId, h.first.runId);
    assert.equal((await call('droid_result', { runId: h.next.runId })).text, 'answer:follow-up');
    assert.equal((await call('droid_status', { runId: h.next.runId })).reasoningEffort, 'high');
    assert.equal(statSync(join(h.dir, 'state/state.json')).mode & 0o777, 0o600);
    const again = await call('droid_continue', { runId: h.next.runId, requestKey: 'after-restart', prompt: 'remember' });
    assert.equal((await finish(again.runId)).droidSessionId, h.first.droidSessionId);
    const reset = audit().filter((x) => x.method === 'droid.update_session_settings').at(-1);
    assert.equal(reset.params.autonomyLevel, 'off');
    assert.equal(reset.params.interactionMode, 'spec');
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
      const run = await call('droid_start', { requestKey: 'terminal-before-cleanup', prompt: 'done', workspace: join(separate.dir, 'workspace') }, separate);
      let result;
      for (let i = 0; i < 100; i++) {
        result = await call('droid_result', { runId: run.runId }, separate);
        if (result.resultAvailable) break;
        await sleep(20);
      }
      assert.equal(result.resultAvailable, true);
      assert.equal(result.terminal, false, 'Serial slot is held until process cleanup');
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
      assert.equal((await client.listTools()).tools.length, 6);
      await client.close();
      await sleep(100);
      const smoke = spawn(process.execPath, [join(root, 'scripts/smoke.mjs'), '--config', path, '--out', join(dir, 'acceptance.json')], { env: { ...process.env, MOCK_DROID_HOME: dir, MOCK_AUDIT: join(dir, 'audit.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let smokeLog = ''; smoke.stdout.on('data', (b) => { smokeLog += b; }); smoke.stderr.on('data', (b) => { smokeLog += b; });
      assert.equal((await once(smoke, 'exit'))[0], 0, smokeLog);
      const evidence = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
      assert.equal(evidence.passed, true);
      assert.equal(evidence.runs.length, 2);
      assert.ok(evidence.runs.every((r) => r.markerMatched && r.state === 'succeeded'));
      assert.equal(evidence.runs[0].droidSessionId, evidence.runs[1].droidSessionId);
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
