# Verification of review code 20b31df

Code under review: [20b31dfec8712750de7d81ce79177a607f31066c](https://github.com/teobucos/droid-mcp-controller/commit/20b31dfec8712750de7d81ce79177a607f31066c),
on top of [ee240db78fff56561f89c78874eabdf9b0e6d70d](https://github.com/teobucos/droid-mcp-controller/commit/ee240db78fff56561f89c78874eabdf9b0e6d70d).
Base main: [c76dee2ccbd2b1173ca96abba671a2636f0c3df6](https://github.com/teobucos/droid-mcp-controller/commit/c76dee2ccbd2b1173ca96abba671a2636f0c3df6).
This report is a separate docs-only commit. Results below name the tested code,
not a self-referential report commit. No merge, deployment, CI, license change,
credential change, or live-service repair was performed.

## Evidence classes and sources

- **FRESH / MOCK-CONTROLLED:** High-thread checks and integration tests through
  the real MCP/controller entry points and published SDK, with a controlled
  Droid peer. These are not authenticated model or Puck-service evidence.
- **FRESH / REAL AUTHENTICATED:** no-prompt Amp diagnosis and one harmless Puck
  send, all on unchanged `ee240db` in disposable setups with existing login.
- **HISTORICAL / NOT RERUN:** the final recorded results in
  [the Ultra verification thread](https://ampcode.com/threads/T-01a11be3-0762-74db-a23d-60ff7e24301e).
  Its raw artifacts, including red TAP and smoke/probe output, were removed with
  its worktree; an attempted archive upload was rejected, so no archive was delivered.
- Fresh work is recorded in [the High follow-up thread](https://ampcode.com/threads/T-01a11c3a-624b-761a-805f-e1e05edcc0fe).
  Sanitized fresh TAP/diagnostic files are retained outside Git. No full artifacts,
  prompt text, credentials, private recipient IDs, or reply handles are included here.

## Finding verdicts

Code locations are relative to `20b31df`, except explicitly historical references.
Fresh full suites reproduce the controlled regression coverage, not the earlier
authenticated smoke or complete six-state attachment probe.

| Item | Verdict and evidence class | Code locations |
| --- | --- | --- |
| R1: STOP behind queued work | Confirmed/fixed at `ee240db`; FRESH MOCK/CONTROLLED regressions pass: durable queued supersession, idempotent retries, full queue, crash/no replay, other sessions unaffected. | `src/controller.mjs:153-198`; `test/review-regressions.test.mjs` |
| R2: IPC callback treated as persistence ACK | Confirmed/fixed at `ee240db`; FRESH MOCK/CONTROLLED delay/failure/correlation/cancellation/disconnect tests gate SDK submission on durable file/directory persistence. | `src/controller.mjs:242-261`; `src/worker.mjs:24-39`; `test/worker-ack.test.mjs` |
| R3: unrestricted read_reply preapproval | Local fix/regressions pass. FRESH REAL AUTHENTICATED send response parsing and inline ACK observed; live exact-handle read_reply remains UNVERIFIED. Missing/foreign/stale/failed-send/retargeted/restarted handle denial is MOCK/CONTROLLED only. High retains general single-use permission approval. | `src/worker.mjs:104-121,145-163,187-213`; `test/review-regressions.test.mjs` |
| R4: predecessor failure hidden | Confirmed/fixed at `ee240db`; FRESH MOCK/CONTROLLED failed/timed-out predecessor attention survives dropped queued head; resolution clears attention. | `src/views.mjs:33-65` |
| Current models | HISTORICAL REAL AUTHENTICATED catalog: 58 entries, 3 explicitly deprecated, controller returned 55. Fresh controlled catalog/correlation regressions pass. Unknown lifecycle metadata remains unknown. | `src/models.mjs:42-82` |
| Routed-to-detached retention | Refuted for the HISTORICAL tested CLI/SDK versions: six attachment states, same saved UUID, detached inventories empty. No prompt/Puck exchange in that probe; not rerun. | `scripts/verify-route.mjs` |
| Autonomy compatibility | Approved high/Auto/single-use policy preserved; explicit off and independent reasoning remain available. FRESH MOCK/CONTROLLED policy regressions pass. | `src/config.mjs:35-36`; `src/worker.mjs:187-213` |
| Original v1 fingerprint (98e0e7) | Previously missed; CONFIRMED and fixed at `20b31df`. Fresh red/green controller-entry-point tests cover raw v1, prompt-free v2 and already-migrated v3 records. | `src/store.mjs:63-80,103-106`; `src/controller.mjs:125-138`; `test/review-regressions.test.mjs:146-237` |
| Later v1 fingerprint (7b4a816) and v2 migration | Preserved; FRESH MOCK/CONTROLLED start/continue/retry tests pass, including explicit recorded routing and exact conflict rejection. The Ultra migration verdict covered this later serializer, not the first published serializer. | Same migration locations above |
| Earlier safeguards | FRESH MOCK/CONTROLLED suites pass: head guards, serialization/canonical workspace locks, cleanup-held slots, authenticated HTTP/Host/Origin/body checks, unknown/no replay, prompt-free state/results, corrupt-state refusal. | Existing integration suite |

## Fresh original-v1 red reproduction and measured impact

Primary source: [98e0e738d3520545355da1c93f1e219a39592cfa](https://github.com/teobucos/droid-mcp-controller/commit/98e0e738d3520545355da1c93f1e219a39592cfa),
`src/controller.mjs:116-139`. Its hash contains exactly workspace, prompt,
autonomy, model and parentRunId in that order. Host reasoning is persisted on
the run separately, outside the hash. Later `7b4a816` adds optional reasoning
and routing to the hashed intent.

Fixtures independently write that original five-field hash with stored host
reasoning `high`; raw v1 retains the original prompt for migration. Tests call
legacy `droid_start` and `droid_continue` through MCP, including repeated same-key
retries. They also cover prompt-free original v2, original v3 previously tagged
by `ee240db`, and later-format v1/v2. These are authentic serializer/state-format
fixtures built from controlled successful run records, not a production-state copy.

Against unchanged `ee240db`, original-format unchanged-key start/continue retries
fail with **request_key_conflict**. Red TAP: 15 counted tests, 6 pass/9 fail
(six replay subtests and their three parent tests fail; later formats pass).
The impact probe continues after the expected failures: **zero additional
droid.add_user_message submissions, unchanged head, byte-identical post-migration
state.json**. Startup migration itself intentionally rewrites/removes prompts.
This proves rejected idempotent retries, not duplicate execution or resubmission.

At `20b31df`, focused migration tests pass **15/15**, zero failed/skipped.
Same-key start/continue/retry returns original run IDs/outcomes without launch or
post-migration state mutation. Changed prompt, model, canonical approved workspace,
autonomy, parent, reasoning, routing, title, labels and steering conflict. The
original format rejects even explicit per-turn reasoning equal to stored host
reasoning: that caller option did not exist in the original API.

Migration proves the hash version before deleting raw v1 prompts (original,
later, or unknown). Prompt-free records cannot be reclassified from raw intent;
their five-field candidate fallback is limited to legacy entry points with no
explicit per-turn reasoning and no requested/stored routing or modern title,
labels or steering. Later and modern fingerprints remain exact. Unknown raw-v1
hashes do not gain fallback. No new key, replay or reset was introduced.

## Fresh checks and versions

2026-10-09, Node **22.23.3**, npm **9.2.0**, Droid **0.236.0**;
lockfile Factory SDK **0.9.1**, MCP SDK **1.32.0**, zod **3.25.76**.
`npm ci --prefer-offline --ignore-scripts` ran only in a temporary clone/export.

| Tested code | Fresh result | Retained output |
| --- | --- | --- |
| `ee240db` | `npm run check` passed; full `npm test` **118/118**, 0 failed/skipped, 199142.728 ms | `ee240db-check.txt`, `ee240db-test.tap` |
| `20b31df` | `npm run check` passed; full `npm test` **131/131**, 0 failed/skipped, 199231.928 ms | `final-code-check.txt`, `final-code-test.tap` |
| `ee240db` with new migration tests only | Original-format red/impact tests: 6 pass/9 fail; 0 skipped | `original-v1-red.tap`, `original-v1-red-impact.tap` |
| Fixed migration coverage | 15/15, 0 failed/skipped | `original-v1-green.tap` |

The full-suite count rose by 13: three additional format fixtures and ten replay
subtests. The docs-only branch tip is additionally checked/tested before push;
its exact SHA and TAP summary are recorded in the follow-up thread and external evidence.

## Historical authenticated evidence, NOT RERUN

Ultra thread on `ee240db`: baseline **96/96**; final **118/118**, zero
failed/skipped, `npm run check` passed. These older outputs are historical;
the independent fresh 118/118 above is retained separately.

**HISTORICAL / REAL AUTHENTICATED smoke: 12/12**, `gpt-6-luna`, low reasoning,
autonomy off. Assertion names below are corroborated by the checked-in smoke
script; the historical final message records aggregate success, not raw output:

1. explicit_model_current
2. catalog_excludes_deprecated
3. discovery_no_prompt
4. first_result
5. continued_result
6. same_uuid
7. terminal_sdk_result
8. cancelled_after_real_submission
9. exactly_three_accepted_messages
10. three_durable_intents
11. read_only
12. worker_and_cli_cleanup

**HISTORICAL / REAL AUTHENTICATED route probe: 6/6**, modes
fresh-detached, routed, routed-resume, detached-omitted, routed-again,
detached-empty; Amp tool counts **0,4,4,0,4,0**. Same saved UUID on resume,
no submitted prompts and no Puck send/read. Versions are the same as above.

## Fresh Amp diagnosis and the one authorized send

Initial isolated attempt: **NOT RUN / BLOCKED**, `amp_mcp_unreachable`,
zero sends, zero reads, no returned handle, no model prompt submitted.
Run `43240ce8-b953-4df8-9cb1-22f6482207d8`,
session `6bf3b0d8-4101-47a7-8108-970364bb9c44`.
Its sanitized original artifact still existed during this follow-up.

Fresh no-prompt SDK diagnosis exposed server status failed, hasAuthTokens true,
error "Failed to connect to MCP server", no tools. Correlated CLI logs for
that failure and the diagnosis reported **"This thread is archived"**. The
disposable cwd inherited a project-level thread-bound amp-puck definition.
Both worker-equivalent and route-probe-equivalent attachment failed there.
The generic Amp endpoint returned unauthenticated HTTP **401**.

Moving only disposable cwd/state outside that project-config ancestry attached
four Amp tools; worker-equivalent filtering left only puck permitted. The same
generic profile URL, OAuth resource, existing login and egress environment were
used. No credential/shared-config/live-service change or OAuth reauthorization
was needed. Transient SDK attachment was visible in registered tools even when
absent from listMcpServers. This is setup inheritance evidence, not a confirmed
code defect in `ee240db`; it does not prove arbitrary network failures transient.
Retained diagnosis: `amp-diagnosis.json`, `amp-isolated-diagnosis.json`,
`amp-log-cause.json`.

Owner-authorized clean disposable attempt on `ee240db`, with `gpt-6-luna`/low/off:
run `8fc67293-75d5-4657-8cfc-b25d60d882d2`,
session `816aaf65-4a3a-4273-84c3-7e42b91dbb63`.
**Total actual send attempts: 1. Total read_reply attempts: 0.**
Preflight passed; the real permission event approved ProceedOnce without a
safety override. The send tool_result was a JSON string with conversationID,
url, replyHandle, status and reply. A real handle was returned; status was
**replied**, and the matching saved CLI tool_result contained the exact fixed
acknowledgment. SDK run succeeded and notification state was accepted.
This verifies a real send response and inline recipient reply, not merely an
assistant's delivery claim or thread-to-thread ACK.

The summary's completedAckObserved false reflects an expected-status-string
mismatch (`completed` versus actual `replied`); `puck-inline-ack.json`
independently confirms reply equality from the matching saved tool_result.
`puck-single-send.jsonl` and `puck-single-send-summary.json` retain sanitized
real observations privately outside Git. Processes, temporary state/workspace,
and fresh temporary bearer were cleaned up. No resend or further live test was run.

## Reproduction and remaining limits

Use Node 22. In a disposable clone at the desired commit, not the deployed checkout:

```sh
npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
npm run check
npm test
node --test --test-name-pattern='migration v' test/review-regressions.test.mjs
```

For the red reproduction only, export `ee240db`, copy the fixed migration test
file into that disposable export, and run the same targeted command. Do not
replace production state. Historical script commands were
`node scripts/verify-live.mjs --droid <absolute-cli> --model gpt-6-luna` and
`node scripts/verify-route.mjs --droid <absolute-cli>`; these use real login and
are recorded here for reproducibility, not permission to rerun them.

- **UNVERIFIED:** live exact-handle read_reply, asynchronous queued/working
  reply retrieval, and real rejection of missing/foreign handles. The send
  returned its reply inline; only controlled tests exercise read capability
  scoping. No extra prompt/send was used to manufacture that coverage.
- **BLOCKED:** production readiness/acceptance. Read-only inventory found no
  controller/tunnel/supervisor process or controller listener; loopback refused,
  public curl HTTP 530 versus Python HTTP 403 (2026-10-09T03:29:44Z).
  Neither is healthy MCP HTTP 401. The supervisor socket was absent. Source on
  disk remains clean base main; no live repair, deployment or restart was attempted.
- npm registry connectivity is now healthy (`npm ping`: PONG); CLI doctor auth
  check passed without interactive input. This does not prove production health.
- New authenticated smoke/full route probes were not run on `20b31df`; the
  migration change was validated by controlled entry-point tests, not model calls.
- Historical raw artifacts are unavailable; original v1 backups can retain
  old prompts by design. OAuth permission filtering remains client-side policy,
  not per-thread credential scoping or OS isolation. Boot persistence and
  cloud-client production acceptance were not tested.
