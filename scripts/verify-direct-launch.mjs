// Direct-launch acceptance on a disposable HTTP controller: two fresh sessions created
// straight through MCP with only host defaults (no model argument), run in parallel in
// separate directories, then continued with every setting omitted. No ampMcp is
// configured and replyTo is null, so nothing contacts Amp.
//
//   node scripts/verify-direct-launch.mjs --droid /abs/droid --default-model CURRENT_ID \
//     --root /approved/disposable/dir [--reasoning low]
//
// Requires existing Factory CLI login. Never authenticates, updates the CLI, starts a
// daemon, registers a computer or changes global config. The private report (mode 600)
// maps controller sessions to Factory session UUIDs and the documented web route; it
// holds no prompts, assistant text beyond the fixed markers, tokens or credentials.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values } = parseArgs({ options: { droid: { type: 'string' }, 'default-model': { type: 'string' }, root: { type: 'string' }, reasoning: { type: 'string', default: 'low' } } });
if (!values.droid?.startsWith('/') || !values['default-model'] || !values.root?.startsWith('/')) throw new Error('Pass --droid /absolute/droid --default-model CURRENT_ID --root /approved/disposable/dir');
const repo = resolve(import.meta.dirname, '..');
mkdirSync(values.root, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(values.root, 'direct-launch-'));
const projects = join(dir, 'projects');
for (const name of ['alpha', 'beta']) mkdirSync(join(projects, name), { recursive: true });
const wire = join(dir, 'wire.jsonl');
writeFileSync(join(dir, 'token'), randomBytes(32).toString('base64url'), { mode: 0o600 });
const config = {
  approvedDirectories: [projects], stateDirectory: join(dir, 'state'), droidPath: values.droid, transport: 'http', port: 0, tokenFile: join(dir, 'token'),
  defaultModel: values['default-model'], reasoningEffort: values.reasoning, defaultAutonomy: 'off', maxAutonomy: 'low', maxConcurrentRuns: 2, runTimeoutMs: 180000, cancelGraceMs: 3000,
};
writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
const env = { ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false', DROID_VERIFY_WIRE: wire, NODE_OPTIONS: `--import=${join(repo, 'scripts/verify-wire.mjs')}` };
const report = {
  at: new Date().toISOString(), node: process.version, cli: execFileSync(values.droid, ['--version'], { env, encoding: 'utf8' }).trim(),
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim() !== '',
  hostPolicy: { defaultModel: config.defaultModel, reasoningEffort: config.reasoningEffort, defaultAutonomy: config.defaultAutonomy, maxAutonomy: config.maxAutonomy, ampMcp: null },
  checks: {}, sessions: [],
};
const check = (name, condition) => { report.checks[name] = Boolean(condition); assert.ok(condition, name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const audit = () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const state = () => JSON.parse(readFileSync(join(dir, 'state/state.json'), 'utf8'));
const server = spawn(process.execPath, ['src/server.mjs', '--config', join(dir, 'config.json')], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
server.stderr.on('data', (b) => { log += b; });
const client = new Client({ name: 'direct-launch-acceptance', version: '1' });
const call = async (name, args) => {
  const raw = await client.callTool({ name, arguments: args });
  const result = JSON.parse(raw.content[0].text);
  if (raw.isError) throw Object.assign(new Error(`${name} rejected: ${result.error?.code}`), { code: result.error?.code });
  return result;
};
const settle = async (sessions) => {
  const deadline = Date.now() + 240000;
  for (;;) {
    const result = await call('droid_wait_for_sessions', { sessions, timeoutSeconds: 30 });
    if (result.settled) return result.sessions;
    if (Date.now() > deadline) throw new Error('Sessions did not settle in time');
  }
};
const effective = (status) => ({ model: status.latestRun.model, autonomy: status.latestRun.autonomy, reasoningEffort: status.latestRun.reasoningEffort });
try {
  let url;
  for (let i = 0; i < 300 && !url; i++) { url = log.match(/Listening (http:\/\/127\.0\.0\.1:\d+\/mcp)/)?.[1]; if (server.exitCode !== null) throw new Error('Controller startup failed'); await sleep(50); }
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${readFileSync(join(dir, 'token'), 'utf8')}` } } }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('exactly_eleven_tools', tools.length === 11);
  const { policy } = await call('droid_list_workspaces', {});
  check('policy_reports_default_model', policy.defaultModel === config.defaultModel && policy.replyBack === false);
  const catalog = await call('droid_models', {});
  check('default_model_current', catalog.models.some((m) => m.id === config.defaultModel && m.deprecated !== true));

  // Two fresh sessions, model omitted: exactly what Puck sends after one-time setup.
  const a = await call('droid_create_session', { requestKey: 'direct-a-1', workspace: join(projects, 'alpha'), prompt: 'Reply exactly DIRECT_A_ONE. Do not use any tools.', replyTo: null, title: 'Direct launch A' });
  const b = await call('droid_create_session', { requestKey: 'direct-b-1', workspace: join(projects, 'beta'), prompt: 'Reply exactly DIRECT_B_ONE. Do not use any tools.', autonomy: 'low', replyTo: null, title: 'Direct launch B' });
  const ids = [a.metadata.session, b.metadata.session];
  const [a1, b1] = await settle(ids);
  check('fresh_sessions_succeeded', a1.latestRun.state === 'succeeded' && a1.preview.text.trim() === 'DIRECT_A_ONE' && b1.latestRun.state === 'succeeded' && b1.preview.text.trim() === 'DIRECT_B_ONE');
  check('host_defaults_applied', JSON.stringify(effective(a1)) === JSON.stringify({ model: config.defaultModel, autonomy: 'off', reasoningEffort: config.reasoningEffort }) && effective(b1).autonomy === 'low' && effective(b1).model === config.defaultModel);
  const uuids = ids.map((id) => state().sessions[id].droidSessionId);
  check('isolated_factory_sessions', uuids.every(Boolean) && uuids[0] !== uuids[1]);
  const runsA = Object.values(state().runs).filter((r) => r.sessionId === ids[0]);
  const runsB = Object.values(state().runs).filter((r) => r.sessionId === ids[1]);
  check('ran_in_parallel', Date.parse(runsA[0].startedAt) < Date.parse(runsB[0].finishedAt) && Date.parse(runsB[0].startedAt) < Date.parse(runsA[0].finishedAt));

  // Continuations with every setting omitted inherit the session, not host defaults.
  await call('droid_send_message', { session: ids[0], requestKey: 'direct-a-2', message: 'Reply exactly DIRECT_A_TWO. Do not use any tools.' });
  await call('droid_send_message', { session: ids[1], requestKey: 'direct-b-2', message: 'Reply exactly DIRECT_B_TWO. Do not use any tools.' });
  const [a2, b2] = await settle(ids);
  check('continuations_succeeded', a2.latestRun.state === 'succeeded' && a2.preview.text.trim() === 'DIRECT_A_TWO' && b2.latestRun.state === 'succeeded' && b2.preview.text.trim() === 'DIRECT_B_TWO');
  check('continuations_inherit_session_settings', JSON.stringify(effective(a2)) === JSON.stringify(effective(a1)) && JSON.stringify(effective(b2)) === JSON.stringify(effective(b1)) && effective(b2).autonomy === 'low');
  check('same_factory_session_on_continue', ids.every((id, i) => state().sessions[id].droidSessionId === uuids[i]));
  check('replay_is_idempotent', (await call('droid_create_session', { requestKey: 'direct-a-1', workspace: join(projects, 'alpha'), prompt: 'Reply exactly DIRECT_A_ONE. Do not use any tools.', replyTo: null, title: 'Direct launch A' })).metadata.session === ids[0]);
  check('four_turns_submitted', audit().filter((m) => m.kind === 'response' && m.method === 'droid.add_user_message' && m.success).length === 4);
  check('zero_amp_contact', audit().every((m) => !m.attachesMcp && !/mcp/i.test(m.method ?? '')));
  for (const [i, id] of ids.entries()) {
    report.sessions.push({
      controllerSession: id, runs: Object.values(state().runs).filter((r) => r.sessionId === id).map((r) => ({ runId: r.runId, state: r.state, model: r.model, autonomy: r.autonomy, reasoningEffort: r.reasoningEffort })),
      factorySession: uuids[i], factoryWebRoute: `https://app.factory.ai/sessions/${uuids[i]}`,
    });
  }
  report.passed = true;
} catch (error) {
  report.failure = { message: error.code === 'ERR_ASSERTION' ? error.message : error.message.replace(/\/[^\s]+/g, '<path>'), code: error.code ?? null };
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  if (server.exitCode === null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)); }
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ report: join(dir, 'report.json'), ...report }, null, 2));
}
