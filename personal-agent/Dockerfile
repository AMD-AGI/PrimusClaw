# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# The personal agent's worker on Microsoft Teams, as an image: the three npm packages built and checked exactly as a
# release publishes them (npm run build, npm run check-pack), installed from those tarballs into /app, and run as an
# unprivileged user. The worker reads its configuration from the environment (personal-agent/README.md); its store
# defaults to /data/state.db, so mount a volume writable by uid 65534 at /data.
#
# Build from the repository root (core compiles the Claw wire contract in from claw/packages/protocol):
#
#   docker build -f personal-agent/Dockerfile -t personal-agent-teams .
#
# BASE_REGISTRY prefixes the base image's reference, for a registry mirror (for example
# `--build-arg BASE_REGISTRY=registry.example.com/dockerhub/`); empty pulls from Docker Hub.

ARG BASE_REGISTRY=
ARG NODE_IMAGE=node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

# ========== Build and check the packages ==========
FROM ${BASE_REGISTRY}${NODE_IMAGE} AS build
WORKDIR /src/personal-agent

# The dependencies first, so a source change reuses this layer.
COPY personal-agent/package.json personal-agent/package-lock.json ./
COPY personal-agent/packages/core/package.json packages/core/
COPY personal-agent/packages/runtime/package.json packages/runtime/
COPY personal-agent/packages/teams/package.json packages/teams/
RUN npm ci --ignore-scripts --no-audit --no-fund

# What the build reads, and nothing else (no tests, fixtures or local node_modules).
COPY LICENSE /src/LICENSE
COPY claw/tsconfig.base.json /src/claw/tsconfig.base.json
COPY claw/packages/protocol/package.json /src/claw/packages/protocol/package.json
COPY claw/packages/protocol/src /src/claw/packages/protocol/src
COPY personal-agent/tsconfig.json ./
COPY personal-agent/scripts scripts
COPY personal-agent/packages/core/tsconfig.build.json packages/core/
COPY personal-agent/packages/core/src packages/core/src
COPY personal-agent/packages/runtime/tsconfig.build.json packages/runtime/
COPY personal-agent/packages/runtime/src packages/runtime/src
COPY personal-agent/packages/teams/tsconfig.build.json packages/teams/
COPY personal-agent/packages/teams/src packages/teams/src

RUN npm run build && npm run check-pack -- --out /packages

# The image installs the checked tarballs, as any user of the packages would: production dependencies only.
WORKDIR /app
RUN printf '{"name":"personal-agent-image","private":true,"type":"module"}\n' > package.json \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund /packages/*.tgz

# ========== Runtime ==========
FROM ${BASE_REGISTRY}${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown 65534:65534 /data
USER 65534:65534
# The worker's endpoint (PORT) and /metrics (METRICS_PORT), at their defaults.
EXPOSE 8080 9090
CMD ["node", "/app/node_modules/@primusclaw/personal-agent-teams/dist/main.js"]
