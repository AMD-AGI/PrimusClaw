#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# E2E smoke test for Brain idle reclaim via GET /api/jobs.
# Requires: SAFE_API_KEY, AUTH_INTERNAL_TOKEN (optional), kubectl access.
#
# Usage (from a host with cluster network + SaFE API). The deployment-specific
# values are required rather than defaulted: a default pointing at one cluster
# is wrong everywhere else, and silently so.
#   SAFE_API_KEY=ak-xxx \
#   SAFE_API_URL=https://safe.example.com \
#   SANDBOX_NAMESPACE=your-namespace \
#   SANDBOX_IMAGE=registry.example.com/org/claw:tag \
#   ./deploy/test/test-idle-reclaim-e2e.sh
#
# Optional:
#   AUTH_INTERNAL_TOKEN=...
#   JOB_SLEEP_SEC=25
#   QUIESCE_WAIT_SEC=120

set -euo pipefail

SAFE_API_KEY="${SAFE_API_KEY:?set SAFE_API_KEY}"
AUTH_INTERNAL_TOKEN="${AUTH_INTERNAL_TOKEN:-}"
SAFE_API_URL="${SAFE_API_URL:?set SAFE_API_URL, e.g. https://safe.example.com}"
SANDBOX_NAMESPACE="${SANDBOX_NAMESPACE:?set SANDBOX_NAMESPACE}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:?set SANDBOX_IMAGE, e.g. registry.example.com/org/claw:tag}"
JOB_SLEEP_SEC="${JOB_SLEEP_SEC:-25}"
QUIESCE_WAIT_SEC="${QUIESCE_WAIT_SEC:-120}"
ROUTER_URL="${ROUTER_URL:-http://agent-sandbox-router.agent-sandbox-system.svc.cluster.local:8080}"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }

WORKLOAD_ID=""
cleanup() {
  if [[ -n "${WORKLOAD_ID}" ]]; then
    log "Deleting test workload ${WORKLOAD_ID}"
    curl -sf -X DELETE "${SAFE_API_URL}/api/v1/workloads/${WORKLOAD_ID}" \
      -H "Authorization: Bearer ${SAFE_API_KEY}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

auth_headers() {
  echo -H "Authorization: Bearer ${SAFE_API_KEY}"
  if [[ -n "${AUTH_INTERNAL_TOKEN}" ]]; then
    echo -H "X-Internal-Token: ${AUTH_INTERNAL_TOKEN}"
  fi
}

log "Creating sandbox workload in ${SANDBOX_NAMESPACE}..."
CREATE_RESP=$(curl -sf -X POST "${SAFE_API_URL}/api/v1/workloads" \
  -H "Authorization: Bearer ${SAFE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"displayName\": \"idle-reclaim-e2e-$(date +%s)\",
    \"groupVersionKind\": {\"kind\": \"Sandbox\", \"version\": \"v1\"},
    \"priority\": 2,
    \"ttlSecondsAfterFinished\": 10,
    \"workspace\": \"${SANDBOX_NAMESPACE}\",
    \"labels\": {\"test\": \"idle-reclaim-e2e\"},
    \"images\": [\"${SANDBOX_IMAGE}\"],
    \"resources\": [{\"replica\": 1, \"cpu\": \"4\", \"memory\": \"16Gi\", \"sharedMemory\": \"8Gi\", \"ephemeralStorage\": \"100Gi\"}],
    \"timeout\": 3600
  }")
WORKLOAD_ID=$(echo "${CREATE_RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workloadId',''))")
[[ -n "${WORKLOAD_ID}" ]] || fail "workload create failed: ${CREATE_RESP}"
ok "workload created: ${WORKLOAD_ID}"

log "Waiting for Running..."
for i in $(seq 1 90); do
  PHASE=$(curl -sf "${SAFE_API_URL}/api/v1/workloads/${WORKLOAD_ID}" \
    -H "Authorization: Bearer ${SAFE_API_KEY}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('phase',''))")
  [[ "${PHASE}" == "Running" ]] && break
  sleep 5
done
[[ "${PHASE}" == "Running" ]] || fail "workload not Running (phase=${PHASE})"
ok "workload Running"

INJECTOR=$(kubectl get pod -n "${SANDBOX_NAMESPACE}" -l "runtime.agent-sandbox.io/sandbox-name=${WORKLOAD_ID}" \
  -o jsonpath='{.items[0].spec.initContainers[?(@.name=="envd-injector")].image}' 2>/dev/null || true)
log "envd-injector image: ${INJECTOR:-unknown}"
if [[ "${INJECTOR}" != *"feat-sandbox-user-job-reclaim"* ]]; then
  fail "pod still uses old envd-injector; update amd-sandbox-template first"
fi

BASE="${ROUTER_URL}/v1/namespaces/${SANDBOX_NAMESPACE}/code-interpreters/${WORKLOAD_ID}/invocations"
HDR_AUTH=(-H "Authorization: Bearer ${SAFE_API_KEY}" -H "x-session-id: ${WORKLOAD_ID}")
[[ -n "${AUTH_INTERNAL_TOKEN}" ]] && HDR_AUTH+=(-H "X-Internal-Token: ${AUTH_INTERNAL_TOKEN}")

get_jobs() {
  curl -sf "${BASE}/api/jobs" "${HDR_AUTH[@]}"
}

log "GET /api/jobs (idle)..."
IDLE_JOBS=$(get_jobs) || fail "GET /api/jobs failed"
IDLE_COUNT=$(echo "${IDLE_JOBS}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_process_count',-1))")
[[ "${IDLE_COUNT}" == "0" ]] || fail "expected user_process_count=0 idle, got: ${IDLE_JOBS}"
ok "idle jobs roster: user_process_count=0"

log "POST /api/execute sleep ${JOB_SLEEP_SEC}..."
curl -sf -X POST "${BASE}/api/execute" "${HDR_AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"command\":[\"sh\",\"-c\",\"echo E2E_START; sleep ${JOB_SLEEP_SEC}; echo E2E_DONE\"],\"timeout\":\"300s\"}" \
  >/tmp/e2e-exec.json &
EXEC_PID=$!
sleep 5

log "GET /api/jobs (during execute)..."
RUN_JOBS=$(get_jobs) || fail "jobs probe during execute failed"
RUN_COUNT=$(echo "${RUN_JOBS}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_process_count',0))")
[[ "${RUN_COUNT}" -ge 1 ]] || fail "expected user_process_count>=1 during execute, got: ${RUN_JOBS}"
ok "running jobs roster: user_process_count=${RUN_COUNT}"

wait "${EXEC_PID}"
EXEC_OUT=$(cat /tmp/e2e-exec.json)
echo "${EXEC_OUT}" | grep -q E2E_DONE || fail "execute output missing E2E_DONE: ${EXEC_OUT}"
ok "execute completed with expected output"

log "GET /api/jobs (after execute)..."
sleep 2
AFTER_JOBS=$(get_jobs) || fail "jobs probe after execute failed"
AFTER_COUNT=$(echo "${AFTER_JOBS}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_process_count',-1))")
[[ "${AFTER_COUNT}" == "0" ]] || fail "expected user_process_count=0 after execute, got: ${AFTER_JOBS}"
ok "post-execute jobs roster: user_process_count=0"

log "Brain quiesce check (workload-only sandbox; expect no idle_reclaim without Claw session)..."
log "For full 15min reclaim, attach a Claw session and watch: kubectl logs -n primus-claw deploy/primus-claw-brain -c brain | grep idle_reclaim"
log "SANDBOX_KEEPALIVE_IDLE_DEADLINE_SEC=900 on brain (15min quiesce window)"

echo ""
ok "E2E jobs API + execute path verified for workload ${WORKLOAD_ID}"
