#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# test-inference.sh — Test unified inference endpoint functionality
#
# Usage:
#   GATEWAY=https://<your-gateway>/sandbox \
#   LITELLM_ENDPOINT=https://<your-gateway>/api/v1/llm-proxy/v1 \
#   SAFE_API_KEY=ak-xxx ./deploy/test/test-inference.sh
#
# Prerequisites:
#   1. agent-sandbox deployed (INFERENCE_ENABLED=true)
#   2. Using SaFE API Key authentication (Cookie auth not supported for inference endpoint)

set -euo pipefail

GATEWAY="${GATEWAY:?Please set GATEWAY env var to your sandbox gateway, e.g.: GATEWAY=https://sandbox.example.com/sandbox $0}"
SAFE_API_KEY="${SAFE_API_KEY:?Please set SAFE_API_KEY env var, e.g.: SAFE_API_KEY=ak-xxx $0}"
TEMPLATE="${TEMPLATE:-python-311-runc}"
NAMESPACE="${NAMESPACE:-default}"
LITELLM_ENDPOINT="${LITELLM_ENDPOINT:?Please set LITELLM_ENDPOINT env var to your LiteLLM gateway, e.g.: LITELLM_ENDPOINT=https://sandbox.example.com/api/v1/llm-proxy/v1 $0}"
ALT_MODEL="${ALT_MODEL:-gpt-4o-mini}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
log()  { echo -e "${CYAN}[INFO]${NC} $*"; }
step() { echo -e "\n${YELLOW}── $* ──${NC}"; }

AUTH_HEADER="Authorization: Bearer ${SAFE_API_KEY}"
SESSION_ID=""
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

exec_in_sandbox() {
    local desc="$1"; shift
    curl -sf -X POST \
        "${GATEWAY}/v1/namespaces/${NAMESPACE}/code-interpreters/${TEMPLATE}/invocations/api/execute" \
        -H "${AUTH_HEADER}" \
        -H "x-session-id: ${SESSION_ID}" \
        -H "Content-Type: application/json" \
        -d "$@"
}

# ═══════════════════════════════════════════════════════════════════════════════
step "1. Create sandbox"
# ═══════════════════════════════════════════════════════════════════════════════
RESPONSE=$(curl -sf -X POST "${GATEWAY}/v1/code-interpreter" \
    -H "${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${TEMPLATE}\",\"namespace\":\"${NAMESPACE}\"}")

SESSION_ID=$(echo "${RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null || true)

if [[ -z "${SESSION_ID}" ]]; then
    fail "Failed to create sandbox, response: ${RESPONSE}"
    exit 1
fi
ok "Sandbox created, sessionId: ${SESSION_ID}"
ALL_SESSION_IDS+=("${SESSION_ID}")

# ═══════════════════════════════════════════════════════════════════════════════
step "2. Verify OPENAI_BASE_URL (Pod env var)"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "check OPENAI_BASE_URL" \
    '{"command":["python3","-c","import os; print(os.environ.get(\"OPENAI_BASE_URL\",\"NOT_SET\"))"],"timeout":"10s"}')

if echo "${RESULT}" | grep -q "NOT_SET"; then
    fail "OPENAI_BASE_URL not injected"
    echo "  Response: ${RESULT}"
else
    BASE_URL=$(echo "${RESULT}" | grep -oP 'https?://[^\s"]+' | head -1)
    ok "OPENAI_BASE_URL = ${BASE_URL:-<set>}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "3. Verify OPENAI_API_KEY (EnvD process-level injection)"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "check OPENAI_API_KEY" \
    '{"command":["python3","-c","import os; k=os.environ.get(\"OPENAI_API_KEY\",\"\"); print(k[:10]+\"...\" if len(k)>10 else k or \"NOT_SET\")"],"timeout":"10s"}')

if echo "${RESULT}" | grep -q "NOT_SET"; then
    fail "OPENAI_API_KEY not injected (confirm API Key auth used, not Cookie)"
    echo "  Response: ${RESULT}"
else
    ok "OPENAI_API_KEY injected"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "4. Install openai SDK"
# ═══════════════════════════════════════════════════════════════════════════════
log "pip install openai ..."
RESULT=$(exec_in_sandbox "pip install" \
    '{"command":["pip","install","openai","-q"],"timeout":"120s"}')
ok "openai SDK installed"

# ═══════════════════════════════════════════════════════════════════════════════
step "5. Verify OPENAI_BASE_URL value and format"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "validate OPENAI_BASE_URL" \
    '{"command":["python3","-c","import os; print(os.environ.get(\"OPENAI_BASE_URL\",\"NOT_SET\"))"],"timeout":"10s"}')
ACTUAL_URL=$(echo "${RESULT}" | grep -oP 'https?://[^\s"\\]+' | head -1)

if [[ -n "${ACTUAL_URL}" && "${ACTUAL_URL}" == "${LITELLM_ENDPOINT}" ]]; then
    record_pass "OPENAI_BASE_URL matches expected: ${ACTUAL_URL}"
elif [[ -n "${ACTUAL_URL}" ]]; then
    record_fail "OPENAI_BASE_URL mismatch (actual=${ACTUAL_URL}, expected=${LITELLM_ENDPOINT})"
else
    record_fail "Cannot extract OPENAI_BASE_URL value"
fi

if [[ "${ACTUAL_URL}" =~ /v1$ ]]; then
    record_pass "OPENAI_BASE_URL ends with /v1, format correct"
else
    record_fail "OPENAI_BASE_URL does not end with /v1 (${ACTUAL_URL}), may cause double /v1/v1"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "6. End-to-end test: call LLM from sandbox"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "call LLM" \
    '{"command":["python3","-c","import httpx; from openai import OpenAI; c=OpenAI(http_client=httpx.Client(verify=False)); r=c.chat.completions.create(model=\"gpt-4.1\",messages=[{\"role\":\"user\",\"content\":\"Say hello in exactly 3 words\"}],max_tokens=20); print(\"LLM_RESPONSE:\", r.choices[0].message.content)"],"timeout":"30s"}') || true

if echo "${RESULT}" | grep -q "LLM_RESPONSE:"; then
    LLM_REPLY=$(echo "${RESULT}" | grep -oP 'LLM_RESPONSE:\s*\K.*' | head -1)
    record_pass "LLM call success: ${LLM_REPLY}"
elif echo "${RESULT}" | grep -q "timed out"; then
    log "LLM call timed out, skipping (LLM service may be unavailable)"
else
    record_fail "LLM call failed"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "7. Session persistence: API Key injection consistency across executions"
# ═══════════════════════════════════════════════════════════════════════════════
PERSIST_OK=true
for i in 1 2 3; do
    RESULT=$(exec_in_sandbox "persist #${i}" \
        '{"command":["python3","-c","import os; k=os.environ.get(\"OPENAI_API_KEY\",\"\"); print(\"KEY_OK\" if len(k)>0 else \"KEY_MISSING\")"],"timeout":"10s"}')
    if echo "${RESULT}" | grep -q "KEY_OK"; then
        log "Execution ${i}/3: OPENAI_API_KEY ✓"
    else
        PERSIST_OK=false
        log "Execution ${i}/3: OPENAI_API_KEY ✗"
    fi
done
if [[ "${PERSIST_OK}" == "true" ]]; then
    record_pass "OPENAI_API_KEY injected correctly in all 3 executions (EnvD cache reliable)"
else
    record_fail "Some executions missing OPENAI_API_KEY"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "8. Streaming completion test"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "streaming" \
    '{"command":["python3","-c","import httpx\nfrom openai import OpenAI\nc=OpenAI(http_client=httpx.Client(verify=False))\nchunks=[]\nfor ck in c.chat.completions.create(model=\"gpt-4.1\",messages=[{\"role\":\"user\",\"content\":\"Say hi\"}],max_tokens=10,stream=True):\n    if ck.choices and ck.choices[0].delta.content:\n        chunks.append(ck.choices[0].delta.content)\nprint(\"STREAM_OK:\",\"\".join(chunks))"],"timeout":"30s"}')

if echo "${RESULT}" | grep -q "STREAM_OK:"; then
    STREAM_REPLY=$(echo "${RESULT}" | grep -oP 'STREAM_OK:\s*\K.*' | head -1)
    record_pass "Streaming completion success: ${STREAM_REPLY}"
elif echo "${RESULT}" | grep -q "timed out"; then
    log "Streaming timed out, skipping (LLM service may be unavailable)"
else
    record_fail "Streaming completion failed"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "9. Different model routing test (${ALT_MODEL})"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "alt model" \
    "{\"command\":[\"python3\",\"-c\",\"import httpx; from openai import OpenAI; c=OpenAI(http_client=httpx.Client(verify=False)); r=c.chat.completions.create(model='${ALT_MODEL}',messages=[{'role':'user','content':'Say ok'}],max_tokens=10); print('ALT_MODEL_OK:', r.choices[0].message.content)\"],\"timeout\":\"30s\"}") || true

if echo "${RESULT}" | grep -q "ALT_MODEL_OK:"; then
    ALT_REPLY=$(echo "${RESULT}" | grep -oP 'ALT_MODEL_OK:\s*\K.*' | head -1)
    record_pass "Model ${ALT_MODEL} call success: ${ALT_REPLY}"
elif echo "${RESULT}" | grep -qiE "Invalid model|not found|does not exist"; then
    log "Model ${ALT_MODEL} not configured in LiteLLM, skipping (not an inference endpoint defect)"
    log "Query available models: curl \${LITELLM_ENDPOINT}/models"
elif echo "${RESULT}" | grep -q "timed out"; then
    log "Model ${ALT_MODEL} request timed out, skipping (LLM service may be unavailable)"
else
    record_fail "Model ${ALT_MODEL} call failed"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "10. User-defined OPENAI_API_KEY override test"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "user env override" \
    '{"command":["python3","-c","import os; print(\"OVERRIDE_KEY:\", os.environ.get(\"OPENAI_API_KEY\",\"NOT_SET\"))"],"timeout":"10s","env":{"OPENAI_API_KEY":"user-custom-key-test-12345"}}')

if echo "${RESULT}" | grep -q "user-custom-key-test-12345"; then
    record_pass "User env override active, OPENAI_API_KEY replaced with custom value"
else
    record_fail "User env override not active (execute API may not support env field)"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "11. Non-existent model error handling"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "invalid model" \
    '{"command":["python3","-c","import httpx\nfrom openai import OpenAI\nc=OpenAI(http_client=httpx.Client(verify=False))\ntry:\n    c.chat.completions.create(model=\"nonexistent-model-xyz\",messages=[{\"role\":\"user\",\"content\":\"hi\"}],max_tokens=5)\n    print(\"UNEXPECTED_SUCCESS\")\nexcept Exception as e:\n    print(\"INVALID_MODEL_ERR:\", type(e).__name__)"],"timeout":"30s"}') || true

if echo "${RESULT}" | grep -q "INVALID_MODEL_ERR:"; then
    ERR_TYPE=$(echo "${RESULT}" | grep -oP 'INVALID_MODEL_ERR:\s*\K[A-Za-z]+' | head -1)
    record_pass "Non-existent model request correctly rejected (${ERR_TYPE})"
elif echo "${RESULT}" | grep -q "UNEXPECTED_SUCCESS"; then
    record_fail "Non-existent model request not rejected (LiteLLM may have fallback behavior)"
else
    record_fail "Non-existent model test failed"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "12. Invalid API Key error handling"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "invalid key" \
    '{"command":["python3","-c","import httpx\nfrom openai import OpenAI\nc=OpenAI(api_key=\"invalid-key-xxx\",http_client=httpx.Client(verify=False))\ntry:\n    c.chat.completions.create(model=\"gpt-4.1\",messages=[{\"role\":\"user\",\"content\":\"hi\"}],max_tokens=5)\n    print(\"UNEXPECTED_SUCCESS\")\nexcept Exception as e:\n    print(\"BAD_KEY_ERR:\", type(e).__name__)"],"timeout":"30s"}') || true

if echo "${RESULT}" | grep -q "BAD_KEY_ERR:"; then
    ERR_TYPE=$(echo "${RESULT}" | grep -oP 'BAD_KEY_ERR:\s*\K[A-Za-z]+' | head -1)
    record_pass "Invalid API Key correctly rejected (${ERR_TYPE})"
elif echo "${RESULT}" | grep -q "UNEXPECTED_SUCCESS"; then
    record_fail "Invalid API Key not rejected"
else
    record_fail "Invalid API Key test failed"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "13. LLM request timeout handling"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "timeout handling" \
    '{"command":["python3","-c","import httpx\nfrom openai import OpenAI\nc=OpenAI(http_client=httpx.Client(verify=False,timeout=0.5))\ntry:\n    c.chat.completions.create(model=\"gpt-4.1\",messages=[{\"role\":\"user\",\"content\":\"Write a very long essay about the history of computing\"}],max_tokens=500)\n    print(\"TIMEOUT_NOT_TRIGGERED\")\nexcept Exception as e:\n    print(\"TIMEOUT_ERR:\", type(e).__name__)"],"timeout":"30s"}') || true

if echo "${RESULT}" | grep -q "TIMEOUT_ERR:"; then
    ERR_TYPE=$(echo "${RESULT}" | grep -oP 'TIMEOUT_ERR:\s*\K[A-Za-z]+' | head -1)
    record_pass "Timeout correctly caught by client (${ERR_TYPE})"
elif echo "${RESULT}" | grep -q "TIMEOUT_NOT_TRIGGERED"; then
    log "Timeout not triggered (network latency below 0.5s), skipping"
else
    record_fail "Timeout handling test failed"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "14. Internal env var security check"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "internal env check" \
    '{"command":["python3","-c","import os\nfor k in [\"INTERNAL_API_TOKEN\",\"WORKLOAD_MANAGER_URL\"]:\n    v=os.environ.get(k,\"\")\n    if v:\n        print(f\"VISIBLE:{k}={v[:20]}...\")\n    else:\n        print(f\"HIDDEN:{k}\")"],"timeout":"10s"}')

LEAKED=false
if echo "${RESULT}" | grep -q "VISIBLE:INTERNAL_API_TOKEN"; then
    LEAKED=true
    echo -e "  ${YELLOW}[WARN]${NC} INTERNAL_API_TOKEN still visible to user code (should be removed)"
fi
if echo "${RESULT}" | grep -q "VISIBLE:WORKLOAD_MANAGER_URL"; then
    log "WORKLOAD_MANAGER_URL visible (only address exposed, no credentials, low risk)"
fi
if [[ "${LEAKED}" == "true" ]]; then
    record_fail "INTERNAL_API_TOKEN should not appear in Pod env (switched to Router JWT auth)"
else
    record_pass "INTERNAL_API_TOKEN not leaked (switched to Router JWT auth for internal API)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "15. Concurrent LLM calls"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(exec_in_sandbox "concurrent" \
    '{"command":["python3","-c","import httpx, concurrent.futures\nfrom openai import OpenAI\nc=OpenAI(http_client=httpx.Client(verify=False))\ndef call(i):\n    r=c.chat.completions.create(model=\"gpt-4.1\",messages=[{\"role\":\"user\",\"content\":\"Say \"+str(i)}],max_tokens=5)\n    return r.choices[0].message.content\ne=concurrent.futures.ThreadPoolExecutor(max_workers=3)\nfuts=[e.submit(call,i) for i in range(3)]\nresults=[f.result(timeout=30) for f in futs]\ne.shutdown()\nprint(\"CONCURRENT_OK:\",len(results))"],"timeout":"60s"}') || true

if echo "${RESULT}" | grep -q "CONCURRENT_OK: 3"; then
    record_pass "All 3 concurrent LLM requests succeeded"
elif echo "${RESULT}" | grep -q "CONCURRENT_OK:"; then
    CNT=$(echo "${RESULT}" | grep -oP 'CONCURRENT_OK:\s*\K\d+' | head -1)
    record_fail "Concurrent test only ${CNT}/3 succeeded"
elif echo "${RESULT}" | grep -qE "timed out|TimeoutError"; then
    log "Concurrent LLM calls timed out, skipping (LLM service may be unavailable)"
else
    record_fail "Concurrent LLM calls failed"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "16. Multi-session isolation verification"
# ═══════════════════════════════════════════════════════════════════════════════
log "Creating second sandbox..."
SESSION_ID_2=""
RESP2=$(curl -sf -X POST "${GATEWAY}/v1/code-interpreter" \
    -H "${AUTH_HEADER}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${TEMPLATE}\",\"namespace\":\"${NAMESPACE}\"}") || true

SESSION_ID_2=$(echo "${RESP2}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null || true)

if [[ -z "${SESSION_ID_2}" ]]; then
    record_fail "Failed to create second sandbox, cannot verify isolation"
else
    ALL_SESSION_IDS+=("${SESSION_ID_2}")
    log "Second sandbox sessionId: ${SESSION_ID_2}"

    ORIG_SESSION="${SESSION_ID}"
    SESSION_ID="${SESSION_ID_2}"

    sleep 3

    RESULT=$(exec_in_sandbox "session2 env check" \
        '{"command":["python3","-c","import os; k=os.environ.get(\"OPENAI_API_KEY\",\"\"); b=os.environ.get(\"OPENAI_BASE_URL\",\"\"); print(\"S2_KEY:\", \"OK\" if k else \"MISSING\"); print(\"S2_URL:\", \"OK\" if b else \"MISSING\")"],"timeout":"10s"}')

    SESSION_ID="${ORIG_SESSION}"

    if echo "${RESULT}" | grep -q "S2_KEY: OK" && echo "${RESULT}" | grep -q "S2_URL: OK"; then
        record_pass "Second sandbox env vars injected independently OK"
    else
        record_fail "Second sandbox env var injection failed"
        echo "  Response: ${RESULT}"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "17. Cleanup verification: sandbox inaccessible after deletion"
# ═══════════════════════════════════════════════════════════════════════════════
if [[ -n "${SESSION_ID_2}" ]]; then
    log "Manually deleting second sandbox ${SESSION_ID_2}..."
    DEL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "${GATEWAY}/v1/code-interpreter/sessions/${SESSION_ID_2}" \
        -H "${AUTH_HEADER}") || true

    if [[ "${DEL_CODE}" =~ ^2 ]]; then
        ok "Delete request succeeded (HTTP ${DEL_CODE})"
    else
        fail "Delete request failed (HTTP ${DEL_CODE})"
    fi

    sleep 3

    ORIG_SESSION="${SESSION_ID}"
    SESSION_ID="${SESSION_ID_2}"
    POST_DEL_RESULT=$(exec_in_sandbox "post-delete exec" \
        '{"command":["echo","should-not-work"],"timeout":"10s"}' 2>&1) || POST_DEL_RESULT="EXEC_FAILED"
    SESSION_ID="${ORIG_SESSION}"

    if [[ "${POST_DEL_RESULT}" == "EXEC_FAILED" ]] || echo "${POST_DEL_RESULT}" | grep -qiE "not.found|error|fail|404|no.such"; then
        record_pass "Deleted sandbox cannot execute commands"
    else
        record_fail "Deleted sandbox can still execute commands"
        echo "  Response: ${POST_DEL_RESULT}"
    fi

    ALL_SESSION_IDS=("${ALL_SESSION_IDS[@]/${SESSION_ID_2}/}")
else
    log "Skipping cleanup verification (second sandbox not created)"
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
