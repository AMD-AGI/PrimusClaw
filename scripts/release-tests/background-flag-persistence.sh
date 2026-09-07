#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# The background-shell enablement and its ceiling pin must survive the upgrade
# that follows the one that set them.
#
# Neither key had a path through the reference entrypoints: they were reachable
# only by hand-passing --set to helm, and the next routine upgrade re-rendered
# the Brain Deployment at the chart defaults and reverted both. That fails safe
# in direction and unsafe in behaviour -- a rollout gate that passed yesterday
# measures a deployment with the feature off today, and nobody is told. A
# reverted ceiling pin is worse: it widens the foreground ceiling under running
# work. Kept separate from deploy-values-persistence.sh so the lifetime knobs
# and these two stay independently attributable.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
namespace="claw-bg-persist-$$"
values_file="$repo_root/claw/deploy/values.${namespace}.env"
default_namespace="claw-bg-default-$$"
default_values_file="$repo_root/claw/deploy/values.${default_namespace}.env"
cleanup() {
  rm -rf "$tmp"
  rm -f "$values_file" "$default_values_file"
}
trap cleanup EXIT

mkdir -p "$tmp/bin" "$tmp/home"

cat >"$tmp/bin/helm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${HELM_CAPTURE:-/dev/null}"
if [[ "${1:-}" == "status" ]]; then exit "${MOCK_HELM_STATUS:-1}"; fi
if [[ "${1:-}" == "template" ]]; then
  printf 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: mock\nspec:\n  replicas: 1\n'
fi
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "-f" || "${!i}" == "--values" ]]; then
    j=$((i+1))
    cp "${!j}" "${HELM_VALUES_CAPTURE:-/dev/null}"
  fi
done
exit 0
EOF

cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
# An object nothing here declares is absent, and under --ignore-not-found that
# is a successful empty answer rather than a failure. The upgrade's security
# preservation tells the two apart and refuses to render on the second, so a
# mock that exits non-zero for an absent Secret stops the run this asserts.
case " $* " in *" --ignore-not-found "*) exit 0 ;; esac
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"get sc"*) printf 'fast (default)\n' ;;
  # wait_pods_ready counts lines that carry both the tag and a ready flag.
  *"get pods"*) printf '%s true\n' "${MOCK_TAG:-none}" ;;
  *"get secret"*|*"get deploy"*|*"get statefulset"*|*"get pod"*) exit 1 ;;
esac
exit 0
EOF

cat >"$tmp/bin/openssl" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "rand" ]] && { echo "0123456789abcdef0123456789abcdef"; exit 0; }
exit 0
EOF

cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "$tmp/bin/helm" "$tmp/bin/kubectl" "$tmp/bin/openssl" "$tmp/bin/curl"

capture="$tmp/helm.args"
values_capture="$tmp/helm-values.json"

# The Brain Deployment is what carries both keys, and upgrade.sh renders it
# through its own --show-only invocation, so "some render had it" is too weak a
# claim: the values have to be on the command line that produces that manifest.
assert_brain_render() {
  local phase="$1" flag="$2" ceiling="$3" found=0
  while read -r line; do
    case "$line" in
      *"--show-only templates/brain-deployment.yaml"*)
        found=1
        for want in "features.backgroundShell=$flag" "brain.bashMaxTimeoutSec=$ceiling"; do
          case "$line" in
            *"--set-string $want"*) ;;
            *) echo "$phase: brain render lost $want" >&2; exit 1 ;;
          esac
        done
        ;;
    esac
  done <"$capture"
  [ "$found" -eq 1 ] || { echo "$phase: no brain-deployment render was captured" >&2; exit 1; }
}

# The other half of the same claim, and the one an empty knob turns on: a key
# with no opinion recorded must reach no render at all. Rendered as the empty
# string it would overwrite the chart's own default with nothing.
assert_brain_render_omits() {
  local phase="$1" key="$2" found=0
  while read -r line; do
    case "$line" in
      *"--show-only templates/brain-deployment.yaml"*)
        found=1
        case "$line" in
          *"$key"*) echo "$phase: brain render passed $key with nothing set" >&2; exit 1 ;;
        esac
        ;;
    esac
  done <"$capture"
  [ "$found" -eq 1 ] || { echo "$phase: no brain-deployment render was captured" >&2; exit 1; }
}

# ── An install that names neither knob ──
# The generated file is the operator's editing surface for the next upgrade, so
# both keys belong in it whether or not this install set them -- empty, which
# has to stay distinguishable from a value.
: >"$capture"
env HOME="$tmp/home" PATH="$tmp/bin:$PATH" HELM_CAPTURE="$capture" \
  HELM_VALUES_CAPTURE="$values_capture" \
  NAMESPACE="$default_namespace" DOMAIN="persist.example" \
  STORAGE_CLASS="release-test-sc" MOCK_TAG="release-test" TAG="release-test" \
  S3_ACCESS_KEY="ak" S3_SECRET_KEY="sk" \
  bash "$repo_root/claw/deploy/deploy.sh" \
    --skip-pgo --skip-nats --skip-pg --skip-lifecycle --skip-shared-assets \
    >"$tmp/deploy-default.log" 2>&1 || { command cat "$tmp/deploy-default.log" >&2; exit 1; }

for _key in BG_SHELL_ENABLED BASH_MAX_TIMEOUT_SEC; do
  grep -q "^${_key}=\"\"$" "$default_values_file" || {
    echo "a no-knob install left $_key out of the generated values file" >&2
    command cat "$default_values_file" >&2
    exit 1
  }
done

python3 - "$values_capture" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    values = json.load(f)
brain = values.get("brain", {})
assert "bashMaxTimeoutSec" not in brain, f"unset ceiling reached the chart: {brain!r}"
# values["features"] does not exist unless something creates it, so an
# enablement wired into the brain loop alone would be dropped without a word --
# and an empty one that created the key would render the flag as "".
assert "features" not in values, f"unset flag reached the chart: {values.get('features')!r}"
PY

# ── The install that turns it on, naming both knobs once ──
: >"$capture"
env HOME="$tmp/home" PATH="$tmp/bin:$PATH" HELM_CAPTURE="$capture" \
  HELM_VALUES_CAPTURE="$values_capture" \
  NAMESPACE="$namespace" DOMAIN="persist.example" STORAGE_CLASS="release-test-sc" \
  TAG="release-test" S3_ACCESS_KEY="ak" S3_SECRET_KEY="sk" \
  BG_SHELL_ENABLED="true" \
  BASH_MAX_TIMEOUT_SEC="600" \
  bash "$repo_root/claw/deploy/deploy.sh" \
    --skip-pgo --skip-nats --skip-pg --skip-lifecycle --skip-shared-assets \
    >"$tmp/deploy.log" 2>&1 || { command cat "$tmp/deploy.log" >&2; exit 1; }

python3 - "$values_capture" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    values = json.load(f)
assert values["features"]["backgroundShell"] == "true", values.get("features")
assert values["brain"]["bashMaxTimeoutSec"] == "600", values["brain"]
PY

for _pair in 'BG_SHELL_ENABLED="true"' 'BASH_MAX_TIMEOUT_SEC="600"'; do
  grep -q "^${_pair}\$" "$values_file" || {
    echo "the install did not persist ${_pair%%=*}" >&2
    command cat "$values_file" >&2
    exit 1
  }
done

# ── The upgrade an operator actually runs: `env -i`, neither knob re-passed ──
# The empty environment is the point. If the values file is not carrying the
# enablement and the pin, there is nowhere else for them to come from, and this
# is the upgrade that silently reverted both.
: >"$capture"
env -i HOME="$tmp/home" PATH="$tmp/bin:/usr/bin:/bin" HELM_CAPTURE="$capture" \
  MOCK_HELM_STATUS=0 TAG="release-test-2" \
  bash "$repo_root/claw/deploy/upgrade.sh" -n "$namespace" --dry-run \
    >"$tmp/upgrade.log" 2>&1 || { command cat "$tmp/upgrade.log" >&2; exit 1; }

assert_brain_render "upgrade with no env" "true" "600"

# ── And the same upgrade against the no-knob install ──
: >"$capture"
env -i HOME="$tmp/home" PATH="$tmp/bin:/usr/bin:/bin" HELM_CAPTURE="$capture" \
  MOCK_HELM_STATUS=0 TAG="release-test-2" \
  bash "$repo_root/claw/deploy/upgrade.sh" -n "$default_namespace" --dry-run \
    >"$tmp/upgrade-default.log" 2>&1 || { command cat "$tmp/upgrade-default.log" >&2; exit 1; }

assert_brain_render_omits "no-knob upgrade" "features.backgroundShell"
assert_brain_render_omits "no-knob upgrade" "brain.bashMaxTimeoutSec"

echo "background flag persistence: ok"
