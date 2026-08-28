# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Article extraction.

Two implementations:
    - RuleBasedExtractor: deterministic baseline; no LLM dependency.
        Maps RawEvent -> ArticleDraft using simple heuristics. Useful for
        bootstrapping and golden-path tests.
    - LLMExtractor (Protocol): plug your inference-optimizer / vLLM call here.
        The MVP ships only the protocol; concrete impl lives in a follow-up.

Both produce the same ArticleDraft structure, which the writer consumes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Protocol

from .events import RawEvent
from .slug import SlugifyError, slugify, slugify_safe

KIND_PITFALL = "pitfall"
KIND_TECHNIQUE = "technique"


@dataclass
class ArticleDraft:
    """Pre-write representation of a KB article."""

    scope: Dict[str, str]
    kind: str  # one of KIND_*
    slug: str
    content: str
    importance: float = 0.5
    metadata: Dict[str, Any] = field(default_factory=dict)
    source_event_count: int = 1

    def to_upsert_payload(self) -> Dict[str, Any]:
        return {
            "scope": dict(self.scope),
            "kind": self.kind,
            "slug": self.slug,
            "content": self.content,
            "importance": self.importance,
            "metadata": dict(self.metadata),
        }


class Extractor(Protocol):
    async def extract(self, events: List[RawEvent]) -> List[ArticleDraft]: ...


def _pick_kind(event: RawEvent) -> str:
    """Naive classifier: failure -> pitfall, success -> technique."""
    if event.outcome == "failure":
        return KIND_PITFALL
    return KIND_TECHNIQUE


def _scope_from_event(event: RawEvent) -> Dict[str, str]:
    s: Dict[str, str] = {"org": "hyperloom"}
    if event.framework:
        s["framework"] = event.framework
    if event.model:
        s["model"] = event.model
    return s


def _importance_from_event(event: RawEvent) -> float:
    """Failures are more important than incremental successes."""
    return 0.7 if event.outcome == "failure" else 0.5


class RuleBasedExtractor:
    """Deterministic baseline extractor with optional async slug fallback (G-6)."""

    def __init__(
        self,
        *,
        translate_fn: Optional[Callable[[str], Awaitable[str]]] = None,
    ) -> None:
        self._translate_fn = translate_fn

    async def extract(self, events: List[RawEvent]) -> List[ArticleDraft]:
        drafts: List[ArticleDraft] = []
        for ev in events:
            topic = ev.title or ev.kind or "untitled"
            try:
                slug = slugify(topic)
            except SlugifyError:
                slug = await slugify_safe(topic, translate_fn=self._translate_fn)
            metadata: Dict[str, Any] = {
                "topic": topic,
                "source_session": ev.session_id,
                "source_type": ev.kind,
                "source_role": ev.actor,
                "source_event_ts": ev.ts,
            }
            if ev.source_review_id:
                metadata["source_review_id"] = ev.source_review_id
            if ev.metadata:
                metadata["evidence"] = dict(ev.metadata)

            drafts.append(
                ArticleDraft(
                    scope=_scope_from_event(ev),
                    kind=_pick_kind(ev),
                    slug=slug,
                    content=ev.description or topic,
                    importance=_importance_from_event(ev),
                    metadata=metadata,
                )
            )
        return drafts
