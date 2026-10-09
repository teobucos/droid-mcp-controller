# Current state and recovery

State lives in `stateDirectory`: `state.json`, `<runId>.result.json`, `owner.json`.
Only version 3 is accepted. Startup no longer migrates v1/v2, backfills reply
ownership, or interprets obsolete request fingerprints. Incomplete ownership
records fail closed, without rewriting the state file.

## Durable session contract

`sessions` contains controller handles, authoritative `headRunId`, title, labels,
archive flag, workspace, explicit `replyTo`, Factory session UUID and sequence.
`runs` contains each accepted turn, request key and fingerprint, outcome, progress,
result reference, durable `replyHandles` and `replyRouteId`. These are current
session internals, not a callable run API. `nextSeq` remains monotonic.

The session API fingerprint serialization is unchanged, including its fixed null
slot, because prompt-free state cannot recompute accepted hashes. Current session
request keys replay only identical intent. Keys belonging to removed tools remain
reserved, but cannot be retried through those tools or translated into new intent.

Existing `submittedAt` values remain stored intent markers used by history/usage;
new turns write `submissionIntentAt`. Neither proves exact Factory acceptance.
Keeping these data fields preserves current stored history without a migration.
The worker waits for correlated, fsynced acknowledgments of session UUID and
submission intent before submission. A subsequent crash can still leave an
unaccepted or partially executed turn; this is not exactly-once execution.

## Startup and recovery

Startup validates host/HOME, request-key uniqueness, session sequences, head
ownership and matching Factory UUIDs. Invalid state refuses startup; nothing is
reset or repaired automatically.

Runs in `starting/running/cancelling` become `unknown` unless a complete durable
terminal result establishes the outcome. Queued turns become `cancelled` with
`queue_lost`: their prompts were memory-only and never submitted. Nothing replays.

An `unknown` session cannot continue. Inspect its workspace and Factory history
locally, reconcile side effects, then create a new session with a new request key.
Do not edit state to manufacture success.

## Backup and rollback

Back up stopped state, results, source and matching dependencies privately before
deployment; preserve credentials and the service user's identity. Do not run
unsupported source against state or roll back a backup over newly accepted work.
See [CUTOVER.md](CUTOVER.md). Old private backups remain recovery data, not inputs
this server promises to migrate.

## Retention

Progress is bounded: last 20 events, 4000 chars per event field, 16000-character
text/stderr tails, 10 declined questions. Result files omit SDK user-message copies.
Completed records are not deleted automatically. Preserve keys if archiving with
the controller stopped. Old backups, assistant echoes, tool output and Factory
history may contain sensitive text; protect them independently.
