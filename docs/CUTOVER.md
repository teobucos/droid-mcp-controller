# Session-only deployment and rollback

Requires operator authorization. Use private paths below; never commit tokens,
host configuration, state, personal thread IDs or runtime artifacts.

## Prerequisites

1. Implement and test in an isolated worktree on Node 22:
   `npm ci --ignore-scripts && npm run check && npm test`.
2. Merge the approved PR. Record the merge SHA, previous deployed SHA, local `main`
   and fetched `origin/main` separately. The runtime executes `src/server.mjs`
   directly; do not advance its checkout while it is serving work.
3. Coordinate a no-new-work window with Puck/operator. Check
   `droid_list_workspaces`: both active and queued must be zero. Recheck immediately
   before stopping. Never cancel someone else's jobs for a deployment.
4. Validate a private copy of current state against the new source without submitting
   tasks. Only v3 with durable `replyHandles` and `replyRouteId` is supported;
   unsupported state must block the deployment, not be reset or silently migrated.
5. Record current session/run counts and result checksums for the preservation check.

## Back up and deploy

Use the existing supervisor's private configuration/socket. Stop only the controller,
not the tunnel or unrelated services:

```sh
supervisorctl -c <private supervisor config> stop teobucos-droid-mcp
cp -a <stateDirectory> <private backup>/state
cp <controller config> <private backup>/config.json
git archive <previous deployed SHA> > <private backup>/source.tar
```

Retain matching dependencies and a manifest with hashes and the rollback SHA.
Do not read or copy Factory credential files. Leave token, OAuth, workspace roots,
service user/HOME, endpoint and tunnel configuration unchanged.

Fast-forward the stopped runtime checkout to the merged `origin/main`; refuse a
dirty/divergent checkout. Install locked dependencies only if the lockfile changed.
Start the controller, verify its PID/cwd/argv and source bytes against the merge SHA.
Compare state and results with the backup before creating acceptance work.

## Acceptance

- Unauthenticated HTTP is 401. Authenticated `tools/list` contains exactly the 11
  tools in docs/TOOLS.md. Each removed name fails at dispatch, not merely discovery.
- Existing sessions, results, request keys and unknown outcomes remain intact.
- Run detached create/wait/read/send/usage with an explicitly selected current
  model supporting `low`, `reasoningEffort:low`, `autonomy:off`, and `replyTo:null`
  in the operator-approved smoke root. Check exact output and cleanup.
- Refresh the connected client's MCP catalog. Puck independently retests the
  connected MCP; local HTTP alone is not proof of public/cloud acceptance.
- If a routed check is needed, use the actual requesting Puck conversation.
- Detached work (`replyTo:null`) never contacts Amp and needs no Amp sign-in.
  Routed reply-back uses `https://ampcode.com/mcp?profile=puck`. Factory stores Amp
  OAuth per exact URL, so a host previously signed in only for an older profile URL
  needs one supported owner sign-in (`scripts/amp-signin.mjs`) for the current URL
  before routed sessions can pass preflight; until then they fail before any prompt
  with an `amp_mcp_*` code.

## Rollback

First coordinate another idle window and stop only the controller. Restore the
previous source and matching dependencies. This change keeps the current v3 state
format, so preserve new accepted work; do not blindly replace state with an older
backup. If restoring state is necessary, retain the failed deployment's complete
state/results separately and reconcile any work accepted since the backup first.
Restart and verify source provenance, authentication, history and capacity. Keep
the tunnel, bearer token and Factory credentials unchanged.
