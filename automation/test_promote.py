# -*- coding: utf-8 -*-
from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

import promote


class _Response:
    def __init__(self, body: str):
        self.body = body.encode("utf-8")
        self.status = 200
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return False
    def read(self):
        return self.body


class PromoteTests(unittest.TestCase):
    REF = "a" * 40

    def _control(self):
        return {
            "schema_version": "quantpro-automation-control-v2",
            "status": "PRODUCTION",
            "content_ref": "b" * 40,
            "registry": {
                "x": {
                    "prompt_id": "x",
                    "path": "automation/prompts/x.md",
                    "production_ref": "b" * 40,
                    "write_scope": "READ_ONLY",
                    "automation_guidance": ["automation_guidance/x/a.md"],
                    "research_guidance": [],
                }
            },
        }

    def test_validation_passes_and_apply_updates_only_after_raw_success(self):
        payloads = {
            f"{promote.RAW_BASE}/{self.REF}/automation/prompts/x.md":
                "# x\n\nPROMPT_ID=x\nSTATUS=PRODUCTION\nWRITE_SCOPE=READ_ONLY\n",
            f"{promote.RAW_BASE}/{self.REF}/automation_guidance/x/a.md": "# guidance\n",
        }
        def opener(url, timeout=20):
            return _Response(payloads[url])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "production.json"
            path.write_text(json.dumps(self._control()), encoding="utf-8")
            result = promote.promote(self.REF, apply=True, control_path=path, opener=opener)
            self.assertEqual(result["content_ref"], self.REF)
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["registry"]["x"]["production_ref"], self.REF)

    def test_header_mismatch_never_writes_control(self):
        control = self._control()
        def opener(url, timeout=20):
            if url.endswith("x.md"):
                return _Response("PROMPT_ID=wrong\nSTATUS=PRODUCTION\nWRITE_SCOPE=READ_ONLY\n")
            return _Response("# guidance\n")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "production.json"
            before = json.dumps(control, sort_keys=True)
            path.write_text(json.dumps(control), encoding="utf-8")
            with self.assertRaises(promote.PromotionError):
                promote.promote(self.REF, apply=True, control_path=path, opener=opener)
            after = json.dumps(json.loads(path.read_text(encoding="utf-8")), sort_keys=True)
            self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
