# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""reindex stage placeholder.

Contract v1.2 §1.2 stage 3 ('reindex' = token-free regeneration of projections)
is a server-side concern in the v1.x architecture; the worker has no work to do
because kb-service already maintains the indexes used at read time.

This module exists so the pipeline call shape stays stable when v2 introduces
client-side projection caching.
"""
from __future__ import annotations

from typing import Any


async def reindex(_drafts: Any) -> None:
    return None
