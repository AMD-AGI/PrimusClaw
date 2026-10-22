#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# migrate-sandbox-policy.sh — copy per-session egress policy from Redis onto SandboxPolicy CRs.
#
# Called by deploy/upgrade.sh before the control-plane image rolls. It applies
# the SandboxPolicy CRD, then copies Redis session:* policies. Redis still holds
# those keys during the upgrade; the sandbox chart upgrade removes Redis.
# policyVersion is copied and not incremented. An existing SandboxPolicy is left
# unchanged. The reconciler creates agent-default only when a SandboxPolicy is
# absent. A running EnvD ignores the copied version until the sandbox pod
# restarts, then loads this object instead of the default policy.
#
# Usage:
#   ./migrate-sandbox-policy.sh
#   DRY_RUN=true ./migrate-sandbox-policy.sh
#   REDIS_ADDR=redis.example:6379 REDIS_PASSWORD=secret REDIS_DB=1 ./migrate-sandbox-policy.sh
#
# Without REDIS_ADDR, the script reads Secret agent-sandbox-redis in NAMESPACE
# and runs redis-cli inside the Redis Pod. REDIS_DB defaults to 1, matching the
# previous control plane.

set -euo pipefail

NAMESPACE="${NAMESPACE:-agent-sandbox-system}"
REDIS_SECRET="${REDIS_SECRET:-agent-sandbox-redis}"
REDIS_POD_LABEL="${REDIS_POD_LABEL:-app=redis}"
DRY_RUN="${DRY_RUN:-false}"
REDIS_ADDR="${REDIS_ADDR:-}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
REDIS_POD=""
# Empty means unset. An explicit REDIS_DB, including 0, wins over the URL path.
SAVED_REDIS_DB="${REDIS_DB:-}"
REDIS_DB=""

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC}  $*" >&2; exit 1; }

CREATED=0
SKIPPED_EXISTS=0
SKIPPED_NO_SANDBOX=0
SKIPPED_INVALID=0
FAILED=0

# Build a SandboxPolicy JSON document from one Redis SandboxInfo on stdin.
# policyVersion is copied; 0 or a missing value becomes 1 and is not incremented.
render_policy() {
    # The Python program is a heredoc, so the Redis record cannot ride on stdin.
    local payload
    payload="$(cat)"
    SANDBOX_UID="$1" POLICY_JSON="${payload}" python3 - <<'PY'
import json
import os
import sys

uid = os.environ["SANDBOX_UID"]
info = json.loads(os.environ["POLICY_JSON"])

def text(key, default=""):
    value = info.get(key)
    if value is None:
        return default
    return str(value).strip()

def hosts(key):
    value = info.get(key) or []
    if not isinstance(value, list):
        raise SystemExit("host list %s is not a list" % key)
    out = []
    for item in value:
        if item is None:
            continue
        host = str(item).strip()
        if host:
            out.append(host)
    return out

name = text("sandbox_name")
namespace = text("namespace")
if not name or not namespace:
    raise SystemExit("missing sandbox_name or namespace")

runtime = text("runtime_policy", "agent-default") or "agent-default"
mode = text("policy_mode", "enforce") or "enforce"
if mode not in ("enforce", "audit"):
    print("policy_mode %r is not enforce or audit; using enforce" % mode, file=sys.stderr)
    mode = "enforce"

raw_version = info.get("policy_version") or 0
try:
    version = int(raw_version)
except (TypeError, ValueError):
    version = 1
if version <= 0:
    version = 1

spec = {
    "runtimePolicy": runtime,
    "policyMode": mode,
    "policyVersion": version,
}
egress = hosts("allowed_egress_hosts")
internal = hosts("allowed_internal_hosts")
if egress:
    spec["allowedEgressHosts"] = egress
if internal:
    spec["allowedInternalHosts"] = internal

doc = {
    "apiVersion": "runtime.agent-sandbox.io/v1alpha1",
    "kind": "SandboxPolicy",
    "metadata": {
        "name": name,
        "namespace": namespace,
        "ownerReferences": [{
            "apiVersion": "agents.x-k8s.io/v1alpha1",
            "kind": "Sandbox",
            "name": name,
            "uid": uid,
            "controller": True,
            "blockOwnerDeletion": True,
        }],
    },
    "spec": spec,
}
json.dump(doc, sys.stdout)
print()
PY
}

redis_cli() {
    if [[ -n "${REDIS_ADDR}" ]]; then
        local host="${REDIS_ADDR%%:*}"
        local port="${REDIS_ADDR##*:}"
        if [[ "${host}" == "${port}" ]]; then
            port=6379
        fi
        if [[ -n "${REDIS_PASSWORD}" ]]; then
            REDISCLI_AUTH="${REDIS_PASSWORD}" redis-cli -h "${host}" -p "${port}" -n "${REDIS_DB}" "$@"
        else
            redis-cli -h "${host}" -p "${port}" -n "${REDIS_DB}" "$@"
        fi
        return
    fi
    if [[ -n "${REDIS_PASSWORD}" ]]; then
        kubectl -n "${NAMESPACE}" exec "${REDIS_POD}" -- \
            env REDISCLI_AUTH="${REDIS_PASSWORD}" redis-cli -n "${REDIS_DB}" "$@"
    else
        kubectl -n "${NAMESPACE}" exec "${REDIS_POD}" -- \
            redis-cli -n "${REDIS_DB}" "$@"
    fi
}

apply_redis_db() {
    if [[ -n "${SAVED_REDIS_DB}" ]]; then
        REDIS_DB="${SAVED_REDIS_DB}"
    elif [[ -z "${REDIS_DB}" ]]; then
        REDIS_DB=1
    fi
}

resolve_redis() {
    if [[ -n "${REDIS_URL:-}" ]]; then
        local parsed addr_b64 pass_b64 db_b64
        parsed="$(python3 - <<'PY'
import base64
import os
from urllib.parse import unquote, urlparse
parsed = urlparse(os.environ.get("REDIS_URL", ""))
host = parsed.hostname or ""
port = parsed.port or 6379
password = unquote(parsed.password or "")
db = (parsed.path or "").lstrip("/")
def emit(value):
    print(base64.b64encode(value.encode()).decode())
emit("%s:%s" % (host, port))
emit(password)
emit(db)
PY
)"
        mapfile -t fields <<<"${parsed}"
        addr_b64="${fields[0]:-}"
        pass_b64="${fields[1]:-}"
        db_b64="${fields[2]:-}"
        REDIS_ADDR="$(printf '%s' "${addr_b64}" | base64 -d)"
        REDIS_PASSWORD="$(printf '%s' "${pass_b64}" | base64 -d)"
        REDIS_DB="$(printf '%s' "${db_b64}" | base64 -d)"
    fi
    apply_redis_db
    if [[ -n "${REDIS_ADDR}" ]]; then
        command -v redis-cli >/dev/null 2>&1 || err "redis-cli is required when REDIS_ADDR is set"
        log "using Redis at ${REDIS_ADDR} db=${REDIS_DB}"
        return
    fi
    command -v kubectl >/dev/null 2>&1 || err "kubectl not found"
    if kubectl -n "${NAMESPACE}" get secret "${REDIS_SECRET}" >/dev/null 2>&1; then
        REDIS_PASSWORD="$(kubectl -n "${NAMESPACE}" get secret "${REDIS_SECRET}" -o jsonpath='{.data.password}' | base64 -d)"
        local addr
        addr="$(kubectl -n "${NAMESPACE}" get secret "${REDIS_SECRET}" -o jsonpath='{.data.addr}' | base64 -d || true)"
        log "read Redis credentials from secret ${NAMESPACE}/${REDIS_SECRET} (${addr:-no addr})"
    fi
    REDIS_POD="$(kubectl -n "${NAMESPACE}" get pods -l "${REDIS_POD_LABEL}" \
        --field-selector=status.phase=Running \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    [[ -n "${REDIS_POD}" ]] || err "no Running Redis pod (label ${REDIS_POD_LABEL}) in ${NAMESPACE}; set REDIS_ADDR"
    log "using redis-cli in pod ${NAMESPACE}/${REDIS_POD} db=${REDIS_DB}"
}

sandbox_uid() {
    local namespace="$1" name="$2" line uid deleting
    line="$(kubectl -n "${namespace}" get sandbox.agents.x-k8s.io "${name}" \
        -o jsonpath='{.metadata.uid}|{.metadata.deletionTimestamp}' 2>/dev/null || true)"
    uid="${line%%|*}"
    deleting="${line#*|}"
    if [[ -z "${uid}" ]]; then
        return 2
    fi
    if [[ -n "${deleting}" ]]; then
        return 3
    fi
    printf '%s' "${uid}"
}

policy_exists() {
    local namespace="$1" name="$2"
    kubectl -n "${namespace}" get sandboxpolicy.runtime.agent-sandbox.io "${name}" >/dev/null 2>&1
}

migrate_one() {
    local key="$1" json namespace name uid manifest
    if ! json="$(redis_cli --raw GET "${key}")"; then
        warn "GET ${key} failed"
        SKIPPED_INVALID=$((SKIPPED_INVALID + 1))
        return
    fi
    if [[ -z "${json}" ]]; then
        warn "empty value for ${key}"
        SKIPPED_INVALID=$((SKIPPED_INVALID + 1))
        return
    fi
    namespace="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("namespace") or "")' "${json}" 2>/dev/null || true)"
    name="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("sandbox_name") or "")' "${json}" 2>/dev/null || true)"
    if [[ -z "${namespace}" || -z "${name}" ]]; then
        warn "skip ${key}: missing namespace or sandbox_name"
        SKIPPED_INVALID=$((SKIPPED_INVALID + 1))
        return
    fi
    if policy_exists "${namespace}" "${name}"; then
        log "skip ${namespace}/${name}: SandboxPolicy already exists"
        SKIPPED_EXISTS=$((SKIPPED_EXISTS + 1))
        return
    fi
    local rc=0
    uid="$(sandbox_uid "${namespace}" "${name}")" || rc=$?
    if [[ "${rc}" -eq 2 ]]; then
        log "skip ${namespace}/${name}: Sandbox not found"
        SKIPPED_NO_SANDBOX=$((SKIPPED_NO_SANDBOX + 1))
        return
    fi
    if [[ "${rc}" -eq 3 ]]; then
        log "skip ${namespace}/${name}: Sandbox is deleting"
        SKIPPED_NO_SANDBOX=$((SKIPPED_NO_SANDBOX + 1))
        return
    fi
    if [[ "${rc}" -ne 0 || -z "${uid}" ]]; then
        warn "skip ${namespace}/${name}: failed to read Sandbox uid"
        FAILED=$((FAILED + 1))
        return
    fi
    if ! manifest="$(printf '%s' "${json}" | render_policy "${uid}")"; then
        warn "skip ${namespace}/${name}: record is not a usable policy"
        SKIPPED_INVALID=$((SKIPPED_INVALID + 1))
        return
    fi
    if [[ "${DRY_RUN}" == "true" ]]; then
        log "dry-run: would create SandboxPolicy ${namespace}/${name}"
        printf '%s\n' "${manifest}"
        CREATED=$((CREATED + 1))
        return
    fi
    if printf '%s' "${manifest}" | kubectl create -f - >/dev/null; then
        ok "created SandboxPolicy ${namespace}/${name}"
        CREATED=$((CREATED + 1))
        return
    fi
    if policy_exists "${namespace}" "${name}"; then
        log "skip ${namespace}/${name}: SandboxPolicy appeared during create"
        SKIPPED_EXISTS=$((SKIPPED_EXISTS + 1))
        return
    fi
    warn "failed to create SandboxPolicy ${namespace}/${name}"
    FAILED=$((FAILED + 1))
}

# Apply the SandboxPolicy CRD shipped next to this script. Idempotent.
# DRY_RUN still applies it: later existence checks need the type to be served.
ensure_crd() {
    local script_dir crd
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    crd="${script_dir}/../crds/runtime/sandboxpolicy-crd.yaml"
    [[ -f "${crd}" ]] || err "missing ${crd}"
    kubectl apply -f "${crd}"
    kubectl get crd sandboxpolicies.runtime.agent-sandbox.io >/dev/null 2>&1 \
        || err "CRD sandboxpolicies.runtime.agent-sandbox.io was not created"
    ok "SandboxPolicy CRD applied"
}

main() {
    command -v python3 >/dev/null 2>&1 || err "python3 not found"
    command -v kubectl >/dev/null 2>&1 || err "kubectl not found"
    ensure_crd
    resolve_redis
    redis_cli PING >/dev/null || err "Redis did not answer PING"

    local key
    while IFS= read -r key; do
        [[ -n "${key}" ]] || continue
        [[ "${key}" == session:* ]] || continue
        migrate_one "${key}"
    done < <(redis_cli --scan --pattern 'session:*')

    log "created=${CREATED} already_present=${SKIPPED_EXISTS} sandbox_gone=${SKIPPED_NO_SANDBOX} invalid=${SKIPPED_INVALID} failed=${FAILED}"
    if [[ "${FAILED}" -ne 0 ]]; then
        err "migration finished with ${FAILED} failure(s)"
    fi
    ok "migration finished"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
