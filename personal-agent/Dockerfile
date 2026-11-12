# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# The personal agent's worker on Microsoft Teams, as an image: the npm packages built and checked exactly as a release
# publishes them (npm run build, npm run check-pack), the worker's three installed from those tarballs into /app, and
# run as an unprivileged user. The worker reads its configuration from the environment (personal-agent/README.md); its
# store defaults to /data/state.db, so mount a volume writable by uid 65534 at /data.
#
# Build from the repository root (core compiles the Claw wire contract in from claw/packages/protocol):
#
#   docker build -f personal-agent/Dockerfile -t personal-agent-teams .
#
# Both stages name the base image literally, pinned by digest, and it is the one claw/Dockerfile runs on (Node.js 26 on
# Debian bookworm, slim): the base image scan (security.yml) reads the FROM lines and scans the final stage's image. To
# pull it through a mirror, configure the builder's registry mirrors.

# ========== Build and check the packages ==========
FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
WORKDIR /src/personal-agent

# The dependencies first, so a source change reuses this layer.
COPY personal-agent/package.json personal-agent/package-lock.json ./
COPY personal-agent/packages/core/package.json packages/core/
COPY personal-agent/packages/runtime/package.json packages/runtime/
COPY personal-agent/packages/teams/package.json packages/teams/
COPY personal-agent/packages/teams-ingress/package.json packages/teams-ingress/
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
COPY personal-agent/packages/teams-ingress/tsconfig.build.json packages/teams-ingress/
COPY personal-agent/packages/teams-ingress/src packages/teams-ingress/src

RUN npm run build && npm run check-pack -- --out /packages

# The image installs the worker's three checked tarballs, as any user of the packages would: production dependencies
# only. The fourth, the Teams ingress, runs as an Azure Function, not in this image.
WORKDIR /app
RUN version="$(node -p 'require("/src/personal-agent/packages/teams/package.json").version')" \
 && printf '{"name":"personal-agent-image","private":true,"type":"module"}\n' > package.json \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
      "/packages/primusclaw-personal-agent-$version.tgz" \
      "/packages/primusclaw-personal-agent-runtime-$version.tgz" \
      "/packages/primusclaw-personal-agent-teams-$version.tgz"

# ========== Runtime ==========
FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# The base image's global npm (and npx) go: the worker is started with `node` and spawns no package manager, and
# npm's bundled dependencies are what the image scan finds HIGH vulnerabilities in (.github/scripts/image-scan.sh).
# The build stage keeps npm.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir -p /data && chown 65534:65534 /data
USER 65534:65534
# The worker's endpoint (PORT) and /metrics (METRICS_PORT), at their defaults.
EXPOSE 8080 9090
CMD ["node", "/app/node_modules/@primusclaw/personal-agent-teams/dist/main.js"]
