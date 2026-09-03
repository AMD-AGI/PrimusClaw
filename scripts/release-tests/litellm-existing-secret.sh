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
  # base64 of "fake": the wrapper reads the credentials Secret to hash it into a
  # pod annotation, so that rotating the Secret rolls the Pods.
  *"get secret"*) echo "ZmFrZQ==" ;;
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
# Credentials arrive by secretKeyRef, so rewriting the Secret leaves the
# Deployment identical and the Pods keep the old ones. The name is resolved from
# the rendered Deployment, which is the only way to find it when the flag came
# from the values file and LITELLM_EXISTING_SECRET is empty.
has_arg_re() { grep -qE "^$1\$" "$capture"; }
has_arg_re 'podAnnotations\.checksum/credentials=[0-9a-f]{32}'

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

# Helm keeps nothing from the previous run, so an upgrade that does not repeat
# the discovered modelList would hand it an empty one and the proxy would come
# back serving no models. Driven through a real (mocked) upgrade rather than
# --dry-run, because that is the path the carry-forward is on.
mkdir -p "$tmp/upbin"
cat >"$tmp/upbin/helm" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "template" ]]; then exec "$REAL_HELM" "$@"; fi
if [[ "$*" == *"get values"* ]]; then
  if [[ "${GET_VALUES_FAILS:-false}" == "true" ]]; then
    echo "Error: Kubernetes cluster unreachable" >&2; exit 1
  fi
  echo '{"modelList":[{"model_name":"carried-model","litellm_params":{"model":"openai/carried-model"}}]}'
  exit 0
fi
printf '%s\n' "$@" >"$HELM_CAPTURE"
: >"$VALUES_COPY"
prev=""
for a in "$@"; do
  [[ "$prev" == "-f" && -e "$a" ]] && command cat "$a" >>"$VALUES_COPY"
  prev="$a"
done
EOF
cat >"$tmp/upbin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"get secret"*) echo "ZmFrZQ==" ;;
  *"exec deployment/litellm"*) printf '%s\n' prometheus ;;
esac
exit 0
EOF
chmod +x "$tmp/upbin/helm" "$tmp/upbin/kubectl"

if ! env "PATH=$tmp/upbin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "VALUES_COPY=$tmp/carried.values" \
  LITELLM_MASTER_KEY=release-master \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  command cat "$output" >&2
  exit 1
fi
grep -qF 'carried-model' "$tmp/carried.values" || {
  echo "the release's modelList was not carried into the upgrade" >&2
  exit 1
}

# An exec that cannot run at all is not "no callbacks configured": continuing
# leaves the hook silently inactive, which is what the probe exists to catch.
cat >"$tmp/upbin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"get secret"*) echo "ZmFrZQ==" ;;
  *"exec deployment/litellm"*) echo "error: unable to upgrade connection" >&2; exit 1 ;;
esac
exit 0
EOF
chmod +x "$tmp/upbin/kubectl"
if env "PATH=$tmp/upbin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "VALUES_COPY=$tmp/carried.values" \
  LITELLM_MASTER_KEY=release-master \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  echo "continued past a callback probe that could not run" >&2
  exit 1
fi
grep -q 'could not read the configured callbacks' "$output"
cat >"$tmp/upbin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"get secret"*) echo "ZmFrZQ==" ;;
  *"exec deployment/litellm"*) printf '%s\n' prometheus ;;
esac
exit 0
EOF
chmod +x "$tmp/upbin/kubectl"

# A failed read is not an empty release: upgrading anyway takes the models away.
if env "PATH=$tmp/upbin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "VALUES_COPY=$tmp/carried.values" GET_VALUES_FAILS=true \
  LITELLM_MASTER_KEY=release-master \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  echo "upgraded with an empty modelList after failing to read the release" >&2
  exit 1
fi
grep -q 'refusing to upgrade with an empty modelList' "$output"

# config.yaml is mounted with subPath, which kubelet never refreshes, so the only
# thing that can move a running Pod onto a new model list is a changed pod
# template. The hash has to follow the rendered ConfigMap.
chart="$repo_root/deploy/litellm/charts/litellm"
sum_of() {
  "$real_helm" template release "$chart" \
    --set-string secrets.masterKey=x --set-string secrets.databaseUrl=y \
    --set "modelList[0].model_name=$1" --set "modelList[0].litellm_params.model=openai/$1" \
    2>/dev/null | grep -o 'checksum/config: [0-9a-f]*' | head -1
}
sum_a="$(sum_of alpha)"; sum_b="$(sum_of beta)"
[ -n "$sum_a" ] || { echo "the pod template carries no checksum for the rendered config" >&2; exit 1; }
[ "$sum_a" != "$sum_b" ] || {
  echo "the pod template does not change when the rendered config does" >&2
  exit 1
}

echo "LiteLLM existingSecret handling: ok"
