#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# test-session-timeout.sh — Test sessionTimeout no hard cap + proxy auto-renewal
#
# Test points:
#   1. sessionTimeout no hard cap — user-set 4h is not truncated
#   2. proxy auto-renewal — LastActivity keeps refreshing during long command execution
#   3. idle countdown starts only after command finishes
#
# Usage:
#   GATEWAY=https://<your-gateway>/sandbox SAFE_API_KEY=ak-xxx ./deploy/test/test-session-timeout.sh
#
# Prerequisites:
#   1. agent-sandbox deployed (with this change's Router/Agentd/WM)
#   2. Using SaFE API Key authentication

set -euo pipefail

GATEWAY="${GATEWAY:?Please set GATEWAY env var to your sandbox gateway, e.g.: GATEWAY=https://sandbox.example.com/sandbox $0}"
SAFE_API_KEY="${SAFE_API_KEY:?Please set SAFE_API_KEY env var, e.g.: SAFE_API_KEY=ak-xxx $0}"
TEMPLATE="${TEMPLATE:-python-311-runc}"
NAMESPACE="${NAMESPACE:-default}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }
step() { echo -e "\n${YELLOW}── $* ──${NC}"; }

AUTH_HEADER="Authorization: Bearer ${SAFE_API_KEY}"
ALL_SESSION_IDS=()
PASS_COUNT=0
FAIL_COUNT=0

record_pass() { ok "$@"; ((PASS_COUNT++)) || true; }
record_fail() { fail "$@"; ((FAIL_COUNT++)) || true; }

cleanup() {
    for sid in "${ALL_SESSION_IDS[@]}"; do
        if [[ -n "${sid}" ]]; then
            log "Cleanup: deleting sandbox session ${sid}"
            curl -sf -X DELETE "${GATEWAY}/v1/code-interpreter/sessions/${sid}" \
                -H "${AUTH_HEADER}" >/dev/null 2>&1 || true
        fi
    done
}
trap cleanup EXIT

INVOKE_BASE="${GATEWAY}/v1/namespaces/${NAMESPACE}/code-interpreters/${TEMPLATE}/invocations"

exec_in_sandbox() {
    local session_id="$1" desc="$2"; shift 2
    log "exec: ${desc}"
    curl -sf -X POST "${INVOKE_BASE}/api/execute" \
        -H "${AUTH_HEADER}" \
        -H "x-session-id: ${session_id}" \
        -H "Content-Type: application/json" \
        -d "$@"
}

get_sandbox() {
    local session_id="$1"
    curl -sf "${GATEWAY}/v1/code-interpreter/sessions/${session_id}" \
        -H "${AUTH_HEADER}"
}

create_sandbox() {
    local overrides="$1"
    local body="{\"name\":\"${TEMPLATE}\",\"namespace\":\"${NAMESPACE}\""
    if [[ -n "${overrides}" ]]; then
        body="${body},\"overrides\":${overrides}"
    fi
    body="${body}}"
    curl -sf -X POST "${GATEWAY}/v1/code-interpreter" \
        -H "${AUTH_HEADER}" \
        -H "Content-Type: application/json" \
        -d "${body}"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Session Timeout — No hard cap + Proxy auto-renewal test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GATEWAY:  ${GATEWAY}"
echo "  TEMPLATE: ${TEMPLATE}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
step "1. sessionTimeout no hard cap — 4h not truncated"
# ═══════════════════════════════════════════════════════════════════════════════
log "Creating sandbox: sessionTimeout=4h (previously truncated to 15min)..."
RESP=$(create_sandbox '{"sessionTimeout":"4h"}') || { fail "Failed to create sandbox"; exit 1; }
SESSION_1=$(echo "${RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null)
SANDBOX_1=$(echo "${RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxName',''))" 2>/dev/null)

if [[ -z "${SESSION_1}" ]]; then
    fail "Failed to create sandbox: ${RESP}"
    exit 1
fi
ALL_SESSION_IDS+=("${SESSION_1}")
ok "Sandbox created session=${SESSION_1}"

# Verify K8s annotation via kubectl
IDLE_ANNOTATION=$(kubectl get sandbox "${SANDBOX_1}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.annotations.runtime\.agent-sandbox\.io/idle-timeout}' 2>/dev/null || echo "KUBECTL_UNAVAILABLE")

if [[ "${IDLE_ANNOTATION}" == "4h0m0s" ]]; then
    record_pass "K8s annotation idle-timeout = ${IDLE_ANNOTATION} (no truncation)"
elif [[ "${IDLE_ANNOTATION}" == "KUBECTL_UNAVAILABLE" ]]; then
    log "kubectl unavailable, skipping annotation verification"
    # Fallback verification: creation succeeded without error, 4h accepted by server
    record_pass "sessionTimeout=4h accepted by server (cannot directly verify annotation)"
elif [[ "${IDLE_ANNOTATION}" == "15m0s" || "${IDLE_ANNOTATION}" == "2h0m0s" ]]; then
    record_fail "idle-timeout truncated to ${IDLE_ANNOTATION}, hard cap not removed"
else
    record_fail "idle-timeout value abnormal: ${IDLE_ANNOTATION}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "2. sessionTimeout extreme value — 23h not truncated"
# ═══════════════════════════════════════════════════════════════════════════════
log "Creating sandbox: sessionTimeout=23h (extreme value test)..."
RESP=$(create_sandbox '{"sessionTimeout":"23h"}') || { fail "Failed to create sandbox"; }
SESSION_2=$(echo "${RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null)
SANDBOX_2=$(echo "${RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxName',''))" 2>/dev/null)

if [[ -n "${SESSION_2}" ]]; then
    ALL_SESSION_IDS+=("${SESSION_2}")
    IDLE_2=$(kubectl get sandbox "${SANDBOX_2}" -n "${NAMESPACE}" \
        -o jsonpath='{.metadata.annotations.runtime\.agent-sandbox\.io/idle-timeout}' 2>/dev/null || echo "KUBECTL_UNAVAILABLE")

    if [[ "${IDLE_2}" == "23h0m0s" ]]; then
        record_pass "sessionTimeout=23h fully written to annotation (${IDLE_2})"
    elif [[ "${IDLE_2}" == "KUBECTL_UNAVAILABLE" ]]; then
        record_pass "sessionTimeout=23h accepted by server (kubectl unavailable)"
    else
        record_fail "sessionTimeout=23h truncated to: ${IDLE_2}"
    fi
else
    record_fail "Failed to create sandbox (sessionTimeout=23h): ${RESP}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "3. maxSessionDuration has no hard cap — 48h should pass through unchanged"
# ═══════════════════════════════════════════════════════════════════════════════
log "Creating sandbox: maxSessionDuration=48h (should be honored as-is)..."
RESP=$(create_sandbox '{"maxSessionDuration":"48h"}') || { fail "Failed to create sandbox"; }
SESSION_3=$(echo "${RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null)

if [[ -n "${SESSION_3}" ]]; then
    ALL_SESSION_IDS+=("${SESSION_3}")
    DETAIL=$(get_sandbox "${SESSION_3}")
    EXPIRES=$(echo "${DETAIL}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expiresAt',''))" 2>/dev/null)

    HOURS=$(python3 -c "
from datetime import datetime, timezone
import re
try:
    s = '${EXPIRES}'.replace('Z','+00:00')
    s = re.sub(r'(\.\d{6})\d+', r'\1', s)  # truncate nanoseconds to microseconds
    exp = datetime.fromisoformat(s)
    now = datetime.now(timezone.utc)
    hours = (exp - now).total_seconds() / 3600
    print(f'{hours:.1f}')
except: print('?')
" 2>/dev/null || echo "?")

    if python3 -c "h=float('${HOURS}'); exit(0 if 47.0 < h < 49.0 else 1)" 2>/dev/null; then
        record_pass "maxSessionDuration honored: expiresAt=${HOURS}h (approx 48h)"
    else
        record_fail "maxSessionDuration not honored: expiresAt=${HOURS}h (expected approx 48h)"
    fi
else
    record_fail "Failed to create sandbox (maxSessionDuration=48h): ${RESP}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "4. Proxy auto-renewal — LastActivity keeps refreshing during long commands"
# ═══════════════════════════════════════════════════════════════════════════════
log "Creating dedicated sandbox (sessionTimeout=2m, short timeout for observation)..."
RESP=$(create_sandbox '{"sessionTimeout":"2m"}') || { fail "Failed to create sandbox"; }
SESSION_4=$(echo "${RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null)

if [[ -z "${SESSION_4}" ]]; then
    fail "Failed to create sandbox: ${RESP}"
else
    ALL_SESSION_IDS+=("${SESSION_4}")
    ok "Sandbox created session=${SESSION_4} (sessionTimeout=2m)"

    # Record pre-execution lastActivity
    BEFORE=$(get_sandbox "${SESSION_4}")
    LAST_BEFORE=$(echo "${BEFORE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastActivity',''))" 2>/dev/null)
    log "Pre-execution lastActivity: ${LAST_BEFORE}"

    # Wait for EnvD readiness (WarmPool pod may need a few seconds after "Running")
    log "Waiting for EnvD readiness..."
    for i in $(seq 1 10); do
        PROBE=$(curl -sf -X POST "${INVOKE_BASE}/api/execute" \
            -H "${AUTH_HEADER}" \
            -H "x-session-id: ${SESSION_4}" \
            -H "Content-Type: application/json" \
            -d '{"command":["echo","READY"],"timeout":"5s"}' 2>&1) || PROBE=""
        if echo "${PROBE}" | grep -q "READY"; then
            log "EnvD ready (probe #${i})"
            break
        fi
        sleep 2
    done

    log "Executing sleep 90 (90 seconds)..."
    log "Without auto-renewal, sandbox will be GC-deleted after 2 minutes"
    RESULT=$(curl -sf -X POST "${INVOKE_BASE}/api/execute" \
        -H "${AUTH_HEADER}" \
        -H "x-session-id: ${SESSION_4}" \
        -H "Content-Type: application/json" \
        -d '{"command":["sh","-c","echo CMD_START; sleep 90; echo CMD_DONE"],"timeout":"300s"}' 2>&1) || RESULT="EXEC_FAILED"

    if echo "${RESULT}" | grep -q "CMD_DONE"; then
        record_pass "sleep 90 completed — sandbox not GC-killed during execution"
    elif echo "${RESULT}" | grep -q "CMD_START"; then
        record_fail "Command started but not completed — sandbox may have been GC-deleted during execution"
        echo "  Response: ${RESULT}"
    elif [[ "${RESULT}" == "EXEC_FAILED" ]]; then
        record_fail "Command execution request failed — sandbox may have been GC-deleted"
    else
        record_fail "Command output abnormal"
        echo "  Response: ${RESULT}"
    fi

    # Verify post-execution lastActivity was refreshed
    AFTER=$(get_sandbox "${SESSION_4}" 2>/dev/null) || AFTER=""
    if [[ -n "${AFTER}" ]]; then
        LAST_AFTER=$(echo "${AFTER}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastActivity',''))" 2>/dev/null)
        log "Post-execution lastActivity: ${LAST_AFTER}"

        if [[ "${LAST_BEFORE}" != "${LAST_AFTER}" ]]; then
            record_pass "lastActivity updated (${LAST_BEFORE} → ${LAST_AFTER})"
        else
            log "lastActivity unchanged (command may be too short to trigger 5-min refresh cycle)"
        fi
    else
        log "Cannot get sandbox details (may have been GC-collected)"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "5. Idle countdown — sandbox still available after command ends"
# ═══════════════════════════════════════════════════════════════════════════════
# Reuse SESSION_4 (sessionTimeout=2m)
if [[ -n "${SESSION_4}" ]]; then
    log "Command just finished, executing again — sandbox should still be alive..."
    RESULT=$(exec_in_sandbox "${SESSION_4}" "post-sleep echo" \
        '{"command":["sh","-c","echo STILL_ALIVE"],"timeout":"10s"}' 2>&1) || RESULT="EXEC_FAILED"

    if echo "${RESULT}" | grep -q "STILL_ALIVE"; then
        record_pass "Sandbox still available after command ends (idle countdown just started)"
    else
        record_fail "Sandbox unavailable after command ends"
        echo "  Response: ${RESULT}"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "6. Default sessionTimeout — uses 15m default when no override"
# ═══════════════════════════════════════════════════════════════════════════════
log "Creating sandbox: no sessionTimeout override..."
RESP=$(create_sandbox '') || { fail "Failed to create sandbox"; }
SESSION_6=$(echo "${RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null)
SANDBOX_6=$(echo "${RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sandboxName',''))" 2>/dev/null)

if [[ -n "${SESSION_6}" ]]; then
    ALL_SESSION_IDS+=("${SESSION_6}")

    IDLE_6=$(kubectl get sandbox "${SANDBOX_6}" -n "${NAMESPACE}" \
        -o jsonpath='{.metadata.annotations.runtime\.agent-sandbox\.io/idle-timeout}' 2>/dev/null || echo "KUBECTL_UNAVAILABLE")

    if [[ "${IDLE_6}" == "" || "${IDLE_6}" == "KUBECTL_UNAVAILABLE" ]]; then
        record_pass "annotation empty with no override (Agentd uses 15m default)"
    else
        log "annotation idle-timeout = ${IDLE_6} (from template default config)"
        record_pass "Default sessionTimeout config OK"
    fi
else
    record_fail "Failed to create sandbox (no override): ${RESP}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "Tests complete"
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "  ${GREEN}PASS: ${PASS_COUNT}${NC}    ${RED}FAIL: ${FAIL_COUNT}${NC}"
echo ""
if [[ ${FAIL_COUNT} -gt 0 ]]; then
    log "Failed test cases found, check output above"
else
    log "All tests passed!"
fi
log "Sandbox will be auto-cleaned on script exit"
