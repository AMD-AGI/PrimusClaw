# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""knowledge-worker CLI entrypoint.

Usage:
    python -m knowledge_worker.main [--backend http|memory] [--input PATH]

Behavior:
    - http   : real KBClient against KB_BASE_URL.
    - memory : InMemoryKBClient (no service required); useful for demos and tests.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from typing import Optional

from .client import KBClient
from .config import Settings
from .events import read_events
from .pipeline import run_pipeline
from .testing import InMemoryKBClient


async def amain(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="knowledge-worker")
    parser.add_argument("--backend", choices=("http", "memory"), default=None)
    parser.add_argument("--input", default=None, help="raw events JSONL path")
    parser.add_argument("--dry-run", action="store_true", help="do not write to KB")
    args = parser.parse_args(argv)

    settings = Settings.from_env()
    backend = args.backend or settings.backend
    input_path = args.input or settings.input_path
    dry_run = args.dry_run or settings.dry_run

    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )
    log = logging.getLogger("knowledge_worker")
    log.info("starting; backend=%s input=%s dry_run=%s", backend, input_path, dry_run)

    events = list(read_events(input_path))
    if not events:
        log.info("no events found at %s; nothing to do", input_path)
        return 0

    if backend == "memory":
        client = InMemoryKBClient()
        result = await run_pipeline(
            events, client, dead_letter_path=settings.dead_letter_path, dry_run=dry_run
        )
        log.info(
            "pipeline done (memory): %d drafts, %d ok, %d failed",
            len(result.drafts),
            result.write.ok,
            result.write.failed,
        )
        return 0

    async with KBClient(settings.kb_base_url) as http_client:
        result = await run_pipeline(
            events,
            http_client,
            dead_letter_path=settings.dead_letter_path,
            dry_run=dry_run,
        )
    log.info(
        "pipeline done: %d drafts, %d ok, %d failed",
        len(result.drafts),
        result.write.ok,
        result.write.failed,
    )
    return 0 if result.write.failed == 0 else 1


def run() -> None:
    sys.exit(asyncio.run(amain()))


if __name__ == "__main__":
    run()
