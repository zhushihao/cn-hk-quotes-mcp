# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import unittest

import validate_holding_day as validator


def _comment(comment_id: str, slot: str, previous: str | None, preopen: str | None, *, close=False):
    gate = {"action_gate_id": "g1", "original_condition": "relative strength remains positive"}
    payload = {
        "schema_version": "premarket_plan_batch_v1" if slot == "09:10" else "market_observation_batch_v1",
        "prompt_id": "holding-assistant",
        "production_ref": "a" * 40,
        "portfolio_version": "live:test",
        "event_id": f"event-{slot}",
        "idempotency_key": f"holding-assistant:2026-09-21:{slot}",
        "trading_date": "2026-09-21",
        "as_of": "2026-09-21T09:10:00+08:00",
        "scheduled_slot": slot,
        "producer": "holding-assistant",
        "observation_type": "PREMARKET" if slot == "09:10" else ("CLOSE" if close else "INTRADAY"),
        "previous_checkpoint_comment_id": previous,
        "preopen_comment_id": preopen,
        "live_universe_hash": "sha256:test",
        "source_task": "holding-assistant",
        "records": [{
            "instrument_key": "000001.SZ",
            "benchmark_mapping_version": "market-benchmarks.v2",
            "action_gates": [gate],
        }],
    }
    return {"id": comment_id, "createdAt": "2026-09-21T01:10:00Z", "body": "```json\n" + json.dumps(payload) + "\n```"}


class HoldingDayTests(unittest.TestCase):
    def _valid(self):
        result = []
        previous = None
        preopen = None
        for index, slot in enumerate(validator.SLOTS):
            cid = f"c{index}"
            if slot == "09:10":
                result.append(_comment(cid, slot, None, None))
                preopen = cid
            else:
                result.append(_comment(cid, slot, previous, preopen, close=slot == "16:45"))
            previous = cid
        return result

    def test_complete_day_passes(self):
        summary = validator.validate_day(self._valid(), "2026-09-21")
        self.assertEqual(summary["checkpoint_count"], 7)
        self.assertEqual(summary["gate_count"], 1)

    def test_missing_slot_fails(self):
        comments = self._valid()[:-1]
        with self.assertRaises(validator.DayValidationError):
            validator.validate_day(comments, "2026-09-21")

    def test_gate_mutation_fails(self):
        comments = self._valid()
        payload = json.loads(validator.JSON_BLOCK.search(comments[2]["body"]).group(1))
        payload["records"][0]["action_gates"][0]["original_condition"] = "mutated"
        comments[2]["body"] = "```json\n" + json.dumps(payload) + "\n```"
        with self.assertRaises(validator.DayValidationError):
            validator.validate_day(comments, "2026-09-21")


if __name__ == "__main__":
    unittest.main()
