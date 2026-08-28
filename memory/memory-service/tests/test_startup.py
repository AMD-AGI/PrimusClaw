# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

import pytest

from claw_memory.storage import handlers


@pytest.mark.asyncio
async def test_startup_fails_fast_when_database_configuration_is_missing(monkeypatch):
    monkeypatch.setattr(handlers, "DATABASE_URL", "")
    monkeypatch.setattr(handlers, "store", None)

    with pytest.raises(RuntimeError, match="configuration is incomplete"):
        await handlers.startup()
