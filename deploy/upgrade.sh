#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Upgrade an already installed PrimusClaw release to this branch.
#
# One command. It does not call install.sh.
#
#   1. Once: apply the SandboxPolicy CRD and copy Redis session:* policies.
#      A ConfigMap records that this finished. Later runs skip it, including
#      after Redis has been removed.
#   2. helm upgrade the sandbox chart with the control-plane image and the
#      envd injector image. The chart no longer ships Redis, so this upgrade
#      deletes the Redis objects that belonged to the release.
#   3. helm upgrade the Claw chart with the Claw image.
#
# Usage:
#   deploy/upgrade.sh \
#     --claw-image docker.io/primussafe/claw:TAG \
#     --sandbox-image docker.io/primussafe/agent-sandbox-controlplane:TAG \
#     --envd-image docker.io/primussafe/agent-sandbox-envd-injector:TAG
#
# Optional:
#   --sandbox-namespace agent-sandbox-system
#   --sandbox-release agent-sandbox
#   --claw-namespace primus-claw
#   --claw-release primus-claw
#   --dry-run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CLAW_IMAGE=""
SANDBOX_IMAGE=""
ENVD_IMAGE=""
SANDBOX_NAMESPACE="${SANDBOX_NAMESPACE:-agent-sandbox-system}"
SANDBOX_RELEASE="${SANDBOX_RELEASE:-agent-sandbox}"
CLAW_NAMESPACE="${CLAW_NAMESPACE:-primus-claw}"
CLAW_RELEASE="${CLAW_RELEASE:-primus-claw}"
DRY_RUN=false

MIGRATION_CONFIGMAP="sandbox-policy-migration"
SANDBOX_CHART="${REPO_ROOT}/sandbox/deploy/helm"
CLAW_CHART="${REPO_ROOT}/claw/deploy/charts/claw"
MIGRATE="${REPO_ROOT}/sandbox/deploy/scripts/migrate-sandbox-policy.sh"

while [ $# -gt 0 ]; do
    case "$1" in
        --claw-image)        CLAW_IMAGE="${2:?}"; shift 2 ;;
        --sandbox-image)     SANDBOX_IMAGE="${2:?}"; shift 2 ;;
        --envd-image)        ENVD_IMAGE="${2:?}"; shift 2 ;;
        --sandbox-namespace) SANDBOX_NAMESPACE="${2:?}"; shift 2 ;;
        --sandbox-release)   SANDBOX_RELEASE="${2:?}"; shift 2 ;;
        --claw-namespace)    CLAW_NAMESPACE="${2:?}"; shift 2 ;;
        --claw-release)      CLAW_RELEASE="${2:?}"; shift 2 ;;
        --dry-run)           DRY_RUN=true; shift ;;
        -h|--help)
            sed -n '2,32p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

log() { printf '[upgrade] %s\n' "$*"; }
die() { printf '[upgrade] ERROR: %s\n' "$*" >&2; exit 1; }

# Split name:tag. The tag is the colon in the last path segment, so a registry
# port (registry:5000/org/name:tag) stays in the name.
split_name_tag() {
    python3 - "$1" <<'PY'
import sys
ref = sys.argv[1].strip()
if not ref or "@" in ref or "://" in ref:
    raise SystemExit("image must be name:tag")
leaf = ref.rsplit("/", 1)[-1]
if ":" not in leaf:
    raise SystemExit("image %s has no tag" % ref)
name, tag = ref.rsplit(":", 1)
if not name or not tag:
    raise SystemExit("image %s is incomplete" % ref)
print(name)
print(tag)
PY
}

# Claw's chart renders registry/repository:tag with one slash between them.
split_claw_image() {
    python3 - "$1" <<'PY'
import sys
ref = sys.argv[1].strip()
if not ref or "@" in ref or "://" in ref:
    raise SystemExit("claw image must be registry/name:tag")
leaf = ref.rsplit("/", 1)[-1]
if ":" not in leaf or "/" not in ref:
    raise SystemExit("claw image %s must look like registry/name:tag" % ref)
name, tag = ref.rsplit(":", 1)
registry, repository = name.rsplit("/", 1)
if not registry or not repository or not tag:
    raise SystemExit("claw image %s is incomplete" % ref)
print(registry)
print(repository)
print(tag)
PY
}

write_json() {
    local dest="$1"
    shift
    python3 - "$dest" "$@" <<'PY'
import json
import sys
path = sys.argv[1]
# Remaining args are key=value pairs folded into a nested dict by dots.
root = {}
for item in sys.argv[2:]:
    key, value = item.split("=", 1)
    cursor = root
    parts = key.split(".")
    for part in parts[:-1]:
        cursor = cursor.setdefault(part, {})
    cursor[parts[-1]] = value
with open(path, "w", encoding="utf-8") as fh:
    json.dump(root, fh)
PY
}

require_release() {
    local release="$1" namespace="$2"
    helm status "$release" -n "$namespace" >/dev/null 2>&1 \
        || die "Helm release ${release} not found in ${namespace}"
}

migration_done() {
    kubectl -n "${SANDBOX_NAMESPACE}" get configmap "${MIGRATION_CONFIGMAP}" >/dev/null 2>&1
}

mark_migration_done() {
    kubectl -n "${SANDBOX_NAMESPACE}" create configmap "${MIGRATION_CONFIGMAP}" \
        --from-literal=migrated=true \
        --dry-run=client -o yaml | kubectl apply -f -
}

upgrade_sandbox() {
    local name tag values
    mapfile -t parts < <(split_name_tag "${SANDBOX_IMAGE}")
    name="${parts[0]}"
    tag="${parts[1]}"
    values="$(mktemp)"
    write_json "${values}" \
        "controlplane.image.repository=${name}" \
        "controlplane.image.tag=${tag}" \
        "controlplane.config.envdInjectorImage=${ENVD_IMAGE}"
    log "sandbox image ${name}:${tag}"
    log "envd image ${ENVD_IMAGE}"
    if [[ "${DRY_RUN}" == "true" ]]; then
        helm upgrade "${SANDBOX_RELEASE}" "${SANDBOX_CHART}" -n "${SANDBOX_NAMESPACE}" \
            --reset-then-reuse-values -f "${values}" --dry-run >/dev/null
    else
        helm upgrade "${SANDBOX_RELEASE}" "${SANDBOX_CHART}" -n "${SANDBOX_NAMESPACE}" \
            --reset-then-reuse-values -f "${values}" --wait --timeout 5m
        kubectl -n "${SANDBOX_NAMESPACE}" rollout status deploy/agent-sandbox-controlplane --timeout=5m
    fi
    rm -f "${values}"
}

upgrade_claw() {
    local registry repository tag values
    mapfile -t parts < <(split_claw_image "${CLAW_IMAGE}")
    registry="${parts[0]}"
    repository="${parts[1]}"
    tag="${parts[2]}"
    values="$(mktemp)"
    write_json "${values}" \
        "image.registry=${registry}" \
        "image.repository=${repository}" \
        "image.tag=${tag}"
    log "claw image ${registry}/${repository}:${tag}"
    if [[ "${DRY_RUN}" == "true" ]]; then
        helm upgrade "${CLAW_RELEASE}" "${CLAW_CHART}" -n "${CLAW_NAMESPACE}" \
            --reset-then-reuse-values -f "${values}" --dry-run >/dev/null
    else
        helm upgrade "${CLAW_RELEASE}" "${CLAW_CHART}" -n "${CLAW_NAMESPACE}" \
            --reset-then-reuse-values -f "${values}" --wait --timeout 5m
        kubectl -n "${CLAW_NAMESPACE}" rollout status deployment/primus-claw-api --timeout=3m
        kubectl -n "${CLAW_NAMESPACE}" rollout status deployment/primus-claw-brain --timeout=5m
    fi
    rm -f "${values}"
}

main() {
    [[ -n "${CLAW_IMAGE}" && -n "${SANDBOX_IMAGE}" && -n "${ENVD_IMAGE}" ]] \
        || die "required: --claw-image, --sandbox-image, --envd-image"
    command -v kubectl >/dev/null 2>&1 || die "kubectl not found"
    command -v helm >/dev/null 2>&1 || die "helm not found"
    command -v python3 >/dev/null 2>&1 || die "python3 not found"
    [[ -x "${MIGRATE}" ]] || die "missing ${MIGRATE}"
    [[ -d "${SANDBOX_CHART}" && -d "${CLAW_CHART}" ]] || die "helm charts not found"
    kubectl cluster-info >/dev/null 2>&1 || die "kubectl cannot reach the cluster"
    require_release "${SANDBOX_RELEASE}" "${SANDBOX_NAMESPACE}"
    require_release "${CLAW_RELEASE}" "${CLAW_NAMESPACE}"

    log "context $(kubectl config current-context 2>/dev/null || echo unknown)"
    log "sandbox ${SANDBOX_NAMESPACE}/${SANDBOX_RELEASE}"
    log "claw ${CLAW_NAMESPACE}/${CLAW_RELEASE}"

    if migration_done; then
        log "SandboxPolicy migration already recorded; skipping Redis"
    elif [[ "${DRY_RUN}" == "true" ]]; then
        log "dry-run: would migrate Redis session policies once, then upgrade images"
    else
        log "migrating SandboxPolicy from Redis (once)"
        NAMESPACE="${SANDBOX_NAMESPACE}" bash "${MIGRATE}"
        mark_migration_done
    fi

    upgrade_sandbox
    upgrade_claw
    log "upgrade finished"
}

main "$@"
