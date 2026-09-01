# Napkin Runbook

## Curation Rules

- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)

1. **[2026-08-28] Cloudflare Worker internal `workers.dev` calls may return 404**
   Do instead: retry the public Site endpoint on HTTP 404 and record the actual source used.
2. **[2026-08-28] Cloudflare cron weekday numbers are 1=Sunday through 7=Saturday**
   Do instead: use named ranges such as `mon-fri` so weekday intent cannot drift.
3. **[2026-09-01] The Site emits the complete v4 23-instrument `PORTFOLIO_UNIVERSE`**
   Do instead: treat the bridge's market-qualified keys as a validation guard, not a second editable holding list; keep all ten Watch records and both A/H mappings in every full snapshot, with no Exited Watch status.
4. **[2026-09-01] Market plus complete code is the only instrument identity**
   Do instead: use keys such as `CN:603308` and `HK:03308`; never match shortened pure-number aliases.

## Shell & Command Reliability

1. **[2026-08-28] Wrangler CLI is not authenticated in this environment**
   Do instead: use the Cloudflare API connector for production deployment and the signed-in Cloudflare browser session for scheduled-event tests when the API has no trigger endpoint.
2. **[2026-08-28] In zsh, `path` is tied to `PATH`**
   Do instead: use names such as `endpoint_path` for loop variables so command lookup is not broken.

## Domain Behavior Guardrails

1. **[2026-09-01] Portfolio records must preserve closed-snapshot time semantics**
   Do instead: keep `market_status: CLOSED`, `quality: CLOSED_SNAPSHOT`, real market/source times, and `quote_time: null` when no confirmed trade time exists; do not treat supplier update time as trade time.

## User Directives

1. **[2026-08-28] Never expose secrets or claim a fabricated success**
   Do instead: inspect secret presence/status without printing token values and only report evidence-backed online results.
