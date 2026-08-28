# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

"""Does a failure tell the caller more than it should?

An unforeseen exception's message is written by whichever library raised it, and
this service installs no authentication, so anything able to reach it could read
whatever that message happened to carry. It used to be returned verbatim.

What the caller gets now is a fixed phrase. The message goes to the log.

MemoryStoreError is deliberately not covered here: those bodies are written in
postgres_store for the caller ("slug is required"), so they stay in the response.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from claw_memory.storage.handlers import unexpected_error  # noqa: E402
from claw_memory.storage.postgres_store import MemoryStoreError  # noqa: E402

# Stands in for what a library failure carries: a message naming internals a
# caller has no business reading.
SECRET_MESSAGE = (
    "connection to server at 10.42.0.7 port 5432 failed, user=claw_admin"
)


class TestUnexpectedError:
    def test_the_message_does_not_reach_the_caller(self):
        exc = unexpected_error(RuntimeError(SECRET_MESSAGE))

        assert exc.status_code == 500
        assert SECRET_MESSAGE not in str(exc.detail)
        for leak in ("10.42.0.7", "5432", "claw_admin"):
            assert leak not in str(exc.detail), f"{leak!r} leaked into the response"

    def test_the_traceback_reaches_the_log(self, caplog):
        with caplog.at_level(logging.ERROR, logger="claw_memory.storage.handlers"):
            try:
                raise RuntimeError(SECRET_MESSAGE)
            except RuntimeError as e:
                unexpected_error(e)

        # Withheld from the caller, not discarded -- an operator still needs it.
        assert SECRET_MESSAGE in caplog.text
        # log.exception, so the traceback is there to locate the raise site.
        assert "Traceback" in caplog.text


class TestBatchInsertReportsPerEntry:
    """Batch insert answers per entry in the body rather than raising.

    unexpected_error is therefore unreachable from here, and the same rule is
    applied by hand -- which is worth holding in place, since the response is
    assembled at four separate points in that loop.
    """

    def _run(self, monkeypatch, caplog, raises):
        from claw_memory.storage import kb_handlers

        async def failing_upsert(_req):
            raise raises

        monkeypatch.setattr(kb_handlers, "_do_upsert", failing_upsert)

        req = kb_handlers.KBBatchRequest(entries=[{
            "scope": {"org": "hyperloom"},
            "kind":  "pitfall",
            "slug":  "some-slug",
        }])
        with caplog.at_level(logging.ERROR, logger="claw_memory.storage.kb_handlers"):
            out = asyncio.run(kb_handlers.kb_batch_insert(req))
        return out

    def test_the_message_does_not_reach_the_caller(self, monkeypatch, caplog):
        out = self._run(monkeypatch, caplog, RuntimeError(SECRET_MESSAGE))

        # Both the per-entry result and the errors list quote it, so check the
        # whole response rather than one field.
        body = json.dumps(out)
        assert SECRET_MESSAGE not in body
        for leak in ("10.42.0.7", "5432", "claw_admin"):
            assert leak not in body, f"{leak!r} leaked into the response"

    def test_the_entry_is_still_reported_as_failed(self, monkeypatch, caplog):
        # Withholding the message must not cost the caller the fact that it failed.
        out = self._run(monkeypatch, caplog, RuntimeError(SECRET_MESSAGE))

        assert out["inserted"] == 0
        assert len(out["errors"]) == 1
        assert out["errors"][0]["index"] == 0
        assert out["results"][0]["status"] == "error"

    def test_the_traceback_reaches_the_log(self, monkeypatch, caplog):
        self._run(monkeypatch, caplog, RuntimeError(SECRET_MESSAGE))

        assert SECRET_MESSAGE in caplog.text
        assert "Traceback" in caplog.text

    def test_a_store_error_still_says_which_field_is_at_fault(self, monkeypatch, caplog):
        # The store writes those bodies for the caller, so this one is returned.
        out = self._run(
            monkeypatch, caplog, MemoryStoreError(400, "slug is required for KB rows")
        )

        # Both places it is reported, or the caller sees it in one listing and a
        # bare status in the other.
        assert "slug is required for KB rows" in out["errors"][0]["error"]
        assert "slug is required for KB rows" in out["results"][0]["error"]["message"]


class TestValidationFeedbackIsKept:
    """Not everything is a leak.

    A validation message is written here, for the caller, and names the field at
    fault. Redacting those too would leave a 400 with nothing actionable in it,
    so the activation-context check keeps its own.
    """

    def test_activation_context_still_says_what_is_missing(self):
        from claw_memory.storage.activation import ActivationContext

        with pytest.raises(ValueError) as caught:
            ActivationContext.from_dict({})

        assert "org" in str(caught.value)
