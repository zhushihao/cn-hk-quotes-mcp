-- Preserve inbound envelope generations so delayed v2/v3 Evidence cannot
-- overwrite an already complete v4 Evidence projection.
ALTER TABLE research_records
    ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'collector-outbound-v2';

CREATE INDEX IF NOT EXISTS research_records_schema_version
    ON research_records(record_type, record_key, schema_version);
