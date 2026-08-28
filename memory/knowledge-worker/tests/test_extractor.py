# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""RuleBasedExtractor tests."""
from __future__ import annotations

import pytest

from knowledge_worker.events import RawEvent
from knowledge_worker.extractor import KIND_PITFALL, KIND_TECHNIQUE, RuleBasedExtractor


def _event(**overrides) -> RawEvent:
    base = {
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
        "source_review_id": "review_1",
    }
    base.update(overrides)
    return RawEvent.from_dict(base)


@pytest.mark.asyncio
async def test_success_event_becomes_technique() -> None:
    drafts = await RuleBasedExtractor().extract([_event(outcome="success")])

    assert len(drafts) == 1
    draft = drafts[0]
    assert draft.kind == KIND_TECHNIQUE
    assert draft.slug == "fp8-warmup-improves-stability"
    assert draft.scope == {
        "org": "hyperloom",
        "framework": "sglang",
        "model": "DeepSeek-R1",
    }
    assert draft.importance == 0.5
    assert draft.metadata["source_session"] == "sess_1"
    assert draft.metadata["source_review_id"] == "review_1"
    assert draft.metadata["evidence"] == {"patch_id": "p1"}


@pytest.mark.asyncio
async def test_failure_event_becomes_pitfall_with_higher_importance() -> None:
    drafts = await RuleBasedExtractor().extract(
        [_event(title="MLA overflow pitfall", outcome="failure")]
    )

    assert drafts[0].kind == KIND_PITFALL
    assert drafts[0].importance == 0.7
    assert drafts[0].slug == "mla-overflow-pitfall"


@pytest.mark.asyncio
async def test_non_ascii_title_uses_translation_callback() -> None:
    async def translate(_: str) -> str:
        return "MLA FP8 stability"

    drafts = await RuleBasedExtractor(translate_fn=translate).extract(
        [_event(title="MLA FP8 stability non ascii: 稳定性")]
    )

    assert drafts[0].slug == "mla-fp8-stability"


@pytest.mark.asyncio
async def test_non_ascii_title_hash_fallback_without_translation() -> None:
    drafts = await RuleBasedExtractor().extract([_event(title="稳定性 only")])

    assert drafts[0].slug.startswith("auto-")


@pytest.mark.asyncio
async def test_to_upsert_payload_shape() -> None:
    drafts = await RuleBasedExtractor().extract([_event()])
    payload = drafts[0].to_upsert_payload()

    assert set(payload) == {
        "scope",
        "kind",
        "slug",
        "content",
        "importance",
        "metadata",
    }
    assert payload["kind"] == KIND_TECHNIQUE
