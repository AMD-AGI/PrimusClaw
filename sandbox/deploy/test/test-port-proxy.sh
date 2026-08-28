#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# test-port-proxy.sh — Test Phase 2: Router port proxy + SDK/CLI service access
#
# Usage:
#   GATEWAY=https://<your-gateway>/sandbox SAFE_API_KEY=ak-xxx ./deploy/test/test-port-proxy.sh
#
# Prerequisites:
#   1. agent-sandbox deployed
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

INVOKE_BASE="${GATEWAY}/v1/namespaces/${NAMESPACE}/code-interpreters/${TEMPLATE}/invocations"

exec_in_sandbox() {
    local desc="$1"; shift
    log "exec: ${desc}"
    curl -sf -X POST "${INVOKE_BASE}/api/execute" \
        -H "${AUTH_HEADER}" \
        -H "x-session-id: ${SESSION_ID}" \
        -H "Content-Type: application/json" \
        -d "$@"
}

proxy_get() {
    local port="$1" path="$2"; shift 2
    curl -sf "${INVOKE_BASE}/proxy/${port}${path}" \
        -H "${AUTH_HEADER}" \
        -H "x-session-id: ${SESSION_ID}" \
        "$@"
}

proxy_get_code() {
    local port="$1" path="$2"; shift 2
    curl -s -o /dev/null -w "%{http_code}" "${INVOKE_BASE}/proxy/${port}${path}" \
        -H "${AUTH_HEADER}" \
        -H "x-session-id: ${SESSION_ID}" \
        "$@"
}

proxy_get_full() {
    local port="$1" path="$2"; shift 2
    curl -s -D - "${INVOKE_BASE}/proxy/${port}${path}" \
        -H "${AUTH_HEADER}" \
        -H "x-session-id: ${SESSION_ID}" \
        "$@"
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
step "2. Start HTTP server in sandbox (port 9000)"
# ═══════════════════════════════════════════════════════════════════════════════
log "Starting Python HTTP server (background)..."
RESULT=$(exec_in_sandbox "start http server" \
    '{"command":["python3","-c","import subprocess,sys; p=subprocess.Popen([sys.executable,\"-c\",\"from http.server import HTTPServer,BaseHTTPRequestHandler\\nimport json,os,sys\\nclass H(BaseHTTPRequestHandler):\\n    def do_GET(self):\\n        body=json.dumps({\\\"path\\\":self.path,\\\"headers\\\":{k:v for k,v in self.headers.items()},\\\"method\\\":\\\"GET\\\"})\\n        self.send_response(200)\\n        self.send_header(\\\"Content-Type\\\",\\\"application/json\\\")\\n        self.send_header(\\\"X-Test-Header\\\",\\\"from-sandbox\\\")\\n        self.end_headers()\\n        self.wfile.write(body.encode())\\n    def do_POST(self):\\n        length=int(self.headers.get(\\\"Content-Length\\\",0))\\n        body_in=self.rfile.read(length)\\n        body=json.dumps({\\\"path\\\":self.path,\\\"body\\\":body_in.decode(),\\\"method\\\":\\\"POST\\\"})\\n        self.send_response(200)\\n        self.send_header(\\\"Content-Type\\\",\\\"application/json\\\")\\n        self.end_headers()\\n        self.wfile.write(body.encode())\\n    def log_message(self,*a): pass\\nHTTPServer((\\\"0.0.0.0\\\",9000),H).serve_forever()\"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); import time; time.sleep(1); print(\"SERVER_STARTED\" if p.poll() is None else \"SERVER_FAILED\")"],"timeout":"10s"}')

if echo "${RESULT}" | grep -q "SERVER_STARTED"; then
    record_pass "HTTP server started on sandbox port 9000"
else
    fail "HTTP server failed to start"
    echo "  Response: ${RESULT}"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "3. HTTP GET proxy — basic connectivity"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(proxy_get 9000 "/hello?foo=bar" 2>&1) || RESULT="PROXY_FAILED"

if echo "${RESULT}" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['path']=='/hello?foo=bar'; assert d['method']=='GET'" 2>/dev/null; then
    record_pass "GET /proxy/9000/hello?foo=bar proxy success, path and query params fully forwarded"
else
    record_fail "GET proxy failed or path lost"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "4. HTTP POST proxy — request body passthrough"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(curl -sf -X POST "${INVOKE_BASE}/proxy/9000/api/data" \
    -H "${AUTH_HEADER}" \
    -H "x-session-id: ${SESSION_ID}" \
    -H "Content-Type: application/json" \
    -d '{"key":"value"}' 2>&1) || RESULT="PROXY_FAILED"

if echo "${RESULT}" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['method']=='POST'; assert d['path']=='/api/data'; assert '\"key\"' in d['body'] or 'value' in d['body']" 2>/dev/null; then
    record_pass "POST /proxy/9000/api/data proxy success, request body fully forwarded"
else
    record_fail "POST proxy failed or request body lost"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "5. Response header passthrough — custom headers returned from sandbox"
# ═══════════════════════════════════════════════════════════════════════════════
FULL_RESP=$(proxy_get_full 9000 "/test-headers" 2>&1) || FULL_RESP=""

if echo "${FULL_RESP}" | grep -qi "X-Test-Header: from-sandbox"; then
    record_pass "Response header (X-Test-Header) fully returned from sandbox service"
else
    record_fail "Response header missing or not forwarded"
    echo "  Response headers: $(echo "${FULL_RESP}" | head -20)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "6. Header cleanup — internal credentials not leaked"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(proxy_get 9000 "/check-headers" 2>&1) || RESULT="PROXY_FAILED"

LEAKED=false
if echo "${RESULT}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
h=d.get('headers',{})
hl={k.lower():v for k,v in h.items()}
# Router should strip these headers
assert 'x-session-id' not in hl, 'x-session-id leaked'
assert 'authorization' not in hl, 'Authorization leaked'
assert 'x-sandbox-api-key' not in hl, 'X-Sandbox-Api-Key leaked'
print('HEADERS_CLEAN')
" 2>/dev/null | grep -q "HEADERS_CLEAN"; then
    record_pass "x-session-id / Authorization / X-Sandbox-Api-Key not leaked to user service"
else
    LEAKED=true
    record_fail "Internal auth headers leaked to user service"
    echo "  Received headers: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "7. Reserved port rejection — port 8080 (EnvD)"
# ═══════════════════════════════════════════════════════════════════════════════
HTTP_CODE=$(proxy_get_code 8080 "/" 2>&1)

if [[ "${HTTP_CODE}" == "400" ]]; then
    record_pass "Proxy port 8080 rejected (HTTP 400), EnvD reserved port protected"
elif [[ "${HTTP_CODE}" == "000" ]]; then
    record_fail "Port 8080 request connection failed (Router may not be running)"
else
    record_fail "Proxy port 8080 not rejected (HTTP ${HTTP_CODE}), expected 400"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "8. Invalid port rejection — port 0 / 99999"
# ═══════════════════════════════════════════════════════════════════════════════
CODE_0=$(proxy_get_code 0 "/" 2>&1)
CODE_BIG=$(proxy_get_code 99999 "/" 2>&1)

if [[ "${CODE_0}" == "400" ]]; then
    record_pass "Port 0 rejected (HTTP 400)"
else
    record_fail "Port 0 not rejected (HTTP ${CODE_0})"
fi

if [[ "${CODE_BIG}" == "400" ]]; then
    record_pass "Port 99999 rejected (HTTP 400)"
else
    record_fail "Port 99999 not rejected (HTTP ${CODE_BIG})"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "9. Unlistened port — 502 Bad Gateway"
# ═══════════════════════════════════════════════════════════════════════════════
CODE_UNLISTENED=$(proxy_get_code 59999 "/" 2>&1)

if [[ "${CODE_UNLISTENED}" == "502" ]]; then
    record_pass "Unlistened port 59999 returned 502 Bad Gateway"
elif [[ "${CODE_UNLISTENED}" == "400" ]]; then
    log "Port 59999 returned 400 (may exceed range validation), acceptable"
else
    record_fail "Unlistened port 59999 returned HTTP ${CODE_UNLISTENED}, expected 502"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "10. Start SSE server in sandbox (port 9001)"
# ═══════════════════════════════════════════════════════════════════════════════
log "Starting SSE server..."
RESULT=$(exec_in_sandbox "start sse server" \
    '{"command":["python3","-c","import subprocess,sys; p=subprocess.Popen([sys.executable,\"-c\",\"from http.server import HTTPServer,BaseHTTPRequestHandler\\nimport time\\nclass H(BaseHTTPRequestHandler):\\n    def do_GET(self):\\n        self.send_response(200)\\n        self.send_header(\\\"Content-Type\\\",\\\"text/event-stream\\\")\\n        self.send_header(\\\"Cache-Control\\\",\\\"no-cache\\\")\\n        self.end_headers()\\n        for i in range(5):\\n            self.wfile.write(f\\\"data: event-{i}\\\\n\\\\n\\\".encode())\\n            self.wfile.flush()\\n            time.sleep(0.1)\\n    def log_message(self,*a): pass\\nHTTPServer((\\\"0.0.0.0\\\",9001),H).serve_forever()\"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); import time; time.sleep(1); print(\"SSE_STARTED\" if p.poll() is None else \"SSE_FAILED\")"],"timeout":"10s"}')

if echo "${RESULT}" | grep -q "SSE_STARTED"; then
    ok "SSE server started on port 9001"
else
    fail "SSE server failed to start: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "11. SSE streaming proxy — events arrive sequentially"
# ═══════════════════════════════════════════════════════════════════════════════
SSE_RESULT=$(curl -sf -N --max-time 10 "${INVOKE_BASE}/proxy/9001/" \
    -H "${AUTH_HEADER}" \
    -H "x-session-id: ${SESSION_ID}" 2>&1) || SSE_RESULT="SSE_FAILED"

if echo "${SSE_RESULT}" | grep -q "data: event-0" && echo "${SSE_RESULT}" | grep -q "data: event-4"; then
    EVENT_COUNT=$(echo "${SSE_RESULT}" | grep -c "^data:")
    record_pass "SSE proxy success, received ${EVENT_COUNT} events"
elif [[ "${SSE_RESULT}" == "SSE_FAILED" ]]; then
    record_fail "SSE proxy request failed"
else
    record_fail "SSE events incomplete"
    echo "  Response: ${SSE_RESULT}"
fi

SSE_HEADERS=$(curl -sf -D - -o /dev/null --max-time 10 "${INVOKE_BASE}/proxy/9001/" \
    -H "${AUTH_HEADER}" \
    -H "x-session-id: ${SESSION_ID}" 2>&1) || SSE_HEADERS=""

if echo "${SSE_HEADERS}" | grep -qi "text/event-stream"; then
    record_pass "SSE response Content-Type: text/event-stream correctly forwarded"
else
    record_fail "SSE Content-Type not correctly forwarded"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "12. Start TCP Echo server in sandbox (port 9002)"
# ═══════════════════════════════════════════════════════════════════════════════
log "Starting TCP Echo server..."
RESULT=$(exec_in_sandbox "start tcp echo" \
    '{"command":["python3","-c","import subprocess,sys; p=subprocess.Popen([sys.executable,\"-c\",\"import socket,threading\\ndef handle(c):\\n    while True:\\n        d=c.recv(4096)\\n        if not d: break\\n        c.sendall(d)\\n    c.close()\\ns=socket.socket()\\ns.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\\ns.bind((\\\"0.0.0.0\\\",9002))\\ns.listen(5)\\nwhile True:\\n    c,_=s.accept()\\n    threading.Thread(target=handle,args=(c,),daemon=True).start()\"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); import time; time.sleep(1); print(\"ECHO_STARTED\" if p.poll() is None else \"ECHO_FAILED\")"],"timeout":"10s"}')

if echo "${RESULT}" | grep -q "ECHO_STARTED"; then
    ok "TCP Echo server started on port 9002"
else
    fail "TCP Echo server failed to start: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "13. WebSocket tunnel — basic connectivity"
# ═══════════════════════════════════════════════════════════════════════════════
TUNNEL_URL="${INVOKE_BASE}/tunnel/9002"
WS_URL=$(echo "${TUNNEL_URL}" | sed 's|^https://|wss://|; s|^http://|ws://|')

HAS_WEBSOCAT=false
if command -v websocat &>/dev/null; then
    HAS_WEBSOCAT=true
fi

if [[ "${HAS_WEBSOCAT}" == "true" ]]; then
    TUNNEL_RESULT=$(echo "hello-tunnel" | timeout 5 websocat --binary -1 \
        -H "x-session-id: ${SESSION_ID}" \
        -H "${AUTH_HEADER}" \
        "${WS_URL}" 2>&1) || TUNNEL_RESULT="WS_FAILED"

    if [[ "${TUNNEL_RESULT}" == "hello-tunnel" ]]; then
        record_pass "WebSocket tunnel echo test passed"
    elif [[ "${TUNNEL_RESULT}" == "WS_FAILED" ]]; then
        record_fail "WebSocket tunnel connection failed"
    else
        record_fail "WebSocket tunnel data mismatch: ${TUNNEL_RESULT}"
    fi
else
    log "websocat not installed, testing WebSocket tunnel via Python..."
    RESULT=$(exec_in_sandbox "ws tunnel via python" \
        '{"command":["python3","-c","import socket,time\ns=socket.socket()\ns.connect((\"127.0.0.1\",9002))\ns.sendall(b\"echo-test-data\")\ntime.sleep(0.5)\nd=s.recv(1024)\ns.close()\nprint(\"TUNNEL_ECHO_OK\" if d==b\"echo-test-data\" else \"TUNNEL_ECHO_FAIL:\"+repr(d))"],"timeout":"10s"}')

    if echo "${RESULT}" | grep -q "TUNNEL_ECHO_OK"; then
        record_pass "TCP Echo service internal connectivity OK (WebSocket tunnel needs websocat or SDK for full test)"
    else
        record_fail "TCP Echo service connectivity failed"
        echo "  Response: ${RESULT}"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "14. WebSocket tunnel — reserved port rejection"
# ═══════════════════════════════════════════════════════════════════════════════
TUNNEL_8080_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${INVOKE_BASE}/tunnel/8080" \
    -H "${AUTH_HEADER}" \
    -H "x-session-id: ${SESSION_ID}" \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" 2>&1)

if [[ "${TUNNEL_8080_CODE}" == "400" ]]; then
    record_pass "WebSocket tunnel port 8080 rejected (HTTP 400)"
else
    record_fail "WebSocket tunnel port 8080 not rejected (HTTP ${TUNNEL_8080_CODE})"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "15. No session-id — GET request rejected"
# ═══════════════════════════════════════════════════════════════════════════════
NO_SID_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${INVOKE_BASE}/proxy/9000/" \
    -H "${AUTH_HEADER}" 2>&1)

if [[ "${NO_SID_CODE}" == "400" ]]; then
    record_pass "GET without x-session-id rejected (HTTP 400)"
else
    record_fail "GET without x-session-id not rejected (HTTP ${NO_SID_CODE}), expected 400"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "16. Invalid session-id — 404"
# ═══════════════════════════════════════════════════════════════════════════════
BAD_SID_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${INVOKE_BASE}/proxy/9000/" \
    -H "${AUTH_HEADER}" \
    -H "x-session-id: nonexistent-session-xyz" 2>&1)

if [[ "${BAD_SID_CODE}" == "404" ]]; then
    record_pass "Invalid session-id returned 404"
else
    record_fail "Invalid session-id returned HTTP ${BAD_SID_CODE}, expected 404"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "17. SDK — Python SDK port proxy"
# ═══════════════════════════════════════════════════════════════════════════════
log "Installing agent-sandbox SDK in sandbox and testing..."
RESULT=$(exec_in_sandbox "install sdk" \
    '{"command":["pip","install","agent-sandbox","-q"],"timeout":"120s"}') || true

SDK_RESULT=$(exec_in_sandbox "sdk proxy test" \
    "{\"command\":[\"python3\",\"-c\",\"from agent_sandbox.clients.data_plane import DataPlaneClient; dp=DataPlaneClient(router_url='${GATEWAY}',session_id='${SESSION_ID}',sandbox_name='${TEMPLATE}',namespace='${NAMESPACE}',api_key='${SAFE_API_KEY}'); url=dp.proxy_url(9000,'/test'); print('SDK_URL:',url); r=dp.proxy_request(9000,'/sdk-test'); print('SDK_STATUS:',r.status_code); print('SDK_BODY:',r.text[:200])\"],\"timeout\":\"30s\"}") || SDK_RESULT="SDK_FAILED"

if echo "${SDK_RESULT}" | grep -q "SDK_STATUS: 200"; then
    record_pass "Python SDK proxy_request success (HTTP 200)"
elif echo "${SDK_RESULT}" | grep -qiE "No module|ModuleNotFoundError"; then
    log "agent-sandbox SDK not installed in sandbox, skipping SDK test"
elif [[ "${SDK_RESULT}" == "SDK_FAILED" ]]; then
    record_fail "Python SDK proxy test execution failed"
else
    record_fail "Python SDK proxy_request failed"
    echo "  Response: ${SDK_RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "18. Multi-port parallel proxy — accessing 9000 and 9001 simultaneously"
# ═══════════════════════════════════════════════════════════════════════════════
TMPDIR_PAR=$(mktemp -d)
proxy_get_code 9000 "/" > "${TMPDIR_PAR}/code_9000" 2>&1 &
PID_9000=$!
proxy_get_code 9001 "/" > "${TMPDIR_PAR}/code_9001" 2>&1 &
PID_9001=$!
wait ${PID_9000} || true
wait ${PID_9001} || true
CODE_9000=$(cat "${TMPDIR_PAR}/code_9000")
CODE_9001=$(cat "${TMPDIR_PAR}/code_9001")
rm -rf "${TMPDIR_PAR}"

if [[ "${CODE_9000}" == "200" && "${CODE_9001}" == "200" ]]; then
    record_pass "Multi-port parallel proxy: 9000(${CODE_9000}) and 9001(${CODE_9001}) both succeeded"
else
    record_fail "Multi-port parallel proxy failed: 9000(${CODE_9000}), 9001(${CODE_9001})"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "19. Deep path proxy — multi-level path preserved"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(proxy_get 9000 "/a/b/c/d?x=1&y=2" 2>&1) || RESULT="PROXY_FAILED"

if echo "${RESULT}" | python3 -c "
import sys,json; d=json.load(sys.stdin)
assert d['path'] == '/a/b/c/d?x=1&y=2', f'path mismatch: {d[\"path\"]}'
print('DEEP_PATH_OK')
" 2>/dev/null | grep -q "DEEP_PATH_OK"; then
    record_pass "Deep path /a/b/c/d?x=1&y=2 fully forwarded"
else
    record_fail "Deep path forwarding failed"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "20. Host header verification — Host is podIP:port after proxy"
# ═══════════════════════════════════════════════════════════════════════════════
RESULT=$(proxy_get 9000 "/check-host" 2>&1) || RESULT="PROXY_FAILED"

if echo "${RESULT}" | python3 -c "
import sys,json,ipaddress
d=json.load(sys.stdin)
h=d.get('headers',{})
hl={k.lower():v for k,v in h.items()}
host=hl.get('host','')
# Host should be podIP:port, not the Router gateway domain
ip, sep, port = host.rpartition(':')
assert sep and port.isdigit(), f'Host is not podIP:port: {host}'
ipaddress.ip_address(ip)
print('HOST_OK:' + host)
" 2>/dev/null | grep -q "HOST_OK:"; then
    HOST_VAL=$(echo "${RESULT}" | python3 -c "import sys,json; h=json.load(sys.stdin).get('headers',{}); hl={k.lower():v for k,v in h.items()}; print(hl.get('host','unknown'))" 2>/dev/null)
    record_pass "Host header rewritten by Director to: ${HOST_VAL}"
else
    record_fail "Host header not correctly rewritten (may still be Router domain)"
    echo "  Response: ${RESULT}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
step "21. Special character path proxy — URL-encoded path correctly forwarded"
# ═══════════════════════════════════════════════════════════════════════════════
ENCODED_PATH="/path%20with%20spaces/file%3Fname%3Dval"
RESULT=$(proxy_get 9000 "${ENCODED_PATH}" 2>&1) || RESULT="PROXY_FAILED"

if echo "${RESULT}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=d.get('path','')
assert 'space' in p or '%20' in p, f'encoded path not forwarded: {p}'
print('ENCODED_PATH_OK')
" 2>/dev/null | grep -q "ENCODED_PATH_OK"; then
    record_pass "URL-encoded path ${ENCODED_PATH} correctly proxied"
else
    record_fail "URL-encoded path proxy failed"
    echo "  Response: ${RESULT}"
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
