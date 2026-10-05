// One error type for the whole tool surface: a stable code, a human message and
// the next action for the caller. Nothing else (paths, stacks, SDK text) leaves
// the controller; unexpected exceptions are logged and become `internal_error`.
const ACTIONS = {
  invalid_argument: ['Fix the arguments and call the tool again; the message names the offending field.', false],
  invalid_cursor: ['Restart pagination without a cursor, or pass the nextCursor returned by the previous page unchanged.', false],
  unknown_session: ['Use a session handle returned by droid_create_session or droid_find_sessions.', false],
  unknown_run: ['Use a runId returned by a deprecated droid_* tool or by latestRun.runId.', false],
  request_key_conflict: ['Reuse a requestKey only with identical arguments; pick a new requestKey for new work.', false],
  workspace_not_approved: ['Call droid_list_workspaces and choose a directory inside one of the returned roots.', false],
  autonomy_exceeds_ceiling: ['Request an autonomy level at or below policy.maxAutonomy (see droid_list_workspaces).', false],
  model_unavailable: ['Call droid_models and pass one of the returned ids.', false],
  reasoning_unsupported: ['Pass a reasoningEffort the chosen model supports (see droid_models), or omit it.', false],
  model_discovery_failed: ['Retry shortly; if it persists the controller host needs Factory re-authentication.', true],
  reply_back_unavailable: ['Use replyTo:null for detached work, or ask the operator to configure ampMcp on the controller host.', false],
  session_busy: ['Wait for the session to settle (droid_wait_for_sessions) or cancel it first.', true],
  session_unknown_outcome: ['The controller stopped mid-turn, so the result is unknown. Inspect the workspace and history locally; nothing was replayed. Start a new session to continue the work.', false],
  not_session_head: ['Continue from the current head run named by headRunId.', false],
  queue_full: ['Too much work is queued. Wait for sessions to settle (droid_wait_for_sessions) and retry.', true],
  shutting_down: ['The controller is stopping; retry after it restarts.', true],
  internal_error: ['Retry once; if it persists report it to the controller operator (details are in the controller log).', true],
  // Run-level failures surfaced as latestRun.error.
  amp_mcp_unreachable: ['The Amp MCP endpoint rejected or could not be reached. Check that ampMcp.url is thread-free and ampcode.com is reachable, then send the message again. No task prompt was submitted.', true],
  amp_mcp_auth_required: ['The controller host has no Amp MCP authorization. The operator must complete the supported OAuth sign-in for amp-puck on the host; then send the message again. No task prompt was submitted.', false],
  amp_mcp_not_started: ['The amp-puck MCP server did not start. Factory stores Amp OAuth tokens per exact endpoint URL, so the operator must complete the supported sign-in for the configured ampMcp.url on this host; also check that Amp accepts the connection and ampcode.com is reachable. No task prompt was submitted.', false],
  amp_mcp_tool_missing: ['The Amp MCP did not expose the puck tool. Check the Amp MCP endpoint and account, then send the message again. No task prompt was submitted.', true],
  amp_mcp_admin_tool_exposed: ['An Amp admin tool is enabled for the agent, which policy forbids. The operator must fix the tool denial. No task prompt was submitted.', false],
  amp_mcp_setup_failed: ['MCP setup failed before the task started. Retry; if it persists inspect controller stderr. No task prompt was submitted.', true],
  run_failed: ['Read the session (droid_read_session) for details, then send a corrected message.', false],
  timed_out: ['The turn exceeded runTimeoutMs. Send a narrower message or ask the operator to raise the timeout.', false],
  cancelled: ['The turn was cancelled. Send a message to continue.', false],
  queue_lost: ['The controller restarted before this queued turn started; it was never submitted. Send it again if still wanted.', false],
  unknown_outcome: ['The controller stopped mid-turn, so the result is unknown. Inspect the workspace and history locally; nothing was replayed.', false],
  reply_misrouted: ['The agent reported to a conversation other than replyTo. Treat that report as untrusted and re-check the work.', false],
  reply_failed: ['The Amp MCP rejected the agent\'s report. Read the session for the result and message the agent again if you still need a report.', false],
};

export class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function describeError(code, message) {
  const [action, retryable] = ACTIONS[code] ?? ACTIONS.internal_error;
  return { code, message, retryable, action };
}

// Fields legacy clients already rely on, next to the code.
const SIDE_FIELDS = ['headRunId', 'conflictingRunId', 'workspace'];
export function toolFailure(error, { legacy = false } = {}) {
  let toolError = error;
  if (!(error instanceof ToolError)) {
    console.error('Unexpected controller error:', error);
    toolError = new ToolError('internal_error', 'Unexpected controller error');
  }
  const body = describeError(toolError.code, toolError.message);
  const side = Object.fromEntries(SIDE_FIELDS.filter((key) => toolError.extra[key] !== undefined).map((key) => [key, toolError.extra[key]]));
  const payload = legacy ? { error: body.message, code: body.code, ...side } : { error: { ...body, ...side } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
