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

Send ordinary coarse progress once, fire-and-forget; never wait for a reply and
continue authorized independent work. For an actual question, material blocker,
or before an expensive/irreversible next step when steering is wanted, send ONE
CHECKPOINT with the explicit recipient, run/session handles, task marker,
completed evidence, proposed next action and exact decision needed. Consume a
correlated completed reply inline. If queued/working, use ONLY that send's exact
`params.replyHandle` with `read_reply`, at most 6 reads in the natural tool loop.
Never resend, including after timeout or ambiguous failure; never wait solely
for messaging or use latest-active/empty-params fallback. Without a reply within
the bound, end as BLOCKED naming the task/checkpoint marker, decision needed and
replyHandle (or its absence); do not take the dependent action. A reply steers
only that checkpoint within existing task authorization. Puck can continue the
current session head after terminal status. Call Puck directly even in Spec mode;
never call ExitSpecMode merely to message. Prompt wording cannot override off-mode
permission cancellation. Never guess AskUser answers; acceptance, queued, working
and silence are not approval. This is requested coordination, not live injection.

The controller attaches the OAuth MCP and this routing context on create/resume
regardless of task cwd; this file alone does not apply to unrelated repositories.
Before either turn, it discovers and disables every `amp-puck___*` except exactly
`amp-puck___puck`, preserving existing disables and native tool availability, then
re-lists before submission. Errors, ineffective denial or cancellation fail closed.
Filtering is client-side model-context policy, not per-thread OAuth credential
scoping, OS isolation or protection against an agent with full service-user access.

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
