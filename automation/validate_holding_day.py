#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate one production holding-assistant day from Issue #2 comments.

Input is the JSON array returned by GitHub's issue comments API.  The validator
is read-only and deliberately ignores legacy comments that do not match the
current holding-assistant batch contracts.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SLOTS = ("09:10", "09:50", "10:50", "11:50", "13:50", "14:50", "16:45")
JSON_BLOCK = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)
SCHEMAS = {"premarket_plan_batch_v1", "market_observation_batch_v1"}


class DayValidationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Checkpoint:
    comment_id: str
    created_at: str
    payload: dict[str, Any]


def _payload_from_comment(body: str) -> dict[str, Any] | None:
    match = JSON_BLOCK.search(body or "")
    if not match:
        return None
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("schema_version") not in SCHEMAS:
        return None
    if payload.get("prompt_id") != "holding-assistant":
        return None
    return payload


def load_checkpoints(comments: list[dict[str, Any]], trade_date: str) -> list[Checkpoint]:
    result: list[Checkpoint] = []
    for comment in comments:
        payload = _payload_from_comment(str(comment.get("body", "")))
        if payload is None or payload.get("trading_date") != trade_date:
            continue
        comment_id = str(comment.get("id", ""))
        created_at = str(comment.get("created_at") or comment.get("createdAt") or "")
        if not comment_id or not created_at:
            raise DayValidationError("valid checkpoint is missing comment identity")
        result.append(Checkpoint(comment_id, created_at, payload))
    return result


def _gate_map(records: Any) -> dict[str, str]:
    gates: dict[str, str] = {}
    if not isinstance(records, list):
        raise DayValidationError("records must be a list")
    for record in records:
        if not isinstance(record, dict):
            raise DayValidationError("record must be an object")
        raw_gates = record.get("action_gates", record.get("gates", []))
        if raw_gates is None:
            raw_gates = []
        if not isinstance(raw_gates, list):
            raise DayValidationError("action gates must be a list")
        for gate in raw_gates:
            if not isinstance(gate, dict):
                raise DayValidationError("gate must be an object")
            gate_id = gate.get("action_gate_id")
            condition = gate.get("original_condition")
            if not isinstance(gate_id, str) or not gate_id or not isinstance(condition, str) or not condition:
                raise DayValidationError("gate identity/original condition missing")
            previous = gates.setdefault(gate_id, condition)
            if previous != condition:
                raise DayValidationError(f"gate original condition mutated: {gate_id}")
    return gates


def validate_day(comments: list[dict[str, Any]], trade_date: str) -> dict[str, Any]:
    checkpoints = load_checkpoints(comments, trade_date)
    by_slot: dict[str, Checkpoint] = {}
    seen_keys: set[str] = set()
    for checkpoint in checkpoints:
        payload = checkpoint.payload
        slot = payload.get("scheduled_slot")
        key = payload.get("idempotency_key")
        if slot not in SLOTS:
            raise DayValidationError(f"unexpected scheduled_slot: {slot}")
        expected_key = f"holding-assistant:{trade_date}:{slot}"
        if key != expected_key:
            raise DayValidationError(f"idempotency key mismatch at {slot}")
        if key in seen_keys or slot in by_slot:
            raise DayValidationError(f"duplicate/conflicting checkpoint at {slot}")
        seen_keys.add(key)
        by_slot[slot] = checkpoint

    missing = [slot for slot in SLOTS if slot not in by_slot]
    if missing:
        raise DayValidationError(f"missing scheduled slots: {','.join(missing)}")

    preopen = by_slot["09:10"]
    if preopen.payload.get("schema_version") != "premarket_plan_batch_v1":
        raise DayValidationError("09:10 is not premarket_plan_batch_v1")
    if preopen.payload.get("observation_type") != "PREMARKET":
        raise DayValidationError("09:10 observation_type is not PREMARKET")
    gates = _gate_map(preopen.payload.get("records"))
    if not gates:
        raise DayValidationError("PREOPEN has no Action Gate")

    previous_id = preopen.comment_id
    mapping_versions: dict[str, str] = {}
    production_ref = preopen.payload.get("production_ref")
    universe_hash = preopen.payload.get("live_universe_hash")
    for slot in SLOTS[1:]:
        checkpoint = by_slot[slot]
        payload = checkpoint.payload
        if payload.get("previous_checkpoint_comment_id") != previous_id:
            raise DayValidationError(f"checkpoint chain broken at {slot}")
        if payload.get("preopen_comment_id") != preopen.comment_id:
            raise DayValidationError(f"preopen reference broken at {slot}")
        if payload.get("production_ref") != production_ref:
            raise DayValidationError(f"production_ref drift at {slot}")
        if payload.get("live_universe_hash") != universe_hash:
            raise DayValidationError(f"live_universe_hash drift at {slot}")
        current_gates = _gate_map(payload.get("records"))
        for gate_id, condition in current_gates.items():
            if gate_id in gates and gates[gate_id] != condition:
                raise DayValidationError(f"gate mutation at {slot}: {gate_id}")
        records = payload.get("records")
        if isinstance(records, list):
            for record in records:
                if not isinstance(record, dict):
                    continue
                instrument = record.get("instrument_key")
                version = record.get("benchmark_mapping_version")
                if isinstance(instrument, str) and isinstance(version, str) and version:
                    prior = mapping_versions.setdefault(instrument, version)
                    if prior != version:
                        raise DayValidationError(f"benchmark mapping drift for {instrument}")
        previous_id = checkpoint.comment_id

    close = by_slot["16:45"]
    if close.payload.get("observation_type") != "CLOSE":
        raise DayValidationError("16:45 observation_type is not CLOSE")
    return {
        "trade_date": trade_date,
        "checkpoint_count": len(checkpoints),
        "slots": list(SLOTS),
        "preopen_comment_id": preopen.comment_id,
        "close_comment_id": close.comment_id,
        "gate_count": len(gates),
        "production_ref": production_ref,
        "live_universe_hash": universe_hash,
        "benchmark_mapping_versions": sorted(set(mapping_versions.values())),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comments-json", type=Path, required=True)
    parser.add_argument("--trade-date", required=True)
    args = parser.parse_args(argv)
    try:
        comments = json.loads(args.comments_json.read_text(encoding="utf-8"))
        if not isinstance(comments, list):
            raise DayValidationError("comments JSON must be an array")
        summary = validate_day(comments, args.trade_date)
    except (OSError, json.JSONDecodeError, DayValidationError) as error:
        print(f"HOLDING_DAY_LOOP=FAIL error={type(error).__name__}: {error}")
        return 1
    print("HOLDING_DAY_LOOP=PASS " + json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
