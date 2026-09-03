#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chart="$repo_root/deploy/litellm/charts/litellm"
deploy_script="$repo_root/deploy/litellm/deploy.sh"
real_helm="$(command -v helm || true)"
[ -n "$real_helm" ] || {
  echo "error: helm is required for LiteLLM deployment verification" >&2
  exit 1
}
# Checked up front rather than left to the first assertion: without it a
# missing ripgrep surfaces as `rg: command not found` partway through, which
# reads like a chart that stopped rendering what the test expects.
command -v rg >/dev/null || {
  echo "error: ripgrep (rg) is required for LiteLLM deployment verification" >&2
  exit 1
}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

values="$tmp/existing-secret-values.yaml"
cat >"$values" <<'EOF'
secrets:
  existingSecret: release-litellm-credentials
  masterKey: unused-master-value
  databaseUrl: postgresql://unused:unused@example.invalid/litellm
extraEnv:
  - name: RELEASE_TEST_TOKEN
    valueFrom:
      secretKeyRef:
        name: release-extra-env
        key: token
litellmSettings:
  drop_params: false
  callbacks:
    - prometheus
    - litellm.proxy.hooks.apim_key_hook.proxy_handler_instance
generalSettings:
  disable_spend_logs: true
EOF

helm lint "$chart" --values "$values" >/dev/null
existing_render="$tmp/existing-render.yaml"
helm template release "$chart" --values "$values" >"$existing_render"
if rg -q '^kind: Secret$' "$existing_render"; then
  echo "LiteLLM chart rendered a Secret despite secrets.existingSecret" >&2
  exit 1
fi
[[ "$(rg -c 'name: release-litellm-credentials' "$existing_render")" -eq 2 ]]
rg -q 'name: RELEASE_TEST_TOKEN' "$existing_render"
rg -q 'name: release-extra-env' "$existing_render"
rg -q 'drop_params: false' "$existing_render"
rg -q -- '- prometheus' "$existing_render"
rg -q 'disable_spend_logs: true' "$existing_render"

generated_render="$tmp/generated-render.yaml"
helm template release "$chart" \
  --set-string secrets.masterKey=release-master \
  --set-string secrets.databaseUrl=postgresql://release@example.invalid/litellm \
  >"$generated_render"
rg -q '^kind: Secret$' "$generated_render"
rg -q 'master_key: "release-master"' "$generated_render"

git -C "$repo_root" check-ignore --no-index -q deploy/litellm/private-values.yaml
git -C "$repo_root" check-ignore --no-index -q deploy/litellm/values.private.yaml
if git -C "$repo_root" check-ignore --no-index -q \
  deploy/litellm/values.autorouting.example.yaml; then
  echo "tracked LiteLLM example values are ignored" >&2
  exit 1
fi

mkdir -p "$tmp/bin"
cat >"$tmp/bin/helm" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "template" ]]; then
  exec "$REAL_HELM" "$@"
fi
printf '%s\n' "$@" >"$HELM_CAPTURE"
EOF
chmod +x "$tmp/bin/helm"

cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
# `set -e` matters here: a bare `[[ ]]` below would otherwise only set the exit
# status of that one line, and the mock would carry on to drop its "I checked"
# marker and exit 0 -- so an assertion about what the deploy script passed could
# never fail the test that depends on it.
set -euo pipefail
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"exec deployment/litellm"*"import yaml"*)
    [[ "${CALLBACK_READ_FAIL:-false}" != "true" ]] || exit 1
    printf '%s\n' \
      prometheus \
      litellm.proxy.hooks.apim_key_hook.proxy_handler_instance
    ;;
  *"exec deployment/litellm"*"import importlib"*)
    # The callback has to arrive as the final argument -- that is the contract
    # the deploy script's `python3 -c '...' "$callback"` form exists to keep.
    # The value goes to a file, not stderr: the deploy script runs this command
    # with 2>/dev/null, so a message written here would vanish and the failure
    # would surface only as its generic "cannot resolve it" -- which blames the
    # image for what is actually a wrong argument.
    if [[ "${!#}" != "litellm.proxy.hooks.apim_key_hook.proxy_handler_instance" ]]; then
      printf '%s\n' "${!#}" >"$CALLBACK_CAPTURE.unexpected"
      exit 1
    fi
    : >"$CALLBACK_CAPTURE"
    ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/kubectl"

cat >"$tmp/bin/openssl" <<'EOF'
#!/usr/bin/env bash
: >"$OPENSSL_CAPTURE"
exit 1
EOF
chmod +x "$tmp/bin/openssl"

capture="$tmp/helm.args"
output="$tmp/deploy.log"
mock_env=(
  "PATH=$tmp/bin:$PATH"
  "REAL_HELM=$real_helm"
  "HELM_CAPTURE=$capture"
  "CALLBACK_CAPTURE=$tmp/callback.checked"
  "OPENSSL_CAPTURE=$tmp/openssl.called"
)

if ! env "${mock_env[@]}" \
  LITELLM_VALUES_FILE="$values" \
  LITELLM_INSTALL_INGRESS=false \
  SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  command cat "$output" >&2
  if [[ -e "$tmp/callback.checked.unexpected" ]]; then
    echo "the deploy script passed this callback to the import check:" >&2
    command cat "$tmp/callback.checked.unexpected" >&2
  fi
  exit 1
fi

rg -qx -- '-f' "$capture"
rg -qx -- "$values" "$capture"
rg -qx 'secrets.masterKey=' "$capture"
rg -qx 'secrets.databaseUrl=' "$capture"
if rg -q 'unused-master-value|postgresql://unused' "$capture"; then
  echo "existing credentials leaked into Helm command arguments" >&2
  exit 1
fi
[[ ! -e "$tmp/openssl.called" ]]
[[ -e "$tmp/callback.checked" ]]
rg -q "callback 'prometheus'.*nothing to import" "$output"
rg -q "callback litellm.proxy.hooks.apim_key_hook.proxy_handler_instance resolves" "$output"

if env "${mock_env[@]}" \
  CALLBACK_READ_FAIL=true \
  LITELLM_VALUES_FILE="$values" \
  LITELLM_INSTALL_INGRESS=false \
  SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  echo "deploy.sh ignored an unreadable callback configuration" >&2
  exit 1
fi
rg -q "could not read callbacks from deployment/litellm" "$output"

if ! env "${mock_env[@]}" \
  LITELLM_EXISTING_SECRET=release-env-secret \
  LITELLM_DATABASE_URL=postgresql://ignored:ignored@example.invalid/litellm \
  LITELLM_MASTER_KEY=ignored-master \
  DRY_RUN=true \
  bash "$deploy_script" >"$output" 2>&1; then
  command cat "$output" >&2
  exit 1
fi
rg -qx 'secrets.existingSecret=release-env-secret' "$capture"
rg -qx 'secrets.masterKey=' "$capture"
rg -qx 'secrets.databaseUrl=' "$capture"
if rg -q 'ignored-master|postgresql://ignored' "$capture"; then
  echo "explicit credentials overrode LITELLM_EXISTING_SECRET" >&2
  exit 1
fi

if ! env "${mock_env[@]}" \
  LITELLM_DATABASE_URL=postgresql://release:release@example.invalid/litellm \
  LITELLM_MASTER_KEY=release-inline-master \
  DRY_RUN=true \
  bash "$deploy_script" >"$output" 2>&1; then
  command cat "$output" >&2
  exit 1
fi
rg -qx 'secrets.masterKey=release-inline-master' "$capture"
rg -qx 'secrets.databaseUrl=postgresql://release:release@example.invalid/litellm' "$capture"

echo "LiteLLM deployment behavior: ok"
