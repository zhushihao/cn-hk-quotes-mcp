-- rcpt3 repairs historical receipt ordering without changing migration 0006's
-- already-issued ingress_sequence values. The D1 migration runner executes
-- this while writes are stopped; the epoch remains valid across restarts.

CREATE TABLE research_receipt_order_epochs (
    epoch TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE research_receipt_event_order (
    event_id TEXT PRIMARY KEY,
    epoch TEXT NOT NULL,
    receipt_sequence INTEGER NOT NULL UNIQUE CHECK (receipt_sequence > 0),
    FOREIGN KEY (event_id) REFERENCES research_job_events(event_id),
    FOREIGN KEY (epoch) REFERENCES research_receipt_order_epochs(epoch),
    UNIQUE (epoch, receipt_sequence)
);

CREATE TABLE research_receipt_order_state (
    epoch TEXT PRIMARY KEY,
    next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
    FOREIGN KEY (epoch) REFERENCES research_receipt_order_epochs(epoch)
);

INSERT INTO research_receipt_order_epochs (epoch, created_at)
VALUES ('receipt-order-v3-2026-09-15', '2026-09-15T00:00:00.000Z');

-- The migration snapshot is deterministically numbered by business audit
-- fields, not rowid/ingress order. BINARY makes the event-id tie breaker
-- explicit and independent of database locale settings.
INSERT INTO research_receipt_event_order (event_id, epoch, receipt_sequence)
SELECT event_id,
       'receipt-order-v3-2026-09-15',
       ROW_NUMBER() OVER (ORDER BY created_at ASC, event_id COLLATE BINARY ASC)
FROM research_job_events
ORDER BY created_at ASC, event_id COLLATE BINARY ASC;

INSERT INTO research_receipt_order_state (epoch, next_sequence)
SELECT 'receipt-order-v3-2026-09-15', COALESCE(MAX(receipt_sequence), 0) + 1
FROM research_receipt_event_order
WHERE epoch = 'receipt-order-v3-2026-09-15';

-- Every later event receives its new mapping inside the same D1 transaction
-- as the event INSERT. A backward business timestamp always appends after
-- the migration snapshot; receipt sequences never reorder or reset.
CREATE TRIGGER research_job_events_assign_receipt_sequence
AFTER INSERT ON research_job_events
FOR EACH ROW
BEGIN
    INSERT INTO research_receipt_event_order (event_id, epoch, receipt_sequence)
    SELECT NEW.event_id, epoch, next_sequence
    FROM research_receipt_order_state
    WHERE epoch = 'receipt-order-v3-2026-09-15';

    UPDATE research_receipt_order_state
    SET next_sequence = next_sequence + 1
    WHERE epoch = 'receipt-order-v3-2026-09-15';
END;
