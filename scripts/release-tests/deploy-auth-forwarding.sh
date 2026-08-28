#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/repo/sandbox/deploy/scripts" "$tmp/repo/claw/deploy" "$tmp/repo/deploy" "$tmp/bin"
cp "$repo_root/deploy/deploy.sh" "$tmp/repo/deploy/deploy.sh"
cp "$repo_root/deploy/profile-loader.sh" "$tmp/repo/deploy/profile-loader.sh"

cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"current-context"* ]]; then echo release-test; fi
exit 0
EOF
chmod +x "$tmp/bin/kubectl"

cat >"$tmp/repo/sandbox/deploy/scripts/install.sh" <<'EOF'
#!/usr/bin/env bash
printf 'SAFE_API_URL=%s\n' "${SAFE_API_URL:-}" >"$CAPTURE"
printf 'ALLOW_INSECURE_NO_AUTH=%s\n' "${ALLOW_INSECURE_NO_AUTH:-}" >>"$CAPTURE"
printf 'REDIS_STORAGE_CLASS=%s\n' "${REDIS_STORAGE_CLASS:-}" >>"$CAPTURE"
printf 'EGRESS_ENABLED=%s\n' "${EGRESS_ENABLED:-}" >>"$CAPTURE"
printf 'EGRESS_EXTRA_BLOCKED_CIDRS=%s\n' "${EGRESS_EXTRA_BLOCKED_CIDRS:-}" >>"$CAPTURE"
printf 'DRY_RUN=%s\n' "${DRY_RUN:-}" >>"$CAPTURE"
EOF
chmod +x "$tmp/repo/sandbox/deploy/scripts/install.sh"

cat >"$tmp/repo/claw/deploy/deploy.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/repo/claw/deploy/deploy.sh"

common_env=(
  "PATH=$tmp/bin:$PATH"
  "STORAGE_CLASS=release-sc"
  "ANTHROPIC_BASE_URL=https://llm.example"
  "OPENAI_BASE_URL=https://llm.example"
  "LLM_API_STYLE=anthropic"
  "SANDBOX_EGRESS_ENABLED=false"
  "SANDBOX_EGRESS_EXTRA_BLOCKED_CIDRS=10.0.0.0/8,192.168.0.0/16"
)

capture="$tmp/safe.env"
env "${common_env[@]}" CAPTURE="$capture" SAFE_API_URL="https://safe.example" \
  bash "$tmp/repo/deploy/deploy.sh" --yes --skip-litellm --skip-sandbox-check >/dev/null
grep -qx 'SAFE_API_URL=https://safe.example' "$capture"
grep -qx 'ALLOW_INSECURE_NO_AUTH=' "$capture"
grep -qx 'REDIS_STORAGE_CLASS=release-sc' "$capture"
grep -qx 'EGRESS_ENABLED=false' "$capture"
grep -qx 'EGRESS_EXTRA_BLOCKED_CIDRS=10.0.0.0/8,192.168.0.0/16' "$capture"

cat >"$tmp/profile.env" <<'EOF'
SAFE_API_URL=https://profile-safe.example
STORAGE_CLASS=profile-sc
EOF
chmod 600 "$tmp/profile.env"
capture="$tmp/profile-capture.env"
env "${common_env[@]}" CAPTURE="$capture" \
  bash "$tmp/repo/deploy/deploy.sh" --config "$tmp/profile.env" \
  --yes --skip-litellm --skip-sandbox-check >/dev/null
grep -qx 'SAFE_API_URL=https://profile-safe.example' "$capture"
grep -qx 'REDIS_STORAGE_CLASS=release-sc' "$capture"
grep -qx 'DRY_RUN=' "$capture"

cat >"$tmp/unsafe-profile.env" <<'EOF'
SAFE_API_URL=https://profile-safe.example
DRY_RUN=true
REPO_ROOT=/tmp/not-the-repository
EOF
set +e
env "${common_env[@]}" CAPTURE="$tmp/unsafe-profile-capture.env" \
  bash "$tmp/repo/deploy/deploy.sh" --config "$tmp/unsafe-profile.env" \
  --yes --skip-litellm --skip-sandbox-check >/dev/null 2>&1
profile_control_rc=$?
set -e
if [[ "$profile_control_rc" -ne 2 ]]; then
  echo "deploy.sh accepted a command variable from the deployment profile" >&2
  exit 1
fi

set +e
env "${common_env[@]}" CAPTURE="$tmp/unreadable.env" \
  bash "$tmp/repo/deploy/deploy.sh" --config "$tmp/does-not-exist.env" \
  --yes --skip-litellm --skip-sandbox-check >/dev/null 2>&1
profile_rc=$?
set -e
if [[ "$profile_rc" -ne 2 ]]; then
  echo "deploy.sh did not propagate an unreadable profile error (rc=$profile_rc)" >&2
  exit 1
fi

capture="$tmp/insecure.env"
env "${common_env[@]}" CAPTURE="$capture" \
  bash "$tmp/repo/deploy/deploy.sh" --yes --skip-litellm --skip-sandbox-check --insecure-sandbox >/dev/null
grep -qx 'SAFE_API_URL=' "$capture"
grep -qx 'ALLOW_INSECURE_NO_AUTH=true' "$capture"

if env "${common_env[@]}" CAPTURE="$tmp/missing.env" \
  bash "$tmp/repo/deploy/deploy.sh" --yes --skip-litellm --skip-sandbox-check >/dev/null 2>&1; then
  echo "deploy.sh accepted a missing Sandbox authentication choice" >&2
  exit 1
fi

echo "deploy auth forwarding: ok"
