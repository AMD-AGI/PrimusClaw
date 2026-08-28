# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Deterministic slug helpers for KB article topics."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Awaitable, Callable, Optional


class SlugifyError(ValueError):
    """Raised when a topic cannot be converted into a deterministic ASCII slug."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def slugify(topic: str) -> str:
    if not topic or not topic.strip():
        raise SlugifyError("empty")
    for ch in topic:
        if ord(ch) > 0x7F:
            raise SlugifyError("non_ascii")
    s = unicodedata.normalize("NFKC", topic).lower()
    s = _NON_ALNUM.sub("-", s).strip("-")
    if not s:
        raise SlugifyError("empty")
    if len(s) < 8:
        raise SlugifyError("too_short")
    if len(s) > 80:
        suffix = hashlib.sha256(topic.encode("utf-8")).hexdigest()[:7]
        return f"{s[:72].rstrip('-')}-{suffix}"
    return s


async def slugify_safe(
    topic: str,
    translate_fn: Optional[Callable[[str], Awaitable[str]]] = None,
) -> str:
    try:
        return slugify(topic)
    except SlugifyError as exc:
        if exc.reason != "non_ascii":
            raise
    if translate_fn:
        try:
            return slugify(await translate_fn(topic))
        except Exception:
            pass
    suffix = hashlib.sha256(topic.encode("utf-8")).hexdigest()[:8]
    return f"auto-{suffix}"
