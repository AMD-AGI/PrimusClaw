# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

from claw_memory.storage.config import _database_url


def test_database_url_prefers_explicit_dsn(monkeypatch):
    monkeypatch.setenv("MEMORY_SERVICE_DATABASE_URL", "postgresql://explicit/db")
    monkeypatch.setenv("POSTGRES_HOST", "bundled-postgres")
    assert _database_url() == "postgresql://explicit/db"


def test_database_url_builds_from_postgres_secret_env(monkeypatch):
    for key in ("MEMORY_SERVICE_DATABASE_URL", "MEMORY_STORAGE_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("POSTGRES_HOST", "memory-postgres")
    monkeypatch.setenv("POSTGRES_PORT", "5433")
    monkeypatch.setenv("POSTGRES_DB", "claw_memory")
    monkeypatch.setenv("POSTGRES_USER", "claw user")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p@ss/word")

    assert _database_url() == (
        "postgresql://claw%20user:p%40ss%2Fword"
        "@memory-postgres:5433/claw_memory"
    )


def test_database_url_rejects_incomplete_postgres_env(monkeypatch):
    for key in (
        "MEMORY_SERVICE_DATABASE_URL",
        "MEMORY_STORAGE_DATABASE_URL",
        "DATABASE_URL",
        "POSTGRES_PASSWORD",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("POSTGRES_HOST", "memory-postgres")
    monkeypatch.setenv("POSTGRES_DB", "claw_memory")
    monkeypatch.setenv("POSTGRES_USER", "claw")

    assert _database_url() == ""
