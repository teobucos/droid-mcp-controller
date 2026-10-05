import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadConfig, autonomy, reasoning, conversationId } from './config.mjs';
import { Controller } from './controller.mjs';
import { ModelCatalog } from './models.mjs';

const runId = z.string().uuid().describe('Controller run UUID, not Droid session UUID');
const requestKey = z.string().min(1).max(200).describe('Stable idempotency key; reuse only with exactly the same arguments');
const prompt = z.string().min(1).max(100000);
const options = {
  autonomy: autonomy.optional().describe('Uses host default EVERY new turn; off is read-only, high is full Auto execution. Bounded by maxAutonomy'),
  model: z.string().min(1).max(200).optional().describe('Current model ID from droid_models, explicit for this turn including continuation; do not guess or reuse historical IDs'),
  reasoningEffort: reasoning.optional().describe('Independent of autonomy; overrides host reasoning for this turn. Must be supported by the chosen Factory model'),
  puckConversationId: conversationId.optional().describe('Optional explicit Puck recipient for the authenticated Amp MCP. Defaults to the session recipient or host configuration; included in idempotency intent'),
};

function createMcp(controller, models) {
  const server = new McpServer({ name: 'droid-controller', version: '0.1.0' });
  const policy = `Approved workspace roots: ${JSON.stringify(controller.config.approvedDirectories)}. Autonomy ceiling: ${controller.config.maxAutonomy}. Default autonomy: ${controller.config.defaultAutonomy}. Host reasoning effort: ${controller.config.reasoningEffort ?? 'Droid default'}.`;
  const register = (name, description, inputSchema, handler, readOnlyHint = false) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: !readOnlyHint } }, async (args) => {
      try {
        const value = await handler(args);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        const details = { error: error.message };
        for (const key of ['code', 'headRunId', 'conflictingRunId', 'workspace']) if (error[key] !== undefined) details[key] = error[key];
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(details) }] };
      }
    });
  };
  const selection = 'Call droid_models when model selection is needed. Pass one of its current model IDs explicitly. Do not guess or reuse historical model IDs.';
  register('droid_start', `Start a durable asynchronous Droid task in an approved workspace. requestKey is idempotent for identical intent. Autonomy defaults to high (full supported service-user access) unless the host configures otherwise; explicitly request off for read-only work. Mutating runs require exclusive access to overlapping workspaces. Poll status; no completion push notification is provided. ${selection} ${policy}`, { requestKey, prompt, workspace: z.string().min(1), ...options }, (args) => controller.start(args));
  register('droid_continue', `Continue only the current head run of a linear Droid session, returning a NEW controller runId with the same underlying Droid UUID. Rejects active, unknown or stale-head sessions. To steer, cancel, wait for terminal status, then continue. ${selection} ${policy}`, { runId, requestKey, prompt, ...options }, (args) => controller.continue(args));
  register('droid_status', 'Inspect state, session UUID, recent events, partial text and separate stderr. Only terminal=true ends polling; idle/silence is never success.', { runId }, ({ runId }) => controller.status(runId), true);
  register('droid_result', 'Retrieve paginated final text and terminal outcome, or partial progress if no terminal result was stored. Failed/cancelled/unknown results remain inspectable.', { runId, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16000).default(12000) }, (args) => controller.result(args), true);
  register('droid_list', 'Discover durable controller runs, newest first, across client reconnects.', { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) }, (args) => controller.list(args), true);
  register('droid_cancel', 'Explicitly interrupt one active controller run. Returns immediately; poll until terminal. Falls back to process-group termination after configured grace. Does not undo edits.', { runId }, ({ runId }) => controller.cancel(runId));
  register('droid_models', 'List the models currently available to this authenticated Factory account and organization, discovered from the live Droid/Factory catalog. Excludes disabled models and historical or legacy IDs no longer available. Use one of these IDs when choosing a model for droid_start or droid_continue.', {}, () => models.get(), true);
  return server;
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Usage: node src/server.mjs --config /absolute/config.json');
  const config = loadConfig(process.argv[3]);
  const controller = new Controller(config);
  const models = new ModelCatalog({ ...config, stateDirectory: controller.dir });
  let listener, mcp, closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    listener?.close(); listener?.closeIdleConnections();
    await models.close();
    await controller.close();
    await mcp?.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  if (config.transport === 'stdio') {
    mcp = createMcp(controller, models);
    await mcp.connect(new StdioServerTransport());
    process.stdin.on('end', shutdown);
    return;
  }
  const expected = Buffer.from(`Bearer ${config.token}`);
  listener = http.createServer(async (req, res) => {
    const fail = (status, message) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(message); };
    const provided = Buffer.from(req.headers.authorization ?? '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return fail(401, 'Bearer authentication required');
    const local = `127.0.0.1:${listener.address().port}`;
    const hosts = [local, ...(config.publicUrl ? [new URL(config.publicUrl).host] : [])];
    const origins = [`http://${local}`, ...(config.publicUrl ? [new URL(config.publicUrl).origin] : [])];
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) return fail(403, 'Host or Origin not approved');
    if (req.url !== '/mcp') return fail(404, 'Not found');
    if (closing) return fail(503, 'Shutting down');
    // Stateless MCP HTTP: no unauthenticated SSE listener or client-owned task state.
    if (req.method !== 'POST') return fail(405, 'POST required');
    let size = 0, chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576) { fail(413, 'Request too large'); req.resume(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return fail(400, 'Invalid MCP request'); }
      const messages = Array.isArray(body) ? body : [body];
      if (!messages.length || messages.some((message) => !JSONRPCMessageSchema.safeParse(message).success)) return fail(400, 'Invalid MCP request');
      const server = createMcp(controller, models);
      // Use the public Web Standard transport so an SDK-internal failure can be
      // classified/sanitized BEFORE its HTTP response reaches the client.
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      server.server.onerror = (error) => console.error('MCP transport error:', error);
      const response = await transport.handleRequest(new Request(`http://${local}/mcp`, { method: 'POST', headers: req.headers }), { parsedBody: body });
      if (response.status === 400) {
        const data = await response.clone().json();
        // SDK 1.32's broad catch emits -32700 + internal error data. JSON and
        // envelopes were already validated above; this is not client input.
        if (data.error?.code === -32700) throw new Error(data.error.data ?? 'Unexpected MCP transport failure');
      }
      const payload = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(payload);
    } catch (error) {
      console.error('Internal MCP server error:', error);
      if (!res.headersSent) fail(500, 'Internal MCP server error');
      else res.end();
    }
  });
  listener.requestTimeout = 15000; listener.headersTimeout = 10000;
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(config.port, '127.0.0.1', resolve); });
  console.error(`Listening http://127.0.0.1:${listener.address().port}/mcp (authenticated; loopback only)`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
