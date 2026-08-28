# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Raw event JSONL reader tests."""
from __future__ import annotations

import json
from pathlib import Path

from knowledge_worker.events import RawEvent, read_events


def test_raw_event_from_dict_defaults_optional_fields() -> None:
    event = RawEvent.from_dict(
        {
            "ts": "2026-05-08T10:00:00Z",
            "session_id": "sess_1",
            "actor": "critic",
            "kind": "verdict",
        }
    )

    assert event.ts == "2026-05-08T10:00:00Z"
    assert event.session_id == "sess_1"
    assert event.framework == ""
    assert event.metadata == {}
    assert event.source_review_id is None


def test_read_events_reads_valid_jsonl(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    events = [
        {
            "ts": "2026-05-08T10:00:00Z",
            "session_id": "sess_1",
            "actor": "orchestrator",
            "kind": "action_eval",
            "framework": "sglang",
            "model": "DeepSeek-R1",
            "title": "FP8 warmup improves stability",
            "description": "Enable warmup before fp8 path.",
            "outcome": "success",
            "metadata": {"patch_id": "p1"},
        },
        {
            "ts": "2026-05-08T10:01:00Z",
            "session_id": "sess_1",
            "actor": "critic",
            "kind": "verdict",
            "title": "MLA overflow pitfall",
            "outcome": "failure",
        },
    ]
    path.write_text("\n".join(json.dumps(e) for e in events), encoding="utf-8")

    out = list(read_events(path))

    assert len(out) == 2
    assert out[0].framework == "sglang"
    assert out[0].metadata == {"patch_id": "p1"}
    assert out[1].actor == "critic"


def test_read_events_skips_malformed_lines(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    path.write_text(
        "\n".join(
            [
                "{not-json",
                json.dumps(
                    {
                        "ts": "2026-05-08T10:00:00Z",
                        "session_id": "sess_1",
                        "actor": "critic",
                        "kind": "verdict",
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    out = list(read_events(path))

    assert len(out) == 1
    assert out[0].session_id == "sess_1"


def test_read_events_missing_file_yields_empty(tmp_path: Path) -> None:
    assert list(read_events(tmp_path / "missing.jsonl")) == []
