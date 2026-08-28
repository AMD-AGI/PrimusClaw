#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# deploy-redis.sh — Deploy Redis independently to K8s cluster
#
# Redis is deployed as infrastructure separately from agent-sandbox services,
# only needs to be deployed once and doesn't require updates with service deployments.
#
# Usage:
#   ./deploy/scripts/deploy-redis.sh
#   or override variables:
#   REDIS_PASSWORD="mypass" REDIS_STORAGE_SIZE="5Gi" ./deploy/scripts/deploy-redis.sh

set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
#  Configuration
# ══════════════════════════════════════════════════════════════════════════════

NAMESPACE="${NAMESPACE:-agent-sandbox-system}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"              # Empty = auto-generate 32-char random password
REDIS_DB="${REDIS_DB:-1}"                         # DB number
REDIS_IMAGE="${REDIS_IMAGE:-redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2}"
REDIS_STORAGE_SIZE="${REDIS_STORAGE_SIZE:-2Gi}"
REDIS_STORAGE_CLASS="${REDIS_STORAGE_CLASS:-}"
REDIS_CPU_REQUEST="${REDIS_CPU_REQUEST:-100m}"
REDIS_CPU_LIMIT="${REDIS_CPU_LIMIT:-500m}"
REDIS_MEM_REQUEST="${REDIS_MEM_REQUEST:-128Mi}"
REDIS_MEM_LIMIT="${REDIS_MEM_LIMIT:-512Mi}"

# ══════════════════════════════════════════════════════════════════════════════
#  Internal variables
# ══════════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEPLOY_DIR="${REPO_ROOT}/deploy"

for tool in kubectl helm python3 openssl; do
    command -v "${tool}" >/dev/null 2>&1 || {
        echo "Required tool not found: ${tool}" >&2
        exit 1
    }
done

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC}  $*"; exit 1; }
print_header() { echo -e "\n${YELLOW}════════════════════════════════════\n  $*\n════════════════════════════════════${NC}"; }

# ══════════════════════════════════════════════════════════════════════════════
#  Step 1: Auto-generate password (if not specified)
# ══════════════════════════════════════════════════════════════════════════════
if [[ -z "${REDIS_PASSWORD}" ]]; then
    EXISTING_PASSWORD=$(kubectl get secret agent-sandbox-redis -n "${NAMESPACE}" \
        -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
    if [[ -n "${EXISTING_PASSWORD}" ]]; then
        REDIS_PASSWORD="${EXISTING_PASSWORD}"
        log "Reusing Redis password from existing Secret"
    else
        REDIS_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
        log "Auto-generated 32-char Redis password"
    fi
fi

# ── Print configuration ───────────────────────────────────────────────────────
print_header "Redis deployment configuration"
echo "  Namespace:     ${NAMESPACE}"
echo "  Image:         ${REDIS_IMAGE}"
echo "  DB:            ${REDIS_DB}"
echo "  Storage:       ${REDIS_STORAGE_SIZE}"
echo "  Storage class: ${REDIS_STORAGE_CLASS:-<cluster default>}"
echo "  Resources:     CPU ${REDIS_CPU_REQUEST}/${REDIS_CPU_LIMIT}, MEM ${REDIS_MEM_REQUEST}/${REDIS_MEM_LIMIT}"
echo "  Password:      ******** (${#REDIS_PASSWORD} chars)"
echo ""

read -r -p "Confirm Redis deployment? [y/N] " confirm
[[ "${confirm}" =~ ^[Yy]$ ]] || { log "Cancelled"; exit 0; }

# ══════════════════════════════════════════════════════════════════════════════
#  Step 2: Ensure Namespace exists
# ══════════════════════════════════════════════════════════════════════════════
print_header "Step 1: Namespace"
kubectl apply -f "${DEPLOY_DIR}/k8s/namespace.yaml"
ok "Namespace ${NAMESPACE}"

# ══════════════════════════════════════════════════════════════════════════════
#  Step 3: Create Redis Secret
# ══════════════════════════════════════════════════════════════════════════════
print_header "Step 2: Redis Secret"
kubectl create secret generic agent-sandbox-redis \
    --namespace="${NAMESPACE}" \
    --from-literal=addr="redis.${NAMESPACE}:6379" \
    --from-literal=password="${REDIS_PASSWORD}" \
    --from-literal=db="${REDIS_DB}" \
    --dry-run=client -o yaml | kubectl apply -f -
ok "Secret/agent-sandbox-redis (addr=redis.${NAMESPACE}:6379, db=${REDIS_DB})"

# ══════════════════════════════════════════════════════════════════════════════
#  Step 4: Deploy Redis through the maintained Helm chart
# ══════════════════════════════════════════════════════════════════════════════
print_header "Step 3: Redis StatefulSet"

VALUES_FILE=$(mktemp /tmp/redis-values-XXXXXX.json)
MANIFEST_FILE=$(mktemp /tmp/redis-manifest-XXXXXX.yaml)
trap 'rm -f "${VALUES_FILE}" "${MANIFEST_FILE}"' EXIT
REDIS_IMAGE="${REDIS_IMAGE}" \
REDIS_STORAGE_SIZE="${REDIS_STORAGE_SIZE}" \
REDIS_STORAGE_CLASS="${REDIS_STORAGE_CLASS}" \
REDIS_CPU_REQUEST="${REDIS_CPU_REQUEST}" \
REDIS_CPU_LIMIT="${REDIS_CPU_LIMIT}" \
REDIS_MEM_REQUEST="${REDIS_MEM_REQUEST}" \
REDIS_MEM_LIMIT="${REDIS_MEM_LIMIT}" \
python3 - "${VALUES_FILE}" <<'PY'
import json
import os
import sys

values = {
    "controlplane": {"enabled": False},
    "redis": {
        "deploy": True,
        "secret": {"create": False},
        "image": {"reference": os.environ["REDIS_IMAGE"]},
        "resources": {
            "requests": {
                "cpu": os.environ["REDIS_CPU_REQUEST"],
                "memory": os.environ["REDIS_MEM_REQUEST"],
            },
            "limits": {
                "cpu": os.environ["REDIS_CPU_LIMIT"],
                "memory": os.environ["REDIS_MEM_LIMIT"],
            },
        },
        "storage": {
            "size": os.environ["REDIS_STORAGE_SIZE"],
            "storageClassName": os.environ["REDIS_STORAGE_CLASS"],
        },
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(values, handle)
PY

helm template agent-sandbox-redis "${DEPLOY_DIR}/helm" \
    --namespace "${NAMESPACE}" \
    --values "${VALUES_FILE}" \
    --show-only templates/redis.yaml >"${MANIFEST_FILE}"
kubectl apply -f "${MANIFEST_FILE}"
ok "StatefulSet/redis + Service/redis"

# ══════════════════════════════════════════════════════════════════════════════
#  Step 6: Wait for readiness
# ══════════════════════════════════════════════════════════════════════════════
print_header "Step 4: Wait for Redis readiness"
echo -n "  Waiting for Redis Pod ..."
kubectl rollout status statefulset/redis -n "${NAMESPACE}" --timeout=120s 2>/dev/null \
    && echo " ✅" || echo " ⚠️ (timeout, check manually: kubectl get pods -n ${NAMESPACE} -l app=redis)"

# ══════════════════════════════════════════════════════════════════════════════
#  Done
# ══════════════════════════════════════════════════════════════════════════════
print_header "✅ Redis deployment complete"
echo ""
echo "  In-cluster address: redis.${NAMESPACE}:6379"
echo "  DB:                 ${REDIS_DB}"
echo ""
echo "  Verify connection:"
echo "    kubectl exec -it \$(kubectl get po -n ${NAMESPACE} -l app=redis -o jsonpath='{.items[0].metadata.name}') -n ${NAMESPACE} -- redis-cli -a '${REDIS_PASSWORD}' ping"
echo ""
echo "  View Secret:"
echo "    kubectl get secret agent-sandbox-redis -n ${NAMESPACE} -o yaml"
echo ""
echo "  ⚠️  Redis password stored in Secret/agent-sandbox-redis"
echo "     No need to specify Redis address when deploying agent-sandbox services later — services read from Secret automatically."
echo ""
echo "  Next step: Deploy agent-sandbox services via Helm"
echo "    helm upgrade --install agent-sandbox ./deploy/helm \\"
echo "      --namespace agent-sandbox-system --create-namespace \\"
echo "      --set controlplane.image.tag=<tag> \\"
echo "      --set controlplane.config.envdInjectorImage=primussafe/agent-sandbox-envd-injector:<tag> \\"
echo "      --set redis.deploy=false  # (we just deployed Redis above)"
