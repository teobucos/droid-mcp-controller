// Repeatable verification on the authenticated user host, through real MCP.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, out: { type: 'string' }, url: { type: 'string' }, model: { type: 'string' }, 'expect-auth-failure': { type: 'boolean', default: false } } });
if (!values.config || !values.out) throw new Error('Usage: npm run smoke -- --config /absolute/config.json --out /absolute/evidence.json [--url https://host/mcp] [--model model-id] [--expect-auth-failure]');
const config = JSON.parse(readFileSync(values.config, 'utf8'));
const client = new Client({ name: 'droid-controller-smoke', version: '0.1.0' });
const report = { at: new Date().toISOString(), node: process.version, model: values.model, passed: false, runs: [] };
let current;
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const data = JSON.parse(response.content[0].text);
  if (response.isError) throw new Error(`${name}: ${data.error}`);
  return data;
}
async function terminal(id) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const status = await call('droid_status', { runId: id });
    if (status.terminal) return call('droid_result', { runId: id });
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Smoke turn did not finish within two minutes');
}
function record(result, marker) {
  // Do not export arbitrary assistant output, stderr, prompts, or credentials.
  const entry = { runId: result.runId, droidSessionId: result.droidSessionId, state: result.state, subtype: result.outcome?.subtype, resultAvailable: result.resultAvailable, markerMatched: result.text.trim() === marker, authFailureObserved: /authenticat|access token|log in/i.test(JSON.stringify(result)) };
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
  if (report.tools.length !== 7 || !report.tools.includes('droid_models')) throw new Error('Expected seven tools including droid_models');
  if (!values['expect-auth-failure']) {
    const catalog = await call('droid_models', {});
    report.catalog = { fetchedAt: catalog.fetchedAt, modelCount: catalog.models.length, ...(values.model ? { selectedModelAvailable: catalog.models.some((model) => model.id === values.model) } : {}) };
    if (values.model && !report.catalog.selectedModelAvailable) throw new Error('Explicit --model is absent from the current catalog; choose an ID from droid_models');
  }
  const key = `smoke-${randomUUID()}`;
  const firstArgs = { requestKey: key, workspace: config.approvedDirectories[0], autonomy: 'off', ...(values.model ? { model: values.model } : {}), prompt: 'Reply exactly DROID_MCP_SMOKE_OK. Do not call tools or edit files.' };
  current = await call('droid_start', firstArgs);
  if ((await call('droid_start', firstArgs)).runId !== current.runId) throw new Error('Idempotent start failed');
  const first = record(await terminal(current.runId), 'DROID_MCP_SMOKE_OK');
  if (values['expect-auth-failure']) {
    if (first.state !== 'failed' || first.subtype !== 'error_during_execution' || !first.authFailureObserved || !first.resultAvailable) throw new Error('Expected a persisted terminal authentication failure');
  } else {
    if (first.state !== 'succeeded' || !first.markerMatched) throw new Error('Authenticated start did not return the expected marker');
    current = await call('droid_continue', { runId: first.runId, requestKey: `${key}-resume`, autonomy: 'off', ...(values.model ? { model: values.model } : {}), prompt: 'Reply exactly DROID_MCP_RESUME_OK. Do not call tools or edit files.' });
    const second = record(await terminal(current.runId), 'DROID_MCP_RESUME_OK');
    if (second.state !== 'succeeded' || !second.markerMatched || second.droidSessionId !== first.droidSessionId || second.runId === first.runId) throw new Error('Authenticated resume failed');
  }
  report.passed = true;
  console.log('PASS: real MCP lifecycle smoke; evidence saved');
} catch (error) {
  // Generic evidence only. Keep detailed provider diagnostics on the local host.
  report.failure = 'Smoke failed; inspect droid_status/droid_result locally';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (current) await call('droid_cancel', { runId: current.runId }).catch(() => {});
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await client.close();
}
