# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""lint stage placeholder.

Contract v1.2 §1.2 stage 4 ('lint' = read-only LLM pass that flags semantic
duplicates) is deferred until the worker has a real LLM driver. Stub kept here
so pipeline.run() can call it unconditionally.
"""
from __future__ import annotations

from typing import Any, List


async def lint(_drafts: Any) -> List[dict]:
    return []
