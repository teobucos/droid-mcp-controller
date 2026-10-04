# Droid MCP controller

A small, same-host MCP server for Puck to start, inspect, cancel, and continue
Factory Droid tasks. No UI, database service, Factory daemon, account API, or
completion-notification dependency. Installation and secure connection steps
are in [HANDOFF.md](HANDOFF.md).

Requires Node.js 22+, Linux or macOS, and an authenticated Droid CLI. The target
is Droid **0.233.0**, normally `~/.local/bin/droid`. The controller inherits the
service user's login environment; it does not collect credentials. Dependencies
are locked. `uuid` is overridden to 11.1.1 to fix GHSA-w5hq-g745-h8pq; the Factory
SDK's `v4` usage is covered by the protocol E2E suite.

```sh
npm ci --ignore-scripts
npm run check
npm test
node src/server.mjs --config /absolute/path/to/config.json
```

## Puck calls six tools

| Tool | Required arguments | Behavior |
| --- | --- | --- |
| `droid_start` | `requestKey`, `workspace`, `prompt` | Returns immediately with a new controller `runId`; Droid UUID arrives during setup. |
| `droid_continue` | `runId`, `requestKey`, `prompt` | Loads the prior run's Droid UUID and workspace; returns a **new** runId. |
| `droid_status` | `runId` | Durable state, UUID, timestamps, recent events, partial text, separate stderr. |
| `droid_result` | `runId` | Final text/outcome if available, otherwise explicitly partial progress. |
| `droid_list` | none | Discover durable runs, newest first. |
| `droid_cancel` | `runId` | Interrupt; poll until terminal. Never undoes edits. |

Start/continue also accept `autonomy: "off" | "low" | "medium" | "high"` and
optional `model`. **Each turn defaults to off**, including continuation of a
previously high-autonomy session. The host's `maxAutonomy` ceiling can only be
changed in its local configuration. `off` sets Spec mode plus autonomy off;
the others set Auto mode plus the requested level through JSON-RPC.

Tool discovery includes the host's approved workspace roots, autonomy ceiling,
and reasoning setting. Choose a workspace from those roots rather than guessing
a repository path. Send an explicit enabled `model` on **every** start/continue
to avoid inheriting a costly default. Model IDs and pricing come from Factory's
current account catalog, not from this controller.

Reasoning is a separate host setting: `reasoningEffort` is applied on both start
and resume, independent of autonomy. Explicit host reasoning is saved on each
new run and returned by status/result/list. Older records may lack that field;
they are not rewritten. Omission leaves Droid's default/saved reasoning in place.

`droid_result` accepts `offset` (default 0) and `limit` (default 12000, max 16000)
in JavaScript string characters. Follow `nextOffset` until null. It returns the
SDK's final answer, not a concatenation of progress messages. `droid_list` also
supports offset/limit (default 25, max 100).

Typical Puck sequence (tool arguments, not shell commands):

```json
{"requestKey":"review-42","workspace":"/approved/project","model":"YOUR_ENABLED_MODEL_ID","autonomy":"off","prompt":"Review the changes; do not edit files."}
```

1. Call `droid_start` with those arguments. Retain `runId` and `requestKey`.
2. Poll `droid_status({runId})` at a reasonable interval, e.g. 2–5 seconds.
   Recent complete assistant/tool/error events show progress; a quiet stream
   does not prove the task has finished.
3. Once `terminal` is true, inspect `state`, then retrieve `droid_result`.
   `resultAvailable` means a terminal Droid result was persisted; it is **not**
   a success flag. Success requires `state: "succeeded"` and a successful outcome.
4. Continue with `{runId, requestKey:"review-42-followup", model:"YOUR_ENABLED_MODEL_ID",
   autonomy:"off", prompt:"Explain the first finding."}`. Retain the returned
   NEW runId. The Droid UUID stays the same.
5. For immediate steering: cancel the current run, await terminal status, inspect
   its outcome, then continue. Busy sessions reject follow-ups rather than queue
   them ambiguously. Never operate the same UUID from another Droid process.

Keys are global to this controller state directory. Retrying exactly the same
start/continue arguments returns the existing run, even after restart. Reusing
a key for different arguments fails. Use a new key for intentional new work.
An accepted intent is synced to disk before spawning the worker. This provides
at-most-one controller launch per key, **not exactly-once Droid side effects**.

For an Amp connection named **Droid Grokbot**, discover `droid-grokbot` with
`tool_search`, then call the six functions through `code_exec`:

```js
import { droid_start } from "droid-grokbot"
text(await droid_start({
  requestKey: "review-42",
  workspace: "/approved/project",
  model: "YOUR_ENABLED_MODEL_ID",
  autonomy: "off",
  prompt: "Review the changes; do not edit files."
}))
```

The module name depends on the connection name. `code_exec` is a tool dispatcher,
not a host shell; it cannot edit the host configuration or run timer-based polling.
Poll in later calls. A separate runner is needed only for host administration,
not for ordinary Droid execution. There is no completion push or live prompt
injection: follow-ups are serial after the prior turn terminates.

## Outcomes are explicit

| State | Meaning |
| --- | --- |
| `starting`, `running`, `cancelling` | Active; keep polling. `running` means the session is initialized, not that Droid is continuously producing output. |
| `succeeded` | Matching terminal SDK result has subtype `success`. |
| `interrupted` | Droid returned a terminal interruption, including declined permissions/questions. |
| `failed` | Terminal agent failure, setup/transport failure, unexpected exit, or invalid result. |
| `cancelled` | Controller cancelled without receiving a terminal result, usually during setup or after forced process termination. |
| `timed_out` | Configured wall-clock deadline expired; never inferred from silence. |
| `unknown` | Controller died before a durable terminal result; never replayed or inferred as success. |

All but the first row have `terminal: true`. An unknown outcome is terminal for
the controller's polling loop but **not a known Droid outcome**. Continuation
of that UUID is blocked, even using an older run handle. Inspect/reconcile Droid
history and the workspace locally. Start a fresh controller task with a new key
after reconciliation, or use the saved UUID manually outside the controller.
Do not edit state to manufacture success.

Pending permission requests are recorded and declined with `Cancel`, never
`ProceedAlways`. AskUser questions are recorded and declined, not guessed. Puck
can inspect the context and send a new prompt after interruption. This version
does not offer an interactive permission queue or arbitrary session import.

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
stored whole. There is no automatic deletion of completed records; archive them
locally with the controller stopped, preserving keys if deduplication is needed.
Timestamps are UTC ISO strings; Puck may display them in Asia/Bangkok.

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
| `maxAutonomy` | `off` |
| `reasoningEffort` | Unset; otherwise `off`, `none`, `low`, `medium`, `high`, `xhigh`, or `max`, supported by the selected Factory model |
| `maxConcurrentRuns` | 4 across distinct sessions |
| `runTimeoutMs` | 3600000 (one hour wall clock, including setup) |
| `cancelGraceMs` | 5000, also bounds terminal cleanup |
| `port` | 8787, HTTP only; binds **127.0.0.1 only** |
| `tokenFile` | Required for HTTP; private file, ≥32 URL-safe random characters |
| `publicUrl` | Optional approved HTTPS proxy URL, ending in `/mcp` |

The listener implements stateless Streamable HTTP MCP POST `/mcp`, with constant-
time Bearer authentication on every request, approved Host/Origin checks, a 1 MiB
body cap and request timeouts. No unauthenticated HTTP option exists. No OAuth
provider, SSE notification channel, or automatic push back to Puck is provided.
Status/results work independently of a connected client.

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
  that Droid failed or stopped. Check the connector's private loopback readiness,
  connection count, DNS, and bounded logs. A controller restart cannot repair an
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

`npm test` drives the real MCP SDK client, controller, worker, Factory SDK and
mock JSON-RPC peer. It covers exact final output, settings, UUID retention,
idempotency, serial steering, permissions/questions, forced/setup cancellation,
agent/process failures, crash/restart durability, process-group cleanup,
timeouts, malformed/unrelated events, directory escapes, authentication and
HTTP checks, STDIO, ownership and corrupt-state rejection. See `test/README.md`
for failure cases written before implementation. `npm run smoke` additionally
exercises a real installed CLI through MCP and writes sanitized repeatable
evidence; authenticated success is required for production handoff.

Sources: [Factory SDK documentation](https://docs.factory.com/sdk/typescript.md),
[Droid exec](https://docs.factory.com/docs/droid-exec/overview),
[published SDK](https://github.com/Factory-AI/droid-sdk-typescript),
[reference bridge](https://github.com/mrwogu/factory-droid-openai).
The reference bridge was cloned/read, not changed or incorporated: its
OpenAI-transcript/tool isolation contract differs from this session controller.
