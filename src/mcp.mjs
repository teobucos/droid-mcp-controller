import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describeError, toolFailure } from './errors.mjs';
import { defineTools } from './tools.mjs';

// Validate with our own error shape: a strict, actionable body instead of SDK text.
class PuckMcpServer extends McpServer {
  async validateToolInput(tool, args, name) {
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (parsed.success) return parsed.data;
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
    throw new Error(JSON.stringify({ error: describeError('invalid_argument', `${name}: ${message}`.slice(0, 1000)) }));
  }
}

export const SERVER_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function createMcp(controller, models) {
  const server = new PuckMcpServer({ name: 'droid-mcp', version: SERVER_VERSION });
  for (const tool of defineTools(controller, models)) {
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.input, ...(tool.output ? { outputSchema: tool.output } : {}),
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, openWorldHint: !tool.readOnly },
    }, async (args, extra) => {
      try {
        const value = await tool.run(args, extra);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        return toolFailure(error);
      }
    });
  }
  return server;
}
