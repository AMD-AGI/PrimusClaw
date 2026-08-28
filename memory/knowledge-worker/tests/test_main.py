# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""CLI smoke tests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from knowledge_worker.main import amain


@pytest.mark.asyncio
async def test_main_memory_backend_processes_input_file(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    path.write_text(
        json.dumps(
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
            }
        )
        + "\n",
        encoding="utf-8",
    )

    rc = await amain(["--backend", "memory", "--input", str(path)])

    assert rc == 0


@pytest.mark.asyncio
async def test_main_returns_zero_when_no_events(tmp_path: Path) -> None:
    rc = await amain(["--backend", "memory", "--input", str(tmp_path / "missing.jsonl")])

    assert rc == 0
