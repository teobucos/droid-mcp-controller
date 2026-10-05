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
5. Run ids, request keys, fingerprints, results and `unknown` outcomes are untouched. A
   replay of an old key through the new code with identical arguments conflicts instead of
   re-running (the fingerprint schema changed); that is the fail-closed direction.

Every start also recovers: runs that were `starting/running/cancelling` become `unknown`
(or take their stored terminal result); runs that were `queued` become `cancelled` with
`queue_lost` because their prompt was memory-only and they were never submitted. Nothing
is replayed.

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
deduplication.
