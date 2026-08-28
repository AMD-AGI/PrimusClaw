# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from fastapi import Response

SERVICE_REQUESTS_TOTAL = Counter(
    "storage_service_http_requests_total",
    "Total HTTP requests to memory storage service",
    ["endpoint", "method", "status"]
)

SERVICE_REQUEST_DURATION = Histogram(
    "storage_service_http_request_duration_seconds",
    "Duration of HTTP requests to memory storage service",
    ["endpoint"]
)

async def metrics_route():
    data = generate_latest()
    return Response(content=data, media_type=CONTENT_TYPE_LATEST)
