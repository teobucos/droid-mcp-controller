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

## Reliability/safety/catalog revision failure cases

Before implementation, extend protocol E2E to distinguish:

- A stale ancestor continues after a successor, failure, restart or v1 migration;
  two simultaneous continuations both launch; an unknown descendant is bypassed.
  A v2 authoritative head is ignored or a missing/wrong-family head is repaired
  silently. V1 acceptance timestamps, not insertion order or parent edges, choose
  the migrated head; malformed timestamps must refuse startup.
- Original prompt text remains in accepted/completed/migrated state, or removing
  it breaks fingerprint-based replay with changed defaults after restart. Use a
  unique non-echoed marker; separately permit assistant echoes as result data.
  SDK user-message copies in new result files are original input, not assistant
  output. The protocol peer emits user notifications to catch this retention.
- Reader/writer overlap succeeds in either order, nested paths work only one way,
  symlink spellings bypass locks, or siblings are wrongly locked. Multiple readers
  may overlap. A received terminal result releases a writer before slow cleanup.
  Global concurrency still bounds readers and distinct workspace writers.
- Discovery is missing, caches per HTTP request instead of per controller, starts
  duplicate simultaneous probes, returns disabled/historical models, fabricates
  optional metadata, ignores snake-case catalogs, or keeps an expired catalog
  after a failed refresh. A discovery process submits a prompt, authorizes tools,
  hangs without cleanup, omits the SDK-required machineId, or needs FACTORY_API_KEY.
  Mock audit proves init/close without a turn and dead child PIDs; catalog changes
  prove replacement, not merge.
- Malformed JSON/envelopes return 500; unexpected dispatch/setup errors become
  400 or leak paths/stacks. Inject an SDK exception in the spawned test process,
  check generic HTTP body and detailed private stderr, and preserve MCP isError
  for ordinary lifecycle rejections plus existing HTTP security/status checks.
- Latest owner policy: omitted host settings must use Auto/high and approve only
  an offered ProceedOnce. Explicit off and independent reasoning must still work;
  human AskUser decisions interrupt with retrievable context, never guessed answers.

## Puck coordination failure cases

Tests-first protocol cases distinguish missing OAuth attachment on resume or
outside the controller cwd, silently usable Amp admin tools, unavailable messaging
before task submission, lost explicit recipient/run/session correlation, recipient
changes bypassing idempotency, and routing accepted without host MCP configuration.
The mock artifacts prove configuration/protocol wiring only. Live acceptance also
requires an actual agent-origin message and correlated Puck reply; discovery alone
cannot prove delivery.

Expected outcomes are independently asserted, including exact final text and
UUIDs, request settings in a mock wire audit, and real process exit/restart.
`npm test` emits TAP, suitable for a repeatable handoff artifact.
To retain the sanitized two-turn **mock**, not live-host, smoke artifact too:

```sh
mkdir -p .amp/in/artifacts
DROID_E2E_ARTIFACT="$PWD/.amp/in/artifacts/mock-smoke.json" npm test \
  > .amp/in/artifacts/e2e.tap 2>&1
```
