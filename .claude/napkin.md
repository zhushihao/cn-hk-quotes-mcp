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

## Shell & Command Reliability

1. **[2026-08-28] Wrangler CLI is not authenticated in this environment**
   Do instead: use the already signed-in Cloudflare browser session for production inspection and scheduled-event tests.
2. **[2026-08-28] In zsh, `path` is tied to `PATH`**
   Do instead: use names such as `endpoint_path` for loop variables so command lookup is not broken.

## Domain Behavior Guardrails

1. **[2026-08-28] Portfolio codes must come from the upstream `PORTFOLIO` configuration**
   Do instead: verify upstream, MCP, and Issue snapshots against the same ordered ten-code list.

## User Directives

1. **[2026-08-28] Never expose secrets or claim a fabricated success**
   Do instead: inspect secret presence/status without printing token values and only report evidence-backed online results.
