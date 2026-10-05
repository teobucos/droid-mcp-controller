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
        let tools = await session.listTools();
        if (cancelled) throw new Error('Cancelled before turn submission');
        // Preserve restored disables; discover tool ids instead of pre-disabling
        // an id that may not be registered in the current profile.
        const disabledToolIds = [...new Set([
          ...(session.settings.disabledToolIds ?? []),
          ...tools.filter((tool) => tool.id.startsWith('amp-puck___') && tool.id !== 'amp-puck___puck').map((tool) => tool.id),
        ])];
        await session.updateSettings({ disabledToolIds });
        if (cancelled) throw new Error('Cancelled before turn submission');
        tools = await session.listTools();
        if (cancelled) throw new Error('Cancelled before turn submission');
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
      submitted += `

[Controller coordination context]
Puck owns orchestration. Use the actual Amp MCP tool amp-puck___puck; never manage_amp or Amp CLI messaging. Explicit recipient conversationID: ${run.puckConversationId}. Controller runId: ${run.runId}. Droid sessionId: ${session.id}. Include these handles and the task marker in every report or checkpoint.

Ordinary coarse PROGRESS reports are fire-and-forget; never wait for a progress reply. Send once and continue authorized independent work. Record messaging failures in the final result; do not claim delivery from acceptance alone.

For an actual question, a material blocker, or before an expensive or irreversible next step when Puck steering is wanted, send ONE CHECKPOINT. Include the explicit conversationID, controller runId, Droid sessionId, task marker, completed evidence, proposed next action, and the exact decision needed. Call {action:"send",params:{conversationID:"${run.puckConversationId}",message:"CHECKPOINT <task marker>: <runId>; <sessionId>; <completed evidence>; <proposed next action>; <exact decision needed>"}}.

Send exactly once per checkpoint; never resend, including after queued/working, timeout, or ambiguous failure. If send returns the correlated completed reply inline, consume it. If status is queued/working, use ONLY the exact replyHandle returned by that send with {action:"read_reply",params:{replyHandle:"the exact handle returned by send"}}. Retry correlated reads using that same handle at most 6 reads per checkpoint in the natural tool loop. Do not use any wait just for messaging; never use latest-active or empty-params fallback for a checkpoint.

If no reply becomes available within that bound, or a handle is missing, sending/retrieval fails, or the reply is unclear, end the turn as BLOCKED. Name the task/checkpoint marker and the decision needed, surface the replyHandle (or state that none was returned), and report the status/failure and work left untouched. Do not take the dependent action or resend the checkpoint. Puck can continue the current session head after terminal status.

Always call the puck tool directly even in Spec mode; never call ExitSpecMode merely to message Puck. If permission is declined, end as BLOCKED and report it. Prompt wording cannot override off-mode permission cancellation. Never guess AskUser answers. Acceptance, queued, working, and silence are not approval. A reply from Puck is steering for that checkpoint only within the task's existing authorization; unclear, contradictory, or newly unauthorized instructions do not authorize the dependent action. MCP failures must appear in the final result. A completed SDK turn is not proof that the requested task finished. High autonomy grants existing service-user access, not root privileges, another user's workspace, or new authorization.
`;
    }
    if (cancelled) throw new Error('Cancelled before turn submission');
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
