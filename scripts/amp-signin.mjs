// Operator sign-in helper: completes Factory's supported MCP OAuth for the exact
// ampMcp.url on THIS host, through the SDK's authenticateMcpServer. Factory stores
// the resulting token per endpoint URL in its own credential store; this script never
// reads, prints, logs or copies tokens or the authorization code.
//
//   node scripts/amp-signin.mjs --config /abs/config.json --dir /abs/private-dir [--workspace /abs/dir]
//
// Flow: the script writes the authorization link to DIR/auth-url.txt (mode 600) and
// prints AUTH_URL_READY. The owner opens it and consents. The browser then lands on
// a http://127.0.0.1:<port>/callback page that fails to load: the owner copies that
// full URL into DIR/callback-url.txt (mode 600). The script delivers it to the local
// callback listener and waits for Factory to report completion. A link lasts five
// minutes; the script reissues a new one (same file) up to three times.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createSession, ProcessTransport } from '@factory/droid-sdk/node';
import { AMP_MCP_URL } from '../src/config.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' }, dir: { type: 'string' }, workspace: { type: 'string' }, 'callback-port': { type: 'string', default: '54621' } } });
if (!values.config || !values.dir) throw new Error('Usage: node scripts/amp-signin.mjs --config /abs/config.json --dir /abs/private-dir');
const config = JSON.parse(readFileSync(values.config, 'utf8'));
const url = config.ampMcp?.url ?? AMP_MCP_URL;
if (new URL(url).searchParams.has('threadID')) throw new Error('ampMcp.url must be thread-free');
mkdirSync(values.dir, { recursive: true, mode: 0o700 });
chmodSync(values.dir, 0o700);
const authFile = join(values.dir, 'auth-url.txt');
const callbackFile = join(values.dir, 'callback-url.txt');
rmSync(authFile, { force: true }); rmSync(callbackFile, { force: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cwd = values.workspace ?? join(values.dir, 'ws');
mkdirSync(cwd, { recursive: true });

const transport = new ProcessTransport({ droidExecPath: config.droidPath, cwd, env: { FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' } });
await transport.connect();
// Droid can only authenticate a server it holds in its hub. An SDK-injected server that
// failed to start is dropped from the hub, so the sign-in uses a PROJECT-level definition
// inside a throwaway workspace: nothing is added to the user's persistent Factory MCP config.
const definition = join(cwd, '.factory', 'mcp.json');
mkdirSync(join(cwd, '.factory'), { recursive: true });
writeFileSync(definition, JSON.stringify({ mcpServers: { 'amp-puck': { type: 'http', url, oauth: { resource: 'https://ampcode.com/mcp', callbackPort: Number(values['callback-port']) }, disabledTools: ['manage_amp'] } } }, null, 2), { mode: 0o600 });
const session = await createSession({ transport, cwd, disableBuiltinSkills: true, interactionMode: 'spec', autonomyLevel: 'off' });
let outcome = null;
let authState = null;
session.onNotification((notification) => {
  if (notification.type === 'mcp_auth_required') {
    authState = notification.state;
    writeFileSync(authFile, `${notification.authUrl}\n`, { mode: 0o600 });
    console.log('AUTH_URL_READY');
  } else if (notification.type === 'mcp_auth_completed') {
    outcome = notification.outcome;
    console.log(`AUTH_COMPLETED outcome=${notification.outcome}`);
  }
});

async function deliver() {
  // Deliver the owner's callback to Factory's own loopback listener; never log it.
  if (!existsSync(callbackFile)) return false;
  if ((statSync(callbackFile).mode & 0o077) !== 0) throw new Error('callback-url.txt must be mode 600');
  const callback = new URL(readFileSync(callbackFile, 'utf8').trim());
  rmSync(callbackFile, { force: true });
  if (callback.hostname !== '127.0.0.1' && callback.hostname !== 'localhost') throw new Error('callback must be a loopback URL');
  if (authState && callback.searchParams.get('state') !== authState) throw new Error('callback state does not match the current authorization link');
  const response = await fetch(callback, { redirect: 'manual' });
  console.log(`CALLBACK_DELIVERED http=${response.status}`);
  return true;
}

try {
  for (let attempt = 1; attempt <= 3 && outcome === null; attempt++) {
    const authenticating = session.authenticateMcpServer({ serverName: 'amp-puck' }).then((r) => r, (e) => ({ success: false, error: e.message }));
    let settled;
    authenticating.then((r) => { settled = r; });
    while (settled === undefined && outcome === null) {
      await deliver().catch((e) => { console.error(`CALLBACK_REJECTED ${e.message}`); });
      // The link is also exposed as the server's pending auth; notifications can precede our subscription.
      const pending = (await session.listMcpServers().catch(() => ({ servers: [] }))).servers.find((s) => s.name === 'amp-puck');
      if (pending?.pendingAuthUrl && pending.pendingAuthState !== authState) {
        authState = pending.pendingAuthState ?? authState;
        writeFileSync(authFile, `${pending.pendingAuthUrl}\n`, { mode: 0o600 });
        console.log('AUTH_URL_READY');
      }
      await sleep(1000);
    }
    if (settled?.success) break;
    console.log(`AUTH_ATTEMPT_${attempt}_ENDED success=${Boolean(settled?.success)}${settled?.error ? ` error=${String(settled.error).replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1").slice(0, 200)}` : ""}`);
  }
  await sleep(1000);
  const servers = (await session.listMcpServers()).servers.find((s) => s.name === 'amp-puck');
  const tools = await session.listTools().then((t) => t.filter((x) => x.id.startsWith('amp-puck___')).map((x) => `${x.id}:allowed=${x.allowed}`), () => ['listTools failed']);
  console.log(JSON.stringify({ server: servers ? { status: servers.status, hasAuthTokens: servers.hasAuthTokens } : null, tools }));
  process.exitCode = servers?.status === 'connected' ? 0 : 1;
} finally {
  await session.close().catch(() => {});
  await transport.close().catch(() => {});
}
