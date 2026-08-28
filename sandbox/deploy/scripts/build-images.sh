#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# build-images.sh — Build and push agent-sandbox images to a cluster-specific registry
#
# Usage:
#   ./build-images.sh --cluster <name> [--tag <tag>] [--no-push]
#
# Examples:
#   # Push to an environment registry
#   ./build-images.sh --cluster production
#
#   # Push with an explicit tag
#   ./build-images.sh --cluster staging --tag 202604171727
#
#   # Build only (local, no push)
#   ./build-images.sh --cluster local --no-push
#
#   # Push to Docker Hub (public registry)
#   REGISTRY_PREFIX=primussafe/ ./build-images.sh --cluster any --tag 202604171727
#
# Prerequisites:
#   - Docker running, logged in (`docker login <registry>`)
#   - Go 1.24+ on PATH (or at /usr/local/go/bin/go)
#
# Registry resolution:
#   - $REGISTRY_PREFIX is required (e.g. "primussafe/" or "my.harbor.example.com/foo/").
#     It must end with "/".
#   - $REGISTRY_TEMPLATE + --cluster is an alternative for multi-cluster setups:
#     "{cluster}" in the template is replaced with the --cluster value, e.g.
#       REGISTRY_TEMPLATE='harbor.{cluster}.example.com/agent-sandbox/' --cluster prod
#
# Only two images are built (matching the CI workflow and unified controlplane):
#   - agent-sandbox-controlplane   (Router + WM + controllers + watcher)
#   - agent-sandbox-envd-injector  (EnvD sidecar injection image)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── Args ──────────────────────────────────────────────────────────────────────
CLUSTER=""
TAG="$(date +%Y%m%d%H%M)"
PUSH=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster)   CLUSTER="$2"; shift 2 ;;
    --tag)       TAG="$2"; shift 2 ;;
    --no-push)   PUSH=false; shift ;;
    -h|--help)
      sed -n '3,30p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# There is no built-in registry hostname: this is an open-source build script and
# must not default to any one organisation's registry.
if [[ -z "${REGISTRY_PREFIX:-}" ]]; then
  if [[ -n "${REGISTRY_TEMPLATE:-}" && -n "${CLUSTER}" ]]; then
    REGISTRY_PREFIX="${REGISTRY_TEMPLATE//\{cluster\}/${CLUSTER}}"
  else
    echo "Error: set REGISTRY_PREFIX (e.g. REGISTRY_PREFIX=my.harbor.example.com/agent-sandbox/)," >&2
    echo "       or set REGISTRY_TEMPLATE together with --cluster <name>." >&2
    exit 2
  fi
fi
[[ "${REGISTRY_PREFIX}" == */ ]] || REGISTRY_PREFIX="${REGISTRY_PREFIX}/"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
head() { echo -e "\n${YELLOW}════════ $* ════════${NC}"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

CONTROLPLANE_IMAGE="${REGISTRY_PREFIX}agent-sandbox-controlplane:${TAG}"
ENVD_INJECTOR_IMAGE="${REGISTRY_PREFIX}agent-sandbox-envd-injector:${TAG}"

head "Agent-Sandbox image build"
log "Cluster:  ${CLUSTER:-<custom registry>}"
log "Registry: ${REGISTRY_PREFIX}"
log "Tag:      ${TAG}"
log "Push:     ${PUSH}"

# ── Locate go ─────────────────────────────────────────────────────────────────
GO_BIN="$(command -v go 2>/dev/null || true)"
if [[ -z "${GO_BIN}" ]]; then
  for candidate in /usr/local/go/bin/go /usr/local/bin/go; do
    [[ -x "${candidate}" ]] && GO_BIN="${candidate}" && break
  done
fi
[[ -z "${GO_BIN}" ]] && err "go not found on PATH; install Go 1.24+"
log "Go:       ${GO_BIN} ($(${GO_BIN} version | awk '{print $3}'))"

cd "${REPO_ROOT}"

# ── Step 1: build Go binaries ─────────────────────────────────────────────────
head "Step 1: Build Go binaries"
mkdir -p bin

log "Building controlplane ..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "${GO_BIN}" build -buildvcs=false \
    -ldflags="-s -w -X main.version=${TAG}" \
    -o bin/controlplane ./cmd/controlplane/main.go
ok "bin/controlplane"

log "Building envd ..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "${GO_BIN}" build -buildvcs=false \
    -ldflags="-s -w -X main.version=${TAG}" \
    -o bin/envd ./cmd/envd/main.go
ok "bin/envd"

# ── Step 2: build docker images ───────────────────────────────────────────────
head "Step 2: Build Docker images"

build_image() {
  local name="$1" dockerfile="$2" image="$3"
  log "Building ${name} → ${image} ..."
  docker build -f "${dockerfile}" -t "${image}" \
      --build-arg VERSION="${TAG}" \
      ${NO_CACHE:+--no-cache} \
      "${REPO_ROOT}"
  ok "${image}"
}

build_image "controlplane"   docker/Dockerfile.controlplane   "${CONTROLPLANE_IMAGE}"
build_image "envd-injector"  docker/Dockerfile.envd-injector  "${ENVD_INJECTOR_IMAGE}"

# ── Step 3: push (optional) ───────────────────────────────────────────────────
if [[ "${PUSH}" == "true" ]]; then
  head "Step 3: Push images"
  # Avoid sudo-env credential surprises (force the root docker config we logged in with)
  [[ -n "${DOCKER_CONFIG:-}" ]] && { log "unset DOCKER_CONFIG=${DOCKER_CONFIG}"; unset DOCKER_CONFIG; }

  for img in "${CONTROLPLANE_IMAGE}" "${ENVD_INJECTOR_IMAGE}"; do
    log "Pushing ${img} ..."
    if ! docker push "${img}"; then
      err "push failed for ${img} — run 'docker login ${REGISTRY_PREFIX%%/*}' and retry"
    fi
    ok "${img}"
  done
fi

# ── Done ──────────────────────────────────────────────────────────────────────
head "✅ Build complete"
cat <<EOF

  Images:
    ${CONTROLPLANE_IMAGE}
    ${ENVD_INJECTOR_IMAGE}

  Deploy with helm:
    helm upgrade --install agent-sandbox ./deploy/helm \\
      --namespace agent-sandbox-system --create-namespace \\
      --set controlplane.image.repository=${REGISTRY_PREFIX}agent-sandbox-controlplane \\
      --set controlplane.image.tag=${TAG} \\
      --set controlplane.config.envdInjectorImage=${ENVD_INJECTOR_IMAGE}
EOF
