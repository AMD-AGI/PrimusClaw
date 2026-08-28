# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

import os
from urllib.parse import quote


def _database_url() -> str:
    direct = (
        os.environ.get("MEMORY_SERVICE_DATABASE_URL")
        or os.environ.get("MEMORY_STORAGE_DATABASE_URL")
        or os.environ.get("DATABASE_URL")
    )
    if direct:
        return direct

    host = os.environ.get("POSTGRES_HOST", "")
    database = os.environ.get("POSTGRES_DB", "")
    username = os.environ.get("POSTGRES_USER", "")
    password = os.environ.get("POSTGRES_PASSWORD", "")
    if not all((host, database, username, password)):
        return ""
    port = os.environ.get("POSTGRES_PORT", "5432")
    return (
        f"postgresql://{quote(username, safe='')}:{quote(password, safe='')}"
        f"@{host}:{port}/{quote(database, safe='')}"
    )


DATABASE_URL = _database_url()


def _bool_env(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# ``/api/kb/*`` (KB extension) routes mounted on the FastAPI app.
# - true  (default): KB CRUD, search, activation, touch, edges/add live.
# - false:           routes unmounted; service responds 404 on those paths
#                    and behaves byte-identically to the pre-extension
#                    build. Provides the rollback path documented in the
#                    KB extension design (§7).
KB_ENDPOINTS_ENABLED: bool = _bool_env("KB_ENDPOINTS_ENABLED", True)
