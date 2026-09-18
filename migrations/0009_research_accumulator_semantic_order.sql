-- #25 P0: an accumulator's current state is ordered by the producer's
-- snapshot calculation time, never by replica arrival/update time.
-- The values are copied from the already-frozen v2/v3/v4 payload fields so
-- a subject lookup is indexable and does not need a global latest-record scan.
ALTER TABLE research_records ADD COLUMN accumulator_subject_key TEXT;
ALTER TABLE research_records ADD COLUMN accumulator_created_at TEXT;

UPDATE research_records
SET accumulator_subject_key = json_extract(payload_json, '$.subject_key'),
    accumulator_created_at = strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(payload_json, '$.created_at'))
WHERE record_type = 'accumulator';

CREATE INDEX IF NOT EXISTS research_records_accumulator_current
ON research_records(visibility, accumulator_subject_key, accumulator_created_at DESC, record_key DESC)
WHERE record_type = 'accumulator';
