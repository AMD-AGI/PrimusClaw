#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Sandbox lifetime knobs must survive the reference upgrade path.
#
# deploy.sh takes them from the shell; upgrade.sh does not -- it re-renders the
# Deployment from deploy/values.<ns>.env alone, and that file is the only thing
# carrying an operator's choice forward. A knob that deploy.sh honors but never
# writes down is a knob the very next upgrade silently reverts to the chart
# default, which is exactly the regression this pins.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
namespace="claw-values-persist-$$"
values_file="$repo_root/claw/deploy/values.${namespace}.env"
default_namespace="claw-values-default-$$"
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

# The whole-release install goes through `helm upgrade --install -f <json>`,
# not through render_chart, so a knob wired into only one of the two reaches
# only one of deploy and upgrade. This asserts the install side.
assert_installed_with() {
  local phase="$1" timeout="$2" duration="$3"
  python3 - "$values_capture" "$phase" "$timeout" "$duration" <<'PY'
import json, sys
path, phase, timeout, duration = sys.argv[1:5]
with open(path, encoding="utf-8") as f:
    values = json.load(f)
brain = values.get("brain", {})
assert brain.get("sessionTimeout") == timeout, f"{phase}: sessionTimeout={brain.get('sessionTimeout')!r}"
assert brain.get("maxSessionDuration") == duration, f"{phase}: maxSessionDuration={brain.get('maxSessionDuration')!r}"
PY
}

# Assert the knobs reached `helm template` in every render captured so far.
# render_chart feeds both the API and the Brain Deployment, and upgrade.sh
# re-renders both, so "some invocation had it" is too weak a claim -- the value
# has to be on the command line that produces the Brain Deployment.
assert_rendered_with() {
  local phase="$1" timeout="$2" duration="$3" found=0
  while read -r line; do
    case "$line" in
      *"--show-only templates/brain-deployment.yaml"*)
        found=1
        case "$line" in
          *"--set-string brain.sessionTimeout=$timeout"*) ;;
          *) echo "$phase: brain render lost sessionTimeout=$timeout" >&2; exit 1 ;;
        esac
        case "$line" in
          *"--set-string brain.maxSessionDuration=$duration"*) ;;
          *) echo "$phase: brain render lost maxSessionDuration=$duration" >&2; exit 1 ;;
        esac
        ;;
    esac
  done <"$capture"
  [ "$found" -eq 1 ] || { echo "$phase: no brain-deployment render was captured" >&2; exit 1; }
}

# ── An install that names neither knob ──
# The generated file is the operator's editing surface for the next upgrade, so
# the keys belong in it whether or not this install set them -- empty, meaning
# "no opinion", which has to stay distinct from a value: an empty knob must not
# reach the chart at all, or "unset" would render as the empty string and the
# sandbox template's own numbers would be overwritten with nothing.
: >"$capture"
env HOME="$tmp/home" PATH="$tmp/bin:$PATH" HELM_CAPTURE="$capture" \
  HELM_VALUES_CAPTURE="$values_capture" \
  NAMESPACE="$default_namespace" DOMAIN="persist.example" \
  STORAGE_CLASS="release-test-sc" MOCK_TAG="release-test" TAG="release-test" \
  S3_ACCESS_KEY="ak" S3_SECRET_KEY="sk" \
  bash "$repo_root/claw/deploy/deploy.sh" \
    --skip-pgo --skip-nats --skip-pg --skip-lifecycle --skip-shared-assets \
    >"$tmp/deploy-default.log" 2>&1 || { command cat "$tmp/deploy-default.log" >&2; exit 1; }

for _key in AGENT_SANDBOX_SESSION_TIMEOUT AGENT_SANDBOX_MAX_SESSION_DURATION; do
  grep -q "^${_key}=\"\"$" "$default_values_file" || {
    echo "a no-knob install left $_key out of the generated values file" >&2
    command cat "$default_values_file" >&2
    exit 1
  }
done

python3 - "$values_capture" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    brain = json.load(f).get("brain", {})
assert "sessionTimeout" not in brain, f"unset knob reached the chart: {brain!r}"
assert "maxSessionDuration" not in brain, f"unset knob reached the chart: {brain!r}"
PY

# ── First install: the operator names the knobs once, on the command line ──
: >"$capture"
env HOME="$tmp/home" PATH="$tmp/bin:$PATH" HELM_CAPTURE="$capture" \
  HELM_VALUES_CAPTURE="$values_capture" \
  NAMESPACE="$namespace" DOMAIN="persist.example" STORAGE_CLASS="release-test-sc" \
  TAG="release-test" S3_ACCESS_KEY="ak" S3_SECRET_KEY="sk" \
  AGENT_SANDBOX_SESSION_TIMEOUT="6h" \
  AGENT_SANDBOX_MAX_SESSION_DURATION="48h" \
  bash "$repo_root/claw/deploy/deploy.sh" \
    --skip-pgo --skip-nats --skip-pg --skip-lifecycle --skip-shared-assets \
    >"$tmp/deploy.log" 2>&1 || { command cat "$tmp/deploy.log" >&2; exit 1; }

assert_installed_with "first install" "6h" "48h"

grep -q '^AGENT_SANDBOX_SESSION_TIMEOUT="6h"$' "$values_file" || {
  echo "first install did not persist AGENT_SANDBOX_SESSION_TIMEOUT" >&2
  command cat "$values_file" >&2
  exit 1
}
grep -q '^AGENT_SANDBOX_MAX_SESSION_DURATION="48h"$' "$values_file" || {
  echo "first install did not persist AGENT_SANDBOX_MAX_SESSION_DURATION" >&2
  command cat "$values_file" >&2
  exit 1
}

# ── The upgrade an operator actually runs: `env -i`, no knobs re-passed ──
# The empty environment is the point. If the values file is not carrying the
# choice, there is nowhere else for it to come from.
: >"$capture"
env -i HOME="$tmp/home" PATH="$tmp/bin:/usr/bin:/bin" HELM_CAPTURE="$capture" \
  MOCK_HELM_STATUS=0 TAG="release-test-2" \
  bash "$repo_root/claw/deploy/upgrade.sh" -n "$namespace" --dry-run \
    >"$tmp/upgrade.log" 2>&1 || { command cat "$tmp/upgrade.log" >&2; exit 1; }

assert_rendered_with "upgrade with no env" "6h" "48h"

# ── An install that set neither knob, and a later upgrade that sets one ──
# The file carries the keys, empty. Empty means "the file has no opinion", so
# the shell wins for this run -- and has to be written down, or the run after
# it reverts.
python3 - "$values_file" <<'PY'
import re, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    text = f.read()
text = re.sub(r'(?m)^(AGENT_SANDBOX_[A-Z_]+)=.*$', r'\1=""', text)
assert '="6h"' not in text, "failed to blank the values file"
with open(path, "w", encoding="utf-8") as f:
    f.write(text)
PY

: >"$capture"
env HOME="$tmp/home" PATH="$tmp/bin:$PATH" HELM_CAPTURE="$capture" \
  MOCK_HELM_STATUS=0 MOCK_TAG="release-test-2b" TAG="release-test-2b" \
  NAMESPACE="$namespace" \
  AGENT_SANDBOX_SESSION_TIMEOUT="9h" \
  AGENT_SANDBOX_MAX_SESSION_DURATION="36h" \
  bash "$repo_root/claw/deploy/upgrade.sh" -n "$namespace" --skip-health --skip-shared-assets \
    >"$tmp/fill.log" 2>&1 || { command cat "$tmp/fill.log" >&2; exit 1; }

grep -q '^AGENT_SANDBOX_SESSION_TIMEOUT="9h"$' "$values_file" || {
  echo "an empty knob in the values file was not filled in from the shell" >&2
  command cat "$values_file" >&2
  exit 1
}

: >"$capture"
env -i HOME="$tmp/home" PATH="$tmp/bin:/usr/bin:/bin" HELM_CAPTURE="$capture" \
  MOCK_HELM_STATUS=0 TAG="release-test-2c" \
  bash "$repo_root/claw/deploy/upgrade.sh" -n "$namespace" --dry-run \
    >"$tmp/upgrade1b.log" 2>&1 || { command cat "$tmp/upgrade1b.log" >&2; exit 1; }

assert_rendered_with "upgrade after filling a blank" "9h" "36h"

# ── A values file written before the knobs existed ──
# Every install that predates this feature has one. It has no line to source,
# so the first deploy that sets a knob has to append it, or that deploy is the
# only one the setting ever survives.
python3 - "$values_file" <<'PY'
import re, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    text = f.read()
text = re.sub(r"(?m)^AGENT_SANDBOX_[A-Z_]+=.*\n", "", text)
assert "AGENT_SANDBOX" not in text, "failed to age the values file"
with open(path, "w", encoding="utf-8") as f:
    f.write(text)
PY

: >"$capture"
env HOME="$tmp/home" PATH="$tmp/bin:$PATH" HELM_CAPTURE="$capture" \
  MOCK_HELM_STATUS=0 MOCK_TAG="release-test-3" TAG="release-test-3" \
  NAMESPACE="$namespace" \
  AGENT_SANDBOX_SESSION_TIMEOUT="12h" \
  AGENT_SANDBOX_MAX_SESSION_DURATION="72h" \
  bash "$repo_root/claw/deploy/upgrade.sh" -n "$namespace" --skip-health --skip-shared-assets \
    >"$tmp/backfill.log" 2>&1 || { command cat "$tmp/backfill.log" >&2; exit 1; }

grep -q '^AGENT_SANDBOX_SESSION_TIMEOUT="12h"$' "$values_file" || {
  echo "pre-existing values file was not back-filled with the new knob" >&2
  command cat "$values_file" >&2
  exit 1
}

: >"$capture"
env -i HOME="$tmp/home" PATH="$tmp/bin:/usr/bin:/bin" HELM_CAPTURE="$capture" \
  MOCK_HELM_STATUS=0 TAG="release-test-4" \
  bash "$repo_root/claw/deploy/upgrade.sh" -n "$namespace" --dry-run \
    >"$tmp/upgrade2.log" 2>&1 || { command cat "$tmp/upgrade2.log" >&2; exit 1; }

assert_rendered_with "upgrade after back-fill" "12h" "72h"

echo "deploy values persistence: ok"
