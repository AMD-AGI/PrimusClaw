# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

import logging

from fastapi import FastAPI

from claw_memory.storage.config import KB_ENDPOINTS_ENABLED
from claw_memory.storage.handlers import router
from claw_memory.storage.metrics import metrics_route

log = logging.getLogger(__name__)

app = FastAPI(title="Claw Memory Service")

app.include_router(router, prefix="/api")

if KB_ENDPOINTS_ENABLED:
    from claw_memory.storage.kb_handlers import router as kb_router

    app.include_router(kb_router, prefix="/api")
    log.info("KB endpoints enabled (/api/kb/*)")
else:
    log.info("KB endpoints disabled by KB_ENDPOINTS_ENABLED=false")


@app.get("/metrics")
async def metrics():
    return await metrics_route()


@app.get("/health")
def health():
    return {"status": "ok", "kb_endpoints": KB_ENDPOINTS_ENABLED}
