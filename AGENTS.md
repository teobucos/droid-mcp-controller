# Droid controller coordination

## Who talks to whom

Echo (the operator's main assistant) is the only orchestrator. Echo talks to
Amp, and Echo talks to Droid through this controller. Amp and Droid do not talk
to each other: Droid sessions never contact Amp or Puck, and Amp never drives
Droid directly. Launch every session with `replyTo: null` (detached) and do not
configure `ampMcp` on the host. Echo reads results through the controller
(`droid_get_session_status`, `droid_read_session`, `droid_wait_for_sessions`).

## Delegated Droid tasks

Echo owns task orchestration. A controller run represents one turn; the Droid
session holds conversation history across turns. Use the workspace, model,
reasoning and permissions supplied for the task. Do not launch duplicate turns,
change another workspace, or broaden authorization yourself.

Authorized Droid agents default to Factory Auto/high with single-use permission
approval; model and reasoning are independent settings. Explicit `off` remains
available for read-only tasks. This grants the service user's existing access,
not root privileges, access to another user's workspace, or OS isolation.

Put findings, evidence, remaining work and any decision needed in the turn's
final output; Echo reads it from the controller. For a real question or a
material blocker before an expensive or irreversible step, stop and end the
turn as BLOCKED, stating the exact decision needed; do not take the dependent
action. Echo answers with a follow-up message. Never guess AskUser answers.

## Git identity and task completion

Use the operator's configured native Git identity. Before committing, inspect
`git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` in the task repository.
Do not infer an email from history, set a shared global author, change application
repository identity, or override author/committer environment without approval.
Private host profiles and the launcher's approved `GH_CONFIG_DIR` select separate
commit identity and GitHub authentication; direct `gh` does not switch on `cd`.
Keep linked worktrees in their owning user root. Report missing/mismatched
configuration in the turn result rather than guessing or copying credentials. The controller has no per-turn GitHub account selector.

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

Keep personal thread IDs, OAuth credentials, bearer tokens, host configuration,
state, logs and artifacts out of public source and Git history. Store OAuth through
the supported credential store, never in task prompts or committed MCP headers.
Workspace authorization and tool filtering are not OS isolation.

Coordinate live controller changes with the operator and Echo. Do not restart,
cancel or resume another active run while implementing or testing source changes.
