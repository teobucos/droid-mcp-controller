# Droid controller and Puck coordination

## Delegated Droid tasks

Puck owns task orchestration. A controller run represents one turn; the Droid
session holds conversation history across turns. Use the workspace, model,
reasoning and permissions supplied for the task. Do not launch duplicate turns,
change another workspace, or broaden authorization yourself.

Authorized Droid agents default to Factory Auto/high with single-use permission
approval; model and reasoning are independent settings. Explicit `off` remains
available for read-only tasks. This grants the service user's existing access,
not root privileges, access to another user's workspace, or OS isolation.

When Puck asks for a report, question or progress update, use the connected Amp
MCP tool `amp-puck___puck`. Its verified actions are `send` and `read_reply`.
Use `send` with `params.message` and the launch context's explicit
`params.conversationID`; never use the latest-active default. Do not use
`manage_amp` or Amp CLI messaging. Inspect the actual schema if it changes.
Include the controller run/session handles when supplied and the task's unique
correlation marker. Keep messages concise: findings, evidence, remaining work and
the specific decision needed.

An accepted message is not proof that Puck received it or answered. Do not claim
delivery without a receipt or confirmation. If Amp MCP is unavailable or rejects
the message, include that failure in the terminal task result; do not hide it or
invent a reply. Controller status/result remain the authority for execution state.

If an answer is needed before proceeding, send the actual question and explain
what is blocked. If `send` reports queued/working, poll `read_reply` with
`params.replyHandle` returned by that send. Retry reads, never duplicate sends or
uncorrelated empty reads. This permits a requested answer during the turn; it is
not unsolicited live steering. If a reply is unavailable, end the turn without
taking the dependent action. Puck can continue the current session head after
terminal status. Never guess AskUser answers or infer new approval from silence,
tool availability or high autonomy.

The controller attaches the OAuth MCP and this routing context on create/resume
regardless of task cwd; this file alone does not apply to unrelated repositories.
Admin-tool filtering is model-context policy, not per-thread OAuth credential
scoping or protection against an agent with full service-user access.

## Controller development

Preserve authenticated HTTP, explicit canonical workspace authorization, durable
request-key idempotency, linear sessions and fail-closed ambiguous outcomes. Never
automatically replay accepted work after a crash. Hold execution/workspace slots
until worker and Droid cleanup finish.

Discover selectable models from the current authenticated Factory runtime; do
not maintain a hard-coded or historical model allowlist. Write the relevant E2E
failure cases before implementation and preserve repeatable verification evidence.

Keep personal Puck thread IDs, OAuth credentials, bearer tokens, host configuration,
state, logs and artifacts out of public source and Git history. Store OAuth through
the supported credential store, never in task prompts or committed MCP headers.
Workspace authorization and tool filtering are not OS isolation.

Coordinate live controller changes with the operator and Puck. Do not restart,
cancel or resume another active run while implementing or testing source changes.
