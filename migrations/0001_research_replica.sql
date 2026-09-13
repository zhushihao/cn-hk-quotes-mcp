-- QuantPro Collector C5: Collector-owned, one-way Research replica.
-- The source Research database is never connected or mounted here.

CREATE TABLE IF NOT EXISTS research_ingest_messages (
	message_id TEXT PRIMARY KEY,
	record_type TEXT NOT NULL,
	record_key TEXT NOT NULL,
	visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
	payload_sha256 TEXT NOT NULL,
	generated_at TEXT,
	received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_records (
	record_type TEXT NOT NULL,
	record_key TEXT NOT NULL,
	message_id TEXT NOT NULL,
	visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
	payload_json TEXT NOT NULL,
	generated_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (record_type, record_key)
);

CREATE TABLE IF NOT EXISTS research_record_objects (
	record_type TEXT NOT NULL,
	record_key TEXT NOT NULL,
	role TEXT NOT NULL,
	content_sha256 TEXT NOT NULL,
	visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
	PRIMARY KEY (record_type, record_key, role, content_sha256)
);

CREATE TABLE IF NOT EXISTS research_objects (
	content_sha256 TEXT PRIMARY KEY,
	message_id TEXT NOT NULL,
	visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
	media_type TEXT NOT NULL,
	byte_size INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('READY')),
	received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_replica_health (
	name TEXT PRIMARY KEY,
	last_attempt_at TEXT,
	last_success_at TEXT,
	last_message_id TEXT,
	last_error_code TEXT,
	accepted_messages INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO research_replica_health (name, accepted_messages)
VALUES ('primary', 0);

CREATE INDEX IF NOT EXISTS research_records_type_visibility
	ON research_records (record_type, visibility, updated_at DESC);
CREATE INDEX IF NOT EXISTS research_record_objects_content
	ON research_record_objects (content_sha256);
