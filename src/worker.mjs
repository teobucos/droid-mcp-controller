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
  const { run, prompt, config } = msg;
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
      ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
    };
    const options = {
      transport, abortSignal: abort.signal, disableBuiltinSkills: true,
      ...(config.puck ? {
        mcpServers: [{ name: 'amp-puck', type: 'http', url: config.puck.url, headers: [], oauth: { resource: 'https://ampcode.com/mcp' } }],
        disabledToolIds: ['amp-puck___manage_amp'],
      } : {}),
      permissionHandler(params) {
        const proceed = run.autonomy === 'high' && params.options.some((option) => option.value === ToolConfirmationOutcome.ProceedOnce);
        void event({ type: proceed ? 'permission_approved_once' : 'permission_declined', details: JSON.stringify(params).slice(0, 4000) }).catch(() => {});
        return proceed ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
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
    let submitted = prompt;
    if (config.puck) {
      let ready = false;
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
        const tools = await session.listTools();
        if (tools.some((tool) => tool.id.startsWith('amp-puck___') && tool.id !== 'amp-puck___puck' && tool.allowed)) {
          throw new Error('Puck MCP exposes an unapproved Amp tool; no task was submitted');
        }
        if (tools.some((tool) => tool.id === 'amp-puck___puck' && tool.allowed)) { ready = true; break; }
        // SDK-injected servers may not appear in the project/server listing;
        // the actual registered tool catalog is authoritative for availability.
        const { servers } = await session.listMcpServers();
        const server = servers.find((item) => item.name === 'amp-puck');
        if (server && (server.status !== 'connecting' || (server.requiresAuth && !server.hasAuthTokens))) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!ready || cancelled) throw new Error('Authenticated Puck MCP is unavailable; no task was submitted');
      await event({ type: 'puck_mcp_ready', tool: 'amp-puck___puck', conversationId: run.puckConversationId });
      submitted += `\n\n[Controller coordination context]\nPuck owns orchestration. Use the actual Amp MCP tool amp-puck___puck; never manage_amp or Amp CLI messaging. Explicit recipient conversationID: ${run.puckConversationId}. Controller runId: ${run.runId}. Droid sessionId: ${session.id}. Include these handles and any task marker in reports/questions. When reporting or asking Puck, call {action:"send",params:{conversationID:"${run.puckConversationId}",message:"your concise report or actual question"}}. If a reply is needed and send returns queued/working, use {action:"read_reply",params:{replyHandle:"the handle returned by send"}}; retry reads, never duplicate sends or use latest-active routing. Do not claim delivery from mere acceptance. If a reply cannot be retrieved, report the blocker and end this turn; Puck can continue the current session head after terminal status. Never guess AskUser answers. MCP failures must appear in your final result. High autonomy grants existing service-user access, not root privileges, another user's workspace, or new authorization.\n`;
    }
    for await (const message of session.stream(submitted)) {
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
