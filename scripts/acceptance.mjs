// Live acceptance against a SECOND controller instance (never the production one):
// real Factory models through the real session tools. Run it only against an
// instance started with its own port, token and state directory.
//   node scripts/acceptance.mjs --instance DIR --out evidence.json --reply-to T-... \
//        [--luna gpt-6-luna] [--haiku claude-haiku-4-5-20251001] [--sonnet claude-sonnet-5-5]
// DIR holds config.json, token and service.log of that instance.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values } = parseArgs({ options: { instance: { type: 'string' }, out: { type: 'string' }, 'reply-to': { type: 'string' }, luna: { type: 'string', default: 'gpt-6-luna' }, haiku: { type: 'string', default: 'claude-haiku-4-5-20251001' }, sonnet: { type: 'string', default: 'claude-sonnet-5-5' } } });
if (!values.instance || !values.out) throw new Error('Usage: node scripts/acceptance.mjs --instance DIR --out FILE [--reply-to T-...]');
const config = JSON.parse(readFileSync(join(values.instance, 'config.json'), 'utf8'));
if (!/\/accept/.test(values.instance) && !process.env.ACCEPTANCE_ALLOW_ANY_DIR) throw new Error('Refusing to run: instance directory must be a dedicated acceptance instance');
const url = readFileSync(join(values.instance, 'service.log'), 'utf8').match(/Listening (\S+)/)?.[1];
const client = new Client({ name: 'droid-acceptance', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${readFileSync(join(values.instance, 'token'), 'utf8').trim()}` } } }));
const RUN = randomUUID().slice(0, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { at: new Date().toISOString(), node: process.version, kind: 'live-second-instance', models: { luna: values.luna, haiku: values.haiku, sonnet: values.sonnet }, phases: {}, passed: false };
const check = (phase, name, ok, detail, blocked) => { (report.phases[phase] ??= []).push({ name, ok: Boolean(ok), ...(blocked ? { blocked } : {}), ...(detail === undefined ? {} : { detail }) }); console.log(`${blocked ? 'BLOCKED' : ok ? 'ok  ' : 'FAIL'} ${phase}: ${name}`); };
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const v = JSON.parse(r.content[0].text);
  if (r.isError) throw Object.assign(new Error(`${name}: ${v.error?.code}: ${v.error?.message}`), v.error);
  return v;
}
const ws = (name) => { const dir = join(config.approvedDirectories[0], name); mkdirSync(dir, { recursive: true }); return dir; };
const create = (key, name, model, prompt, extra = {}) => call('droid_create_session', { requestKey: `${key}-${randomUUID()}`, workspace: ws(name), prompt, model, replyTo: null, autonomy: 'off', reasoningEffort: 'low', title: key, labels: ['acceptance', `run-${RUN}`], ...extra });
const status = (session) => call('droid_get_session_status', { session });
const sid = (s) => s.metadata.session;
async function until(fn, what, ms = 90000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(400); } }
async function join_(sessions) { for (;;) { const r = await call('droid_wait_for_sessions', { sessions, timeoutSeconds: 20 }); if (r.settled) return r.sessions; } }
// Assistant text arrives whole, so readiness is "running for a few seconds", not "output visible".
const running = async (session) => { await until(async () => (await status(session)).latestRun.state === 'running', 'turn to start'); await sleep(4000); const s = await status(session); if (s.agentState.state !== 'working') throw new Error('turn finished before it could be interrupted; use a longer task'); };
const ESSAY = (words) => `Write a ${words}-word essay about rivers. Do not use any tools.`;
const COUNT = (n) => `Count from 1 to ${n}, one number per line. Do not use any tools.`;

try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('p0', '17 tools (11 session + 6 aliases) discovered', tools.length === 17);
  const ws0 = await call('droid_list_workspaces', {});
  check('p0', 'capacity maximum is 4', ws0.capacity.maximum === 4, ws0.capacity);
  const catalog = (await call('droid_models', {})).models.map((m) => m.id);
  check('p0', 'luna, haiku and sonnet are in the live catalog', [values.luna, values.haiku, values.sonnet].every((m) => catalog.includes(m)));

  // P1: four concurrent sessions on three small models, one routed to Puck.
  const replyTo = values['reply-to'] ?? null;
  const p1 = [
    await create('luna', 'p1-luna', values.luna, 'Reply exactly LUNA_OK. Do not use tools.'),
    await create('haiku', 'p1-haiku', values.haiku, 'Reply exactly HAIKU_OK. Do not use tools.'),
    await create('sonnet', 'p1-sonnet', values.sonnet, 'Reply exactly SONNET_OK. Do not use tools.'),
    await create('reply', 'p1-reply', values.haiku, `Send exactly one message to Puck with your Puck messaging tool saying "ACCEPTANCE TEST ONLY, no action needed: droid session surface reply-back works". Then reply exactly REPLY_DONE.`, replyTo ? { replyTo } : {}),
  ];
  let peak = 0;
  const sampler = setInterval(async () => { try { peak = Math.max(peak, (await call('droid_list_workspaces', {})).capacity.active); } catch {} }, 250);
  const early = await call('droid_wait_for_sessions', { sessions: p1.map(sid), timeoutSeconds: 0 });
  check('p1', 'zero-second wait reports timedOut without cancelling', early.timedOut && !early.settled);
  const done1 = await join_(p1.map(sid));
  clearInterval(sampler);
  check('p1', 'at least 3 sessions were active at once', peak >= 3, { peakActive: peak });
  // Factory stores Amp OAuth tokens per exact endpoint URL: a fresh thread-free URL needs a one-time owner sign-in.
  const ampBlocked = done1[3].latestRun.error?.code?.startsWith('amp_mcp_') ? done1[3].latestRun.error.code : null;
  for (const [i, marker] of ['LUNA_OK', 'HAIKU_OK', 'SONNET_OK', 'REPLY_DONE'].entries()) {
    if (i === 3 && ampBlocked) { check('p1', 'reply-back session failed with an actionable preflight error and submitted no task', done1[3].latestRun.state === 'failed' && done1[3].latestRun.error.action.length > 20, done1[3].latestRun.error, ampBlocked); continue; }
    check('p1', `${marker}: succeeded with exact output`, done1[i].latestRun.state === 'succeeded' && done1[i].preview.text.trim() === marker, { state: done1[i].latestRun.state, error: done1[i].latestRun.error?.code ?? null });
  }
  check('p1', 'models recorded per session', done1.map((s) => s.latestRun.model).join() === [values.luna, values.haiku, values.sonnet, values.haiku].join());
  if (replyTo && ampBlocked) check('p1', 'agent-origin report to Puck', false, { code: ampBlocked }, 'needs one-time Amp OAuth sign-in for the thread-free endpoint URL on this host');
  else if (replyTo) {
    check('p1', 'agent-origin report observed as accepted (not proof Puck read it)', done1[3].notification.state === 'accepted', { notification: done1[3].notification });
  } else report.phases.p1.push({ name: 'agent-origin reply skipped: no --reply-to', ok: true });
  const usage = await call('droid_get_usage', { session: sid(p1[0]) });
  check('p1', 'usage reports real tokens', usage.turns === 1 && usage.tokens.outputTokens > 0, usage);
  const read = await call('droid_read_session', { session: sid(p1[0]) });
  check('p1', 'read returns assistant history without prompts', read.messages.some((m) => m.role === 'assistant' && /LUNA_OK/.test(m.text)) && read.messages.every((m) => m.role !== 'user'));

  // P2: overlapping workspace serialization and disjoint parallelism.
  const dir2 = 'p2-shared';
  const writer = await create('writer', dir2, values.luna, 'Create a file named note.txt in the current directory containing exactly OK, then reply exactly WRITER_DONE.', { autonomy: 'high' });
  const nested = await create('nested-reader', `${dir2}/sub`, values.luna, 'Reply exactly READER_DONE. Do not use tools.');
  const disjoint = await create('disjoint', 'p2-other', values.luna, 'Reply exactly DISJOINT_DONE. Do not use tools.');
  check('p2', 'reader nested under a running writer is queued', nested.latestRun.state === 'queued', { state: nested.latestRun.state });
  check('p2', 'disjoint workspace is not blocked', disjoint.latestRun.state !== 'queued');
  const queuedWhileWriting = (await status(sid(nested))).latestRun.state;
  const done2 = await join_([writer, nested, disjoint].map(sid));
  check('p2', 'all three succeeded', done2.every((s) => s.latestRun.state === 'succeeded'), done2.map((s) => s.latestRun.state));
  check('p2', 'writer output file exists', existsSync(join(ws(dir2), 'note.txt')) && readFileSync(join(ws(dir2), 'note.txt'), 'utf8').trim() === 'OK');
  report.phases.p2.push({ name: 'nested reader state sampled after creation', ok: true, detail: queuedWhileWriting });

  // P3: steering through droid_send_message.
  const steer = await create('steer', 'p3-steer', values.luna, ESSAY(2500));
  await running(sid(steer));
  const queuedMsg = await call('droid_send_message', { session: sid(steer), requestKey: `queue-${randomUUID()}`, message: 'Reply exactly QUEUED_OK. Do not use tools.', model: values.luna, reasoningEffort: 'low', interrupt: false });
  check('p3', 'default send queues behind the active turn', queuedMsg.disposition === 'queued', { disposition: queuedMsg.disposition });
  const steered = await call('droid_send_message', { session: sid(steer), requestKey: `steer-${randomUUID()}`, message: 'Reply exactly STEERED_OK. Do not use tools.', model: values.luna, reasoningEffort: 'low', interrupt: true });
  check('p3', 'interrupt:true reports interrupting', steered.disposition === 'interrupting', { disposition: steered.disposition });
  const [done3] = await join_([sid(steer)]);
  check('p3', 'final output is the last message', done3.preview.text.trim() === 'STEERED_OK' && done3.latestRun.state === 'succeeded', { state: done3.latestRun.state, preview: done3.preview.text.slice(0, 40) });
  const hist3 = await call('droid_read_session', { session: sid(steer), limit: 100 });
  check('p3', 'history spans interrupted and resumed turns', new Set(hist3.messages.map((m) => m.runId)).size >= 2, { runs: new Set(hist3.messages.map((m) => m.runId)).size });

  // P4: cancel isolation.
  const [A, B, C] = [await create('iso-a', 'p4-a', values.haiku, COUNT(60)), await create('iso-b', 'p4-b', values.haiku, ESSAY(3000)), await create('iso-c', 'p4-c', values.luna, COUNT(60))];
  await running(sid(B));
  await call('droid_cancel_session', { session: sid(B) });
  const done4 = await join_([A, B, C].map(sid));
  check('p4', 'cancelled session settled as interrupted', ['interrupted', 'cancelled'].includes(done4[1].latestRun.state), { state: done4[1].latestRun.state });
  check('p4', 'neighbours were untouched and succeeded', done4[0].latestRun.state === 'succeeded' && done4[2].latestRun.state === 'succeeded', { a: done4[0].latestRun.state, c: done4[2].latestRun.state });

  // P5: find / update / archive.
  const found = await call('droid_find_sessions', { labels: [`run-${RUN}`], limit: 100 });
  check('p5', 'find by label sees every session created here', found.sessions.length >= 11, { count: found.sessions.length });
  const textHit = await call('droid_find_sessions', { query: 'HAIKU_OK' });
  check('p5', 'find by retained output text', textHit.sessions.some((s) => s.metadata.session === sid(p1[1])));
  const updated = await call('droid_update_session', { session: sid(p1[0]), title: 'Renamed by acceptance', labels: { add: [`renamed-${RUN}`], remove: ['acceptance'] } });
  check('p5', 'update changes title and labels', updated.metadata.title === 'Renamed by acceptance' && updated.metadata.labels.includes(`renamed-${RUN}`) && !updated.metadata.labels.includes('acceptance'));
  await call('droid_update_session', { session: sid(p1[0]), archived: true });
  const hidden = await call('droid_find_sessions', { labels: [`renamed-${RUN}`] });
  const shown = await call('droid_find_sessions', { labels: [`renamed-${RUN}`], archived: true });
  check('p5', 'archive hides, archived:true shows', hidden.sessions.length === 0 && shown.sessions.length === 1);
  const total = await call('droid_get_usage', {});
  check('p5', 'global usage aggregates all turns', total.turns >= 13 && total.tokens.outputTokens > 0, { turns: total.turns });
  report.blocked = Object.values(report.phases).flat().filter((c) => c.blocked).map((c) => ({ name: c.name, because: c.blocked }));
  report.passed = Object.values(report.phases).every((phase) => phase.every((c) => c.ok || c.blocked));
} catch (error) {
  report.error = error.message;
  console.error('Acceptance aborted:', error.message);
} finally {
  mkdirSync(join(values.out, '..'), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await client.close();
  console.log(report.passed ? `ACCEPTANCE PASSED${report.blocked?.length ? ` (${report.blocked.length} check(s) blocked, see evidence)` : ''}` : 'ACCEPTANCE FAILED');
  process.exitCode = report.passed ? 0 : 1;
}
