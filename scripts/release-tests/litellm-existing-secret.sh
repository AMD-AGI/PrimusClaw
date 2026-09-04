#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# secrets.existingSecret exists so a deployment can keep the master key and the
# database URL out of Helm's release history. The chart honoured it -- it
# rendered no Secret -- while the wrapper went on passing both values with
# --set, so they landed in the release values and in every stored revision
# regardless. These three cases cover the two ways the flag arrives and the
# path that legitimately still passes credentials.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
deploy_script="$repo_root/deploy/litellm/deploy.sh"
real_helm="$(command -v helm || true)"
[ -n "$real_helm" ] || { echo "error: helm is required for this check" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# Passes `helm template` through so the chart is really rendered, and records
# the arguments of everything else -- the upgrade being what matters.
cat >"$tmp/bin/helm" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "template" ]]; then exec "$REAL_HELM" "$@"; fi
printf '%s\n' "$@" >"$HELM_CAPTURE"
EOF
cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"config current-context"*) echo release-test ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/helm" "$tmp/bin/kubectl"

capture="$tmp/helm.args"
output="$tmp/deploy.log"
run() {
  if ! env "PATH=$tmp/bin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
    LITELLM_INSTALL_INGRESS=false DRY_RUN=true "$@" \
    bash "$deploy_script" >"$output" 2>&1; then
    command cat "$output" >&2
    exit 1
  fi
}
# An argument is on its own line in the capture, so match whole lines.
has_arg() { grep -qxF -- "$1" "$capture"; }
refute()  {
  if grep -qF -- "$1" "$capture"; then
    echo "$2" >&2
    exit 1
  fi
}

# 1. secrets.existingSecret set in the values file -- the case where
#    LITELLM_EXISTING_SECRET is empty and only the chart knows.
values="$tmp/values.yaml"
cat >"$values" <<'EOF'
secrets:
  existingSecret: release-file-credentials
  masterKey: stale-master-in-values
  databaseUrl: postgresql://stale@example.invalid/litellm
EOF
run LITELLM_VALUES_FILE="$values"
has_arg 'secrets.masterKey='
has_arg 'secrets.databaseUrl='
refute 'stale-master-in-values' \
  "a stale master key in the values file was passed to Helm anyway"
refute 'stale@example.invalid' \
  "a stale database URL in the values file was passed to Helm anyway"

# 2. The same flag through the environment.
run LITELLM_EXISTING_SECRET=release-env-credentials \
  LITELLM_MASTER_KEY=ignored-master \
  LITELLM_DATABASE_URL=postgresql://ignored@example.invalid/litellm
has_arg 'secrets.existingSecret=release-env-credentials'
has_arg 'secrets.masterKey='
has_arg 'secrets.databaseUrl='
refute 'ignored-master' \
  "an explicit master key overrode LITELLM_EXISTING_SECRET"
refute 'ignored@example.invalid' \
  "an explicit database URL overrode LITELLM_EXISTING_SECRET"

# 3. No existing Secret: the chart renders one, so the wrapper still has to
#    supply the credentials it will hold.
run LITELLM_MASTER_KEY=release-inline-master \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm
has_arg 'secrets.masterKey=release-inline-master'
has_arg 'secrets.databaseUrl=postgresql://release@example.invalid/litellm'

echo "LiteLLM existingSecret handling: ok"
