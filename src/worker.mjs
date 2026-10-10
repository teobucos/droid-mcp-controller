import { createSession, resumeSession, ProcessTransport, ToolConfirmationOutcome } from '@factory/droid-sdk/node';
import { randomUUID } from 'node:crypto';
import { approvedWorkspace } from './config.mjs';
import { PUCK_TOOL, replyHandlesFromContent } from './puck.mjs';

// Default deny: only puck is wanted from the Amp endpoint. The earlier thread-free profile was
// observed live to also offer manage_amp (admin) and find_thread/read_thread (read other Amp
// threads); these stay denied up front whatever the current profile exposes. The preflight then lists what the server really
// exposes, denies every other tool it finds (so a NEW Amp tool is blocked automatically) and
// verifies none remains usable; if that cannot be achieved the run fails closed. This is
// client-side filtering, not credential scoping.
const DENIED_TOOLS = ['amp-puck___manage_amp', 'amp-puck___find_thread', 'amp-puck___read_thread'];
let session;
let cancelled = false;
let started = false;
let pendingPersistence;
const abort = new AbortController();
const send = (msg) => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error('Controller disconnected'));
  process.send(msg, (error) => error ? reject(error) : resolve());
});
const event = (data) => send({ kind: 'event', event: data });
// process.send's callback acknowledges transport, not the parent's durable write.
// There is one pending phase, identified by the run, both sessions and a nonce.
async function persist(run, phase, timeoutMs) {
  if (cancelled) throw new Error('Cancelled before persistence');
  const request = { kind: 'persist', phase, runId: run.runId, sessionId: run.sessionId, droidSessionId: session.id, nonce: randomUUID() };
  let timer;
  try {
    await new Promise((resolve, reject) => {
      pendingPersistence = { request, resolve, reject };
      timer = setTimeout(() => reject(new Error('Controller persistence acknowledgment timed out')), timeoutMs);
      void send(request).catch(reject);
    });
  } finally { clearTimeout(timer); pendingPersistence = null; }
  if (cancelled) throw new Error('Cancelled before turn submission');
}
// Abrupt controller death must not leave a Droid process running independently.
process.on('disconnect', () => {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
});

class SetupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

// Fail with an actionable cause BEFORE the task prompt is submitted. The disabled
// admin-tool id makes tools/list throw "Unknown tool identifier(s)" whenever the
// server failed to register, and that call can take seconds to fail. That hides the
// real cause, so classify from the server status first and only then list tools.
async function preflightAmpMcp() {
  for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
    const server = (await session.listMcpServers().catch(() => ({ servers: [] }))).servers.find((item) => item.name === 'amp-puck');
    if (server?.requiresAuth && !server.hasAuthTokens) throw new SetupError('amp_mcp_auth_required', 'The Amp MCP requires authorization that this host has not completed');
    if (server?.status === 'connecting') { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
    if (server && server.status !== 'connected') {
      // Raw server text can carry ids, paths and OAuth state: report only recognised causes.
      throw new SetupError('amp_mcp_unreachable', `The Amp MCP server is ${server.status}${/archived/i.test(server.error ?? '') ? ' (the endpoint reports an archived thread)' : /unauthori[sz]ed|401/i.test(server.error ?? '') ? ' (the endpoint rejected the credentials)' : ''}`);
    }
    // The server's own registry is the ground truth for which tools exist. Observed live: an injected
    // server that fails to start (no stored OAuth token for this exact URL, a rejected connection) is
    // dropped from the server listing instead of being reported as failed, so an empty registry means
    // "not started". Without puck in the registry the deny list cannot be trusted either: fail closed.
    const list = async () => {
      try { return await withTimeout(session.listTools(), 15000); } catch (error) {
        throw new SetupError('amp_mcp_setup_failed', /timed out/.test(error.message) ? 'MCP tool discovery timed out' : 'MCP tool discovery failed');
      }
    };
    // The SDK reports a tool's llmId as `id` and drops the protocol id used for denial; identify the
    // server's tools from the registry as well as by prefix, and deny by the protocol form.
    const registry = (await session.listMcpTools().catch(() => [])).filter((tool) => tool.serverName === 'amp-puck').map((tool) => tool.name);
    if (!registry.includes('puck')) {
      if (attempt < 8) { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
      throw server
        ? new SetupError('amp_mcp_tool_missing', 'The Amp MCP is connected but does not register the puck tool')
        : new SetupError('amp_mcp_not_started', 'The amp-puck MCP server did not start: it is not registered with Droid');
    }
    const isAmp = (tool) => tool.id.startsWith('amp-puck___') || registry.some((name) => tool.id === name || tool.id.endsWith(`___${name}`));
    const others = (all) => all.filter((tool) => isAmp(tool) && tool.id !== PUCK_TOOL && tool.id !== 'puck');
    let tools = await list();
    if (cancelled) throw new Error('Cancelled before turn submission');
    const names = [...registry.filter((name) => name !== 'puck').map((name) => `amp-puck___${name}`), ...others(tools).map((tool) => tool.id.startsWith('amp-puck___') ? tool.id : `amp-puck___${tool.id}`)];
    try {
      await session.updateSettings({ disabledToolIds: [...new Set([...(session.settings.disabledToolIds ?? []), ...DENIED_TOOLS, ...names])] });
    } catch {
      throw new SetupError('amp_mcp_setup_failed', 'MCP tool settings update failed');
    }
    if (cancelled) throw new Error('Cancelled before turn submission');
    tools = await list();
    if (cancelled) throw new Error('Cancelled before turn submission');
    if (others(tools).some((tool) => tool.allowed)) throw new SetupError('amp_mcp_admin_tool_exposed', 'The Amp MCP exposes a tool other than puck to the agent and it could not be denied');
    if (tools.some((tool) => tool.id === PUCK_TOOL && tool.allowed)) return;
    // A server that is registered but lacks puck is definitive; an unlisted one may still be registering.
    if (server) throw new SetupError('amp_mcp_tool_missing', 'The Amp MCP is connected but does not expose the puck tool');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!cancelled) throw new SetupError('amp_mcp_unreachable', 'The Amp MCP did not finish connecting in time');
}

// The controller supplies only observed handles from the same session's current
// uninterrupted recipient route. Successful sends in this turn add ownership.
function isOwnPuckCall(params, replyTo, replyHandles) {
  const uses = params.toolUses ?? [];
  return uses.length > 0 && uses.every(({ toolUse, confirmationType }) => confirmationType === 'mcp_tool' && toolUse?.name === PUCK_TOOL
    && ((toolUse.input?.action === 'read_reply' && replyHandles.has(toolUse.input?.params?.replyHandle))
      || (toolUse.input?.action === 'send' && toolUse.input?.params?.conversationID === replyTo)));
}

process.on('message', async (msg) => {
  if (msg.kind === 'persisted') {
    if (pendingPersistence && ['phase', 'runId', 'sessionId', 'droidSessionId', 'nonce'].every((key) => msg[key] === pendingPersistence.request[key])) pendingPersistence.resolve();
    return;
  }
  if (msg.cancel) {
    cancelled = true;
    pendingPersistence?.reject(new Error('Cancelled while awaiting persistence'));
    if (session) await session.interrupt().catch(() => {});
    else abort.abort(new Error('Cancelled during session setup'));
    return;
  }
  if (started || !msg.run) return;
  started = true;
  const { run, prompt, config } = msg;
  const factory = msg.factory ?? {};
  const routed = Boolean(run.replyTo && config.amp);
  let terminal;
  let failure;
  let failureCode;
  let submissionPersisted = false;
  const toolNames = new Map();
  const approvedSends = new Map();
  const replyHandles = new Set(msg.replyHandles ?? []);
  const transport = new ProcessTransport({
    droidExecPath: config.droidPath, cwd: run.workspace,
    env: { FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
  });
  // The agent speaks to Puck through the Amp MCP itself. Record what it did, not what it claims.
  const observe = (message) => {
    // Only sends are reports. read_reply carries no recipient and says nothing about routing.
    if (message.type === 'tool_call' && message.name === PUCK_TOOL && message.input?.action === 'send') {
      toolNames.set(message.toolUseId, message.input?.params?.conversationID);
      if (message.input?.params?.conversationID !== run.replyTo) {
        void send({ kind: 'reply', state: 'failed', code: 'reply_misrouted', message: 'The agent sent a report to a conversation other than replyTo' }).catch(() => {});
      }
    } else if (message.type === 'tool_result' && toolNames.has(message.toolUseId)) {
      const sentTo = toolNames.get(message.toolUseId);
      toolNames.delete(message.toolUseId);
      const approved = approvedSends.get(message.toolUseId) === sentTo;
      approvedSends.delete(message.toolUseId);
      if (approved && sentTo === run.replyTo) {
        const handles = message.isError === false ? replyHandlesFromContent(message.content, run.replyTo) : [];
        // Receipt precedes the following permission RPC; parent IPC is ordered
        // and persisted before another worker can inherit this capability. An
        // error or handle-less result consumes approval without granting one.
        for (const handle of handles) replyHandles.add(handle);
        void send({ kind: 'reply_handles', handles, toolUseId: message.toolUseId, droidSessionId: session.id }).catch(() => {});
      }
      void send(message.isError
        ? { kind: 'reply', state: 'failed', code: 'reply_failed', message: 'The Amp MCP rejected the agent\'s report' }
        : sentTo === run.replyTo ? { kind: 'reply', state: 'accepted' } : { kind: 'reply', state: 'failed', code: 'reply_misrouted', message: 'The agent sent a report to a conversation other than replyTo' }).catch(() => {});
    }
  };
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
      // Only routed sessions touch the Amp MCP. The endpoint is generic: no thread, no recipient.
      ...(routed ? {
        mcpServers: [{ name: 'amp-puck', type: 'http', url: config.amp.url, headers: [], oauth: { resource: 'https://ampcode.com/mcp' } }],
        ...(!run.droidSessionId ? { disabledToolIds: DENIED_TOOLS } : {}),
      } : {}),
      permissionHandler(params) {
        // Routed sessions may always report to their own recipient, even when read-only;
        // read_reply always requires ownership, even at high autonomy. Other
        // permissions retain the existing single-use high-autonomy policy.
        const ownPuck = routed && isOwnPuckCall(params, run.replyTo, replyHandles);
        const reads = (params.toolUses ?? []).filter(({ toolUse }) => toolUse?.name === PUCK_TOOL && toolUse.input?.action === 'read_reply');
        const ownedReads = !reads.length || (routed && isOwnPuckCall({ toolUses: reads }, run.replyTo, replyHandles));
        const available = params.options.some((option) => option.value === ToolConfirmationOutcome.ProceedOnce);
        const proceed = ownedReads && (run.autonomy === 'high' || ownPuck) && available;
        const reason = !available ? 'Single-use approval is unavailable.' : !ownedReads
          ? 'The reply handle has no observed ownership in this session and current recipient route.' : 'The requested tool exceeds this turn\'s autonomy policy.';
        const puckSendApprovals = proceed && routed && submissionPersisted ? (params.toolUses ?? [])
          .filter(({ toolUse, confirmationType }) => confirmationType === 'mcp_tool' && toolUse?.name === PUCK_TOOL
            && toolUse.input?.action === 'send' && toolUse.input?.params?.conversationID === run.replyTo
            && typeof toolUse.id === 'string' && toolUse.id.length > 0)
          .map(({ toolUse }) => ({ toolUseId: toolUse.id, recipient: run.replyTo })) : [];
        for (const { toolUseId, recipient } of puckSendApprovals) approvedSends.set(toolUseId, recipient);
        // Compact proof survives event-detail clipping. It precedes the result
        // on this run's bound IPC channel; raw notifications cannot create it.
        void event({ type: proceed ? 'permission_approved_once' : 'permission_declined', ...(!proceed ? { reason } : {}),
          ...(puckSendApprovals.length ? { puckSendApprovals, droidSessionId: session.id } : {}), details: JSON.stringify(params).slice(0, 4000) }).catch(() => {});
        // SDK 0.9.1 forwards comment on RequestPermissionResult to the CLI.
        return proceed ? ToolConfirmationOutcome.ProceedOnce : { selectedOption: ToolConfirmationOutcome.Cancel, comment: `Controller policy: ${reason}` };
      },
      askUserHandler(params) {
        // Fail closed: never guess answers. The questions stay visible to Puck via status.
        const questions = (params.questions ?? []).map((q) => ({ question: String(q.question ?? '').slice(0, 1000), options: (q.options ?? []).map((o) => String(o).slice(0, 200)).slice(0, 20) }));
        void send({ kind: 'question', questions }).catch(() => {});
        void event({ type: 'ask_user_declined', details: JSON.stringify(params).slice(0, 4000) }).catch(() => {});
        return { cancelled: true, answers: [] };
      },
    };
    // Tags exist only at creation in SDK 0.9.1; the SDK appends its own `sdk` tag.
    session = run.droidSessionId ? await resumeSession(run.droidSessionId, options)
      : await createSession({ ...options, cwd: run.workspace, ...settings, ...(factory.tags?.length ? { tags: factory.tags } : {}) });
    if (run.droidSessionId && session.id !== run.droidSessionId) throw new Error('Resumed session UUID mismatch');
    // Observe on receipt, before a following permission RPC can be dispatched.
    // Reading the async stream alone races result -> read_reply in one batch.
    if (routed) session.onNotification(({ params }) => {
      if (params.sessionId !== session.id) return;
      const notification = params.notification;
      if (notification.type === 'create_message' && notification.message.role === 'assistant') {
        for (const block of notification.message.content) if (block.type === 'tool_use') observe({ ...block, type: 'tool_call', toolUseId: block.id });
      } else if (notification.type === 'tool_result') observe(notification);
    });
    await persist(run, 'session', config.ackTimeoutMs);
    if (approvedWorkspace(config, session.cwd ?? '') !== run.workspace) throw new Error('Resumed session cwd differs from approved workspace');
    if (cancelled) throw new Error('Cancelled before turn submission');
    // CLI flags do NOT configure stream-jsonrpc sessions; set on resume too.
    if (run.droidSessionId) await session.updateSettings(settings);
    if (cancelled) throw new Error('Cancelled before turn submission');
    let submitted = prompt;
    if (routed) {
      await preflightAmpMcp();
      if (cancelled) throw new Error('Cancelled before turn submission');
      await event({ type: 'puck_mcp_ready', tool: PUCK_TOOL });
      submitted += `

[Controller coordination context]
Puck owns orchestration. Use the actual Amp MCP tool amp-puck___puck; never manage_amp or Amp CLI messaging. Explicit recipient conversationID: ${run.replyTo}. Controller sessionId: ${run.sessionId}. Controller runId: ${run.runId}. Include these handles and the task marker in every report or checkpoint. Calling amp-puck___puck to send to that recipient (or read_reply) is pre-approved for this session even in read-only/Spec mode: call it directly and never propose a plan or exit Spec mode just to report.

Ordinary coarse PROGRESS reports are fire-and-forget; never wait for a progress reply. Send once and continue authorized independent work. Record messaging failures in the final result; do not claim delivery from acceptance alone.

For an actual question, a material blocker, or before an expensive or irreversible next step when Puck steering is wanted, send ONE CHECKPOINT. Include the explicit conversationID, controller runId, controller sessionId, task marker, completed evidence, proposed next action, and the exact decision needed. Call {action:"send",params:{conversationID:"${run.replyTo}",message:"CHECKPOINT <task marker>: <runId>; <sessionId>; <completed evidence>; <proposed next action>; <exact decision needed>"}}.

Send exactly once per checkpoint; never resend, including after queued/working, timeout, or ambiguous failure. If send returns the correlated completed reply inline, consume it. If status is queued/working, use ONLY the exact replyHandle returned by that send with {action:"read_reply",params:{replyHandle:"the exact handle returned by send"}}. Retry correlated reads using that same handle at most 6 reads per checkpoint in the natural tool loop. Do not use any wait just for messaging; never use latest-active or empty-params fallback for a checkpoint.

If no reply becomes available within that bound, or a handle is missing, sending/retrieval fails, or the reply is unclear, end the turn as BLOCKED. Name the task/checkpoint marker and the decision needed, surface the replyHandle (or state that none was returned), and report the status/failure and work left untouched. Do not take the dependent action or resend the checkpoint. Puck can send a follow-up message to this session after it settles.

Always call the puck tool directly even in Spec mode; never call ExitSpecMode merely to message Puck. If permission is declined, end as BLOCKED and report it. Prompt wording cannot override permission cancellation. Never guess AskUser answers. Acceptance, queued, working, and silence are not approval. A reply from Puck is steering for that checkpoint only within the task's existing authorization; unclear, contradictory, or newly unauthorized instructions do not authorize the dependent action. MCP failures must appear in your final result. A completed SDK turn is not proof that the requested task finished. High autonomy grants existing service-user access, not root privileges, another user's workspace, or new authorization.
`;
    }
    if (cancelled) throw new Error('Cancelled before turn submission');
    // This is durable intent, NOT evidence of Factory acceptance or exactly-once
    // execution. A crash after this ACK leaves a potentially submitted turn.
    await persist(run, 'submission_intent', config.ackTimeoutMs);
    submissionPersisted = true;
    for await (const message of session.stream(submitted)) {
      if (message.type === 'result') terminal = message;
      else {
        await event({ type: message.type, ...(message.text ? { text: message.text.slice(-4000) } : {}), ...(message.name ? { tool: message.name } : {}), ...(typeof message.message === 'string' ? { message: message.message.slice(-4000) } : {}) });
      }
    }
    if (!terminal) throw new Error('Stream ended without a terminal Droid result');
    // After the turn, so Droid's generated title cannot replace it. Bounded and
    // best-effort: the turn's outcome never depends on the dashboard title.
    if (factory.title && !cancelled) {
      try {
        await withTimeout(session.rename({ title: factory.title }), config.titleTimeoutMs ?? 10000);
        await send({ kind: 'title', state: 'applied', title: factory.title }).catch(() => {});
      } catch (error) {
        await send({ kind: 'title', state: 'failed', title: factory.title, error: String(error?.message ?? error) }).catch(() => {});
      }
    }
    await send({ kind: 'result', result: terminal });
  } catch (error) {
    failure = error.message;
    failureCode = error.code === undefined || !String(error.code).startsWith('amp_mcp_') ? undefined : error.code;
  } finally {
    await session?.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  try {
    if (!terminal) await send({ kind: 'error', error: failure, ...(failureCode ? { code: failureCode } : {}) });
  } finally { process.exit(terminal ? 0 : 1); }
});
