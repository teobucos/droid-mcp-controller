# Failure cases (written before implementation)

The E2E suite calls the real MCP surface and real Factory SDK process transport
against a mock `droid exec` executable. It must distinguish these failures:

- A slow task blocks start; duplicate start creates another session; a reused key
  changes the prompt/workspace/settings; deduplication disappears after restart.
- Tool discovery hides approved workspace roots and host settings, encouraging
  invalid launches; status loses the explicit host reasoning setting on restart.
- Two continuations overlap or reuse a different session UUID. Settings inherited
  from a saved session silently override requested autonomy/model.
- Per-turn reasoning is ignored on start/resume; changing it reuses a key;
  changing host defaults after restart breaks replay of an accepted legacy key.
- An explicitly configured high default remains Spec/off or cannot approve an
  offered single-use permission; an explicit off override inherits high instead.
  High silently creates persistent permission rules or invents unavailable options.
- Idle, text, silence, malformed JSON, unrelated turn completion, process exit,
  or a timeout is mistaken for a successful terminal result.
- Permission/AskUser requests hang or are approved without authorization; spec
  mode is silently exited; CLI flags are used instead of protocol settings.
- Cancel during setup/streaming hangs, becomes success without a terminal result,
  or kills another run; cancel after terminal completion rewrites its result.
- Results, partial progress, stderr, failed turns, and session IDs are lost on
  restart; a controller crash replays accepted work; a second controller races
  the first; corrupted persistence is silently reset.
- Path traversal, prefix siblings, symlink escapes, or changed resume cwd escape
  configured directories; remote callers elevate above the configured ceiling.
- HTTP is exposed without authentication; wrong token, Origin, Host, oversized
  body, or an unsupported route bypasses checks. STDIO leaks diagnostic output.
- Worker cleanup allows overlapping turns after completion; an orphan worker
  survives controller death; logs grow indefinitely in the state record.

Expected outcomes are independently asserted, including exact final text and
UUIDs, request settings in a mock wire audit, and real process exit/restart.
`npm test` emits TAP, suitable for a repeatable handoff artifact.
