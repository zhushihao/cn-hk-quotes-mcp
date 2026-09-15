-- rcpt2 orders receipt recovery by the D1-assigned event ingress sequence.
-- `rowid` is allocated by SQLite/D1 during the event INSERT transaction; it
-- is independent of caller-supplied timestamps and random event ids.  The
-- existing table deliberately keeps its stable text event_id primary key, so
-- this forward-only migration materializes that allocation as an indexed
-- value rather than rewriting a prior table definition.
ALTER TABLE research_job_events ADD COLUMN ingress_sequence INTEGER;
UPDATE research_job_events
SET ingress_sequence = rowid
WHERE ingress_sequence IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS research_job_events_ingress_sequence
    ON research_job_events(ingress_sequence);

CREATE TRIGGER IF NOT EXISTS research_job_events_assign_ingress_sequence
AFTER INSERT ON research_job_events
FOR EACH ROW WHEN NEW.ingress_sequence IS NULL
BEGIN
    UPDATE research_job_events
    SET ingress_sequence = NEW.rowid
    WHERE rowid = NEW.rowid;
END;

-- Bind a defer idempotency key to its canonical action payload and the
-- claimant's observed lease generation.  Existing historical deferrals have
-- no canonical request hash and therefore cannot be replayed as fresh ones.
ALTER TABLE research_job_deferrals ADD COLUMN payload_sha256 TEXT;
ALTER TABLE research_job_deferrals ADD COLUMN expected_generation INTEGER;
