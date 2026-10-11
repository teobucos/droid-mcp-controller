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

### Every full-suite run

| Run | Source | Result | Failing test (duration vs. its passing runs) |
| --- | --- | --- | --- |
| 1 | fix, pre-commit | 116/117 | e2e "SDK tool-only…": `timed_out`, 13.7 s vs ~5.0 s |
| 2 | fix, pre-commit | 117/117 | none |
| 3 | fix, pre-commit | 116/117 | e2e "terminal result survives crash…": `timed_out`, 13.4 s vs ~1.1 s |
| 4 | fix, pre-commit | 116/117 | e2e "MCP discovery/settings failures…": `timed_out`, 10.8 s vs ~3.6 s |
| 5 | `bafe209` | 110/110 | none |
| 6 | fix, 4000 ms timings | 115/117 | new lock case: `timed_out`, 13.5 s vs ~4.2 s (and its parent group) |
| 7 | `bafe209` | 110/110 | none |
| 8 | fix, 4000 ms timings | 117/117 | none |
| 9 | `a5f2344` | 117/117 | none |
| 10 | `a5f2344` | 117/117 | none |
| 11 | `a5f2344` + stall probe | 116/117 | review-regressions "delayed reply: ownership…": 13.5 s vs ~5.0 s |

Every failure is a deadline or timing assertion. Each failing test ran 7 to 12 s longer
than its own passing runs, and every failing test except the lock case runs only
untitled turns, whose code path this fix does not change.

Hypothesis: the guest VM is paused for several seconds when the sandbox host snapshots
or forks it, freezing every process, so tests with 1.1 to 8 s deadlines time out.
Discriminating check (run 11): `scripts/stall-probe.mjs` ran beside the suite and
recorded one 9209 ms timer stall at 04:38:24Z. Its fsync latency stayed at or below
287 ms over 962 samples, so the stall was a whole-process pause, not slow storage. The
kernel logged `random: crng reseeded due to virtual machine fork` at the same second,
and that run's single failure ran about 8.5 s longer than normal. The kernel logged 44
such events. `dmesg -T` wall times drift across guest pauses, so earlier runs could not
be matched to individual events. A pause hits only when it lands inside a deadline
window: three runs, including one of the `bafe209` runs, passed with a logged fork
inside their time span. The committed regression uses 8000/6500 ms timings instead of
4000/3100 ms so that a normal-length turn keeps more margin.

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
