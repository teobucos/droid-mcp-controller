import { createSession, resumeSession, ProcessTransport, ToolConfirmationOutcome } from '@factory/droid-sdk/node';
import { approvedWorkspace } from './config.mjs';

let session;
let cancelled = false;
const abort = new AbortController();
const send = (msg) => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error('Controller disconnected'));
  process.send(msg, (error) => error ? reject(error) : resolve());
});
const event = (data) => send({ kind: 'event', event: data });
// Abrupt controller death must not leave a Droid process running independently.
process.on('disconnect', () => {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
});
process.on('message', async (msg) => {
  if (msg.cancel) {
    cancelled = true;
    if (session) await session.interrupt().catch(() => {});
    else abort.abort(new Error('Cancelled during session setup'));
    return;
  }
  const { run, config } = msg;
  let terminal;
  let failure;
  const transport = new ProcessTransport({
    droidExecPath: config.droidPath, cwd: run.workspace,
    env: { FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
  });
  try {
    await transport.connect();
    // The SDK observability sink deliberately redacts stderr content. Capture
    // the exposed process pipe instead, separately from JSON-RPC stdout.
    transport.getManagedProcess().childProcess.stderr.on('data', (data) => {
      void send({ kind: 'stderr', text: data.toString() }).catch(() => {});
    });
    const settings = {
      interactionMode: run.autonomy === 'off' ? 'spec' : 'auto',
      autonomyLevel: run.autonomy,
      ...(run.model ? { modelId: run.model } : {}),
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    };
    const options = {
      transport, abortSignal: abort.signal, disableBuiltinSkills: true,
      permissionHandler(params) {
        void event({ type: 'permission_declined', details: JSON.stringify(params).slice(0, 4000) }).catch(() => {});
        return ToolConfirmationOutcome.Cancel;
      },
      askUserHandler(params) {
        void event({ type: 'ask_user_declined', details: JSON.stringify(params).slice(0, 4000) }).catch(() => {});
        return { cancelled: true, answers: [] };
      },
    };
    session = run.droidSessionId ? await resumeSession(run.droidSessionId, options) : await createSession({ ...options, cwd: run.workspace, ...settings });
    if (run.droidSessionId && session.id !== run.droidSessionId) throw new Error('Resumed session UUID mismatch');
    await send({ kind: 'session', sessionId: session.id });
    if (approvedWorkspace(config, session.cwd ?? '') !== run.workspace) throw new Error('Resumed session cwd differs from approved workspace');
    if (cancelled) throw new Error('Cancelled before turn submission');
    // CLI flags do NOT configure stream-jsonrpc sessions; set on resume too.
    if (run.droidSessionId) await session.updateSettings(settings);
    if (cancelled) throw new Error('Cancelled before turn submission');
    for await (const message of session.stream(run.prompt)) {
      if (message.type === 'result') terminal = message;
      else await event({ type: message.type, ...(message.text ? { text: message.text.slice(-4000) } : {}), ...(message.name ? { tool: message.name } : {}), ...(typeof message.message === 'string' ? { message: message.message.slice(-4000) } : {}) });
    }
    if (!terminal) throw new Error('Stream ended without a terminal Droid result');
    await send({ kind: 'result', result: terminal });
  } catch (error) {
    failure = error.message;
  } finally {
    await session?.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  try {
    if (!terminal) await send({ kind: 'error', error: failure });
  } finally { process.exit(terminal ? 0 : 1); }
});
