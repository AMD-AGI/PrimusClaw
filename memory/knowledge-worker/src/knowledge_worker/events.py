# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Raw event dataclass and JSONL reader.

Raw event schema (minimal)::

    {
        "ts":        ISO-8601 string,
        "session_id": str,
        "actor":     "orchestrator" | "kernel-specialist" | "critic",
        "kind":      "action_eval" | "verdict" | "diagnostic" | ...,
        "framework": str,
        "model":     str,
        "title":     str,                    # short topic
        "description": str,                  # full text body
        "outcome":   "success" | "failure",
        "metadata":  {...}                   # free-form
    }

Raw events come from the agents' per-session JSONL append log. The worker
reads them in arrival order; ordering inside a single article is decided
by metadata.source_review_id (G-11) once the review pass is wired in.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, Optional


@dataclass
class RawEvent:
    ts: str
    session_id: str
    actor: str
    kind: str
    framework: str = ""
    model: str = ""
    title: str = ""
    description: str = ""
    outcome: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    source_review_id: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RawEvent":
        return cls(
            ts=d.get("ts", ""),
            session_id=d.get("session_id", ""),
            actor=d.get("actor", ""),
            kind=d.get("kind", ""),
            framework=d.get("framework", ""),
            model=d.get("model", ""),
            title=d.get("title", ""),
            description=d.get("description", ""),
            outcome=d.get("outcome", ""),
            metadata=dict(d.get("metadata", {})),
            source_review_id=d.get("source_review_id"),
        )


def read_events(path: str | Path) -> Iterator[RawEvent]:
    """Yield RawEvent for each well-formed line in a JSONL file. Skip malformed lines."""
    p = Path(path)
    if not p.exists():
        return
    with p.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                yield RawEvent.from_dict(obj)
