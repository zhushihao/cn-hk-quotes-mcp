#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Atomically promote QuantPro Scheduled Task content to an exact Git ref.

The control file is the public production pointer.  A candidate ref is never
written into it until every referenced Prompt/Guidance object is readable from
raw.githubusercontent.com and Prompt header contracts match the registry.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

REPO = "zhushihao/quantpro-collector"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}"
ROOT = Path(__file__).resolve().parents[1]
CONTROL = ROOT / "automation" / "control" / "production.json"
SHA40 = re.compile(r"^[0-9a-f]{40}$")


class PromotionError(RuntimeError):
    pass


def _read_control(path: Path = CONTROL) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("status") != "PRODUCTION":
        raise PromotionError("control is not a PRODUCTION object")
    registry = data.get("registry")
    if not isinstance(registry, dict) or not registry:
        raise PromotionError("control.registry is missing or empty")
    return data


def _fetch_raw(
    ref: str,
    relpath: str,
    *,
    attempts: int = 6,
    delay_seconds: float = 5.0,
    timeout_seconds: int = 20,
    opener: Callable[..., object] = urllib.request.urlopen,
) -> str:
    url = f"{RAW_BASE}/{ref}/{relpath}"
    last: Exception | None = None
    for index in range(attempts):
        try:
            with opener(url, timeout=timeout_seconds) as response:  # type: ignore[attr-defined]
                status = getattr(response, "status", 200)
                body = response.read()  # type: ignore[attr-defined]
                if status != 200 or not body:
                    raise PromotionError(f"raw object unavailable status={status}: {relpath}")
                return body.decode("utf-8")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, PromotionError) as error:
            last = error
            if index + 1 < attempts:
                time.sleep(delay_seconds)
    raise PromotionError(f"raw exact-ref unavailable after {attempts} attempts: {relpath}: {last}")


def validate_candidate(control: dict, ref: str, *, opener=urllib.request.urlopen) -> None:
    if not SHA40.fullmatch(ref):
        raise PromotionError("candidate ref must be a 40-character lowercase SHA")
    registry = control["registry"]
    for key, entry in registry.items():
        if not isinstance(entry, dict):
            raise PromotionError(f"registry entry is not an object: {key}")
        prompt_id = entry.get("prompt_id")
        path = entry.get("path")
        scope = entry.get("write_scope")
        if not all(isinstance(value, str) and value for value in (prompt_id, path, scope)):
            raise PromotionError(f"registry entry missing prompt contract fields: {key}")
        prompt = _fetch_raw(ref, path, opener=opener)
        head = "\n".join(prompt.splitlines()[:10])
        required = (
            f"PROMPT_ID={prompt_id}",
            "STATUS=PRODUCTION",
            f"WRITE_SCOPE={scope}",
        )
        for token in required:
            if token not in head:
                raise PromotionError(f"prompt header mismatch for {key}: missing {token}")
        guidance = entry.get("automation_guidance", []) + entry.get("research_guidance", [])
        if not isinstance(guidance, list) or not all(isinstance(path, str) and path for path in guidance):
            raise PromotionError(f"invalid guidance list: {key}")
        for guidance_path in guidance:
            if not _fetch_raw(ref, guidance_path, opener=opener).strip():
                raise PromotionError(f"empty guidance: {key}: {guidance_path}")


def _atomic_write(path: Path, payload: dict) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def promote(ref: str, *, apply: bool, control_path: Path = CONTROL, opener=urllib.request.urlopen) -> dict:
    control = _read_control(control_path)
    validate_candidate(control, ref, opener=opener)
    updated = json.loads(json.dumps(control))
    updated["content_ref"] = ref
    for entry in updated["registry"].values():
        entry["production_ref"] = ref
    if apply:
        _atomic_write(control_path, updated)
    return updated


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ref", required=True, help="already-pushed exact 40-char content SHA")
    parser.add_argument("--apply", action="store_true", help="write production.json after validation")
    args = parser.parse_args(argv)
    try:
        promote(args.ref, apply=args.apply)
    except (PromotionError, OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        print(f"PROMOTION_GATE=FAIL error={type(error).__name__}: {error}")
        return 1
    print(f"PROMOTION_GATE=PASS ref={args.ref} apply={'YES' if args.apply else 'NO'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
