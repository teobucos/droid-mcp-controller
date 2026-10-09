// Bounded, read-only authenticated smoke on a disposable STDIO controller.
// Usage: node scripts/verify-live.mjs --droid /absolute/droid --model CURRENT_ID --workspace /approved/smoke/root
// Requires existing CLI login. Never authenticates, updates CLI, starts a daemon,
// changes global config, or messages Puck. Prints only sanitized assertions.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({ options: { droid: { type: 'string' }, model: { type: 'string' }, workspace: { type: 'string' } } });
if (!values.droid?.startsWith('/') || !values.model || !values.workspace?.startsWith('/')) throw new Error('Pass --droid /absolute/droid --model CURRENT_ID (from the live catalog) --workspace /approved/smoke/root');
const root = resolve(import.meta.dirname, '..');
const scratch = join(root, '.amp/in');
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(scratch, 'live-verify-'));
const workspace = values.workspace;
const wire = join(dir, 'wire.jsonl');
const config = { approvedDirectories: [workspace], stateDirectory: join(dir, 'state'), droidPath: values.droid, maxAutonomy: 'off', defaultAutonomy: 'off', runTimeoutMs: 60000, cancelGraceMs: 3000 };
writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
const transport = new StdioClientTransport({ command: process.execPath, args: ['src/server.mjs', '--config', join(dir, 'config.json')], cwd: root, stderr: 'pipe', env: { ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false', DROID_VERIFY_WIRE: wire, NODE_OPTIONS: `--import=${join(root, 'scripts/verify-wire.mjs')}` } });
transport.stderr.resume(); // Private diagnostics must never become evidence content.
const client = new Client({ name: 'bounded-read-only-verification', version: '1' });
const report = { node: process.version, cli: execFileSync(values.droid, ['--version'], { env: { ...process.env, FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' }, encoding: 'utf8' }).trim(), sdk: '0.9.1', mcpSdk: '1.32.0', base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), model: values.model, checks: {} };
const audit = () => existsSync(wire) ? readFileSync(wire, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const state = () => JSON.parse(readFileSync(join(dir, 'state/state.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 65000) { const deadline = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('Verification deadline exceeded'); await sleep(100); } }
const call = async (name, args) => {
  const raw = await client.callTool({ name, arguments: args });
  const result = JSON.parse(raw.content[0].text);
  if (raw.isError) throw Object.assign(new Error('Controller rejected verification call'), { code: result.error?.code });
  return result;
};
const check = (name, condition) => { report.checks[name] = Boolean(condition); assert.ok(condition, name); };
const settle = (session) => until(async () => { const status = await call('droid_get_session_status', { session }); return status.latestRun.terminal && status; });
const running = (pid) => {
  try { process.kill(pid, 0); return process.platform !== 'linux' || !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z '); } catch { return false; }
};
try {
  await client.connect(transport);
  const catalog = await call('droid_models', {});
  check('explicit_model_current', catalog.models.some((m) => m.id === values.model && m.deprecated === false));
  check('catalog_excludes_deprecated', catalog.models.every((m) => m.deprecated !== true));
  check('discovery_no_prompt', audit().every((m) => m.method !== 'droid.add_user_message'));
  report.catalogCount = catalog.models.length;
  const first = await call('droid_create_session', { requestKey: 'verify-first', workspace, prompt: 'Reply exactly VERIFY_ONE. Do not use any tools.', model: values.model, reasoningEffort: 'low', autonomy: 'off', replyTo: null });
  const session = first.metadata.session;
  const one = await settle(session);
  check('first_result', one.latestRun.state === 'succeeded' && one.preview.text.trim() === 'VERIFY_ONE');
  const id = state().sessions[session].droidSessionId;
  await call('droid_send_message', { session, requestKey: 'verify-second', message: 'Reply exactly VERIFY_TWO. Do not use any tools.', model: values.model, reasoningEffort: 'low', autonomy: 'off', replyTo: null });
  const two = await settle(session);
  check('continued_result', two.latestRun.state === 'succeeded' && two.preview.text.trim() === 'VERIFY_TWO');
  check('same_uuid', state().sessions[session].droidSessionId === id);
  const history = await call('droid_read_session', { session });
  const usage = await call('droid_get_usage', { session });
  check('terminal_history_and_usage', history.historyAvailable && history.messages.some((m) => m.runId === two.latestRun.runId && m.text === 'VERIFY_TWO') && usage.turns === 2 && usage.tokens.outputTokens > 0);
  await call('droid_send_message', { session, requestKey: 'verify-cancel', message: 'Count from 1 to 10000, one number per line. Do not use any tools.', model: values.model, reasoningEffort: 'low', autonomy: 'off', replyTo: null });
  await until(() => audit().filter((m) => m.kind === 'response' && m.method === 'droid.add_user_message' && m.success).length === 3);
  await call('droid_cancel_session', { session });
  const cancelled = await settle(session);
  check('cancelled_after_real_submission', ['interrupted', 'cancelled'].includes(cancelled.latestRun.state));
  check('exactly_three_accepted_messages', audit().filter((m) => m.kind === 'response' && m.method === 'droid.add_user_message' && m.success).length === 3);
  check('three_durable_intents', Object.values(state().runs).every((r) => r.submissionIntentAt && r.droidSessionId === id));
  check('read_only', Object.values(state().runs).every((r) => r.autonomy === 'off'));
  const pids = [...new Set(audit().filter((m) => m.method === 'droid.add_user_message' && m.kind === 'sent').flatMap((m) => [m.pid, m.cliPid]))];
  await until(() => pids.every((pid) => !running(pid)), 5000);
  check('worker_and_cli_cleanup', pids.every((pid) => !running(pid)));
} catch (error) {
  report.failure = { name: error.name, code: error.code ?? null, check: error.code === 'ERR_ASSERTION' ? error.message : undefined };
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
