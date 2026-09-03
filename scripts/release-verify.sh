#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${RELEASE_IMAGE:-primus-claw:release-smoke}"

for tool in bash rg; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required for release verification" >&2
    exit 1
  }
done

echo "==> public tree hygiene"
bash "$repo_root/scripts/release-tests/public-tree-scan.sh"

# Over the whole history, not a range: at release time every commit is about to
# become public, and unlike the tree, history cannot be fixed afterwards.
echo "==> public history hygiene"
bash "$repo_root/scripts/release-tests/public-message-scan.sh" HEAD

# docker and helm are required, but each is checked immediately before the
# first gate that needs it rather than here.
#
# Checked together up front, a contributor without a Docker daemon got zero
# gates instead of the nine that need no daemon at all -- and the two Docker
# gates were broken for months behind that preflight, because nothing reached
# them to find out. Verification that stops before it starts is the same
# failure mode this file's other guards are written against.
#
# Still fatal, just later: a run that could not build the image has not
# release-verified anything, so the exit status must say so.
require_tool() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: $1 is required for release verification" >&2
    exit 1
  }
}

echo "==> deployment script behavior"
bash -n \
  "$repo_root/deploy/deploy.sh" \
  "$repo_root/deploy/litellm/deploy.sh" \
  "$repo_root/deploy/profile-loader.sh" \
  "$repo_root/sandbox/deploy/scripts/install.sh"
bash "$repo_root/scripts/release-tests/deploy-auth-forwarding.sh"
bash "$repo_root/scripts/release-tests/installer-behavior.sh"
bash "$repo_root/scripts/release-tests/dry-run-no-side-effects.sh"

require_tool helm
echo "==> Helm lint and render"
bash "$repo_root/scripts/release-tests/litellm-deployment.sh"
helm lint "$repo_root/sandbox/deploy/helm" \
  --values "$repo_root/scripts/release-tests/values/sandbox-release.yaml"
sandbox_render="$(mktemp)"
claw_render="$(mktemp)"
memory_render="$(mktemp)"
trap 'rm -f "$sandbox_render" "$claw_render" "$memory_render"' EXIT
helm template sandbox-release "$repo_root/sandbox/deploy/helm" \
  --namespace agent-sandbox-system \
  --values "$repo_root/scripts/release-tests/values/sandbox-release.yaml" >"$sandbox_render"
rg -q '^kind: StatefulSet$' "$sandbox_render"
rg -q '^kind: Secret$' "$sandbox_render"
rg -q 'example.invalid/agent-sandbox-controlplane:release-test@sha256:1111111111111111111111111111111111111111111111111111111111111111' "$sandbox_render"
if rg '^[[:space:]]*image:' "$sandbox_render" | rg -v '@sha256:'; then
  echo "sandbox release render contains a mutable image reference" >&2
  exit 1
fi
helm lint "$repo_root/claw/deploy/charts/claw" \
  --values "$repo_root/scripts/release-tests/values/claw-release.yaml"
helm template claw-release "$repo_root/claw/deploy/charts/claw" \
  --namespace primus-claw \
  --values "$repo_root/scripts/release-tests/values/claw-release.yaml" >"$claw_render"
rg -q '^kind: Secret$' "$claw_render"
rg -q '^kind: Ingress$' "$claw_render"
rg -q 'name: release-pg' "$claw_render"
rg -q 'name: "release-pguser-release-user"' "$claw_render"
if rg '^[[:space:]]*image:' "$claw_render" | rg -v '@sha256:'; then
  echo "Claw release render contains a mutable image reference" >&2
  exit 1
fi
helm lint "$repo_root/memory/memory-service/deploy/helm" \
  --set-string 'postgres.auth.password=p@ss/word'
helm template memory-release "$repo_root/memory/memory-service/deploy/helm" \
  --set-string 'postgres.auth.password=p@ss/word' >"$memory_render"
rg -q 'name: memory-release-claw-memory-service-postgres-secret' "$memory_render"
rg -q 'POSTGRES_PASSWORD: "p@ss/word"' "$memory_render"
rg -q 'name: POSTGRES_HOST' "$memory_render"
# The bundled path must hand the service its credentials as discrete
# POSTGRES_* keys and let Python percent-encode them, so any DSN in the render
# means the chart went back to concatenating one itself.
if rg -q 'MEMORY_SERVICE_DATABASE_URL|postgresql://' "$memory_render"; then
  echo "memory-service bundled render must not contain a database URL" >&2
  exit 1
fi
# A password-only change has to move the Deployment checksum, otherwise Pods
# keep serving with the credentials baked into their current environment.
memory_checksum_a="$(rg -o 'checksum/postgres-secret: \S+' "$memory_render")"
memory_checksum_b="$(helm template memory-release \
  "$repo_root/memory/memory-service/deploy/helm" \
  --set-string 'postgres.auth.password=rotated/p@ss' |
  rg -o 'checksum/postgres-secret: \S+')"
if [ -z "$memory_checksum_a" ] || [ "$memory_checksum_a" = "$memory_checksum_b" ]; then
  echo "memory-service Deployment does not roll on a Postgres password change" >&2
  exit 1
fi
helm template memory-release "$repo_root/memory/memory-service/deploy/helm" \
  --set postgres.auth.existingSecret=release-postgres-secret >/dev/null
# An external database wins over postgres.enabled: no bundled resources, and no
# bundled password required.
memory_external_render="$(helm template memory-release \
  "$repo_root/memory/memory-service/deploy/helm" \
  --set-string 'externalDatabase.url=postgresql://user:p%40ss@db.example.invalid:5432/claw_memory')"
if printf '%s' "$memory_external_render" | rg -q 'component: postgres'; then
  echo "memory-service chart deployed bundled Postgres alongside an external database" >&2
  exit 1
fi
printf '%s' "$memory_external_render" |
  rg -q 'MEMORY_SERVICE_DATABASE_URL: "postgresql://user:p%40ss@db.example.invalid:5432/claw_memory"'
if helm template memory-release "$repo_root/memory/memory-service/deploy/helm" \
  >/dev/null 2>&1; then
  echo "memory-service chart accepted a missing database credential" >&2
  exit 1
fi

require_tool docker
echo "==> Claw image build and Hands compatibility smoke"
# Name the build context and check it here: a directory rename turns this gate
# into a context error nobody reads, and the gate only runs behind `command -v
# docker` on a tag push, so a stale path can sit unnoticed for months.
claw_context="$repo_root/claw"
if [ ! -f "$claw_context/Dockerfile" ]; then
  echo "Claw image build context $claw_context has no Dockerfile; this release gate is pointing at a stale path" >&2
  exit 1
fi
docker build -t "$image" "$claw_context"
docker run --rm --entrypoint /app/hands-binary "$image" --self-check

echo "==> PostgreSQL schema migration"
bash "$repo_root/scripts/release-tests/db-migration-smoke.sh" "$image"

echo "release verification: all local gates passed"
