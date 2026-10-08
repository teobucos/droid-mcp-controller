// No-prompt authenticated SDK probe: transient Amp attachment vs saved session.
// Usage: node scripts/verify-route.mjs --droid /absolute/droid
// Uses existing OAuth only. Never sends/reads a Puck message or authenticates.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSession, resumeSession, ProcessTransport, ToolConfirmationOutcome } from '@factory/droid-sdk/node';
import { AMP_MCP_URL } from '../src/config.mjs';

const { values } = parseArgs({ options: { droid: { type: 'string' } } });
if (!values.droid?.startsWith('/')) throw new Error('Pass --droid /absolute/droid');
const scratch = resolve(import.meta.dirname, '../.amp/in');
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const cwd = mkdtempSync(join(scratch, 'route-verify-'));
const mcpServers = [{ name: 'amp-puck', type: 'http', url: AMP_MCP_URL, headers: [], oauth: { resource: 'https://ampcode.com/mcp' } }];
const report = [];
let id;
try {
  for (const mode of ['fresh-detached', 'routed', 'routed-resume', 'detached-omitted', 'routed-again', 'detached-empty']) {
    const routed = mode.startsWith('routed');
    const transport = new ProcessTransport({ droidExecPath: values.droid, cwd, env: { FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' } });
    const requests = [];
    const send = transport.send.bind(transport);
    transport.send = (line) => {
      const request = JSON.parse(line);
      if (request.type === 'request') requests.push(request);
      return send(line);
    };
    const previousId = id;
    const options = { transport, abortSignal: AbortSignal.timeout(30000), disableBuiltinSkills: true,
      permissionHandler: () => ToolConfirmationOutcome.Cancel, askUserHandler: () => ({ cancelled: true, answers: [] }),
      ...(routed ? { mcpServers } : mode === 'detached-empty' ? { mcpServers: [] } : {}),
    };
    let session;
    try {
      await transport.connect();
      session = previousId ? await resumeSession(previousId, options) : await createSession({ ...options, cwd, autonomyLevel: 'off', interactionMode: 'spec' });
      id = session.id;
      const tools = (await session.listMcpTools()).filter((tool) => tool.serverName === 'amp-puck');
      const load = requests.find((request) => request.method === 'droid.load_session');
      assert.equal(session.cwd, cwd);
      if (previousId) { assert.equal(id, previousId); assert.equal(load?.params.sessionId, previousId); }
      assert.equal(tools.some((tool) => tool.name === 'puck'), routed);
      if (!routed) assert.equal(tools.length, 0);
      assert.ok(requests.every((request) => request.method !== 'droid.add_user_message'));
      report.push({ mode, resumedSameUUID: previousId ? id === previousId && load.params.sessionId === previousId : null,
        ampToolCount: tools.length, expectedAttachment: true, noPrompt: true });
    } finally { if (session) await session.close(); else await transport.close(); }
  }
} finally { rmSync(cwd, { recursive: true, force: true }); }
console.log(JSON.stringify(report, null, 2));
