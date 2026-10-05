# Threat model

Scope: the controller process, its bearer-authenticated MCP endpoint, the Droid
workers it spawns, and the Droid to Puck reply path. Same host, same service user.

## Assets and trust

| Asset | Protected by | Not protected against |
| --- | --- | --- |
| Controller bearer token | private file (600), constant-time compare, Host/Origin checks, TLS at the tunnel | anyone holding it: they can start work and read stored results inside the policy ceiling |
| Workspaces | canonical approved roots, resume-cwd check, reader/writer locks | a Droid agent at any autonomy: roots are a launch restriction, not an OS sandbox |
| Factory credentials and Amp MCP OAuth tokens | Factory's own store; the controller never reads, copies, logs or forwards them | the service user and anything running as it |
| State directory | 700/600, single-owner lock, atomic writes, no prompts | local root/service user; backups made by the operator |
| Puck conversations | explicit per-session `replyTo`; narrow single-use approval; misroute detection | a malicious agent at autonomy `high` (it holds the user's access) |

## Controls added by the session surface

- **No default recipient, no thread-bound endpoint.** `replyTo` is required at creation
  (`null` is detached). The Amp endpoint is generic and attached only to routed
  sessions. This removes the P0 failure (an archived thread breaking every launch) and
  the silent misroute of omitted recipients.
- **Default-deny Amp tools.** Only `amp-puck___puck` may be usable. The preflight lists the endpoint's
  real tools, denies every other one via `updateSettings({disabledToolIds})` and re-lists to verify;
  failure to deny fails the run closed before any prompt. Seed list: `amp-puck___manage_amp` (admin) and the thread-reading
  `amp-puck___find_thread` / `amp-puck___read_thread` (offered by the thread-free endpoint, observed live)
  are always in
  `disabledToolIds`; preflight refuses to submit a prompt if any Amp tool besides `puck`
  is usable. This is model-context policy, **not** credential scoping: the OAuth grant
  is account-level (scope `email offline_access openid profile`).
- **Narrow permission exception.** A routed session approves, single use, only
  `amp-puck___puck` `send` to its own `replyTo` or `read_reply`, so read-only reviewers can
  report. Any other permission still needs autonomy `high` and `ProceedOnce`.
- **Observed, not claimed, reporting.** `notification` records what the worker saw the
  agent's tool call do. A report to another conversation is `reply_misrouted`;
  acceptance is never described as delivery.
- **Bounded concurrency.** Capacity 1 to 16, queue 64 total / 8 per session, one live
  turn per session, canonical writer locks held until process cleanup.
- **Strict input.** `additionalProperties:false`, length/pattern bounds, live-catalog model
  and reasoning validation, sanitized errors (`internal_error` hides stacks and paths).
- **Unchanged safeguards:** authenticated loopback HTTP, explicit workspace authorization,
  durable request-key idempotency before any spawn, linear session heads, `unknown`
  outcomes that never replay, prompt-free state, no `--skip-permissions-unsafe`.

## Residual risks

1. **Autonomy `high` is the service user.** Prompt injection in a workspace can use it.
   Use a dedicated account/container for hard isolation.
2. **Accepted residual risk: wider tool surface on the thread-free endpoint** (owner sign-off line below). Its tool list is `puck`, `manage_amp`,
   `find_thread`, `read_thread`, all allowed server-side; the OAuth scope is unchanged
   (`email offline_access openid profile`). Only the client-side default-deny limits the agent to `puck`;
   a tool list change after the per-turn preflight is blocked only by permission policy (at autonomy `high`
   MCP calls are approved single-use).

   Owner sign-off: `____ accepted client-side default-deny (not credential scoping) for the Amp endpoint  date ____`
3. **Account-level OAuth.** Anyone controlling an agent with the Amp MCP attached can try
   `manage_amp` if the client-side denial is bypassed; the grant is not tool-scoped.
   Report if a narrower grant becomes available.
4. **Token store concurrency.** Several workers read the same Factory token store at once;
   a refresh-token rotation race is possible and unobserved. The sign-in is per endpoint URL.
5. **Per-URL tokens.** Changing `ampMcp.url` requires a new sign-in; the failure is reported as
   `amp_mcp_not_started` and no task is submitted.
6. **Queued prompts are memory-only.** A crash loses them (`queue_lost`); they are never replayed.
7. **Steering is not atomic.** An interrupted turn may leave partial side effects.
8. **Bearer holders are one tenant.** No per-Puck-conversation boundary exists on the controller.

## Open question: controller-owned notifications

A controller-owned Amp OAuth client with a durable terminal-notice outbox would remove the
dependence on the agent remembering to report. It is **not implemented** because no supported
credential path exists: Amp remote-MCP OAuth is per-account and interactive via ampcode.com,
Amp Workload Identity requires Amp-staff access, and Factory's token store must not be read or
copied. Questions for Amp: a service credential or workload identity for a controller, and
server-side idempotency or a receipt lookup so an outbox could retry safely. Until then
`droid_wait_for_sessions` and status are authoritative and agent reports are advisory.
