# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Dockerfile for the standalone Claw Memory Service
FROM python:3.14-slim-bookworm@sha256:416f0db2a2b561945630cef9877a7ea0581b27449eb9fd9df42f03e1b74b5b63

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