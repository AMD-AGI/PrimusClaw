# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Environment-driven configuration."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    kb_base_url: str
    input_path: str
    dead_letter_path: str
    dry_run: bool
    log_level: str
    backend: str  # "http" or "memory"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            kb_base_url=os.environ.get("KB_BASE_URL", "http://localhost:8765"),
            input_path=os.environ.get(
                "WORKER_INPUT_PATH", "/var/lib/knowledge-worker/events.jsonl"
            ),
            dead_letter_path=os.environ.get(
                "WORKER_DEAD_LETTER_PATH", "/var/lib/knowledge-worker/dead-letter.jsonl"
            ),
            dry_run=os.environ.get("WORKER_DRY_RUN", "false").lower() in ("1", "true", "yes"),
            log_level=os.environ.get("WORKER_LOG_LEVEL", "INFO"),
            backend=os.environ.get("WORKER_BACKEND", "http"),
        )
