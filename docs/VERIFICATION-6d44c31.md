# Delayed Puck reply ownership verification

Date: 2026-10-09 UTC. Fixed source:
[`6d44c313f0306665bf26c08f80c3b5fcb507ffed`](https://github.com/teobucos/droid-mcp-controller/commit/6d44c313f0306665bf26c08f80c3b5fcb507ffed).
Base/deployed source at reproduction:
[`ed1837c40d0165d54cda3338831487b77f997538`](https://github.com/teobucos/droid-mcp-controller/commit/ed1837c40d0165d54cda3338831487b77f997538).
This document does not contain credentials, prompts, personal conversation IDs,
or the original artifacts. The earlier migration/review evidence remains in
`docs/VERIFICATION-20b31df.md`; it is not upgraded by this correction.

## Measured failure and intended behavior

An originating turn observed a successful Puck send with a queued reply handle.
Its same-turn read was allowed but the acknowledgment arrived later. A later
turn in the same controller/Factory session, with unchanged recipient and
off autonomy, was denied reading that exact handle. The worker recreated its
ownership set empty on every turn. SDK success therefore coexisted with one
policy decline and `needsAttention:true`; this was not successful task completion
and was not a human cancellation.

Observed successful sends now grant durable ownership on the originating run.
Continuation/restart inherits it only within the same controller session and
recipient route generation. Accepted detach/retarget operations invalidate old
handles, including cancelled turns and retarget-and-return. Generations persist
independently of wall-clock sorting. No prompt text grants authority.

Old prompt-free records require an approved send ID observed in that originating
run, the matching SDK call and non-error result, the same Factory UUID, and the
explicit recipient. Missing/truncated proof stays denied. New records are not
rescanned from historical transcript content. Read-only retrieval does not claim
a new send or delivery. High autonomy cannot invent reply-handle ownership;
other high-autonomy single-use approvals remain unchanged.

Code: `src/puck.mjs`, `src/controller.mjs`, `src/worker.mjs`, `src/store.mjs`,
`src/views.mjs`. Public MCP tool names and input/output schemas remain unchanged
(17 tools, including six legacy aliases). MIT remains unchanged; no CI added.

## Fresh MOCK/CONTROLLED evidence

The tests use the real authenticated controller MCP, actual worker and pinned
published Factory SDK. Only the remote Droid JSON-RPC peer is controlled.

| Check | Result |
| --- | --- |
| Red baseline on the original production source | 10 targeted cases: 6 passed, 4 failed. The same-session delayed read and valid legacy-provenance restore each showed one decline instead of zero. Missing-handle high approval and absent policy-reason output also failed the strengthened contract. |
| Fixed-source targeted regression run | 10/10 passed; zero failed, skipped or cancelled. |
| Fixed-source `npm run check` | Passed. |
| Frozen fixed-source full `npm test` | 140/140 passed; zero failed, skipped or cancelled. The prior suite had 131 tests; nine were added. |

New coverage exercises:

- Delayed same-session retrieval, then retrieval after controller restart, with
  one send total and observable acknowledgment output.
- No false notification of a new report from a read.
- Foreign-session, malformed, unobserved, detached, foreign-recipient and
  retarget-and-return denial; stale handles remain denied at high autonomy.
- A new checkpoint after returning to a recipient cannot revive the old handle.
- Restart with reordered wall-clock timestamps cannot revive the old route.
- Old v3 restore with valid provenance succeeds; missing or truncated approval,
  foreign Factory UUID, error result, wrong tool-use ID and quoted assistant
  text cannot grant ownership.
- Policy reasons remain visible in retained controller history, with existing
  permission-decline counts and `needsAttention` semantics preserved.

The SDK 0.9.1 permission-result contract supports `selectedOption` plus `comment`;
its installed implementation forwards the comment to the CLI. Controlled tests
observe the controller policy comment. Whether the live CLI's generic tool-error
wording changes is not established here; retained controller notices distinguish
policy denial regardless.

## Fresh real retained-provenance copy, NOT a live MCP exchange

At 07:06:26Z, the corrective source opened a disposable private copy of the live
state and retained result files. It recovered the existing delayed-reply handle
from its original approved send and correlated SDK result, authorized it for the
existing continuation, closed/reopened the copy and retained ownership.

All 96 existing runs, every session and all pre-existing run fields remained
unchanged in that copy except the added ownership/route fields. Live state stayed
byte-identical during the probe. No worker was launched, no model prompt was
submitted, and no live Amp send or read was performed. This proves compatibility
of the retained evidence, not that the external reply service returned the ACK.

## Historical REAL AUTHENTICATED / Puck-observed evidence

These are reported observations on the base deployment, not rerun by this fix:

- Puck's cloud client reached the public MCP and refreshed discovery to all 17
  tools. Model discovery returned 56 current choices.
- Independent sessions ran concurrently; continuations retained distinct context
  and Factory UUIDs; queued same-session turns executed in order.
- Exact retries returned the same IDs without extra turns; changed intent failed
  with `request_key_conflict`. Status, find, wait, pagination, usage, explicit
  errors and archive/restore were observed working.
- Cancellation/interruption dropped queued work before submission, steering kept
  the same Factory session, retries were idempotent and independent work remained
  unaffected.
- In the delayed-reply scenario, Puck observed one send and received/replied to
  it. One originating-turn read was allowed and returned queued; one later-turn
  read was policy-denied. The SDK reported success despite that denial.

Older 118-test, 12/12 authenticated model-smoke and 6/6 route-probe claims are
historical records in the earlier verification document; their original raw
artifacts were removed. They were not rerun or substituted for this correction's
fresh evidence.

## Live acceptance still UNVERIFIED / awaiting owner retest

This corrective iteration made **zero live sends and zero live reads**. It did
not repeat Puck's client tests, create a replacement marker or use another
recipient. Puck must retrieve the existing handle after deployment and personally
exercise all 17 exposed tools, including six legacy aliases and affected
permission/error/idempotency workflows. Local green tests are not that acceptance.

Only the previously approved smoke workspace remains authorized. Real-repository
delegation requires a separate exact-root authorization. Client-side filtering is
not OS isolation or account-level OAuth credential scoping. Old handles without
retained originating-run proof remain denied. No new paid infrastructure or
unrelated services/configuration are required.

## Reproduction and evidence

Use the existing Node 22 runtime and a temporary clone, never the live checkout:

```sh
git clone https://github.com/teobucos/droid-mcp-controller.git disposable-review
git -C disposable-review checkout 6d44c313f0306665bf26c08f80c3b5fcb507ffed
# From the disposable clone, with Node 22 on PATH:
npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
npm run check
node --test --test-name-pattern='delayed reply|R3:' test/review-regressions.test.mjs
npm test
```

Sanitized host evidence is retained outside Git in the dedicated verification
evidence directory, under `reply-handles/`: `red.tap`, `green-fix.tap`,
`check-fix-final.txt`, `test-fix.tap`, and `provenance.json`.
Deployment must follow `docs/CUTOVER.md`: quiescence, a new matched private
stopped-state/source/config backup, compatible base-deployment rollback,
locked dependencies, controller-only restart, and authenticated public health.
Merged/deployed SHA, UTC health observations and subsequent Puck acceptance are
recorded separately; this report does not claim a deployment not yet performed.
