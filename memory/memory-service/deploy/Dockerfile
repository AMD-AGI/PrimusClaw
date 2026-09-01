# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Dockerfile for the standalone Claw Memory Service
FROM python:3.14-slim-bookworm@sha256:9ab8d9c8514b44f90cf0029dd42fdd7e9e211e639c8b995304cc04568dee900f

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