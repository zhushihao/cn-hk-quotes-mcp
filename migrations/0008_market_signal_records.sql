-- Independent numeric market-signal latest-state projection.  This uses the
-- generic replica record store; no Evidence accumulator, Research Job, QMT,
-- account, order, or execution table changes.
CREATE INDEX IF NOT EXISTS research_records_market_signal_lookup
ON research_records(record_key, updated_at DESC)
WHERE record_type='market_signal' AND visibility='PUBLIC';
