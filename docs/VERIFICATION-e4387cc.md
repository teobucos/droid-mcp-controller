# Approved-send provenance correction

Historical evidence for the linked revision, not the current deployment status.
Ownership backfill has since been removed; current durable ownership is preserved.
See TOOLS.md and CUTOVER.md for current behavior.

Date: 2026-10-09 UTC. Corrected source:
[`e4387ccca773efd123755309692660593efb416c`](https://github.com/teobucos/droid-mcp-controller/commit/e4387ccca773efd123755309692660593efb416c).
This correction is awaiting exact-SHA independent High re-review. It is not merged,
deployed, or accepted by the live Puck client. Production remains on
[`ed1837c40d0165d54cda3338831487b77f997538`](https://github.com/teobucos/droid-mcp-controller/commit/ed1837c40d0165d54cda3338831487b77f997538).
No original prompts, credentials, personal conversation IDs or full artifacts are
included here. MIT, dependencies, tool schemas, admission/locks and state version 3
remain unchanged; no CI was added.

## Confirmed MOCK/CONTROLLED counterexample

Independent High review blocked the prior source
[`6d44c313f0306665bf26c08f80c3b5fcb507ffed`](https://github.com/teobucos/droid-mcp-controller/commit/6d44c313f0306665bf26c08f80c3b5fcb507ffed).
Its 140 passing tests missed this sequence:

1. A genuinely approved send returns a handle.
2. A queued detach is accepted and cancelled; its exact retry does not resubmit.
3. Reattachment correctly denies the old handle, including at high autonomy.
4. The protocol peer replays the original call/result without a current-run send
   approval. The old worker grants the stale handle; a low-autonomy read succeeds.
5. After close/reopen, an off-autonomy read succeeds from the persisted false grant.

The fresh regression first failed on the prior PR source: both replay/reopened
reads had zero declines instead of one. This uses authenticated controller MCP,
the actual worker and pinned SDK, with a controlled remote protocol peer. It is
**not a demonstrated live CLI exploit** and performed no real Amp calls.

## Correction and fresh controlled results

`src/worker.mjs` records only current-turn approved own-recipient send IDs after
submission-intent persistence. A matching call/result consumes that approval;
only a non-error result can grant ownership. Raw replay cannot create approval.
The bound controller worker entry independently checks the matching approval ID,
recipient and Factory UUID before durably saving handles. Compact approval proof
does not depend on the clipped human-readable permission details. No approval
set is inherited by another worker; only proven ownership is inherited within
the existing session/recipient route generation.

| Fresh evidence | Result |
| --- | --- |
| Targeted candidate suite | 11/11 passed, zero failed/skipped/cancelled. |
| Frozen corrected source `npm run check` | Passed. |
| Frozen corrected source full `npm test` | 141/141 passed, zero failed/skipped/cancelled; one regression added to 140. |
| Copied original review probe against corrected source | `cancel` before and after reopen, no approved send in replay, no stale handle persisted; exact cancelled retry did not submit. |
| Wrong-ID and foreign-recipient approval replay | Denied with `needsAttention:true`; neither grants stale ownership across reopen. |
| Existing delayed-read/restore and denial contracts | Passed in the full suite, including legacy provenance, foreign/malformed/unobserved handles, route transitions and policy reasons. |

README ownership/high-autonomy descriptions now match the scoped policy. The
previous report `VERIFICATION-6d44c31.md` explicitly records its blocked release
verdict instead of treating its green suite as acceptance.

## Fresh real retained-provenance copy, not live E2E

At 09:08:08Z the corrected source opened a disposable copy of retained state and
result files. It recovered the existing approved R handle, authorized its existing
continuation, closed/reopened, and preserved all 96 runs, 34 sessions and existing
fields. Live state remained byte-identical; no worker, model prompt or live
send/read was launched. The legacy proof/backfill algorithm was not weakened.

## Historical and still-unverified evidence

The prior High review independently passed check/140 tests and retained-provenance
restore, but blocked release on the replay counterexample. Earlier Puck-observed
core workflows and delayed-reply failure remain historical observations on the
production source, not retests of this correction. Older Ultra 118-test, 12/12
authenticated model-smoke and 6/6 route-probe results were not rerun; their original
raw artifacts were removed. See the preceding verification reports for scope.

This iteration made zero real model prompts and zero Droid-to-Puck sends/reads.
Live completed-ACK retrieval and Puck's all-17-tool acceptance are **UNVERIFIED**.
Exact-SHA re-review by the same High reviewer must precede merge and deployment.
Only the existing smoke root is approved. Filtering is not OS isolation or
account-level OAuth credential scoping; insufficient old proof remains denied.

## Reproduction and sanitized evidence

Node 22.23.3; Factory SDK 0.9.1, MCP SDK 1.32.0, zod 3.25.76. No `resources.json`
exists in this repo. Grounding used repository guidance, the installed pinned
SDK permission/result and notification contracts, and the review's official-doc
references. No integration/dependency changes or real authenticated model smokes
were needed.

In a disposable clone with Node 22 on PATH:

```sh
git checkout e4387ccca773efd123755309692660593efb416c
npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
npm run check
node --test --test-name-pattern='delayed reply|R3:' test/review-regressions.test.mjs
npm test
```

For the negative reproduction, check out the previous PR head in a disposable
clone, copy only the corrected mock peer and regression test from this source,
and run `node --test --test-name-pattern='replayed send' test/review-regressions.test.mjs`.

Sanitized host evidence is outside Git in the dedicated `reply-handles/approval-correlation/`
directory: `red-replay.tap`, `green-targeted-final.tap`, `check-source.txt`,
`full-source.tap`, `reviewer-probe-corrected.txt`, `provenance-corrected.json`, and
copies of the original review evidence. Final documentation-head check/TAP and
its exact SHA are retained separately; documentation does not change source tests.
Deployment must still follow `CUTOVER.md`, with quiescence, a matched private
backup and compatible rollback, then controller-only restart and Puck retest.
