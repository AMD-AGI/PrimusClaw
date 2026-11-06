# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Dockerfile for the standalone Claw Memory Service
FROM python:3.15-slim-bookworm@sha256:96599df822d0e1c6bb700014a05c7f3c8cabc6e0f7ff3c4f9f69cee033b4b5d9

WORKDIR /app

# Install dependencies (only the core + storage extras)
COPY pyproject.toml /app/
COPY src/ /app/src/

RUN pip install --no-cache-dir -e .[storage]

# Environment variables that should be set at runtime:
# MEMORY_SERVICE_DATABASE_URL=postgresql://claw_memory:<password>@claw-memory-postgres:5432/claw_memory
ENV MEMORY_SERVICE_PORT=8765
ENV MEMORY_SERVICE_HOST=0.0.0.0

EXPOSE 8765

CMD ["claw-memory-service"]