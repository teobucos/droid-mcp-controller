import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.mjs';
import { createMcp } from './mcp.mjs';
import { Controller } from './controller.mjs';
import { ModelCatalog } from './models.mjs';

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Usage: node src/server.mjs --config /absolute/config.json');
  const config = loadConfig(process.argv[3]);
  const models = new ModelCatalog(config);
  const controller = new Controller(config, models);
  let listener, mcp, closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    controller.stopping = true; // before anything else awaits: in-flight requests must not admit work
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
