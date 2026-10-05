# Install and connect securely

Install on the machine with the authenticated Droid CLI, not in a temporary
cloud coding environment. The controller was exercised with Droid **0.233.0**.
It uses that CLI's login; it does not need a separate SDK API key. For an existing
installation, preserve its URL, bearer, user/HOME, state store, and approvals.

## 1. Install the source and verify the host

Run on the approved Linux/macOS machine:

```sh
mkdir -p "$HOME/.local/share"
git clone https://github.com/teobucos/droid-mcp-controller.git \
  "$HOME/.local/share/droid-mcp-controller"
cd "$HOME/.local/share/droid-mcp-controller"
node --version                 # Requires Node.js 22 or newer
"$HOME/.local/bin/droid" --version
npm ci --ignore-scripts
npm run check
npm test
```

Do not replace an existing Droid installation/login unnecessarily. Verify real
authentication with the smoke below; a version check is not an auth check.
If login is required, do it privately on the host. Model execution incurs costs.

### Check Git author and GitHub account separately

From each approved repository, run `git var GIT_AUTHOR_IDENT` and
`git var GIT_COMMITTER_IDENT` before authorizing commits. Use the operator's
existing configured identity, not an email inferred from commit history or a
GitHub login. Factory's [0.213.0 release notes](https://docs.factory.com/docs/changelog/releases/0.213.0.json)
state that Droid uses the configured Git identity; this installation targets
0.233.0. The [settings](https://docs.factory.com/cli/configuration/settings)
option `includeCoAuthoredByDroid` controls a co-author trailer, not the primary
author. It does not fix a missing Git identity.

On a shared HOME, use private native Git conditional includes rather than an
unconditional global author. For example, append separate entries to the
existing `~/.gitconfig`, preserving its existing settings:

```gitconfig
[includeIf "gitdir:/work/alice/"]
    path = ~/.config/git/identities/alice.gitconfig
[includeIf "gitdir:/work/bob/"]
    path = ~/.config/git/identities/bob.gitconfig
```

Each private profile sets `user.name`, `user.email` and `user.useConfigOnly=true`
from the authoritative identity. For Git HTTPS authentication, a profile can
reset `credential.https://github.com.helper` to an empty value, then set it to
`!GH_CONFIG_DIR=/absolute/existing/account-directory /usr/bin/gh auth git-credential`.
Use the host's actual `gh` executable and already-approved credential directory;
never copy tokens into the profile. Repeat for gist only if already configured.
Keep profiles outside source repositories, with mode 600 and a private parent.
Existing repository-local overrides retain precedence; do not rewrite application
`.git/config` or set author/committer environment overrides to bypass them.

[Git 2.47 conditional includes](https://git-scm.com/docs/git-config/2.47.2#_conditional_includes)
match the actual Git directory, not arbitrary shell cwd. Linked worktrees inherit
the owning repository's root profile, including canonical symlink paths. Keep
repositories and their worktrees within the same owner root; a cross-user-root
worktree does not acquire the destination root's identity. Git 2.47 does not
support a `worktree:` include condition. Do not treat these profiles as OS isolation.

Direct `gh` commands use the launcher's existing `GH_CONFIG_DIR`; they do not
switch accounts on `cd`. Launch each runner/controller/Droid process with its
root's approved environment. The controller's SDK transport inherits that
environment on create/resume; there is no per-turn account selector. Verify with
`GH_CONFIG_DIR=/approved/existing/directory gh api user --jq .login` and the Git
identity commands, without printing credential-store contents or tokens. Token
environment variables can override stored GitHub credentials; see
[GitHub CLI environment](https://cli.github.com/manual/gh_help_environment).
Git reads profile changes on subsequent invocations, so profile-only changes
need no service restart. None of this expands controller workspace approval.

## 2. Approve workspace scope and confirm High execution

Create a private state directory **outside** the repositories Droid may edit:

```sh
mkdir -p "$HOME/.local/state/droid-controller"
chmod 700 "$HOME/.local/state/droid-controller"
cp config.example.json config.json
```

Edit `config.json` locally. Use actual absolute paths, e.g. `/home/alice/...` or
`/Users/alice/...`, not `~` placeholders:

```json
{
  "approvedDirectories": ["/home/alice/projects/approved-repo"],
  "stateDirectory": "/home/alice/.local/state/droid-controller",
  "droidPath": "/home/alice/.local/bin/droid",
  "transport": "stdio",
  "maxAutonomy": "high",
  "defaultAutonomy": "high",
  "modelCacheTtlMs": 60000
}
```

The owner's execution policy is High/full supported service-user access for
Droid agents. Source fallbacks and example config both use `defaultAutonomy` and
`maxAutonomy` equal to `high`; this grants no OS/root privileges. A tool request
cannot exceed the host ceiling. Callers should explicitly use `autonomy:"off"`
for read-only work, as the smoke does on both turns. If installing under a lower
ceiling, also set a compatible `defaultAutonomy` (for example both `off`); an old
config with only `maxAutonomy:"off"` now needs an explicit off default.
Inspect project hooks and existing Factory MCP configuration first. Approved cwd is not an OS sandbox;
use a restricted user/container if hard directory containment is required.

If an explicit reasoning level is required, add `reasoningEffort` supported by
the chosen Factory model. It is independent of autonomy and applies on start
and resume; the optional per-turn field overrides it. High autonomy approves
offered single-use permissions, not persistent rules; questions are recorded
and declined instead of guessing answers. Inspect unanswered questions even
when the SDK reports success. Tool discovery shows approvals, default, ceiling,
and reasoning.
Configuration edits require a coordinated restart when no runs are active.

## 3. Verify real authentication and durable continuation locally

First call `droid_models({})` through the authenticated MCP connection on this
host. Choose an economical currently returned ID with supported reasoning.
Never copy an ID from old docs, prior controller history, or another account.
Discovery uses the authenticated CLI without another Factory API key and
submits no task prompt. If discovery fails, fix authentication/runtime access
locally rather than relying on an expired or guessed catalog.

With no other controller owning this state directory:

```sh
npm run smoke -- --config "$PWD/config.json" \
  --model YOUR_ENABLED_MODEL_ID \
  --out "$HOME/.local/state/droid-controller/acceptance.json"
```

Replace `YOUR_ENABLED_MODEL_ID` with the selected `droid_models` ID. The smoke
fetches the current catalog before launching, verifies the explicit selection,
and passes `--model` unchanged on both turns; it never guesses a replacement.
For STDIO-only acceptance, obtain the catalog from a temporary STDIO MCP client,
close that controller, then run the smoke against the same host config.

Expected: `PASS: real MCP lifecycle smoke; evidence saved`, exit 0. The private
artifact must show two succeeded runs, matching markers, the **same Droid UUID**,
different controller run IDs, current catalog metadata, and `passed: true`.
It omits arbitrary assistant text/stderr and all credentials. This starts a
temporary STDIO controller and makes two read-only model calls. Keep acceptance evidence locally; share only
the sanitized artifact if desired.

Do not use `--expect-auth-failure` for user-host acceptance. That switch is for
isolated unauthenticated protocol verification only.

## 4. Choose local STDIO or remote Puck access

For an MCP client actually running on that host, configure STDIO directly:

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/home/alice/.local/share/droid-mcp-controller/src/server.mjs",
    "--config",
    "/home/alice/.local/share/droid-mcp-controller/config.json"
  ]
}
```

Use the real Node path from `command -v node`. That is not a way for cloud Puck
to execute on the user's machine. Cloud Puck needs a reachable **authenticated
HTTPS remote MCP endpoint** served by the controller on that machine.

For remote Puck, generate a token locally without printing it:

```sh
(umask 077; node -e 'require("node:fs").writeFileSync(process.argv[1], require("node:crypto").randomBytes(32).toString("base64url")+"\n", {flag:"wx",mode:0o600})' \
  "$HOME/.local/state/droid-controller/mcp-token")
```

Change config to `"transport":"http"`, add `"port":8787`, and set
`"tokenFile"` to the absolute token path. When a proxy/tunnel URL is chosen, add
`"publicUrl":"https://YOUR-APPROVED-HOST/mcp"`. Start in the foreground to check
startup, then supervise with the user's existing systemd user service/launchd:

```sh
node src/server.mjs --config "$PWD/config.json"
```

Run it as the authenticated user with the same HOME/profile, not root. It binds
only IPv4 loopback and rejects every unauthenticated request. Do not change it
to `0.0.0.0`. Use a user-approved TLS reverse proxy or outbound tunnel to that
loopback port. Preserve Authorization, Content-Type, Accept and MCP protocol
headers, POST bodies, and either the public Host or the loopback Host+port. Do
not log Authorization, return it in errors, expose other local services, or add
a proxy rule that injects the credential for arbitrary unauthenticated callers.
The public endpoint must retain Bearer enforcement; additional access controls
must also be compatible with Puck's MCP client.

Use an approved dedicated HTTPS route for `/mcp` and a catch-all 404, never a
general-purpose tunnel to other local services. While HTTP is running, verify
locally and through that TLS route:

```sh
npm run smoke -- --config "$PWD/config.json" \
  --model YOUR_ENABLED_MODEL_ID \
  --out "$HOME/.local/state/droid-controller/http-acceptance.json"
npm run smoke -- --config "$PWD/config.json" \
  --model YOUR_ENABLED_MODEL_ID \
  --url 'https://YOUR-APPROVED-HOST/mcp' \
  --out "$HOME/.local/state/droid-controller/remote-acceptance.json"
```

These read the token file locally; do not put token values on command lines.
Without authentication the public endpoint must return HTTP 401. With the
correct credential the remote smoke must pass before connecting Puck.

## 5. Connect Amp/Puck once, then use the tools directly

Create the approved remote MCP connection using the HTTPS `/mcp` URL and
**Bearer** authentication. Provision the existing token through private settings
or the supported private credential-file flow, never through chat, logs, command
arguments containing its value, or MCP parameters. Follow the current
[Amp MCP instructions](https://ampcode.com/docs/markdown/customize/mcp).

Puck can use `manage_amp(topic:"remote_mcp_servers",operation:"help")` for the
supported management operations. Named-secret credentials are copied, not linked;
rotation requires updating both the local token file and stored MCP credential.
Do not select authentication `none`, recreate a healthy connection, or rotate
credentials just to upgrade controller source.

Check-server and tool discovery must reveal the 11 session tools
(`droid_create_session` ... `droid_models`) plus the six deprecated aliases
(17 tools; `droid_models` is shared). For a connection named **Droid Grokbot**, Puck
imports from `droid-grokbot` through `code_exec`, as in README.md and
[docs/TOOLS.md](docs/TOOLS.md). Run an actual read-only create/wait/read/send and a
separate cancel through that remote connection: local smoke is not cloud/Puck
acceptance proof. Keep session handles; use `droid_wait_for_sessions` (bounded
joins) rather than polling. There is no completion push.
Non-off turns lock their canonical workspace tree through cleanup; conflicting
work queues FIFO (it is never submitted early). Off readers may share overlapping
paths. Capacity defaults to 4 (`maxConcurrentRuns`, 1 to 16) and is reported by
`droid_list_workspaces`. For a cutover from the old service see
[docs/CUTOVER.md](docs/CUTOVER.md); state and recovery are in
[docs/STATE-MIGRATION.md](docs/STATE-MIGRATION.md).

## 6. Optionally connect Droid back to Puck through Amp OAuth

This is separate from Puck's Bearer connection to the controller. Add private
`"ampMcp": {}` host configuration (README.md). The endpoint is the generic
`https://ampcode.com/mcp?profile=external-agent`: it must not carry a `threadID`, and the
old `puck: {conversationId, url?}` key is rejected at startup. Recipients are chosen per
session with `replyTo`; no host default exists. Never place personal thread IDs, tokens
or private MCP headers in the public repository.

**Factory stores the Amp OAuth token per exact endpoint URL**, so the sign-in must be
done once for this URL, as the service user, in Factory's private credential store. Use
`node scripts/amp-signin.mjs --config <config> --dir <private dir>`: it drives
`session.authenticateMcpServer({serverName:"amp-puck"})` through a throwaway
project-level definition, writes the authorization link to a mode-600 file and delivers
the owner's pasted callback URL to Factory's loopback listener. If the browser runs
elsewhere, a loopback redirect refers to that browser's machine; hence the paste step.
Do not put codes/tokens into shell arguments or logs, and back up the credential store first
(see docs/CUTOVER.md). Successful consent must be followed by authenticated tool
discovery (a routed session reaching `notification: accepted`), not assumed from a
browser success page.

Controller SDK injection supplies the same connection on create/resume in every
approved cwd, so no edits to application repositories are needed. The controller's preflight verifies, before any task prompt, that
`listTools` returns `amp-puck___puck` allowed and `amp-puck___manage_amp` denied.
This is model-context filtering, not a narrow OAuth security grant. The actual
tool supports explicit `params.conversationID` and correlated `params.replyHandle`;
the URL's threadID alone is not routing proof. Native AskUser is recorded
(`latestRun.questions`) and declined; its terminal SDK result does not guarantee
interruption or task completion, so check `needsAttention`.

Release a reserved execution slot only after metadata checks and safe migration.
Have Puck launch separate economical sessions with unique markers and `replyTo` set. Require
actual agent-origin messages in the designated Puck conversation and a reply read
back by Droid. Record handles and tools used; no application edits, admin calls
or cloud jobs are needed. Initialize/tool-list success is not message acceptance.
Status/result remain necessary when a task cannot send a report.

## Recovery and operational limits

Stop the controller gracefully before backup/maintenance. Back up its state,
Factory session storage, and workspaces together. Do not copy state to another
host/profile and expect continuation. The owner lock refuses live/PID-reused
owners; inspect processes locally before removing a stale lock. If `.startup-lock`
survives a crash, verify no controller is running before removing that empty
directory. Never remove locks to run two controllers on the same store.

The first upgraded startup atomically migrates v1 state to v2, removes original
prompt fields and selects each initial session head by durable acceptance time.
IDs, fingerprints, outcomes and per-run results stay intact; unknown sessions
remain blocked. Invalid state/timestamps/heads refuse startup without resetting
history. Back up stopped private state before upgrading. Inspect head choices
locally if the old controller allowed misleading branches; the latest accepted
run, not its parent edges, becomes head. A downgrade needs the matched v1 backup
and old source. Sensitive prompts may still exist in backups, assistant echoes,
permission context and Factory's own session history.
Old result files are deliberately preserved; new result files omit SDK copies
of submitted user messages, not independently generated assistant output.

Confirm explicit host autonomy policy during upgrade: High/full access supersedes
the earlier default-off/blanket-permission-decline specification. High approves
only offered `ProceedOnce`; it does not install persistent permission grants.
AskUser human decisions are retained as interrupted question context, not guessed.
Existing accepted keys replay their original autonomy/reasoning despite changed
defaults. Preserve workspace approvals, bearer authentication and service-user
boundaries when applying this policy; model discovery never authorizes tools.

A crash without a durable result yields `unknown`; Puck may retrieve context
but cannot continue that UUID through this server. Inspect saved Droid history
and files locally, reconcile possible side effects, then start fresh or resume
the UUID manually. Forced cancellation and timeouts do not roll back changes,
and deliberately backgrounded commands can outlive Droid's process group.
Keep unrelated Droid sessions/processes away from UUIDs owned by this controller.

Reserve a safe window with every caller before restarting only the controller.
Leave a healthy connector running. Confirm old results, keys, and sessions survive
and that the same public URL still rejects unauthenticated requests. HTTP 530 is
an HTTPS/connector failure, not proof of a failed Droid task; see README.md for
retry and DNS guidance. Process autorestart does not prove boot persistence:
configure only the machine's supported startup mechanism and document any gap.
