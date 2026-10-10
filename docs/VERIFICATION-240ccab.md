# Launch defaults, settings inheritance and Amp profile

Historical evidence for the linked revision, not the current deployment status.
See README.md, TOOLS.md and CUTOVER.md for current behavior.

Source:
[`240ccab`](https://github.com/teobucos/droid-mcp-controller/commit/240ccab) on
branch `optimize-defaults`. Not deployed by this change; the live controller
configuration and state were not modified or restarted. No prompts, credentials,
personal conversation IDs, Factory session IDs or full artifacts are included.

## Behavior under test

- `droid_create_session` model is optional; it falls back to the host
  `defaultModel`, which is validated against the live Factory catalog. A host
  default that looks like a Fast variant is refused at startup and at use.
- `droid_send` inherits the session's model, reasoning and autonomy. Inherited
  autonomy is capped to the current host ceiling; an explicit value above the
  ceiling is rejected rather than silently downgraded.
- Reasoning resolves as explicit (strict), then the session's effort when the
  same model supports it, then the host default when supported, then the model
  default.
- Request-key replays return the original recorded settings without consulting
  the catalog again.
- The Amp endpoint is exactly `https://ampcode.com/mcp?profile=puck`
  (`profile=external-agent` is now rejected by Amp with HTTP 400).
- MCP server name `droid-mcp`, version read from `package.json`.

## Results

| Evidence | Result |
| --- | --- |
| New suite `test/settings-defaults.test.mjs` | Written first and failed before implementation; 15/15 after. |
| `npm run check` | Passed. |
| Full `npm test` | 104/104 passed. One full run showed a timing flake in the unchanged alias-blind preflight test; it passed in isolation twice and in the next full run. |
| Mutation proofs (7) | Each caught: host autonomy on follow-up, host model over session model, carrying old-model reasoning to a new model, uncapped inherited autonomy, silent explicit downgrade, replay re-resolving settings, no Fast-default refusal. |
| Real-CLI direct launch (`scripts/verify-direct-launch.mjs`) | 13/13 checks: two fresh sessions created in parallel with no explicit model, isolated workspaces, inherited follow-up settings, idempotent replay, four turns total, zero Amp contact. |

Direct-launch environment: Droid CLI 0.236.0, Factory SDK 0.9.1, Node 22.23.3,
disposable HTTP controller with `defaultModel: claude-opus-5-5`, reasoning `low`
and no `ampMcp`. Local Factory session files existed for both sessions. Upload
to and visibility in the Factory web dashboard were **not verified**.

## Reproduction

```sh
git checkout 240ccab
npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
npm run check
node --test test/settings-defaults.test.mjs
npm test
# requires an existing Droid CLI login; ROOT must be a disposable directory
node scripts/verify-direct-launch.mjs --droid /abs/droid \
  --default-model CURRENT_ID --root /abs/disposable/dir --reasoning low
```

Sanitized TAP and the direct-launch `report.json` are retained outside Git.
