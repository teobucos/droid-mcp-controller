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

## 2. Approve workspace scope and choose a ceiling

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
  "maxAutonomy": "off"
}
```

Keep `off` for read-only evaluation. If the user authorizes edits/commands,
explicitly change the host ceiling to `low`, `medium`, or `high`. A tool request
cannot exceed that ceiling. Every start/continue must independently request a
non-off level; omission resets the next turn to read-only. Inspect project hooks
and existing Factory MCP configuration first. Approved cwd is not an OS sandbox;
use a restricted user/container if hard directory containment is required.

If an explicit reasoning level is required, add `reasoningEffort` supported by
the chosen Factory model. It is independent of autonomy and applies on start
and resume. Tool discovery shows the loaded approvals, ceiling, and reasoning.
Configuration edits require a coordinated restart when no runs are active.

## 3. Verify real authentication and durable continuation locally

With no other controller owning this state directory:

```sh
npm run smoke -- --config "$PWD/config.json" \
  --model YOUR_ENABLED_MODEL_ID \
  --out "$HOME/.local/state/droid-controller/acceptance.json"
```

Replace `YOUR_ENABLED_MODEL_ID` with an economical model verified in the current
Factory account catalog. The smoke passes it explicitly on both turns.

Expected: `PASS: real MCP lifecycle smoke; evidence saved`, exit 0. The private
artifact must show two succeeded runs, matching markers, the **same Droid UUID**,
different controller run IDs, and `passed: true`. It omits arbitrary assistant
text/stderr and all credentials. This starts a temporary STDIO controller and
makes two read-only model calls. Keep acceptance evidence locally; share only
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

Check-server and tool discovery must reveal all six tools. For a connection named
**Droid Grokbot**, Puck imports from `droid-grokbot` through `code_exec`, as shown
in README.md. Run an actual read-only start/result/continue and separate cancel
through that remote connection: local smoke is not cloud/Puck acceptance proof.
Retain controller run IDs and poll; there is no completion push.

## Recovery and operational limits

Stop the controller gracefully before backup/maintenance. Back up its state,
Factory session storage, and workspaces together. Do not copy state to another
host/profile and expect continuation. The owner lock refuses live/PID-reused
owners; inspect processes locally before removing a stale lock. If `.startup-lock`
survives a crash, verify no controller is running before removing that empty
directory. Never remove locks to run two controllers on the same store.

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
