# State migration and recovery

State lives in `stateDirectory`: `state.json`, `<runId>.result.json`, `owner.json`.

## Versions

| Version | Shape |
| --- | --- |
| 1 | `runs` with raw `prompt` |
| 2 | `runs` (prompt-free) + `sessionHeads` (Droid UUID -> head runId) |
| 3 (current) | `runs` (each with `sessionId`, `replyTo`) + `sessions` (`headRunId`, `title`, `labels`, `archived`, `replyTo`, `workspace`, `droidSessionId`, `seq`) + `nextSeq` |

## What the upgrade does

1. Takes the single-owner lock, parses and validates the file. v1 is first converted to v2
   (prompts dropped, heads by acceptance time). Heads missing or belonging to another
   session, bad timestamps, or any inconsistency **refuse to start without rewriting**.
2. Copies the validated pre-migration bytes to `state.json.v1.bak` or `state.json.v2.bak`
   (`COPYFILE_EXCL`; an existing backup is never overwritten).
3. Groups runs by Droid session UUID into controller sessions (a run that never obtained a
   UUID is its own session), assigns `seq` by acceptance order, a neutral title
   (`Droid session <8 hex>`), no labels, not archived. The head becomes `headRunId`.
4. `replyTo` of each session is the recorded `puckConversationId` of its head run (or `null`).
   Nothing is retargeted: sessions that carry the archived host-default recipient keep it
   until you retarget or detach them with `droid_send_message({replyTo})`.
5. Run ids, request keys, fingerprints, results and `unknown` outcomes are untouched.
   Migrated fingerprints are marked version 2. Identical retries through `droid_start`
   or `droid_continue` compare the original v1/v2 serialization and return the existing
   outcome without re-running, even when the old run is no longer head. Already-migrated
   records retain `parentRunId`, which also identifies that comparison contract.
   Changed intent conflicts. New session tools do not interpret an old fingerprint as
   acceptance of new title, labels or steering semantics: use the original legacy alias
   to retry an old request, never a new request key to bypass uncertain acceptance.
   The removed host-default recipient is not restored: if an old `droid_start`
   implicitly used one, retry with that recorded `puckConversationId` explicitly.
   Omitting it now means detached and therefore conflicts with that routed intent.

Every start also recovers: runs that were `starting/running/cancelling` become `unknown`
(or take their stored terminal result); runs that were `queued` become `cancelled` with
`queue_lost` because their prompt was memory-only and they were never submitted. Nothing
is replayed.

## Known approximations of migrated history

- **Submission is inferred for legacy runs.** v1/v2 records never stored whether the task prompt
  reached Droid. A migrated run counts as submitted (usage turns, `historyAvailable:false` when its
  transcript is missing) if it had a Droid session UUID or a stored result. A legacy run that failed in
  Amp MCP preflight after the session was created is therefore counted as a turn in `droid_get_usage`
  and shows a "no transcript" notice. Older v3 `submittedAt` fields are also intent
  markers, not exact acceptance timestamps. New runs record `submissionIntentAt`
  before sending to Factory. The worker waits for correlated acknowledgments after
  file and directory fsync of both the session UUID and submission intent. A crash
  after acknowledgment can still leave an unaccepted or partially executed turn;
  this is not exactly-once execution. Usage counts potentially submitted turns.
- **Development builds of v3.** State written by pre-release v3 builds (before the `submittedAt`
  field) is not a supported input; only v1/v2 production state is migrated.

## Roll back

Stop the controller. Restore `state.json.v2.bak` over `state.json` (and keep the v3 file as
`state.json.v3.rolledback`), restore the matching source and config, start. Work accepted
under v3 (new sessions, queue losses, metadata) is not visible to old code and result files
remain valid. Never run old code against a v3 file.

## Recover from `unknown`

Inspect the workspace and Factory history for that session locally. The controller refuses
further turns on it (`session_unknown_outcome`). Start a new session with a new
`requestKey` after reconciling. Do not edit state to manufacture success.

## Retention

Progress is bounded: last 20 events, 4000 chars per event field, 16000-char text/stderr
tails, 10 declined questions. Result files omit SDK user-message copies. Completed records are
not deleted automatically; archive with the controller stopped, preserving keys if you need
deduplication. The byte-identical v1 backup retains its original raw prompts; protect
it as private recovery data. The migrated state and new result files omit original
user-message copies; assistant echoes and tool output are separate retention concerns.
