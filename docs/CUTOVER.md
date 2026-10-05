# Cutover and rollback runbook (NOT executed by the implementation work)

Replaces the running controller (old seven-tool, one-run-at-a-time, thread-bound Amp
endpoint) with the session surface. It needs explicit approval from Puck **and** the
owner, and an owner-present moment for the Amp sign-in. Generic names below: use your
private paths. Never paste tokens, codes or private thread ids into this file or Git.

## 0. Prerequisites (before any change)

1. Approvals recorded from Puck and the owner.
2. **No active run.** Check `droid_list` / `droid_status` for the live service; wait for the
   Acronew run to reach a terminal state or agree to cancel it. Reserve the slot.
3. The sign-in below is done (it is additive and can be done days earlier).
4. The branch builds: `npm ci --ignore-scripts && npm run check && npm test` on Node 22.
5. Backups exist (steps 1 and 2).

## 1. Amp sign-in for the thread-free endpoint (prerequisite regardless of outcome)

Factory stores Amp MCP OAuth tokens **per exact endpoint URL**. The old token (for the
thread-bound URL) does not authorize `https://ampcode.com/mcp?profile=external-agent`.
Without this step every routed session fails fast with `amp_mcp_not_started` (and submits
no task); detached sessions are unaffected.

1. Back up the Factory credential store file(s) to a private directory outside the repo
   (`mkdir -m 700`, copy with mode 600, record `sha256sum` of `mcp-oauth.v2.file`,
   `auth.v2.file`, `auth.v2.key`). Never print their contents.
2. As the service user: `node scripts/amp-signin.mjs --config <controller config> --dir <private dir>`.
   It uses the SDK's `authenticateMcpServer` through a project-level definition in a throwaway
   workspace, so nothing is added to the user's persistent Factory MCP config. It writes the
   authorization link to `<dir>/auth-url.txt` (600).
3. The owner opens the link, approves, and copies the failing
   `http://127.0.0.1:54621/callback?...` address back; place it in `<dir>/callback-url.txt` (600).
   The helper delivers it to Factory's own loopback listener. Tokens and the code are never
   printed or logged. Links last 240 seconds (Factory's window); the helper reissues up to three times, so have the owner ready.
4. Verify: only `mcp-oauth.v2.file` changed (the other two hashes are identical); the live URL's
   entry is unchanged (the file is encrypted: compare that the previous bytes are still present
   as a block, or re-run a detached smoke against the old service and watch it still work);
   a routed session on a second instance reaches `notification: accepted`. The grant scope is
   `email offline_access openid profile` (account-level, same as before).
5. **Rollback of this step:** remove only the new per-URL entry. If Factory offers no
   per-entry removal, restore the backed-up `mcp-oauth.v2.file` **only after** confirming the
   hashes show nothing else wrote to it since, then re-run the verification. Also revoke the
   grant from the Amp account if the owner wants it gone.

## 2. Back up controller state (controller stopped)

```
supervisorctl stop teobucos-droid-mcp          # tunnel stays up
cp -a <stateDirectory> <private backups>/state-<timestamp>
sha256sum <stateDirectory>/state.json
cp <controller config> <private backups>/config-<timestamp>.json
```

## 3. Configuration change

| Key | Old | New |
| --- | --- | --- |
| `approvedDirectories` | two roots | add only the roots the owner approves |
| `maxConcurrentRuns` | `1` | `4` (up to 16) |
| `puck` | `{conversationId, url with threadID}` | **remove**; add `"ampMcp": {}` (startup rejects `puck` and thread-bound URLs) |

Delete the duplicated project MCP definition (`.factory/mcp.json`) that repeats the old
endpoint; the controller attaches the server itself. Keep `maxAutonomy`/`defaultAutonomy`/
`reasoningEffort` as decided by the owner.

## 4. Deploy

1. Check out the approved commit in the controller directory; `npm ci --ignore-scripts`.
2. Start: `supervisorctl start teobucos-droid-mcp`. Startup migrates state v2 to v3,
   keeps `state.json.v2.bak` (byte-identical) and recovers anything in flight as `unknown`.
3. Confirm: listener up, `state.json.v2.bak` present and its `sha256` equals the pre-migration hash.

## 5. Acceptance (public route)

1. Unauthenticated request returns 401; authenticated `tools/list` returns 17 tools.
2. Reconnect or refresh the Amp connection (`tool_search droid`) so Puck sees the new tools.
3. `droid_list_workspaces`: capacity `maximum: 4`, the approved roots, `policy.replyBack: true`.
4. A detached `droid_create_session` with a small model; wait; read; usage.
5. A routed session (`replyTo` = the Puck conversation) with a small model: expect
   `notification.state: accepted` and the agent message arriving in that conversation.
6. Three concurrent small sessions (distinct workspaces), one steered with `interrupt:true`, one
   cancelled; the others finish. Old aliases (`droid_status` on a pre-migration run id) still work.
7. Retarget or detach migrated sessions that still carry the archived recipient
   (`droid_send_message` with `replyTo`) before reusing them.

## 6. Rollback

1. `supervisorctl stop teobucos-droid-mcp`.
2. `mv state.json state.json.v3.rolledback`; `cp state.json.v2.bak state.json` (or restore the
   full state backup from step 2). Keep result files.
3. Restore the previous source revision and the backed-up config.
4. `supervisorctl start teobucos-droid-mcp`; verify seven tools, prior results and idempotency.
5. Remove only the new Amp per-URL entry (step 1.5). Leave the tunnel and bearer token alone.

Work accepted under the new version (new sessions, labels, queue losses) is not visible to old code.
