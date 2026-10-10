// Test-only SDK transport observation, enabled solely by the verify-* scripts.
// No prompt, result content, headers, credentials, or session UUIDs are logged.
import { appendFileSync } from 'node:fs';
import { ProcessTransport } from '@factory/droid-sdk/node';

if (process.env.DROID_VERIFY_WIRE) {
  const pending = new WeakMap();
  const record = (data) => appendFileSync(process.env.DROID_VERIFY_WIRE, `${JSON.stringify({ pid: process.pid, ...data })}\n`, { mode: 0o600 });
  const send = ProcessTransport.prototype.send;
  ProcessTransport.prototype.send = async function (line) {
    const request = JSON.parse(line);
    if (!pending.has(this)) pending.set(this, new Map());
    if (request.type === 'request') pending.get(this).set(request.id, request.method);
    await send.call(this, line);
    record({ kind: 'sent', method: request.method, cliPid: this.getManagedProcess().childProcess.pid, attachesMcp: Boolean(request.params?.mcpServers?.length) });
  };
  const onMessage = ProcessTransport.prototype.onMessage;
  ProcessTransport.prototype.onMessage = function (handler) {
    return onMessage.call(this, (line) => {
      const message = JSON.parse(line);
      if (message.type === 'response' && pending.get(this)?.has(message.id)) {
        record({ kind: 'response', method: pending.get(this).get(message.id), success: !message.error });
        pending.get(this).delete(message.id);
      }
      handler(line);
    });
  };
}
