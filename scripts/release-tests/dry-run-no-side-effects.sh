#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
namespace="claw-dry-run-$$"
values_file="$repo_root/claw/deploy/values.${namespace}.env"
cleanup() {
  rm -rf "$tmp"
  rm -f "$values_file"
}
trap cleanup EXIT

mkdir -p "$tmp/bin" "$tmp/home"
cat >"$tmp/bin/helm" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "status" ]]; then exit 1; fi
exit 0
EOF
cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "get" && "${2:-}" == "sc" ]]; then exit 0; fi
echo "unexpected mutating kubectl call during dry-run: $*" >&2
exit 97
EOF
chmod +x "$tmp/bin/helm" "$tmp/bin/kubectl"

HOME="$tmp/home" \
PATH="$tmp/bin:$PATH" \
NAMESPACE="$namespace" \
DOMAIN="dry-run.example" \
STORAGE_CLASS="release-test-sc" \
TAG="release-test" \
bash "$repo_root/claw/deploy/deploy.sh" \
  --dry-run --skip-pgo --skip-pg --skip-lifecycle --skip-shared-assets \
  >"$tmp/output.log"

[[ ! -e "$tmp/home/.nats-claw-creds.env" ]] || {
  echo "dry-run wrote persistent NATS credentials" >&2
  exit 1
}
[[ ! -e "$values_file" ]] || {
  echo "dry-run wrote a persistent deployment values file" >&2
  exit 1
}
if compgen -G "/tmp/claw-dry-run-values.${namespace}.*.env" >/dev/null; then
  echo "dry-run leaked an ephemeral deployment values file" >&2
  exit 1
fi
rg -q '\[dry-run\] helm upgrade --install' "$tmp/output.log"
echo "dry-run side effects: ok"
