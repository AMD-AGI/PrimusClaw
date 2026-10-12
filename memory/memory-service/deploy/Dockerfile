# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Dockerfile for the standalone Claw Memory Service
FROM python:3.14-slim-bookworm@sha256:48b13b003dda20b16f9442b8475aa05fe21bf6579a8c881db92ffb4d8fd20f83

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