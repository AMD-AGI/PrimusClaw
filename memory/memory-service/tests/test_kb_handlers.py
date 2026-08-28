# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Pure-python tests for the KB request/response shaping helpers."""

from __future__ import annotations

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from fastapi import HTTPException  # noqa: E402

from claw_memory.storage.kb_handlers import (  # noqa: E402
    _upsert_response,
    _validate_kind,
    _validate_scope,
    _wrap_kb_entry,
)


class TestWrapKBEntry:
    def _row(self, **overrides):
        base = {
            "memory_id":     "mem_abc",
            "kind":          "pitfall",
            "slug":          "torch-compile-incompatible-mla-fp8",
            "content":       "do not use torch.compile with MLA + FP8",
            "importance":    0.85,
            "access_count":  17,
            "last_accessed": "2026-05-07T07:31:20+00:00",
            "success_rate":  0.92,
            "scope":         {"org": "hyperloom", "framework": "sglang"},
            "scope_path":    "org:hyperloom/framework:sglang",
            "edges": {
                "backlinks":     ["mla-fp8-incompatibility"],
                "contradicts":   [],
                "superseded_by": None,
            },
            "metadata": {
                "tags":           ["torch.compile"],
                "source_session": "session-002",
                "source_type":    "alchemist-extract",
            },
            "created_at": "2026-05-07T07:31:20+00:00",
            "updated_at": "2026-05-07T07:31:20+00:00",
        }
        base.update(overrides)
        return base

    def test_emits_required_fields(self) -> None:
        out = _wrap_kb_entry(self._row())
        assert out["id"]            == "mem_abc"
        assert out["kind"]          == "pitfall"
        assert out["slug"]          == "torch-compile-incompatible-mla-fp8"
        assert out["importance"]    == 0.85
        assert out["access_count"]  == 17
        assert out["success_rate"]  == 0.92
        assert out["last_accessed"] == "2026-05-07T07:31:20+00:00"

    def test_emits_both_scope_and_scope_path(self) -> None:
        out = _wrap_kb_entry(self._row())
        assert out["scope"]     == {"org": "hyperloom", "framework": "sglang"}
        assert out["scopePath"] == "org:hyperloom/framework:sglang"

    def test_falls_back_when_scope_path_missing(self) -> None:
        row = self._row()
        del row["scope_path"]
        out = _wrap_kb_entry(row)
        assert out["scopePath"] == "org:hyperloom/framework:sglang"

    def test_emits_edges_dict(self) -> None:
        out = _wrap_kb_entry(self._row())
        assert out["edges"]["backlinks"] == ["mla-fp8-incompatibility"]
        assert out["edges"]["contradicts"] == []
        assert out["edges"]["superseded_by"] is None

    def test_lifts_source_fields_out_of_metadata(self) -> None:
        out = _wrap_kb_entry(self._row())
        assert out["source_session"] == "session-002"
        assert out["source_type"]    == "alchemist-extract"

    def test_handles_missing_optional_fields(self) -> None:
        row = {
            "memory_id":   "mem_xyz",
            "kind":        "technique",
            "slug":        "x",
            "content":     "c",
            "scope":       {"org": "hyperloom"},
            "scope_path":  "org:hyperloom",
        }
        out = _wrap_kb_entry(row)
        assert out["access_count"]   == 0
        assert out["edges"]          == {}
        assert out["source_session"] is None
        assert out["source_type"]    is None
        assert out["last_accessed"]  is None
        assert out["success_rate"]   is None

    def test_id_falls_back_to_id_field(self) -> None:
        row = self._row()
        del row["memory_id"]
        row["id"] = "mem_via_id_field"
        out = _wrap_kb_entry(row)
        assert out["id"] == "mem_via_id_field"


class TestUpsertResponse:
    def test_emits_online_and_handoff_fields(self) -> None:
        row = TestWrapKBEntry()._row()
        out = _upsert_response(row, "inserted")
        assert out["status"] == "ok"
        assert out["id"] == "mem_abc"
        assert out["action"] == "inserted"
        assert out["created"] is True
        assert out["scope"] == {"org": "hyperloom", "framework": "sglang"}
        assert out["kind"] == "pitfall"
        assert out["slug"] == "torch-compile-incompatible-mla-fp8"
        assert out["importance"] == 0.85
        assert out["updated_at"] == "2026-05-07T07:31:20+00:00"


class TestValidateKind:
    def test_accepts_each_valid_kind(self) -> None:
        for k in ("model_profile", "technique", "pitfall", "params_catalog"):
            _validate_kind(k)  # must not raise

    def test_rejects_unknown_kind(self) -> None:
        with pytest.raises(HTTPException) as ei:
            _validate_kind("not-a-real-kind")
        assert ei.value.status_code == 400


class TestValidateScope:
    def test_accepts_non_empty_dict(self) -> None:
        out = _validate_scope({"org": "hyperloom"})
        assert out == {"org": "hyperloom"}

    def test_rejects_none(self) -> None:
        with pytest.raises(HTTPException) as ei:
            _validate_scope(None)
        assert ei.value.status_code == 400

    def test_rejects_empty_dict(self) -> None:
        with pytest.raises(HTTPException) as ei:
            _validate_scope({})
        assert ei.value.status_code == 400
