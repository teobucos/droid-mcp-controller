# Factory setup on grok-bot (2026-10-13)

Snapshots of the live configuration on the `grok-bot` Droid computer. No secrets.

- `factory-settings.json`: copy of `~/.factory/settings.json`. Dashboard session defaults: model `claude-opus-5-5`, `reasoningEffort` high, `sessionDefaultSettings.autonomyLevel` high. Verified: a new dashboard session opens on Opus 5.5 with autonomy High.
- `factory-settings.previous.json`: the file before this change.
- `droid-mcp-config.json`: copy of `~/.config/droid-mcp/config.json` (default model `claude-opus-5-5`, reasoning high, max autonomy high, approved root `/workspace`).

## Cleanup done
- Deleted 78 Factory test sessions; archived the droid-smoke project (3 sessions), the tmp session, and the `droid-mcp-controller-optimize-defaults` project with its Oct 10 session (work verified merged on main, PRs #6-#9).
- Old "anonymous" computer removed; this machine registered as `grok-bot`; `droid daemon --remote-control` runs via `~/.droid-daemon/run.sh`.
- Local folder renamed `/workspace/droid-mcp-controller` to `/workspace/droid-mcp`; stale droid-smoke/tmp session folders and session-index cache removed.
- Dashboard projects now: Droid MCP (`/workspace/droid-mcp`) and Zeus Core (`/workspace/zeus-core`), plus a "Defaults test" session.
