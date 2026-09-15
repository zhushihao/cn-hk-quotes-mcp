CREATE TABLE IF NOT EXISTS research_job_leases (
    job_id TEXT PRIMARY KEY,
    lease_owner TEXT NOT NULL,
    claim_token TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    claim_count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS research_job_leases_token ON research_job_leases(claim_token);

CREATE TABLE IF NOT EXISTS research_job_terminal (
    job_id TEXT PRIMARY KEY,
    terminal_status TEXT NOT NULL CHECK (terminal_status IN ('COMPLETED')),
    proposal_id TEXT NOT NULL,
    completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_proposals (
    proposal_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    caller_principal TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('CHATGPT','SYNTHETIC','REPLAY')),
    status TEXT NOT NULL CHECK (status IN ('RECEIVED','REJECTED')),
    reject_reason TEXT,
    payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    request_id TEXT NOT NULL
);
-- 一 Job 一正式结果：数据库层硬保证（REJECTED 与 SYNTHETIC/REPLAY 不占位）。
CREATE UNIQUE INDEX IF NOT EXISTS research_proposals_one_formal
    ON research_proposals(job_id) WHERE origin='CHATGPT' AND status='RECEIVED';
CREATE INDEX IF NOT EXISTS research_proposals_job ON research_proposals(job_id);

CREATE TABLE IF NOT EXISTS research_job_events (
    event_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'CLAIMED','CLAIM_DENIED','LEASE_EXPIRED',
        'SUBMIT_RECEIVED','SUBMIT_REJECTED','SUBMIT_CONFLICT','COMPLETED')),
    actor TEXT NOT NULL,
    proposal_id TEXT,
    origin TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_job_events_cursor ON research_job_events(created_at, event_id);
