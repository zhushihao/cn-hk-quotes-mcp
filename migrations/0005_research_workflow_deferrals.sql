-- Deferred work is a server-side queue state, never a local RESEARCH claim.
-- The one-row-per-job constraint deliberately makes the remote action
-- idempotent and prevents an unbounded defer history from becoming a hidden
-- work queue.  Once recheck_at has passed the job may be claimed again.
CREATE TABLE IF NOT EXISTS research_job_deferrals (
    job_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    lease_owner TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('RECHECK_REQUIRED','UPSTREAM_UNAVAILABLE','NEEDS_OWNER_INPUT')),
    recheck_at TEXT NOT NULL,
    deferred_at TEXT NOT NULL,
    request_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_job_deferrals_recheck
    ON research_job_deferrals(recheck_at, job_id);
