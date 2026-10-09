// Shared E2E harness: boots the real controller process against the protocol-peer
// mock `droid` executable and drives it through the real MCP client.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { once } from 'node:events';

export const root = resolve(import.meta.dirname, '..');
export const token = 'test-only-token-0123456789-abcdefghijkl';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function boot(extra = {}, envExtra = {}, existing) {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'droid-mcp-e2e-'));
  for (const sub of ['workspace', 'workspace-sibling', 'mock']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
  const config = {
    approvedDirectories: [join(dir, 'workspace')], stateDirectory: join(dir, 'state'),
    droidPath: join(root, 'test/mock-droid.mjs'), transport: 'http', port: 0,
    tokenFile: join(dir, 'token'), maxAutonomy: 'high', defaultAutonomy: 'off', runTimeoutMs: 8000,
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
  if (!url) throw new Error(`No listener ready: ${diagnostics}`);
  const client = new Client({ name: 'puck-e2e', version: '1' });
  if (!envExtra.MOCK_HTTP_FAULT) await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return { dir, config, configPath, env, proc, url, client, diagnostics: () => diagnostics };
}

export async function stop(handle, signal = 'SIGTERM') {
  await handle.client.close();
  if (handle.proc.exitCode === null && handle.proc.signalCode === null) {
    const exited = once(handle.proc, 'exit');
    handle.proc.kill(signal);
    await exited;
  }
}

// Returns the parsed tool value; throws an Error carrying the parsed error body on isError.
export async function call(handle, name, args) {
  const result = await handle.client.callTool({ name, arguments: args });
  const value = JSON.parse(result.content[0].text);
  if (result.isError) throw Object.assign(new Error(value.error?.message), value.error);
  if (result.structuredContent) return result.structuredContent;
  return value;
}

export function audit(handle) {
  const path = join(handle.dir, 'audit.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

export const readState = (handle) => JSON.parse(readFileSync(join(handle.dir, 'state/state.json'), 'utf8'));

export function writeCatalog(handle, models) {
  writeFileSync(join(handle.dir, 'mock/catalog.json'), JSON.stringify(models));
}

export function processRunning(pid) {
  try {
    process.kill(pid, 0);
    // An unreaped zombie in an orb cannot execute any work.
    if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z ')) return false;
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}
