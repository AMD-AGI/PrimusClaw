# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Pipeline orchestration tests."""
from __future__ import annotations

import pytest

from knowledge_worker.events import RawEvent
from knowledge_worker.pipeline import run_pipeline
from knowledge_worker.testing import InMemoryKBClient


def _event(title: str, outcome: str = "success") -> RawEvent:
    return RawEvent.from_dict(
        {
            "ts": "2026-05-08T10:00:00Z",
            "session_id": "sess_1",
            "actor": "orchestrator",
            "kind": "action_eval",
            "framework": "sglang",
            "model": "DeepSeek-R1",
            "title": title,
            "description": f"Description for {title}",
            "outcome": outcome,
            "metadata": {"patch_id": title},
        }
    )


@pytest.mark.asyncio
async def test_run_pipeline_extracts_and_writes() -> None:
    client = InMemoryKBClient()
    events = [_event("FP8 warmup improves stability"), _event("MLA overflow pitfall", "failure")]

    result = await run_pipeline(events, client)

    assert len(result.drafts) == 2
    assert result.write.ok == 2
    assert result.write.failed == 0
    assert result.lint_findings == []

    listing = await client.list({"scope_filter": {"framework": "sglang"}})
    assert listing["total"] == 2
    kinds = {entry["kind"] for entry in listing["entries"]}
    assert kinds == {"technique", "pitfall"}


@pytest.mark.asyncio
async def test_run_pipeline_dry_run_skips_writes() -> None:
    client = InMemoryKBClient()

    result = await run_pipeline([_event("FP8 warmup improves stability")], client, dry_run=True)

    assert result.write.ok == 1
    listing = await client.list({})
    assert listing["total"] == 0
