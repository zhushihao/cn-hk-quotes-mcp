-- Conservative hard guardrail: keep Collector-owned R2 usage well below the
-- published free tier.  It accounts for both raw objects and recovery journals.
CREATE TABLE IF NOT EXISTS research_replica_usage (
	name TEXT PRIMARY KEY,
	usage_period TEXT NOT NULL,
	stored_bytes INTEGER NOT NULL DEFAULT 0,
	r2_write_ops INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO research_replica_usage (name, usage_period)
VALUES ('primary', '1970-01');
