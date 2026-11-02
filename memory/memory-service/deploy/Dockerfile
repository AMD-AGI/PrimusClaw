# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Dockerfile for the standalone Claw Memory Service
FROM python:3.15-slim-bookworm@sha256:4e03260adeeebafccd084f3584e6b84823aba5651cfb53ef8a078ed441ddf9cd

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