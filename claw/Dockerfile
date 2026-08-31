# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# ──────────────────────────────────────────────────────────────────────
# Claw — single image for API / Brain / Hands.
# Selector: entrypoint first arg (api / brain / hands).
#
# Build from the Claw root:
#   docker build -t <REGISTRY>/claw:<TAG> .
# ──────────────────────────────────────────────────────────────────────

# ========== Stage 1: build ==========
FROM node:26-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS builder
WORKDIR /app

# ============ Extra CA anchors (opt-in) ============
# Adds private CA certificates to the image trust store, for environments whose
# egress is behind a TLS-intercepting proxy or whose LLM gateway / SaFE / S3
# endpoints are signed by a corporate CA the public trust store does not know.
# The runtime stage copies whatever lands here, which is the supported way to
# reach such an endpoint -- the alternative deployments reach for otherwise is
# tls.insecureSkipVerify, which disables certificate verification for *every*
# outbound connection the image makes.
#
# EMPTY BY DEFAULT, and that default is deliberate. An open-source image must
# not ship one organisation's trust root: every anchor here widens what this
# image will accept from every user of it. Pass your own URLs to opt in:
#
#   docker build --build-arg EXTRA_CA_CERT_URLS="https://host/root.crt https://host/issuing.crt" .
#
# Prefer a content-addressed URL (a commit SHA, a digest) over a branch or a
# mutable path: whoever controls the ref controls what TLS this image trusts.
#
# Certificates must be PEM. Fetch failures are fatal rather than silent -- a
# build that asked for an anchor and did not get it should not be mistaken for
# a working one.
ARG EXTRA_CA_CERT_URLS=""
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && if [ -n "$EXTRA_CA_CERT_URLS" ]; then \
      i=0; \
      for url in $EXTRA_CA_CERT_URLS; do \
        i=$((i+1)); \
        curl -fsSL --retry 2 --max-time 30 \
          -o "/usr/local/share/ca-certificates/extra-ca-${i}.crt" "$url" \
          || { echo "error: could not fetch CA certificate: $url" >&2; exit 1; }; \
        grep -q 'BEGIN CERTIFICATE' "/usr/local/share/ca-certificates/extra-ca-${i}.crt" \
          || { echo "error: not a PEM certificate: $url" >&2; exit 1; }; \
      done; \
      update-ca-certificates; \
      echo "installed $i extra CA anchor(s)."; \
    else \
      echo "no extra CA anchors requested (EXTRA_CA_CERT_URLS empty)."; \
    fi

# Copy only the manifests first so `npm ci` layer caches on deps.
COPY package.json package-lock.json ./
COPY packages/api/package.json       packages/api/
COPY packages/brain/package.json     packages/brain/
COPY packages/hands/package.json     packages/hands/
COPY packages/protocol/package.json  packages/protocol/
COPY packages/utils/package.json     packages/utils/

RUN npm ci

# Copy source + root tsconfig and build workspaces in dependency order.
# The order below must stay identical to the "workspaces" array in
# package.json: each @claw/* package points "types" at dist/index.d.ts, so a
# package that builds before its dependency cannot resolve it and tsc fails
# with TS2307. This is the second copy of that order -- the root
# `npm run build` is `--workspaces` and walks package.json instead -- and the
# two are compared by claw/scripts/lint-dockerfile-build-order.sh, which runs
# in `make verify-lint` and in the lint workflow.
COPY tsconfig*.json ./
COPY packages/      packages/
RUN npm run build -w packages/utils \
 && npm run build -w packages/protocol \
 && npm run build -w packages/hands \
 && npm run build -w packages/brain \
 && npm run build -w packages/api \
 && npm prune --omit=dev

# ========== Stage 1b: Bun compile (Hands single binary) ==========
# Compiles Hands into a standalone executable — no Node.js or Bun runtime needed.
# Sandbox runs this binary directly from shared storage or via Brain HTTP download.
# Must run BEFORE src cleanup since bun build needs the TS source.
#
# Uses Debian 11 / Bullseye (glibc 2.31) so the binary runs on older base
# images like sglang/ROCm (Ubuntu 20.04) and PyTorch (Ubuntu 20.04/22.04).
# Previous Debian 12 builds linked to glibc 2.36 which caused immediate
# crashes on containers with glibc < 2.36.
FROM debian:bullseye-slim@sha256:e5b6442dd2e9684cf5e87d8338b5968f3b348636fc0be6d7850a381e3731a2bd AS bun-builder
WORKDIR /app

# Bun is installed from a pinned release archive whose checksum is verified,
# rather than by piping https://bun.sh/install into a shell. That installer is
# unversioned, so the toolchain compiling the shipped Hands binary would
# otherwise be whatever upstream published most recently.
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bun \
 && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bun \
 && bun --version \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/tsconfig*.json ./
RUN bun build packages/hands/src/index.ts \
      --compile \
      --target=bun-linux-x64 \
      --outfile=/app/hands-binary \
 && echo "hands-binary size: $(wc -c < /app/hands-binary) bytes" \
 && echo "glibc: $(ldd --version 2>&1 | head -1)" \
 && /app/hands-binary --self-check

# ========== Stage 2: runtime ==========
# node:26-slim (Debian/glibc) — Node.js runs API and Brain processes.
FROM node:26-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    WORKSPACE_PATH=/workspace

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates bash curl xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace

# Carry any anchors the builder installed into the runtime trust store. The
# builder installed them for its own network access only, so without this the
# running API/Brain can verify public CAs and nothing else -- which is what
# pushed deployments into disabling Node's TLS verification wholesale. The
# directory is empty unless the build opted in via EXTRA_CA_CERT_URLS, making
# both instructions no-ops in that case rather than a build failure.
COPY --from=builder /usr/local/share/ca-certificates/ /usr/local/share/ca-certificates/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

COPY --from=builder /app/package.json       ./package.json
COPY --from=builder /app/node_modules       ./node_modules
COPY --from=builder /app/packages           ./packages
RUN rm -rf packages/*/src packages/*/tsconfig*.json

# Reaper entry-point sanity guard. This image doubles as the workspace-reaper
# CronJob image, which runs `node /app/packages/brain/dist/reaper-entry.js`.
# The brain Deployment never imports that entry, so a compile failure or a
# dropped dist/ file would stay invisible until the CronJob crash-looped on
# "Cannot find module". --self-check exits 0 right after import, without
# opening a NATS connection.
RUN node packages/brain/dist/reaper-entry.js --self-check

# Bun-compiled Hands binary: standalone executable, no runtime dependencies.
# Brain serves it via HTTP for sandboxes without shared storage access.
COPY --from=bun-builder /app/hands-binary   ./hands-binary
RUN /app/hands-binary --self-check

COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# API : 8200   Brain : 8100   Hands : 9100
EXPOSE 8100 8200 9100

# tini handles PID-1 duties (signal forwarding, zombie reap).
# Debian installs tini to /usr/bin/tini (not /sbin/tini like Alpine).
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["api"]
