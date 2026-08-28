# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Draft writer tests."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from knowledge_worker.client import KBClientError
from knowledge_worker.extractor import ArticleDraft
from knowledge_worker.testing import InMemoryKBClient
from knowledge_worker.writer import write_drafts


def _draft(slug: str = "fp8-warmup") -> ArticleDraft:
    return ArticleDraft(
        scope={"org": "hyperloom", "framework": "sglang"},
        kind="technique",
        slug=slug,
        content="Enable warmup before fp8 path.",
        importance=0.5,
        metadata={"source_session": "sess_1", "source_type": "action_eval"},
    )


@pytest.mark.asyncio
async def test_write_drafts_upserts_all_successfully() -> None:
    client = InMemoryKBClient()

    outcome = await write_drafts([_draft("fp8-warmup"), _draft("rope-scaling")], client)

    assert outcome.ok == 2
    assert outcome.failed == 0
    assert len(outcome.created_ids) == 2
    listing = await client.list({"scope_filter": {"framework": "sglang"}})
    assert listing["total"] == 2


@pytest.mark.asyncio
async def test_dry_run_does_not_write() -> None:
    client = InMemoryKBClient()

    outcome = await write_drafts([_draft()], client, dry_run=True)

    assert outcome.ok == 1
    assert outcome.failed == 0
    listing = await client.list({})
    assert listing["total"] == 0


class FailingClient:
    async def upsert(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        raise KBClientError("service unavailable", code=503, error_id="unavailable")


@pytest.mark.asyncio
async def test_write_failure_appends_dead_letter(tmp_path: Path) -> None:
    dl = tmp_path / "dead-letter.jsonl"

    outcome = await write_drafts([_draft()], FailingClient(), dead_letter_path=dl)

    assert outcome.ok == 0
    assert outcome.failed == 1
    lines = dl.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["endpoint"] == "upsert"
    assert entry["error_code"] == 503
    assert entry["request_body"]["slug"] == "fp8-warmup"


class UnexpectedFailingClient:
    async def upsert(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        raise RuntimeError("boom")


@pytest.mark.asyncio
async def test_unexpected_write_failure_appends_dead_letter(tmp_path: Path) -> None:
    dl = tmp_path / "dead-letter.jsonl"

    outcome = await write_drafts(
        [_draft()], UnexpectedFailingClient(), dead_letter_path=dl
    )

    assert outcome.failed == 1
    entry = json.loads(dl.read_text(encoding="utf-8").splitlines()[0])
    assert entry["error_code"] == 0
