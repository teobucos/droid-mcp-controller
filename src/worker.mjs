import { createSession, resumeSession, ProcessTransport, ToolConfirmationOutcome } from '@factory/droid-sdk/node';
import { approvedWorkspace } from './config.mjs';

const PUCK_TOOL = 'amp-puck___puck';
// Default deny: only puck is wanted from the Amp endpoint. Observed live, the thread-free
// external-agent endpoint also offers manage_amp (admin) and find_thread/read_thread (read other
// Amp threads); these are denied up front. The preflight then lists what the server really
// exposes, denies every other tool it finds (so a NEW Amp tool is blocked automatically) and
// verifies none remains usable; if that cannot be achieved the run fails closed. This is
// client-side filtering, not credential scoping.
const DENIED_TOOLS = ['amp-puck___manage_amp', 'amp-puck___find_thread', 'amp-puck___read_thread'];
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
    if (server && server.status !== 'connected') // Raw server text can carry ids, paths and OAuth state: report only recognised causes.
      throw new SetupError('amp_mcp_unreachable', `The Amp MCP server is ${server.status}${/archived/i.test(server.error ?? '') ? ' (the endpoint reports an archived thread)' : /unauthori[sz]ed|401/i.test(server.error ?? '') ? ' (the endpoint rejected the credentials)' : ''}`);
    if (!server) {
      // Observed live: an injected server that fails to start (no stored OAuth token for
      // this exact URL, a rejected connection) is dropped from the listing instead of
      // being reported as failed. Registered tools are then the only signal.
      const registered = await session.listMcpTools().catch(() => []);
      if (!registered.some((tool) => JSON.stringify(tool).includes('amp-puck'))) {
        if (attempt < 8) { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
        throw new SetupError('amp_mcp_not_started', 'The amp-puck MCP server did not start: it is not registered with Droid');
      }
    }
    const list = async () => {
      try { return await withTimeout(session.listTools(), 15000); } catch (error) {
        throw new SetupError('amp_mcp_setup_failed', /timed out/.test(error.message) ? 'MCP tool discovery timed out' : 'MCP tool discovery failed');
      }
    };
    const others = (all) => all.filter((tool) => tool.id.startsWith('amp-puck___') && tool.id !== PUCK_TOOL);
    let tools = await list();
    if (others(tools).some((tool) => tool.allowed)) {
      await session.updateSettings({ disabledToolIds: [...new Set([...DENIED_TOOLS, ...others(tools).map((tool) => tool.id)])] }).catch(() => {});
      tools = await list();
    }
    if (others(tools).some((tool) => tool.allowed)) throw new SetupError('amp_mcp_admin_tool_exposed', 'The Amp MCP exposes a tool other than puck to the agent and it could not be denied');
    if (tools.some((tool) => tool.id === PUCK_TOOL && tool.allowed)) return;
    // A server that is registered but lacks puck is definitive; an unlisted one may still be registering.
    if (server) throw new SetupError('amp_mcp_tool_missing', 'The Amp MCP is connected but does not expose the puck tool');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!cancelled) throw new SetupError('amp_mcp_unreachable', 'The Amp MCP did not finish connecting in time');
}

// Only the puck tool, only report-to-recipient or read_reply: nothing broader than the explicit route.
function isOwnPuckCall(params, replyTo) {
  const uses = params.toolUses ?? [];
  return uses.length > 0 && uses.every(({ toolUse, confirmationType }) => confirmationType === 'mcp_tool' && toolUse?.name === PUCK_TOOL
    && (toolUse.input?.action === 'read_reply' || (toolUse.input?.action === 'send' && toolUse.input?.params?.conversationID === replyTo)));
}

process.on('message', async (msg) => {
  if (msg.cancel) {
    cancelled = true;
    if (session) await session.interrupt().catch(() => {});
    else abort.abort(new Error('Cancelled during session setup'));
    return;
  }
  const { run, prompt, config } = msg;
  const routed = Boolean(run.replyTo && config.amp);
  let terminal;
  let failure;
  let failureCode;
  const toolNames = new Map();
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
        disabledToolIds: DENIED_TOOLS,
      } : {}),
      permissionHandler(params) {
        // Routed sessions may always report to their own recipient, even when read-only;
        // everything else still needs autonomy high, and only ever as a single use.
        const proceed = (run.autonomy === 'high' || (routed && isOwnPuckCall(params, run.replyTo))) && params.options.some((option) => option.value === ToolConfirmationOutcome.ProceedOnce);
        void event({ type: proceed ? 'permission_approved_once' : 'permission_declined', details: JSON.stringify(params).slice(0, 4000) }).catch(() => {});
        return proceed ? ToolConfirmationOutcome.ProceedOnce : ToolConfirmationOutcome.Cancel;
      },
      askUserHandler(params) {
        // Fail closed: never guess answers. The questions stay visible to Puck via status.
        const questions = (params.questions ?? []).map((q) => ({ question: String(q.question ?? '').slice(0, 1000), options: (q.options ?? []).map((o) => String(o).slice(0, 200)).slice(0, 20) }));
        void send({ kind: 'question', questions }).catch(() => {});
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
    if (routed) {
      await preflightAmpMcp();
      if (cancelled) throw new Error('Cancelled before turn submission');
      await event({ type: 'puck_mcp_ready', tool: PUCK_TOOL });
      submitted += `\n\n[Controller coordination context]\nPuck owns orchestration. Use the actual Amp MCP tool amp-puck___puck; never manage_amp or Amp CLI messaging. Explicit recipient conversationID: ${run.replyTo}. Controller sessionId: ${run.sessionId}. Controller runId: ${run.runId}. Include these handles and any task marker in reports/questions. Calling amp-puck___puck to send to that recipient (or read_reply) is pre-approved for this session even in read-only/Spec mode: call it directly and never propose a plan or exit Spec mode just to report. When reporting or asking Puck, call {action:"send",params:{conversationID:"${run.replyTo}",message:"your concise report or actual question"}}. If a reply is needed and send returns queued/working, use {action:"read_reply",params:{replyHandle:"the handle returned by send"}}; retry reads, never duplicate sends or use latest-active routing. Do not claim delivery from mere acceptance. If a reply cannot be retrieved, report the blocker and end this turn; Puck can send a follow-up message to this session after it settles. Never guess AskUser answers. MCP failures must appear in your final result. High autonomy grants existing service-user access, not root privileges, another user's workspace, or new authorization.\n`;
    }
    for await (const message of session.stream(submitted)) {
      if (message.type === 'result') terminal = message;
      else {
        if (routed) observe(message);
        await event({ type: message.type, ...(message.text ? { text: message.text.slice(-4000) } : {}), ...(message.name ? { tool: message.name } : {}), ...(typeof message.message === 'string' ? { message: message.message.slice(-4000) } : {}) });
      }
    }
    if (!terminal) throw new Error('Stream ended without a terminal Droid result');
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
