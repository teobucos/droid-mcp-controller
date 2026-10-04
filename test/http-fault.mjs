// Loaded only by the E2E child process: inject internal SDK faults, not tool errors.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

for (const Transport of [StreamableHTTPServerTransport, WebStandardStreamableHTTPServerTransport]) {
  const start = Transport.prototype.start;
  Transport.prototype.start = async function () {
    if (process.env.MOCK_HTTP_FAULT === 'connect') throw new Error('PRIVATE_INTERNAL_PATH /private/controller/setup');
    await start.call(this);
    if (process.env.MOCK_HTTP_FAULT === 'dispatch') {
      this.onmessage = () => { throw new Error('PRIVATE_INTERNAL_PATH /private/controller/dispatch'); };
    }
  };
}
