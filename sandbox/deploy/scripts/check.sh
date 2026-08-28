#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# check.sh — Read-only health verification for the agent-sandbox install.
#
# Verifies that an agent-sandbox deployment matches the reference shape running
# on the the cluster: 6 CRDs Established, 1 Helm release, controlplane +
# Redis pods Ready, three Services with endpoints, two Secrets with the right
# keys, and live /healthz probes returning 200.
#
# This script does NOT modify any resource. Run it after install.sh on a new
# cluster (or any time, as a smoke test) to confirm everything is wired.
#
# Usage:
#   ./check.sh                        # default ns=agent-sandbox-system, release=agent-sandbox
#   NAMESPACE=foo RELEASE=bar ./check.sh
#   SKIP_HEALTHZ=true ./check.sh      # skip in-cluster /healthz curl probes
#
# Exit codes:
#   0 — all PASS
#   1 — at least one FAIL
#   2 — only WARNs (e.g. no CodeInterpreter CR yet)

set -uo pipefail

NAMESPACE="${NAMESPACE:-agent-sandbox-system}"
RELEASE="${RELEASE:-agent-sandbox}"
SKIP_HEALTHZ="${SKIP_HEALTHZ:-false}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
PASS_CNT=0; FAIL_CNT=0; WARN_CNT=0

# Output helpers — keep each line aligned for easy scanning
pass()  { printf "  ${GREEN}[PASS]${NC} %-55s %s\n" "$1" "${2:-}"; PASS_CNT=$((PASS_CNT+1)); }
fail()  { printf "  ${RED}[FAIL]${NC} %-55s %s\n" "$1" "${2:-}"; FAIL_CNT=$((FAIL_CNT+1)); }
warn_() { printf "  ${YELLOW}[WARN]${NC} %-55s %s\n" "$1" "${2:-}"; WARN_CNT=$((WARN_CNT+1)); }
section() { printf "\n${CYAN}── %s ──${NC}\n" "$1"; }

# Run kubectl with namespace, suppressing not-found noise — caller decides on emptiness
kget() { kubectl -n "${NAMESPACE}" "$@" 2>/dev/null; }

# ── Preflight ─────────────────────────────────────────────────────────────────
section "Preflight"
command -v kubectl >/dev/null 2>&1 \
    && pass "kubectl on PATH" "$(kubectl version --client -o yaml 2>/dev/null | grep gitVersion | head -1 | awk '{print $2}')" \
    || { fail "kubectl missing"; exit 1; }

CTX="$(kubectl config current-context 2>/dev/null || echo '<unknown>')"
pass "cluster context" "${CTX}"

kubectl cluster-info >/dev/null 2>&1 \
    && pass "cluster reachable" \
    || { fail "kubectl cannot reach cluster"; exit 1; }

# ── 1. CRDs (6 expected, Established) ─────────────────────────────────────────
section "1. CRDs"
for c in sandboxes.agents.x-k8s.io \
         sandboxclaims.extensions.agents.x-k8s.io \
         sandboxtemplates.extensions.agents.x-k8s.io \
         sandboxwarmpools.extensions.agents.x-k8s.io \
         codeinterpreters.runtime.agent-sandbox.io \
         clustersandboxpolicies.runtime.agent-sandbox.io; do
    cond="$(kubectl get crd "$c" -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null)"
    if [[ "${cond}" == "True" ]]; then
        pass "CRD ${c}"
    else
        fail "CRD ${c}" "missing or not Established"
    fi
done

# ── 2. Namespace ──────────────────────────────────────────────────────────────
section "2. Namespace"
NS_PHASE="$(kubectl get ns "${NAMESPACE}" -o jsonpath='{.status.phase}' 2>/dev/null)"
[[ "${NS_PHASE}" == "Active" ]] \
    && pass "ns ${NAMESPACE} Active" \
    || fail "ns ${NAMESPACE}" "phase=${NS_PHASE:-<not found>}"

# ── 3. Helm release ───────────────────────────────────────────────────────────
section "3. Helm release"
# Detect helm via release Secret rather than depending on helm CLI being installed
HELM_REV="$(kget get secret -l "owner=helm,name=${RELEASE}" --sort-by=.metadata.creationTimestamp \
              -o jsonpath='{.items[-1:].metadata.labels.version}' 2>/dev/null)"
HELM_STATUS="$(kget get secret -l "owner=helm,name=${RELEASE}" --sort-by=.metadata.creationTimestamp \
                  -o jsonpath='{.items[-1:].metadata.labels.status}' 2>/dev/null)"
if [[ -n "${HELM_REV}" ]]; then
    if [[ "${HELM_STATUS}" == "deployed" ]]; then
        pass "helm release ${RELEASE}" "revision=${HELM_REV} status=deployed"
    else
        fail "helm release ${RELEASE}" "revision=${HELM_REV} status=${HELM_STATUS} (expected deployed)"
    fi
else
    fail "helm release ${RELEASE}" "no helm release Secret found in ns; was this installed via 'kubectl apply' instead of helm?"
fi

# ── 4. Workloads (Deployment + StatefulSet) ───────────────────────────────────
section "4. Workloads"
CP_READY="$(kget get deploy agent-sandbox-controlplane -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
CP_IMAGE="$(kget get deploy agent-sandbox-controlplane -o jsonpath='{.spec.template.spec.containers[0].image}')"
CP_MANAGED_BY="$(kget get deploy agent-sandbox-controlplane -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')"
if [[ "${CP_READY}" == "1/1" ]]; then
    pass "deploy/agent-sandbox-controlplane" "ready=${CP_READY} image=${CP_IMAGE}"
elif [[ -z "${CP_READY}" || "${CP_READY}" == "/" ]]; then
    fail "deploy/agent-sandbox-controlplane" "not found"
else
    fail "deploy/agent-sandbox-controlplane" "ready=${CP_READY} image=${CP_IMAGE}"
fi
[[ "${CP_MANAGED_BY}" == "Helm" ]] \
    || warn_ "deploy not managed-by Helm" "managed-by=${CP_MANAGED_BY:-<none>} — likely flat-yaml install, will diverge from chart"

REDIS_READY="$(kget get sts redis -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
REDIS_IMAGE="$(kget get sts redis -o jsonpath='{.spec.template.spec.containers[0].image}')"
if [[ "${REDIS_READY}" == "1/1" ]]; then
    pass "sts/redis" "ready=${REDIS_READY} image=${REDIS_IMAGE}"
elif [[ -z "${REDIS_READY}" || "${REDIS_READY}" == "/" ]]; then
    fail "sts/redis" "not found — Helm chart did not render redis (check redis.deploy=true was set)"
else
    fail "sts/redis" "ready=${REDIS_READY}"
fi

# ── 5. Services with endpoints ────────────────────────────────────────────────
section "5. Services + Endpoints"
for svc_port in workloadmanager:8080 agent-sandbox-router:8080 redis:6379; do
    svc="${svc_port%%:*}"
    port="${svc_port##*:}"
    cluster_ip="$(kget get svc "${svc}" -o jsonpath='{.spec.clusterIP}')"
    eps_ips="$(kget get endpoints "${svc}" -o jsonpath='{.subsets[*].addresses[*].ip}' | tr ' ' ',')"
    if [[ -z "${cluster_ip}" ]]; then
        fail "svc/${svc}:${port}" "not found"
    elif [[ -z "${eps_ips}" ]]; then
        fail "svc/${svc}:${port}" "clusterIP=${cluster_ip} but endpoints empty (pod not Ready?)"
    else
        pass "svc/${svc}:${port}" "clusterIP=${cluster_ip} endpoints=${eps_ips}"
    fi
done

# ── 6. PVC for redis ──────────────────────────────────────────────────────────
section "6. PVC"
PVC_STATUS="$(kget get pvc data-redis-0 -o jsonpath='{.status.phase}')"
PVC_SC="$(kget get pvc data-redis-0 -o jsonpath='{.spec.storageClassName}')"
PVC_SIZE="$(kget get pvc data-redis-0 -o jsonpath='{.status.capacity.storage}')"
if [[ "${PVC_STATUS}" == "Bound" ]]; then
    pass "pvc/data-redis-0" "Bound size=${PVC_SIZE} sc=${PVC_SC}"
elif [[ -z "${PVC_STATUS}" ]]; then
    fail "pvc/data-redis-0" "not found"
else
    fail "pvc/data-redis-0" "status=${PVC_STATUS} sc=${PVC_SC} (kubectl describe pvc data-redis-0 -n ${NAMESPACE})"
fi

# ── 7. Secrets (keys + structure) ─────────────────────────────────────────────
section "7. Secrets"
# agent-sandbox-redis must carry addr + password
REDIS_KEYS="$(kget get secret agent-sandbox-redis -o jsonpath='{.data}' \
    | python3 -c 'import sys,json; d=json.loads(sys.stdin.read() or "{}"); print(",".join(sorted(d.keys())))' 2>/dev/null)"
if [[ -z "${REDIS_KEYS}" ]]; then
    fail "secret/agent-sandbox-redis" "not found"
elif [[ "${REDIS_KEYS}" == *"password"* && "${REDIS_KEYS}" == *"addr"* ]]; then
    pass "secret/agent-sandbox-redis" "keys=${REDIS_KEYS}"
else
    fail "secret/agent-sandbox-redis" "missing required keys (got: ${REDIS_KEYS}, want: addr,password)"
fi

# envd-router-identity must carry private.pem + public.pem
ENVD_KEYS="$(kget get secret envd-router-identity -o jsonpath='{.data}' \
    | python3 -c 'import sys,json; d=json.loads(sys.stdin.read() or "{}"); print(",".join(sorted(d.keys())))' 2>/dev/null)"
if [[ -z "${ENVD_KEYS}" ]]; then
    fail "secret/envd-router-identity" "not found — controlplane will be degraded"
elif [[ "${ENVD_KEYS}" == *"private.pem"* && "${ENVD_KEYS}" == *"public.pem"* ]]; then
    pass "secret/envd-router-identity" "keys=${ENVD_KEYS}"
else
    fail "secret/envd-router-identity" "missing required keys (got: ${ENVD_KEYS}, want: private.pem,public.pem)"
fi

# ── 8. RBAC + NetworkPolicy (presence check) ──────────────────────────────────
section "8. RBAC + NetworkPolicy"
kget get sa agent-sandbox-controlplane >/dev/null \
    && pass "sa/agent-sandbox-controlplane" \
    || fail "sa/agent-sandbox-controlplane" "not found"

# Read all cluster roles into a variable first to avoid SIGPIPE under pipefail.
# Chart names the ClusterRole "agent-sandbox-controlplane-<release>" (see helm/templates/controlplane.yaml).
ALL_CR="$(kubectl get clusterrole -o name 2>/dev/null || true)"
if [[ "${ALL_CR}" == *"agent-sandbox-controlplane"* ]]; then
    MATCHED_CR="$(echo "${ALL_CR}" | grep "agent-sandbox-controlplane" | tr '\n' ',' | sed 's/,$//')"
    pass "clusterrole agent-sandbox-controlplane*" "${MATCHED_CR}"
else
    fail "clusterrole agent-sandbox-controlplane*" "missing — controlplane lacks permission to manage Sandbox CRs"
fi

kget get networkpolicy agent-sandbox-controlplane >/dev/null \
    && pass "networkpolicy/agent-sandbox-controlplane" \
    || warn_ "networkpolicy/agent-sandbox-controlplane" "missing — not fatal, but ingress is unrestricted"

# ── 9. Pod runtime (env injection + restart count) ────────────────────────────
section "9. Pod runtime"
CP_POD="$(kget get pod -l app=agent-sandbox-controlplane -o jsonpath='{.items[0].metadata.name}')"
if [[ -n "${CP_POD}" ]]; then
    RESTARTS="$(kget get pod "${CP_POD}" -o jsonpath='{.status.containerStatuses[0].restartCount}')"
    if [[ "${RESTARTS}" -le 5 ]] 2>/dev/null; then
        pass "controlplane pod restarts" "pod=${CP_POD} restarts=${RESTARTS}"
    else
        warn_ "controlplane pod restarts" "pod=${CP_POD} restarts=${RESTARTS} (high — investigate logs)"
    fi
    # Verify REDIS_ADDR/REDIS_PASSWORD env are wired from the Secret
    if kget get pod "${CP_POD}" -o yaml | grep -q 'secretKeyRef:' \
       && kget get pod "${CP_POD}" -o yaml | grep -q 'name: agent-sandbox-redis'; then
        pass "controlplane reads REDIS_* from Secret"
    else
        fail "controlplane env" "REDIS_ADDR/PASSWORD not bound to Secret/agent-sandbox-redis"
    fi
else
    fail "controlplane pod" "no pod matches app=agent-sandbox-controlplane"
fi

# ── 10. In-cluster /healthz probe (optional) ──────────────────────────────────
section "10. In-cluster /healthz"
if [[ "${SKIP_HEALTHZ}" == "true" ]]; then
    warn_ "/healthz probe" "skipped (SKIP_HEALTHZ=true)"
else
    SMOKE="$(kubectl -n "${NAMESPACE}" run smoke-$$ --rm -i --restart=Never \
        --image=curlimages/curl --timeout=20s -- \
        curl -sf -m 5 http://workloadmanager:8080/healthz 2>&1 \
        | tail -1)"
    if [[ "${SMOKE}" == *"ok"* || "${SMOKE}" == *"OK"* || "${SMOKE}" =~ ^\{ ]]; then
        pass "workloadmanager:8080/healthz" "${SMOKE}"
    else
        warn_ "workloadmanager:8080/healthz" "unexpected response: ${SMOKE}"
    fi
fi

# ── 11. SaFE integration hint (informational) ─────────────────────────────────
section "11. SaFE integration (informational)"
if [[ -n "${SAFE_API_URL:-}" ]]; then
    pass "SaFE API configured" "${SAFE_API_URL}"
else
    warn_ "SaFE API" "SAFE_API_URL is unset — sandbox will run standalone"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════════"
printf "  ${GREEN}PASS${NC}=%-4s ${RED}FAIL${NC}=%-4s ${YELLOW}WARN${NC}=%-4s   ns=%s release=%s\n" \
    "${PASS_CNT}" "${FAIL_CNT}" "${WARN_CNT}" "${NAMESPACE}" "${RELEASE}"
echo "════════════════════════════════════════════════════════════════════"

if [[ "${FAIL_CNT}" -gt 0 ]]; then
    echo -e "Verdict: ${RED}FAIL${NC} — sandbox install is broken; see failures above."
    echo -e "${YELLOW}Reminder:${NC} if you just ran install.sh, pods may still be starting — wait a few minutes and re-run check.sh; if it keeps failing, inspect: kubectl -n ${NAMESPACE} get pods && kubectl -n ${NAMESPACE} get events --sort-by=.lastTimestamp | tail -20"
    exit 1
elif [[ "${WARN_CNT}" -gt 0 ]]; then
    echo -e "Verdict: ${YELLOW}OK with warnings${NC} — core is healthy; review WARNs."
    exit 2
else
    echo -e "Verdict: ${GREEN}HEALTHY${NC} — install matches the reference shape."
    exit 0
fi
