#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"get sc -o jsonpath="*) printf 'fast\nslow\n' ;;
  *"get deploy agent-sandbox-controlplane"*)
    [[ "${MOCK_READY:-false}" == "true" ]] && printf 'Helm|agent-sandbox|1|1' || exit 1
    ;;
  *"get statefulset redis"*)
    [[ "${MOCK_READY:-false}" == "true" ]] && printf '1|1' || exit 1
    ;;
  *"get secret agent-sandbox-redis"*)
    [[ "${MOCK_READY:-false}" == "true" || -f "${MOCK_HELM_APPLIED:-/nonexistent}" ]] || exit 1
    ;;
  *"get secret envd-router-identity"*) exit 1 ;;
  *"get ns "*) exit 1 ;;
  *"create secret generic envd-router-identity"*)
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: envd-router-identity\n'
    ;;
  *"label --local -f -"*)
    input="$(cat)"
    printf '%s\n' "$input"
    ;;
  *"apply -f -"*) cat >/dev/null ;;
  *"run smoke-"*) echo ok ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/kubectl"

cat >"$tmp/bin/openssl" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "version" ]]; then echo "OpenSSL mock"; exit 0; fi
if [[ "${1:-}" == "rand" ]]; then
  echo "0123456789abcdefghijklmnopqrstuvwxyz"
  exit 0
fi
if [[ "${1:-}" == "genrsa" ]]; then
  out=""
  for ((i=1; i<=$#; i++)); do
    [[ "${!i}" == "-out" ]] && { j=$((i+1)); out="${!j}"; }
  done
  printf '%s\n' '-----BEGIN RSA PRIVATE KEY-----' 'mock' '-----END RSA PRIVATE KEY-----' >"$out"
  exit 0
fi
if [[ "${1:-}" == "rsa" ]]; then
  out=""
  for ((i=1; i<=$#; i++)); do
    [[ "${!i}" == "-out" ]] && { j=$((i+1)); out="${!j}"; }
  done
  printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'mock' '-----END PUBLIC KEY-----' >"$out"
  exit 0
fi
exit 1
EOF
chmod +x "$tmp/bin/openssl"

cat >"$tmp/bin/helm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$HELM_CAPTURE"
touch "$MOCK_HELM_APPLIED"
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "--values" ]]; then
    j=$((i+1))
    cp "${!j}" "$HELM_VALUES_CAPTURE"
  fi
done
exit 0
EOF
chmod +x "$tmp/bin/helm"

cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/bin/curl"

capture="$tmp/helm.args"
values_capture="$tmp/helm-values.json"
output="$tmp/install.log"

env PATH="$tmp/bin:$PATH" \
  MOCK_READY=true \
  AUTO_INSTALL_HELM=false \
  NAMESPACE=release-test \
  bash "$repo_root/sandbox/deploy/scripts/install.sh" >"$output"
grep -q 'fully ready.*skipping' "$output"
[[ ! -e "$capture" ]] || {
  echo "ready installer path unexpectedly invoked Helm" >&2
  exit 1
}

if ! env PATH="$tmp/bin:$PATH" \
  HELM_CAPTURE="$capture" \
  HELM_VALUES_CAPTURE="$values_capture" \
  MOCK_HELM_APPLIED="$tmp/helm.applied" \
  SAFE_API_URL="https://safe.example" \
  FORCE_SANDBOX=true \
  AUTO_INSTALL_HELM=false \
  NAMESPACE=release-test \
  bash "$repo_root/sandbox/deploy/scripts/install.sh" >"$output" 2>&1; then
  command cat "$output" >&2
  exit 1
fi

grep -q -- '--set redis.storage.storageClassName=fast' "$capture"
grep -q -- '--set router.config.safeApiUrl=https://safe.example' "$capture"
python3 - "$values_capture" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    values = json.load(f)
assert values["redis"]["password"] == "0123456789abcdefghijklmnopqrstuv"
assert values["egress"]["enabled"] is True
PY
if grep -q '════════.*redis.password\|════════.*storageClassName' "$capture"; then
  echo "section formatting leaked into a Helm value" >&2
  exit 1
fi

if ! env PATH="$tmp/bin:$PATH" \
  HELM_CAPTURE="$capture" \
  HELM_VALUES_CAPTURE="$values_capture" \
  MOCK_HELM_APPLIED="$tmp/helm.applied" \
  SAFE_API_URL="https://safe.example" \
  REDIS_PASSWORD='pa,ss\word={x}' \
  FORCE_SANDBOX=true \
  AUTO_INSTALL_HELM=false \
  NAMESPACE=release-test \
  bash "$repo_root/sandbox/deploy/scripts/install.sh" >"$output" 2>&1; then
  command cat "$output" >&2
  exit 1
fi
python3 - "$values_capture" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    values = json.load(f)
assert values["redis"]["password"] == r"pa,ss\word={x}"
PY

echo "installer behavior: ok"
