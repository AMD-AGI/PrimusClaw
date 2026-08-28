# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""KB write step: send ArticleDraft -> /api/kb/upsert; on failure, append to dead-letter."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

from .client import KBClientError
from .extractor import ArticleDraft

logger = logging.getLogger(__name__)


class _UpsertCapable(Protocol):
    async def upsert(self, payload: Dict[str, Any]) -> Dict[str, Any]: ...


class WriteOutcome:
    def __init__(self) -> None:
        self.ok: int = 0
        self.failed: int = 0
        self.created_ids: List[str] = []
        self.failures: List[Dict[str, Any]] = []

    def __repr__(self) -> str:
        return f"WriteOutcome(ok={self.ok}, failed={self.failed})"


async def write_drafts(
    drafts: List[ArticleDraft],
    client: _UpsertCapable,
    dead_letter_path: Optional[str | Path] = None,
    *,
    dry_run: bool = False,
) -> WriteOutcome:
    """Write each draft via the KB client. Failures are appended to dead-letter."""
    out = WriteOutcome()
    dl_path = Path(dead_letter_path) if dead_letter_path else None

    for draft in drafts:
        payload = draft.to_upsert_payload()

        if dry_run:
            logger.info(
                "dry_run upsert", extra={"scope": payload["scope"], "kind": payload["kind"], "slug": payload["slug"]}
            )
            out.ok += 1
            continue

        try:
            resp = await client.upsert(payload)
            out.ok += 1
            out.created_ids.append(resp["id"])
        except KBClientError as exc:
            out.failed += 1
            out.failures.append({"slug": draft.slug, "code": exc.code, "error_id": exc.error_id})
            _append_dead_letter(
                dl_path,
                endpoint="upsert",
                request_body=payload,
                error_code=exc.code,
            )
            logger.warning(
                "upsert failed; appended to dead-letter",
                extra={"slug": draft.slug, "code": exc.code, "error_id": exc.error_id},
            )
        except Exception as exc:  # noqa: BLE001
            out.failed += 1
            out.failures.append({"slug": draft.slug, "error": str(exc)})
            _append_dead_letter(dl_path, endpoint="upsert", request_body=payload, error_code=0)
            logger.exception("unexpected upsert error; appended to dead-letter")

    return out


def _append_dead_letter(
    path: Optional[Path],
    *,
    endpoint: str,
    request_body: Dict[str, Any],
    error_code: int,
) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(
        {
            "endpoint": endpoint,
            "request_body": request_body,
            "error_code": error_code,
            "attempted_at": datetime.now(timezone.utc).isoformat(),
            "retry_count": 0,
        }
    )
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
