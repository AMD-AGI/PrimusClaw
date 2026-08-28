# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Four-stage compile orchestration: extract -> write -> reindex -> lint."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List, Optional

from .events import RawEvent
from .extractor import ArticleDraft, Extractor, RuleBasedExtractor
from .lint import lint as lint_stage
from .reindex import reindex as reindex_stage
from .writer import WriteOutcome, write_drafts

logger = logging.getLogger(__name__)


@dataclass
class PipelineResult:
    drafts: List[ArticleDraft]
    write: WriteOutcome
    lint_findings: List[dict]


async def run_pipeline(
    events: List[RawEvent],
    client,
    *,
    extractor: Optional[Extractor] = None,
    dead_letter_path: Optional[str] = None,
    dry_run: bool = False,
) -> PipelineResult:
    """Run all four stages once over the supplied events."""
    extractor = extractor or RuleBasedExtractor()
    drafts = await extractor.extract(events)
    logger.info("extract: %d events -> %d drafts", len(events), len(drafts))

    write = await write_drafts(
        drafts, client, dead_letter_path=dead_letter_path, dry_run=dry_run
    )
    logger.info("write: %s", write)

    await reindex_stage(drafts)
    findings = await lint_stage(drafts)

    return PipelineResult(drafts=drafts, write=write, lint_findings=findings)
