// Repeatable verification on the authenticated user host, through real MCP, using
// the session tools: create, wait, read, send (resume), wait, usage.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, out: { type: 'string' }, url: { type: 'string' }, model: { type: 'string' }, 'expect-auth-failure': { type: 'boolean', default: false } } });
if (!values.config || !values.out) throw new Error('Usage: npm run smoke -- --config /absolute/config.json --out /absolute/evidence.json --model model-id [--url https://host/mcp] [--expect-auth-failure]');
if (!values.model) throw new Error('--model is required: pick an id from droid_models');
const config = JSON.parse(readFileSync(values.config, 'utf8'));
const client = new Client({ name: 'droid-controller-smoke', version: '0.2.0' });
const report = { at: new Date().toISOString(), node: process.version, model: values.model, passed: false, runs: [] };
let session;
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const data = JSON.parse(response.content[0].text);
  if (response.isError) throw new Error(`${name}: ${data.error.code}: ${data.error.message}`);
  return data;
}
async function settled(id) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const { sessions, settled: done } = await call('droid_wait_for_sessions', { sessions: [id], timeoutSeconds: 20 });
    if (done) return sessions[0];
  }
  throw new Error('Smoke turn did not finish within two minutes');
}
async function record(status, marker) {
  // Do not export arbitrary assistant output, stderr, prompts, or credentials.
  const read = await call('droid_read_session', { session: status.metadata.session, limit: 100 });
  const entry = {
    session: status.metadata.session, runId: status.latestRun.runId, state: status.latestRun.state, needsAttention: status.latestRun.needsAttention,
    markerMatched: status.preview.text.trim() === marker, historyAvailable: read.historyAvailable,
    authFailureObserved: /authenticat|access token|log in/i.test(JSON.stringify(status.latestRun.error) + status.preview.text),
  };
  report.runs.push(entry);
  return entry;
}
try {
  if (values.url || config.transport === 'http') {
    const url = values.url ?? `http://127.0.0.1:${config.port ?? 8787}/mcp`;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) throw new Error('Remote smoke requires HTTPS');
    const token = readFileSync(config.tokenFile, 'utf8').trim();
    await client.connect(new StreamableHTTPClientTransport(parsed, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  } else {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url)), '--config', values.config], env: process.env, stderr: 'inherit' }));
  }
  report.tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ['droid_create_session', 'droid_send_message', 'droid_wait_for_sessions', 'droid_models']) if (!report.tools.includes(name)) throw new Error(`Missing tool ${name}`);
  if (!values['expect-auth-failure']) {
    const catalog = await call('droid_models', {});
    report.catalog = { fetchedAt: catalog.fetchedAt, modelCount: catalog.models.length, selectedModelAvailable: catalog.models.some((model) => model.id === values.model) };
    if (!report.catalog.selectedModelAvailable) throw new Error('--model is absent from the current catalog; choose an ID from droid_models');
  }
  report.workspaces = await call('droid_list_workspaces', {});
  const key = `smoke-${randomUUID()}`;
  const firstArgs = { requestKey: key, workspace: config.approvedDirectories[0], autonomy: 'off', model: values.model, replyTo: null, title: 'Controller smoke', prompt: 'Reply exactly DROID_MCP_SMOKE_OK. Do not call tools or edit files.' };
  const created = await call('droid_create_session', firstArgs);
  session = created.metadata.session;
  if ((await call('droid_create_session', firstArgs)).metadata.session !== session) throw new Error('Idempotent create failed');
  const first = await record(await settled(session), 'DROID_MCP_SMOKE_OK');
  if (values['expect-auth-failure']) {
    if (first.state !== 'failed' || !first.authFailureObserved) throw new Error('Expected a persisted terminal authentication failure');
  } else {
    if (first.state !== 'succeeded' || !first.markerMatched) throw new Error('Authenticated create did not return the expected marker');
    const sent = await call('droid_send_message', { session, requestKey: `${key}-resume`, message: 'Reply exactly DROID_MCP_RESUME_OK. Do not call tools or edit files.', model: values.model, autonomy: 'off' });
    const second = await record(await settled(sent.status.metadata.session), 'DROID_MCP_RESUME_OK');
    if (second.state !== 'succeeded' || !second.markerMatched || second.session !== first.session || second.runId === first.runId) throw new Error('Authenticated resume failed');
    report.usage = await call('droid_get_usage', { session });
  }
  report.passed = true;
  console.log('PASS: real MCP lifecycle smoke; evidence saved');
} catch (error) {
  // Generic evidence only. Keep detailed provider diagnostics on the local host.
  report.failure = 'Smoke failed; inspect droid_get_session_status locally';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (session) await call('droid_cancel_session', { session }).catch(() => {});
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await client.close();
}
