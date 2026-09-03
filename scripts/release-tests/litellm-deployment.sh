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

# The provider key reaches the container from a Secret, never from values: a
# literal api_key in modelList would sit in the release and every revision after
# it. The knob is three scalars rather than an extraEnv entry because Helm
# replaces a list wholesale, so appending there would drop the operator's own.
provider_render="$tmp/provider-render.yaml"
helm template release "$chart" --values "$values" \
  --set-string providerApiKey.secretName=release-provider-key \
  >"$provider_render"
rg -q 'name: "LITELLM_PROVIDER_API_KEY"' "$provider_render"
rg -q 'name: "release-provider-key"' "$provider_render"
# the operator's own extraEnv entry survives alongside it
rg -q 'name: RELEASE_TEST_TOKEN' "$provider_render"
if rg -q 'name: "LITELLM_PROVIDER_API_KEY"' "$existing_render"; then
  echo "provider key env rendered with no providerApiKey.secretName set" >&2
  exit 1
fi

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


# --- the provider discovery path, actually executed -------------------------
# Grepping deploy.sh for `os.environ/` was not coverage: the only match was a
# comment, so the assertion held no matter what the code did. The path is now
# drivable without a TTY, so drive it and look at what it produced.
prov_bin="$tmp/provbin"
mkdir -p "$prov_bin"
cp "$tmp/bin/helm" "$prov_bin/helm"
cat >"$prov_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$CURL_CAPTURE"
for a in "$@"; do
  case "$a" in @*) cp "${a#@}" "$CURL_HEADER_COPY" ;; esac
done
echo '{"data":[{"id":"model-one"},{"id":"model-two"}]}'
EOF
cat >"$prov_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >>"$KUBECTL_CAPTURE"
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"create namespace"*) echo "CALL:namespace" >>"$KUBECTL_ORDER"; echo "apiVersion: v1"; echo "kind: Namespace" ;;
  *"create secret"*) echo "CALL:secret" >>"$KUBECTL_ORDER"; cat >"$SECRET_STDIN_COPY"; echo '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"stub"}}' ;;
  *apply*) cat >/dev/null ;;
  *"exec deployment/litellm"*"import yaml"*) printf '%s\n' prometheus ;;
esac
exit 0
EOF
chmod +x "$prov_bin/curl" "$prov_bin/kubectl"

prov_values="$tmp/provider-values.json"
: >"$tmp/kubectl.args"
if ! env "PATH=$prov_bin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "CURL_CAPTURE=$tmp/curl.args" "CURL_HEADER_COPY=$tmp/curl.headers" \
  "KUBECTL_CAPTURE=$tmp/kubectl.args" "SECRET_STDIN_COPY=$tmp/secret.stdin" "KUBECTL_ORDER=$tmp/kubectl.order" \
  LITELLM_PROVIDER_TYPE=openai \
  LITELLM_PROVIDER_URL=https://provider.invalid/v1 \
  LITELLM_PROVIDER_API_KEY=release-provider-secret \
  LITELLM_PROVIDER_VALUES_FILE="$prov_values" \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_MASTER_KEY=release-master \
  LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  command cat "$output" >&2
  exit 1
fi

# The key reaches the cluster only through the Secret, on stdin.
[[ "$(command cat "$tmp/secret.stdin")" == "release-provider-secret" ]]
for f in "$capture" "$prov_values" "$tmp/curl.args" "$tmp/kubectl.args"; do
  if rg -q 'release-provider-secret' "$f"; then
    echo "provider key leaked into $(basename "$f")" >&2
    exit 1
  fi
done
# curl took it from a header file, and that file was not world-readable.
rg -q '^@' "$tmp/curl.args"
rg -q 'Authorization: Bearer release-provider-secret' "$tmp/curl.headers"

# modelList references the env var; providerApiKey names the Secret.
rg -q '"api_key": "os.environ/LITELLM_PROVIDER_API_KEY"' "$prov_values"
# Credentials arrive by secretKeyRef, so rewriting the Secret leaves the
# Deployment identical and the Pods keep the old ones. The wrapper hashes them
# into a pod annotation to make the rotation a template change.
rg -qx 'podAnnotations.checksum/credentials=[0-9a-f]{32}' "$capture"
rg -q '"model": "openai/model-one"' "$prov_values"
rg -q '"envName": "LITELLM_PROVIDER_API_KEY"' "$prov_values"
# Secret name is content-addressed, so a new key rolls the pods.
prov_secret="$(rg -o 'litellm-provider-[0-9a-f]{10}' "$prov_values" | head -1)"
[[ -n "$prov_secret" ]]
# The namespace is ensured before the Secret is written into it.
# Compared as an ordered list of calls, not line numbers: `[[ a -lt b ]]`
# evaluates its operands arithmetically, so a non-numeric value there fails as
# "unbound variable" rather than as the assertion it is.
[[ "$(head -1 "$tmp/kubectl.order")" == "CALL:namespace" ]]
rg -qx 'CALL:secret' "$tmp/kubectl.order"

# config.yaml is mounted with subPath, which kubelet never refreshes, so the
# only thing that can move a running Pod onto a new model list is a changed pod
# template. Hash has to follow the ConfigMap.
sum_a="$(helm template release "$chart" --values "$values" \
  --set 'modelList[0].model_name=a' --set 'modelList[0].litellm_params.model=openai/a' \
  | rg -o 'checksum/config: [0-9a-f]+' | head -1)"
sum_b="$(helm template release "$chart" --values "$values" \
  --set 'modelList[0].model_name=b' --set 'modelList[0].litellm_params.model=openai/b' \
  | rg -o 'checksum/config: [0-9a-f]+' | head -1)"
[[ -n "$sum_a" && "$sum_a" != "$sum_b" ]] || {
  echo "the pod template does not follow the rendered config" >&2
  exit 1
}

# --- what a later non-interactive upgrade keeps -----------------------------
# Helm recomputes values from what the run passes, so an upgrade that does not
# repeat the provider config would hand it an empty modelList and no
# providerApiKey: the proxy comes back with no models and no key env var. The
# wrapper carries them forward instead.
carry_bin="$tmp/carrybin"
mkdir -p "$carry_bin"
cp "$prov_bin/kubectl" "$carry_bin/kubectl"
cat >"$carry_bin/helm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "template" ]]; then exec "$REAL_HELM" "$@"; fi
if [[ "$*" == *"get values"* ]]; then
  echo '{"modelList":[{"model_name":"carried-model","litellm_params":{"model":"openai/carried-model","api_key":"os.environ/LITELLM_PROVIDER_API_KEY"}}],"providerApiKey":{"secretName":"litellm-provider-deadbeef00","secretKey":"api_key","envName":"LITELLM_PROVIDER_API_KEY"}}'
  exit 0
fi
printf '%s\n' "$@" >"$HELM_CAPTURE"
# The wrapper deletes its temp values files on exit, so copy them while they
# still exist -- this is the only moment their contents are observable.
: >"$VALUES_COPY"
prev=""
for a in "$@"; do
  [[ "$prev" == "-f" && -e "$a" ]] && command cat "$a" >>"$VALUES_COPY"
  prev="$a"
done
EOF
chmod +x "$carry_bin/helm"

: >"$tmp/kubectl.order"
if ! env "PATH=$carry_bin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "CURL_CAPTURE=$tmp/curl.args" "CURL_HEADER_COPY=$tmp/curl.headers" \
  "KUBECTL_CAPTURE=$tmp/kubectl.args" "SECRET_STDIN_COPY=$tmp/secret.stdin" \
  "KUBECTL_ORDER=$tmp/kubectl.order" "VALUES_COPY=$tmp/carried.values" \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_MASTER_KEY=release-master \
  LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  command cat "$output" >&2
  exit 1
fi
# awk rather than `rg -A1`: the capture is one argument per line, and this
# keeps the assertion independent of which grep-alike is installed.
[[ -n "$(awk '/^-f$/{getline; print}' "$capture" | head -1)" ]] || {
  echo "no values file was passed to carry the release's modelList forward" >&2
  command cat "$capture" >&2
  exit 1
}
rg -q 'carried-model' "$tmp/carried.values"
rg -q 'litellm-provider-deadbeef00' "$tmp/carried.values"

# A release from before the key moved into a Secret has a literal api_key in
# its values. Carrying that forward would write the plaintext into the new
# revision, quietly undoing the fix, so it has to stop instead.
cat >"$carry_bin/helm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "template" ]]; then exec "$REAL_HELM" "$@"; fi
if [[ "$*" == *"get values"* ]]; then
  echo '{"modelList":[{"model_name":"legacy","litellm_params":{"model":"openai/legacy","api_key":"sk-plaintext-legacy"}}]}'
  exit 0
fi
printf '%s\n' "$@" >"$HELM_CAPTURE"
EOF
chmod +x "$carry_bin/helm"
if env "PATH=$carry_bin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "KUBECTL_CAPTURE=$tmp/kubectl.args" "SECRET_STDIN_COPY=$tmp/secret.stdin" \
  "KUBECTL_ORDER=$tmp/kubectl.order" "VALUES_COPY=$tmp/carried.values" \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_MASTER_KEY=release-master LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  echo "carried a literal api_key forward instead of refusing" >&2
  exit 1
fi
rg -q 'literal api_key' "$output"

# A failed read is not an empty release. Continuing would hand Helm an empty
# modelList and take the models away.
cat >"$carry_bin/helm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "template" ]]; then exec "$REAL_HELM" "$@"; fi
if [[ "$*" == *"get values"* ]]; then echo "Error: Kubernetes cluster unreachable" >&2; exit 1; fi
printf '%s\n' "$@" >"$HELM_CAPTURE"
EOF
chmod +x "$carry_bin/helm"
if env "PATH=$carry_bin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "KUBECTL_CAPTURE=$tmp/kubectl.args" "SECRET_STDIN_COPY=$tmp/secret.stdin" \
  "KUBECTL_ORDER=$tmp/kubectl.order" "VALUES_COPY=$tmp/carried.values" \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_MASTER_KEY=release-master LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  echo "upgraded with an empty modelList after failing to read the release" >&2
  exit 1
fi
rg -q 'refusing to upgrade with an empty modelList' "$output"

# "not found" is different: that is a first install, and it proceeds.
cat >"$carry_bin/helm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "template" ]]; then exec "$REAL_HELM" "$@"; fi
if [[ "$*" == *"get values"* ]]; then echo "Error: release: not found" >&2; exit 1; fi
printf '%s\n' "$@" >"$HELM_CAPTURE"
EOF
chmod +x "$carry_bin/helm"
if ! env "PATH=$carry_bin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "KUBECTL_CAPTURE=$tmp/kubectl.args" "SECRET_STDIN_COPY=$tmp/secret.stdin" \
  "KUBECTL_ORDER=$tmp/kubectl.order" "VALUES_COPY=$tmp/carried.values" \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_MASTER_KEY=release-master LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  command cat "$output" >&2
  exit 1
fi

# A corrected values file has to be able to get past the refusal -- that is the
# migration the message tells the operator to perform. The check therefore runs
# on what Helm merges, not on the carried copy alone.
fixed_values="$tmp/fixed-values.yaml"
cat >"$fixed_values" <<'EOF'
modelList:
  - model_name: fixed
    litellm_params:
      model: openai/fixed
      api_key: os.environ/LITELLM_PROVIDER_API_KEY
EOF
cat >"$carry_bin/helm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "template" ]]; then exec "$REAL_HELM" "$@"; fi
if [[ "$*" == *"get values"* ]]; then
  echo '{"modelList":[{"model_name":"legacy","litellm_params":{"model":"openai/legacy","api_key":"sk-plaintext-legacy"}}]}'
  exit 0
fi
printf '%s\n' "$@" >"$HELM_CAPTURE"
EOF
chmod +x "$carry_bin/helm"
carry_env=(
  "PATH=$carry_bin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture"
  "KUBECTL_CAPTURE=$tmp/kubectl.args" "SECRET_STDIN_COPY=$tmp/secret.stdin"
  "KUBECTL_ORDER=$tmp/kubectl.order" "VALUES_COPY=$tmp/carried.values"
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm
  LITELLM_MASTER_KEY=release-master LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true
)
if ! env "${carry_env[@]}" LITELLM_VALUES_FILE="$fixed_values" \
  bash "$deploy_script" >"$output" 2>&1; then
  echo "a corrected values file still could not get past the literal-key refusal" >&2
  command cat "$output" >&2
  exit 1
fi
# ...and without that file, the literal one is still refused.
if env "${carry_env[@]}" bash "$deploy_script" >"$output" 2>&1; then
  echo "deployed a modelList holding a provider key in plain text" >&2
  exit 1
fi
rg -q 'literal api_key' "$output"

# A read failure on the credentials Secret must not be read as "first install":
# generating a new master key over a live one makes every model credential
# encrypted with the old one undecryptable.
cat >"$carry_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"get secret"*) echo "Error from server (Forbidden): secrets is forbidden" >&2; exit 1 ;;
  *"exec deployment/litellm"*) printf '%s\n' prometheus ;;
esac
exit 0
EOF
chmod +x "$carry_bin/kubectl"
if env "${carry_env[@]}" LITELLM_VALUES_FILE="$fixed_values" LITELLM_MASTER_KEY= \
  bash "$deploy_script" >"$output" 2>&1; then
  echo "generated a new master key after failing to read the existing Secret" >&2
  exit 1
fi
rg -q 'refusing to generate a new master key' "$output"
cp "$prov_bin/kubectl" "$carry_bin/kubectl"

# The discovered-values file is only replaced once the response has parsed.
kept="$tmp/kept-values.json"
echo '{"modelList":[{"model_name":"previous"}]}' >"$kept"
cat >"$prov_bin/curl" <<'EOF'
#!/usr/bin/env bash
echo '{"data":{"not":"a list"}}'
EOF
if env "PATH=$prov_bin:$PATH" "REAL_HELM=$real_helm" "HELM_CAPTURE=$capture" \
  "CURL_CAPTURE=$tmp/curl.args" "CURL_HEADER_COPY=$tmp/curl.headers" \
  "KUBECTL_CAPTURE=$tmp/kubectl.args" "SECRET_STDIN_COPY=$tmp/secret.stdin" \
  "KUBECTL_ORDER=$tmp/kubectl.order" \
  LITELLM_PROVIDER_TYPE=openai LITELLM_PROVIDER_URL=https://provider.invalid/v1 \
  LITELLM_PROVIDER_API_KEY=release-provider-secret LITELLM_PROVIDER_VALUES_FILE="$kept" \
  LITELLM_DATABASE_URL=postgresql://release@example.invalid/litellm \
  LITELLM_MASTER_KEY=release-master LITELLM_INSTALL_INGRESS=false SKIP_HEALTH=true \
  bash "$deploy_script" >"$output" 2>&1; then
  echo "accepted a /models response whose data was not a list" >&2
  exit 1
fi
rg -q 'previous' "$kept"

echo "LiteLLM deployment behavior: ok"
