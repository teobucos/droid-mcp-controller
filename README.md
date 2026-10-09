# Droid MCP controller

A small, same-host MCP server that lets Puck manage Factory Droid sessions the
way it manages Amp threads: create, message and steer, status, read, wait, find,
update, cancel, usage, workspaces and models, with agent reply-back through the
Amp MCP. No UI, database service, Factory daemon or account API. Installation and
secure connection steps are in [HANDOFF.md](HANDOFF.md); the full, generated tool
schemas are in [docs/TOOLS.md](docs/TOOLS.md).

Requires Node.js 22+, Linux or macOS, and an authenticated Droid CLI (verified with
**0.236.0**, normally `~/.local/bin/droid`). The controller inherits the service
user's login environment and never collects credentials. Dependencies are locked;
`uuid` is overridden to 11.1.1 to fix GHSA-w5hq-g745-h8pq.

```sh
npm ci --ignore-scripts
npm run check      # syntax + docs/TOOLS.md in sync with the registered schemas
npm test           # mock-peer E2E (real MCP client, controller, worker, Factory SDK)
node src/server.mjs --config /absolute/path/to/config.json
```

## The session tools

A **session** is a controller-owned handle for one linear conversation with
Droid in one approved workspace. Each message you send is one **run** (a turn).
Factory session UUIDs never leave the controller.

| Tool | Does | Droid / SDK capability behind it |
| --- | --- | --- |
| `droid_create_session` | Start a session and its first turn. `replyTo` is required (a Puck conversation id, or `null` for detached). | SDK `createSession` over `ProcessTransport` (`droid exec --input-format stream-jsonrpc`) |
| `droid_send_message` | Follow up or steer. Idle starts at once; busy queues (default) or, with `interrupt:true`, interrupts and resumes. | SDK `resumeSession`, `session.interrupt()`; the controller serializes (see Steering) |
| `droid_get_session_status` | `agentState`, metadata, preview, latest run, declined questions, reply-back notification. | Controller records plus the SDK terminal result |
| `droid_read_session` | Paged history. | Terminal SDK result messages the controller retained |
| `droid_wait_for_sessions` | Join up to 10 sessions; bounded; returns when all settle. | Controller bookkeeping, no Droid call |
| `droid_find_sessions` | Text (title, labels, bounded output preview/tail) and typed filters, newest created first, keyset cursor. | Controller records (Factory's `droid search` and SDK `listSessions` are not used: they would expose unrelated service-user history) |
| `droid_update_session` | Title, labels, archive. | Controller metadata (no private Factory files are edited) |
| `droid_cancel_session` | Interrupt the running turn, drop queued turns. | `session.interrupt()` then process-group kill after the grace period |
| `droid_get_usage` | Sum of per-turn token usage and Factory credits. | `DroidResult.tokenUsage` (including `factoryCredits`) |
| `droid_list_workspaces` | Approved roots, capacity, launch policy. | Controller configuration |
| `droid_models` | Live model catalog. | `initializeSession` `availableModels` from the authenticated runtime |

Typical flow (tool arguments, not shell commands):

```json
{"requestKey":"review-42","workspace":"/approved/repo","prompt":"Review the diff and report findings.","model":"MODEL_ID","autonomy":"off","replyTo":"T-...","title":"Diff review"}
```

1. `droid_list_workspaces` (roots, capacity, policy) and `droid_models` (pick an id).
2. `droid_create_session` with a stable `requestKey`; keep `metadata.session`.
3. `droid_wait_for_sessions({sessions:[...]})` in a loop; a timeout is not failure.
4. Inspect `latestRun.state`, `needsAttention`, `notification`; `droid_read_session` for detail.
5. `droid_send_message` to continue. **Mid-run steering needs `interrupt:true`**; the
   default `interrupt:false` queues after the current turn (this differs from Amp
   thread messages, which do not interrupt either, but do inject).

### Concurrency (a hard requirement)

Sessions run at the same time. `maxConcurrentRuns` defaults to **4** (1 to 16) and is
shown by `droid_list_workspaces`. Admission is FIFO and applies three rules:

1. at most `maxConcurrentRuns` live turns;
2. at most one live turn per session;
3. canonical workspace locks: `autonomy:"off"` turns are readers and may share an
   overlapping tree; any other level is a writer and needs its whole canonical
   tree (ancestors, descendants, symlink spellings) to itself.

A turn that cannot start is `queued` (it was **not** submitted to Droid) and starts
when capacity and locks allow, in order, so a waiting writer is never starved by
later readers. Locks are held until the worker and its Droid process are cleaned
up. There is no cross-controller or OS-level lock. Queues are bounded (64 total,
8 per session): beyond that `queue_full`. Queued prompts live only in memory, so
after a controller crash queued turns become `cancelled` with `queue_lost`; they were
never submitted and are never replayed.

### Steering is serial interrupt-and-resume

`interrupt:true` durably cancels older queued turns on that session with `superseded`,
retaining their request keys and history. It then interrupts the active turn through
the protocol, waits for terminal result or termination and process cleanup, then
passes workspace/capacity admission before resuming the same Droid session with your
message. The SDK's high-level session rejects concurrent streams, so native in-flight
injection is **not** claimed or implemented. Tool side effects of the interrupted turn
are not undone. Cancelling or steering one session never touches another.

### Outcomes, attention and notification

| `latestRun.state` | Meaning |
| --- | --- |
| `queued` | Accepted, waiting for capacity or a workspace lock; nothing submitted. |
| `starting`, `running`, `cancelling` | Live. `running` means initialized, not continuously producing output. |
| `succeeded` | Matching terminal SDK result with subtype `success` (not proof the task was done). |
| `interrupted` | Terminal SDK result `interrupted` (cancelled, steered, or a rejected permission). |
| `failed`, `timed_out`, `cancelled` | Setup/agent failure; deadline; cancelled without a terminal result (including dropped queued turns). |
| `unknown` | Controller stopped mid-turn. Never replayed, never inferred as success; the session cannot continue. |

A turn whose worker dies without a result is `failed`, and turns queued behind it on that session are dropped unsubmitted (`predecessor_failed`) so Puck decides what to do; the queue never resumes work across a failure. That cancelled head still needs attention and exposes `latestRun.predecessorFailure` with the failed run handle, state and error. A successful resolving follow-up clears attention; historical failures are not permanent flags.

`agentState` is `working` (anything queued or live), `idle` (nothing pending; **not** a
success claim) or `unknown`. `droid_wait_for_sessions` treats every non-working
state as settled, including `needsAttention`, so Puck is never left blocked.
`needsAttention` is true for failures, unknown outcomes, an interrupt nobody asked for,
declined permissions (`permissionsDeclined`), declined AskUser questions
(`latestRun.questions`, answer them with `droid_send_message`), and failed reports.
SDK 0.9.1 maps a `completed` turn to success even after a declined AskUser or tool, so
check these fields and the requested artifacts.

`notification` is what the controller **observed** the agent do with
`amp-puck___puck` (it cannot send for the agent): `disabled` (detached),
`pending` (turn running), `accepted` (Amp accepted a report; not proof Puck read
it), `failed` (rejected, or sent to a conversation other than `replyTo`,
`reply_misrouted`), `not_sent` (the turn ended without a report). A failed
notification never turns a finished run into a failed run.

### Deprecated aliases

`droid_start`, `droid_continue`, `droid_status`, `droid_result`, `droid_list` and
`droid_cancel` remain as thin views over the same core with their original
run-shaped outputs and string errors. Differences from before: `droid_start`
without `puckConversationId` is **detached** (no host default recipient exists),
conflicting work now queues instead of failing with `workspace_busy` or at capacity,
and `droid_continue` still refuses a busy session instead of queueing. Models are
not catalog-validated on the aliases. Migrate to the session tools; the aliases
carry no logic of their own.

## Models come from the live authenticated runtime

`droid_models` initializes a short-lived Droid connection with the same CLI, service
user, HOME and `FACTORY_HOME_OVERRIDE` as normal runs, captures the live
`availableModels`/`available_models`, closes the session, and never submits a prompt
or approves a tool. Create and send validate `model` and `reasoningEffort` against
that catalog and reject with `model_unavailable` / `reasoning_unsupported`. Entries
with `disabled:true` or `deprecated:true` are omitted; optional metadata is returned
only when Factory supplies it. CLI 0.236.0 supplies `deprecated` in initialization;
the pinned SDK strips it, so raw capture is correlated to that initialization's request
ID before SDK parsing. Missing lifecycle metadata is **unknown**, not proof a model
is non-legacy. Consult Factory's [current catalog](https://docs.factory.com/docs/models)
and the installed `droid exec --help` deprecation labels when metadata is absent.
`modelCacheTtlMs` defaults to 60000 (5000 to 600000); concurrent callers share one
refresh; a failed refresh returns `model_discovery_failed`, never an expired catalog.

## Droid reports and questions use the actual Amp MCP

Reply-back is opt-in per host: `"ampMcp": {}` in the private config. The endpoint is
**generic**: `https://ampcode.com/mcp?profile=external-agent`. It names no thread and
no recipient; a `threadID` in the URL, or the old `puck.conversationId`, is rejected
at startup, because a thread-bound endpoint broke every launch when its thread was
archived and a host default recipient silently misrouted omitted `replyTo`.
Recipients are per session (`replyTo`) and are never defaulted.

The controller attaches `amp-puck` through SDK `mcpServers` on create **and** resume,
**only for routed sessions** (`replyTo` non-null); detached sessions never touch the
endpoint. Tool exposure is **default deny**: only `amp-puck___puck` (send, read_reply) is meant to be
usable. The thread-free endpoint was observed live to offer `manage_amp` (admin) and
`find_thread` / `read_thread` (read other Amp threads) too, so those start in
`disabledToolIds`; the preflight then lists what the server actually exposes, denies every
other `amp-puck___*` tool it finds (a new Amp tool is blocked automatically), and verifies
none remains usable. Saved disables are preserved on resume and when updating settings;
native tools are not restricted. Discovery/settings errors and cancellation submit no
prompt. If denial cannot be achieved the run fails with
`amp_mcp_admin_tool_exposed` and nothing is submitted. This is client-side filtering, **not**
credential scoping (see docs/THREAT-MODEL.md). Detached sessions never touch the endpoint.

**Factory stores Amp MCP OAuth tokens per exact endpoint URL** (observed live: the
thread-free URL and a differently threaded URL both get `unauthorized` on a host that
authorized only another URL). The operator must complete Factory's supported MCP
OAuth once, as the service user, for the exact configured `ampMcp.url`. See
[docs/CUTOVER.md](docs/CUTOVER.md). The controller never accepts tokens or headers and
never starts consent during task execution.

Before any task prompt is submitted a preflight checks the server and tools and
fails the run with an actionable `latestRun.error` instead of the generic one:

| `error.code` | Cause |
| --- | --- |
| `amp_mcp_auth_required` | Server listed but no OAuth tokens. |
| `amp_mcp_not_started` | Server dropped from Droid's listing: usually no stored token for this URL, or Amp rejected the connection. (The SDK does not report these as `failed`; the old `Unknown tool identifier(s)` error was this case, masked by the disabled admin tool id.) |
| `amp_mcp_unreachable` | Server listed as failed or never connected; the sanitized server message is included (for example an archived thread). |
| `amp_mcp_tool_missing` / `amp_mcp_admin_tool_exposed` | `puck` not exposed / any other Amp tool usable. |
| `amp_mcp_setup_failed` | Tool discovery failed for another reason (sanitized). |

Every routed turn receives the explicit recipient, the controller session and run
handles, and how to call `{action:"send",params:{conversationID,message}}` and
`{action:"read_reply",params:{replyHandle}}`. Routed sessions may approve, as a
single use, only that tool: `send` to their own `replyTo`, or `read_reply`
with a nonempty recognized handle from a successful own-recipient send in **this run**
(so read-only reviewers can report). Missing, foreign, failed-send and old-run handles
are not pre-approved. Handles are memory-only and reset on continuation, retarget and
restart. The parser accepts a top-level JSON `replyHandle` in string/text-block results;
unknown result formats fail closed. These are local pre-approval rules: autonomy `high`
still approves any offered single-use permission, including other Puck calls. Neither
policy is OAuth credential scoping or OS isolation.

Progress is sent once, fire-and-forget; continue authorized independent work. A
question, blocker or costly/irreversible step needing steering uses one CHECKPOINT
with recipient, session/run handles, marker, completed evidence, proposed action and
decision needed. Consume a completed reply inline, otherwise read only that send's
exact `replyHandle`, at most **6 reads** in the natural tool loop, without messaging
waits. Never resend after timeout/ambiguous failure or use latest-active/empty params.
Without an answer, end BLOCKED with marker, decision and handle; leave dependent work
untouched. Call Puck directly in Spec mode; never exit Spec just to message or guess
AskUser answers. Acceptance/queued/working/silence is not approval; replies steer
only within existing authorization. Wording cannot override permission cancellation;
mock text pins prove wiring, not model obedience.

A controller-owned Amp OAuth client and durable terminal-notice outbox are **not**
implemented: no supported credential path exists (Amp remote-MCP OAuth is per-account
via ampcode.com; Amp Workload Identity needs Amp-staff access; Factory's token store
must not be read or copied). Terminal outcomes are therefore delivered by
`droid_wait_for_sessions` and status, and the agent's own report is observed in
`notification`. See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the open question.

**OAuth is account authorization, not a demonstrated thread/tool-scoped grant.**
Client-side tool denial reduces model exposure, not credential rights. See
[Factory MCP](https://docs.factory.ai/harness/mcp) and
[Amp MCP](https://ampcode.com/docs/customize/mcp).

## Outcome details

An unknown outcome is settled for waiting but **not a known Droid outcome**. The
session cannot continue (`session_unknown_outcome`), even through an older run handle. Inspect/reconcile Droid
history and the workspace locally. Start a new session with a new key
after reconciliation, or use the saved Droid session manually outside the controller.
Do not edit state to manufacture success.

High-autonomy turns record and approve offered single-use permissions with
`ProceedOnce`, never persistent `ProceedAlways` rules. Other levels decline
pending permission requests with `Cancel`; high also declines if no single-use
option is offered. AskUser questions are recorded and declined, not guessed.
SDK 0.9.1 maps a `completed` turn to success even after declined AskUser and with
empty final text; `cancelled` maps to interruption. The controller preserves that
SDK outcome, not a judgment that the user's task finished. Inspect recorded
`ask_user_declined` events and task artifacts before accepting completion. Puck
can answer the blocked question with `droid_send_message`. There is
no interactive permission queue or arbitrary session import; saved outcomes are
not rewritten to manufacture a different result.

## Same-host durability and cleanup

`stateDirectory` contains private `state.json`, per-run `*.result.json`, and an
owner record. Writes use file+directory fsync and atomic replacement. A single
process owns the state; startup refuses a live owner, another host/HOME/profile,
or malformed state. A stale dead-process owner is recovered under a startup
lock. PID reuse conservatively blocks startup rather than risking two owners.

A controller crash stops its workers through IPC disconnect; each worker owns
a separate process group containing Droid. Cancellation first sends protocol
interrupt, then force-kills that group after its grace period. The session slot
is not released until worker cleanup. Terminal results are persisted before
cleanup, so restart can retain a known outcome even if cleanup was interrupted.
Processes deliberately detached by Droid tools may escape that group: do not
authorize background-service work unless separately supervised.

Keep the same user, HOME, `FACTORY_HOME_OVERRIDE` (if used), Droid session storage,
and workspace. Controller records do not replace Factory's own saved history.
Back up both. Progress is intentionally bounded: last 20 events, 4000 characters
per event field, and 16000-character text/stderr tails. Final SDK results are
stored with submitted user-message copies omitted. There is no automatic deletion
of completed records; archive them locally with the controller stopped, preserving
keys if deduplication is needed.
Timestamps are UTC ISO strings; Puck may display them in Asia/Bangkok.

Original submitted prompts are not retained in controller state. Prompt content
participates in the SHA256 intent fingerprint and is passed to the worker only
over IPC for the accepted execution. A crash before submission becomes `unknown`,
not a replay. Assistant echoes, permission context, stderr and final results can
still contain sensitive text; Factory's own session history is separate and
may retain prompts. Fingerprints are not encryption.

State is versioned. Version 3 (current) has `sessions` (title, labels, archive flag,
`replyTo`, workspace, authoritative `headRunId`) and `runs`. Older state migrates
atomically at startup after validation, **keeping a byte-identical backup**
(`state.json.v1.bak` or `state.json.v2.bak`, never overwritten); invalid or
inconsistent state refuses to start without being rewritten. See
[docs/STATE-MIGRATION.md](docs/STATE-MIGRATION.md) for the exact mapping and recovery.
Original prompts are never in state or in migrated backups' successors.

## Configuration and security

Copy `config.example.json` and replace every path with an **absolute** path.
JSON paths do not expand `~`. Only real directories at/below approved roots
can be launched; traversal, sibling-prefix and symlink escapes are rejected.
Resume must resolve to exactly the recorded workspace. State must be private
(700 directory, 600 files).

Optional settings:

| Setting | Default |
| --- | --- |
| `transport` | `stdio` (no network listener) |
| `maxAutonomy` | `high` (owner-authorized service-user access) |
| `defaultAutonomy` | Inherits `maxAutonomy` (`high` when both omitted); an explicit default cannot exceed the ceiling |
| `reasoningEffort` | Unset; otherwise `off`, `none`, `dynamic`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, supported by the selected Factory model |
| `maxConcurrentRuns` | 4 (1 to 16); queued turns wait FIFO |
| `runTimeoutMs` | 3600000 (one hour wall clock, including setup) |
| `cancelGraceMs` | 5000, also bounds terminal cleanup |
| `modelCacheTtlMs` | 60000, bounded to 5000–600000 |
| `ampMcp` | Unset; `{}` enables reply-back with the generic Amp endpoint. `url` is optional and must be thread-free. The old `puck` key is rejected |
| `port` | 8787, HTTP only; binds **127.0.0.1 only** |
| `tokenFile` | Required for HTTP; private file, ≥32 URL-safe random characters |
| `publicUrl` | Optional approved HTTPS proxy URL, ending in `/mcp` |

The listener implements stateless Streamable HTTP MCP POST `/mcp`, with constant-
time Bearer authentication on every request, approved Host/Origin checks, a 1 MiB
body cap and request timeouts. No unauthenticated HTTP option exists. No OAuth
provider, SSE notification channel, or automatic push back to Puck is provided.
Status and results work independently of a connected client; waits are bounded to 60 seconds per call.

Malformed JSON/MCP envelopes return HTTP 400. Unexpected server/transport failures
return generic HTTP 500 `Internal MCP server error`; details stay in local stderr.
Lifecycle/tool rejections are normal MCP `isError` responses with `{error:{code,message,retryable,action}}`, not HTTP 500.

**Workspace approval is a launch restriction, not an OS sandbox.** Droid runs
as the service user; enabled tools, inherited MCP servers, project hooks, and
commands can access what that user can. Inspect trusted project/Factory config.
For hard file/network isolation use a dedicated restricted account/container
with the approved directories mounted. Read-only/Spec mode is Droid policy,
not a filesystem mount guarantee. Low/medium/high authorize real actions; high
is powerful. The controller never uses `--skip-permissions-unsafe`.

Treat the bearer token as remote access to this account within the selected
ceiling. Anyone with it can read stored results and start tasks. Store it only
in local/private credential settings, use TLS for every remote hop, and restrict
the HTTPS proxy/tunnel to this controller. Never expose an orb preview as the
user's installed controller. Rotate the token by replacing its file and
restarting the server; update Amp's stored credential separately.

## Workspace approval, outages, and safe upgrades

- **Workspace rejection:** a correct authorization failure, not a reason to
  remove the allowlist. Ask the operator to add only the explicitly approved
  project root. Existing directories, real paths, sibling/traversal protection,
  and resume-cwd checks still apply. Configuration is loaded at process startup;
  coordinate a controller-only restart with every caller to activate changes.
- **HTTP 530:** a failure at the HTTPS/Cloudflare boundary; it does not establish
  that Droid failed or stopped. Check the actual public route and Cloudflare's
  tunnel connection state, DNS, and bounded logs. Loopback readiness/metrics can
  appear healthy while public routing is down. Synthetic host DNS can also make
  a local HTTPS probe misleading; cloud-client acceptance is required. Reserve
  connector-only recovery when public routing fails; preserve active Droid runs.
  A controller restart cannot repair an
  unavailable tunnel. Retry read-only status/list/result after a short delay;
  replay start/continue only with the **same key and identical arguments** when
  acceptance is uncertain. Never create a second intent merely because HTTP failed.
- **Connector DNS:** some managed hosts return synthetic addresses that cannot
  carry tunnel traffic. Fix only the connector's resolution/routing, not shared
  machine DNS. A pinned-edge override is a host workaround, not a portability
  guarantee; retain edge TLS verification and revisit it if edge addresses change.
- **Upgrade/restart:** reserve the execution slot, check that all runs are terminal,
  back up private state, and restart only the changed service. Keep the healthy
  tunnel, bearer credential, HTTPS URL, user/HOME, and state store unchanged.
  Recheck remote discovery, prior results, list, and idempotency before resuming.
  Never rewrite installation state to make a failed upgrade appear successful.
- **Persistence:** process supervision and durable records do not imply machine-
  boot startup. Use the host's supported startup mechanism when available; a
  managed container without systemd/launchd needs platform-specific provisioning.
  Do not claim boot persistence from a successful process restart alone.

## Protocol evidence and tests

Uses published `@factory/droid-sdk/node` `ProcessTransport` with
`createSession({transport})` / `resumeSession(id,{transport})`. This bypasses
the SDK helper's API-key requirement, not CLI authentication. The supported CLI
invocation is `exec --input-format stream-jsonrpc --output-format stream-jsonrpc`.
Settings use initialize/update requests, not CLI model/autonomy flags.
Terminal matching is `agent_turn_completed.turnId == add_user_message.messageId`;
idle, assistant text, silence, unrelated turn IDs and process exit cannot succeed.

`npm test` drives the real MCP SDK client, controller, worker, Factory SDK and a
mock JSON-RPC peer (`test/e2e.test.mjs` for the legacy aliases and safeguards,
`test/session-surface.test.mjs` for the session tools). It covers the strict
schemas and errors, idempotency, steering and queueing, N parallel sessions,
capacity queueing, overlapping-workspace serialization (both lock directions,
symlinks, FIFO fairness), mixed autonomy, concurrent reply-back with per-session
recipients, misroute detection, cancel/steer isolation, Amp MCP preflight failures,
v1/v2 migration with backup, crash fail-closed and queue loss. See `test/README.md`.
`test/review-regressions.test.mjs` and `test/worker-ack.test.mjs` additionally test
durable queue supersession, persistence ACK fault boundaries, per-run reply handles,
failed-predecessor attention, catalog lifecycle and migrated request-key retries.
`npm run smoke` runs a two-turn lifecycle against a real CLI, and
`scripts/acceptance.mjs` is the live acceptance driver for a **second** instance
(own port, token and state directory), never the production service.

For bounded authenticated read-only verification with disposable private state:
`node scripts/verify-live.mjs --droid /absolute/path/to/droid --model CURRENT_ID`.
It checks real SDK acceptance, two exact results, same-UUID continuation and
cancellation of a third turn, then process cleanup; output contains only assertions
and versions, not prompts, session UUIDs or credentials. Pick an economical current
model with `low` reasoning from the live catalog first. Existing CLI login is required.
`node scripts/verify-route.mjs --droid /absolute/path/to/droid` separately checks
fresh, resumed, reattached and detached MCP inventories without any model prompt
or Puck message. It requires existing OAuth for the generic Amp endpoint. On CLI
0.236.0 / SDK 0.9.1, omitting attachments on resume does not retain a previous Amp
attachment. This does not prove future CLI behavior or constrain inherited host MCP.

Sources: [Factory SDK documentation](https://docs.factory.com/sdk/typescript.md),
[Droid exec](https://docs.factory.com/docs/droid-exec/overview),
[published SDK](https://github.com/Factory-AI/droid-sdk-typescript),
[Node IPC send callback semantics](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#subprocesssendmessage-sendhandle-options-callback),
[reference bridge](https://github.com/mrwogu/factory-droid-openai).
The reference bridge was cloned/read, not changed or incorporated: its
OpenAI-transcript/tool isolation contract differs from this session controller.

## License

MIT; see [LICENSE](LICENSE).
