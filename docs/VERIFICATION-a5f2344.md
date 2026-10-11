# Title sync must not time out finished turns

Historical evidence for the linked revision, not the current deployment status.
See README.md ("Titles and tags") for current behavior.

Corrected source:
[`a5f2344`](https://github.com/teobucos/droid-mcp-controller/commit/a5f2344) on
branch `fix/title-sync-deadline`, based on `main` at
[`bafe209`](https://github.com/teobucos/droid-mcp-controller/commit/bafe209d0c2a03b395e4ae238488b8d1ab17054e)
(PR #7). Not merged or deployed. The live checkout, controller services, roots, host
config and credentials were not touched. No prompts, credentials, personal
conversation IDs, Factory session IDs or full artifacts are included here.

## Regression

Independent review: `src/worker.mjs` awaited the optional `session.rename()` before
sending the terminal result, while `src/controller.mjs` kept the execution deadline
armed until that result arrived. With a 4000 ms deadline, a successful 3100 ms turn
and a hanging rename, the controller reported `timed_out` and `needsAttention:true`
although the durable result was `success:true`/`subtype:success`. An untitled 3100 ms
turn and a titled 700 ms turn with the same hanging rename both succeeded. PR #7's
claim that a rename failure "never changes the turn's outcome" was therefore false
near the deadline.

## Correction

The worker sends the terminal result first; that disarms the execution deadline.
Only then does it attempt the bounded rename (`min(10 s, runTimeoutMs / 4)`). The
controller's post-result kill timer is extended by that window for titled turns only,
the slot and workspace lock remain held until the worker exits, and an unfinished
rename is recorded as a nonfatal `title_sync_failed` (retried on the next turn).
Cancelled and timed-out turns are not renamed. Untitled turns follow exactly the
previous path. No state fields, schemas, fingerprints or tool contracts changed.

## Results

| Evidence | Result |
| --- | --- |
| Review repro on `bafe209` (4000 ms deadline, 3100 ms titled turn, hanging rename) | Failed as reported: durable result success, state `timed_out`. |
| Same case scaled to 8000/6500 ms on `bafe209` | Failed the same way (scaled so host load cannot cause a genuine timeout). |
| Regression group on `a5f2344` | 6/6: near-deadline hanging rename succeeds with nonfatal `title_sync_failed`; slow successful rename applied; untitled and short titled controls succeed; genuine overrun still `timed_out` with no rename; same-tree writer starts only after the renaming worker closed its Droid session. |
| Full `test/factory-title.test.mjs` | 12/12. |
| Mutations of the fix (rename before result, no title cleanup window, deadline armed after result) | Each fails the suite. |
| `npm run check` | Passed. |
| Full `npm test` on `a5f2344` source | 117/117 in the final two consecutive runs. |

Earlier runs of the same source showed intermittent `timed_out` results in other,
deadline-sensitive tests (several in `test/e2e.test.mjs`, which runs first, and one
run of the new lock case before its timings were relaxed). Each passed when rerun on
its own. Two full runs of `bafe209` passed 110/110. The untitled code path is
unchanged, but the intermittent failures were not proven to be unrelated.

## Real CLI acceptance (SDK/CLI evidence)

`scripts/verify-direct-launch.mjs` on clean source `a5f2344`, Droid CLI 0.236.0,
Factory SDK 0.9.1, Node 22.23.3, disposable controller and state under the ignored
`.amp/in/acceptance/`, existing CLI login, `defaultModel: claude-opus-5-5`,
reasoning `low`, no `ampMcp`: 21/21 checks passed. Two fresh titled sessions ran in
parallel. Their first turns applied the titles, continuations did not rename again,
and a `droid_update_session` title change started no turn and was applied after the
next turn. Exactly three rename RPCs succeeded, five turns were submitted, and Amp was
never contacted. SDK `listSessions()` and the CLI's local session start record return
the controller titles with the manual-title flag set. Local session settings carry the
label tag beside the SDK's `sdk` tag.

**Factory web dashboard display is not verified.** The evidence above is local
CLI/SDK storage and RPC success. Upload depends on the existing `cloudSessionSync`
setting, which was not changed. No authenticated browser check was made, and Remote
Control was not enrolled.

## Reproduction

```sh
git checkout a5f2344
npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
npm run check
node --test --test-name-pattern='near the deadline' test/factory-title.test.mjs
npm test
node scripts/verify-direct-launch.mjs --droid /abs/droid \
  --default-model CURRENT_ID --root /abs/disposable/dir --reasoning low
```

For the failing-before case, copy `test/factory-title.test.mjs` and
`test/mock-droid.mjs` from this source into a disposable checkout of `bafe209` and
run the same `near the deadline` pattern.
