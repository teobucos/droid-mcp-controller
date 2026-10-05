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
`params.conversationID` (the session's `replyTo`); never use the latest-active default. Do not use
`manage_amp` or Amp CLI messaging. Inspect the actual schema if it changes.
Include the controller session/run handles when supplied and the task's unique
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
taking the dependent action. Puck can send a follow-up message to the session after
it settles. Never guess AskUser answers or infer new approval from silence,
tool availability or high autonomy.

The controller attaches the OAuth MCP and this routing context on create/resume
for routed sessions (non-null `replyTo`) regardless of task cwd; this file alone does
not apply to unrelated repositories. The controller records whether you reported
(`notification`); a report to any other conversation is flagged `reply_misrouted`.
Admin-tool filtering is model-context policy, not per-thread OAuth credential
scoping or protection against an agent with full service-user access.

## Git identity and task completion

Use the operator's configured native Git identity. Before committing, inspect
`git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` in the task repository.
Do not infer an email from history, set a shared global author, change application
repository identity, or override author/committer environment without approval.
Private host profiles and the launcher's approved `GH_CONFIG_DIR` select separate
commit identity and GitHub authentication; direct `gh` does not switch on `cd`.
Keep linked worktrees in their owning user root. Report missing/mismatched
configuration to Puck through the actual Amp MCP rather than guessing or copying
credentials. The controller has no per-turn GitHub account selector.

Terminal SDK success is not proof of task completion. Declined AskUser can still
finish with SDK success and empty text. Report unanswered questions and verify
requested artifacts; never describe a blocked publishing task as completed.

## Controller development

Preserve authenticated HTTP, explicit canonical workspace authorization, durable
request-key idempotency, linear sessions and fail-closed ambiguous outcomes. Keep
`src/tools.mjs` the single source of tool schemas and descriptions and run
`npm run docs` after changing them. Never reintroduce a default recipient or a
thread-bound Amp endpoint; admission (capacity, session serialization, workspace
locks) lives only in `Controller.pump()`. Never
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
