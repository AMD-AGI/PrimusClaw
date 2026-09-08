#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# helm-values-schema.sh
#
# The chart half of the Doorbell rollout: what values.schema.json refuses per
# key, what admission-preflight.yaml refuses across keys, and that the rollback
# ordering is legal at every intermediate step and illegal in reverse.
#
# All of it is render-time. The API's startup validator is the authority on the
# same rules, but it answers after the pods have been replaced, so a wrong-order
# rollback learned there is a CrashLoopBackOff with no serving API.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chart_dir="$repo_root/claw/deploy/charts/claw"
rollout_values="$repo_root/scripts/release-tests/values/claw-doorbell-rollout.yaml"
release_values="$repo_root/scripts/release-tests/values/claw-release.yaml"

# shellcheck source=scripts/release-tests/forbidden-strings.sh
source "$repo_root/scripts/release-tests/forbidden-strings.sh"

for tool in helm rg; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required for the chart schema and render tests" >&2
    exit 1
  }
done
require_ripgrep "helm values schema"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
err="$tmp/err"

pass=0
ok()  { pass=$((pass + 1)); echo "  ok: $1"; }
bad() { echo "  FAIL: $1" >&2; exit 1; }

renders() {
  local why="$1" out="$2"; shift 2
  if ! helm template rollout-test "$chart_dir" "$@" >"$out" 2>"$err"; then
    bad "$why: render failed: $(cat "$err")"
  fi
  ok "$why"
}

refuses() {
  local why="$1"; shift
  if helm template rollout-test "$chart_dir" "$@" >/dev/null 2>"$err"; then
    bad "the chart rendered a combination it must refuse: $why"
  fi
  ok "refused: $why"
}

# The refusal has to name the offending key, or the operator is left rendering
# the whole values file by bisection.
refusal_names() {
  local needle="$1"
  rg -qF -- "$needle" "$err" || bad "the refusal must name $needle, got: $(cat "$err")"
  ok "the refusal names $needle"
}

rollout_base=(-f "$rollout_values")
release_base=(-f "$release_values")

# One rendered document out of a whole-chart render, by the `# Source:` comment
# helm writes above each.
document_of() {
  awk -v want="$2" '
    /^# Source: /  { emit = ($3 == want) }
    emit           { print }
  ' "$1"
}

# The eight ceilings as the Secret spells them, which is the only form a pod
# ever sees. RUN_DOORBELL_DISPATCH must NOT be there: one key in one Secret is
# what made a rollback of API dispatch also stop Brain draining the backlog.
assert_zero_ceilings() {
  local render="$1" why="$2" secret="$tmp/secret-doc.yaml"
  document_of "$render" "primus-claw/templates/secret.yaml" >"$secret"
  if rg -q 'RUN_DOORBELL_DISPATCH' "$secret"; then
    bad "$why: RUN_DOORBELL_DISPATCH is in the shared Secret, so one value reaches both deployments"
  fi
  local admit_lines
  admit_lines="$(rg -c '^\s*ADMIT_[A-Z_]+: "0"$' "$secret" || true)"
  [ "$admit_lines" = "8" ] \
    || bad "$why: expected eight ADMIT_* keys at \"0\", found ${admit_lines:-0}"
  ok "$why"
}

# What the container actually gets for RUN_DOORBELL_DISPATCH, per deployment.
doorbell_env_of() {
  local template="$1"; shift
  helm template rollout-test "$chart_dir" "$@" --show-only "templates/$template" 2>"$err" |
    rg -A1 'name: RUN_DOORBELL_DISPATCH' | rg -o 'value: "\w+"'
}

echo "==> chart defaults and the rollout test profile"

renders "chart defaults render" "$tmp/defaults.yaml" "${release_base[@]}"
assert_zero_ceilings "$tmp/defaults.yaml" "chart defaults keep all eight ceilings at zero"
[ "$(doorbell_env_of api-deployment.yaml "${release_base[@]}")" = 'value: "true"' ] \
  || bad "the chart default did not enable API Doorbell dispatch"
ok "API Doorbell dispatch ships on"

renders "the rollout test profile renders" "$tmp/rollout.yaml" "${rollout_base[@]}"
assert_zero_ceilings "$tmp/rollout.yaml" "the rolled-back state renders clean"
[ "$(doorbell_env_of api-deployment.yaml "${rollout_base[@]}")" = 'value: "false"' ] \
  || bad "the rollback profile did not disable API Doorbell dispatch"
ok "the rollback profile keeps API Doorbell dispatch off"

echo "==> one env name, two chart values"

# The rollback 00d prescribes sets features.runDoorbellDispatch false and needs
# every Brain still executing, or the rows it queued strand.
for state in true false; do
  api_env="$(doorbell_env_of api-deployment.yaml "${rollout_base[@]}" \
    --set "features.runDoorbellDispatch=$state")"
  [ "$api_env" = "value: \"$state\"" ] \
    || bad "the API container did not take features.runDoorbellDispatch=$state, got: ${api_env:-nothing}"
  brain_env="$(doorbell_env_of brain-deployment.yaml "${rollout_base[@]}" \
    --set "features.runDoorbellDispatch=$state")"
  [ "$brain_env" = 'value: "true"' ] \
    || bad "features.runDoorbellDispatch=$state changed the Brain kill-switch, got: ${brain_env:-nothing}"
done
ok "each deployment renders RUN_DOORBELL_DISPATCH from its own value"

brain_env="$(doorbell_env_of brain-deployment.yaml "${rollout_base[@]}" \
  --set features.brainDoorbellExecution=false)"
[ "$brain_env" = 'value: "false"' ] \
  || bad "features.brainDoorbellExecution=false did not reach the Brain container, got: ${brain_env:-nothing}"
ok "the Brain kill-switch is off when its own value is false"

refuses "features.brainDoorbellExecution=notabool" \
  "${rollout_base[@]}" --set-string features.brainDoorbellExecution=notabool

echo "==> per-key schema refusals"

refuses "api.admitSoftRuns=-1" "${rollout_base[@]}" --set-string api.admitSoftRuns=-1
refusal_names "api.admitSoftRuns"
refuses "api.admitHardRuns=abc" "${rollout_base[@]}" --set-string api.admitHardRuns=abc
refusal_names "api.admitHardRuns"
refuses "api.admitTreeMaxDepth=1.5" "${rollout_base[@]}" --set-string api.admitTreeMaxDepth=1.5
refuses "features.runDoorbellDispatch=notabool" \
  "${rollout_base[@]}" --set-string features.runDoorbellDispatch=notabool

echo "==> cross-key render refusals"

refuses "a soft ceiling above its own hard ceiling" "${rollout_base[@]}" \
  --set-string api.admitSoftRuns=4 --set-string api.admitHardRuns=2 \
  --set features.runDoorbellDispatch=true
refusal_names "api.admitSoftRuns"
refusal_names "api.admitHardRuns"

refuses "a ceiling configured while Doorbell dispatch is off" \
  "${rollout_base[@]}" --set-string api.admitHardRuns=2
rg -q 'Clear the admission ceilings first' "$err" \
  || bad "the ordering refusal must state the rule, got: $(cat "$err")"
ok "the ordering refusal states the rule"

echo "==> the rollback ordering, one step at a time"

# Forward: the fully-enabled shape is legal. Back: clearing the ceilings is
# legal on its own, and only then is disabling Doorbell legal. The reverse
# order is the case above, which the chart refuses.
renders "fully enabled renders" "$tmp/enabled.yaml" "${rollout_base[@]}" \
  --set-string api.admitHardRuns=2 --set features.runDoorbellDispatch=true
renders "R1 alone renders: ceilings cleared, Doorbell still on" "$tmp/r1.yaml" \
  "${rollout_base[@]}" --set-string api.admitHardRuns=0 \
  --set features.runDoorbellDispatch=true
renders "R4 after R1 renders: Doorbell off once the ceilings are clear" "$tmp/r4.yaml" \
  "${rollout_base[@]}" --set-string api.admitHardRuns=0 \
  --set features.runDoorbellDispatch=false
assert_zero_ceilings "$tmp/r4.yaml" "the R4 rollback render keeps every ceiling at zero"

echo "==> the rendered rollback state carries nothing internal"

failed=false
for literal in "${forbidden[@]}" "${forbidden_tree_only[@]}"; do
  matches="$(search -niF -- "$literal" "$tmp/rollout.yaml")"
  if [ -n "$matches" ]; then
    printf '%s\n' "$matches"
    echo "the rollout render contains a forbidden literal: $literal" >&2
    failed=true
  fi
done
for pattern in "${forbidden_re[@]}"; do
  matches="$(search -nP -- "$pattern" "$tmp/rollout.yaml")"
  if [ -n "$matches" ]; then
    printf '%s\n' "$matches"
    echo "the rollout render matches a forbidden pattern: $pattern" >&2
    failed=true
  fi
done
[ "$failed" = "false" ] || bad "the rollout render is not publishable"
ok "the rollout render carries no forbidden string"

echo "==> a ceiling change is a pod-template change"

# upgrade.sh renders this Deployment with --show-only and secret.create=false,
# under which checksum/secret hashes an empty Secret. Without a value-derived
# annotation the new ceiling reaches the Secret and never reaches a pod.
checksum_of() {
  helm template rollout-test "$chart_dir" "${rollout_base[@]}" \
    --set features.runDoorbellDispatch=true --set-string "api.admitSoftRuns=$1" \
    --show-only templates/api-deployment.yaml 2>"$err" |
    rg -o 'checksum/rollout-config: \S+'
}
checksum_a="$(checksum_of 2)"
checksum_b="$(checksum_of 3)"
[ -n "$checksum_a" ] || bad "api-deployment.yaml carries no checksum/rollout-config annotation"
[ "$checksum_a" != "$checksum_b" ] \
  || bad "changing a ceiling did not change checksum/rollout-config, so the pods would not restart"
ok "a ceiling change rolls the API pods"

doorbell_checksum_of() {
  helm template rollout-test "$chart_dir" "${release_base[@]}" \
    --set "features.runDoorbellDispatch=$1" \
    --show-only templates/api-deployment.yaml 2>"$err" |
    rg -o 'checksum/rollout-config: \S+'
}
checksum_on="$(doorbell_checksum_of true)"
checksum_off="$(doorbell_checksum_of false)"
[ -n "$checksum_on" ] || bad "api-deployment.yaml carries no checksum/rollout-config annotation"
[ "$checksum_on" != "$checksum_off" ] \
  || bad "disabling Doorbell did not change checksum/rollout-config, so the pods would not restart"
ok "an explicit false Doorbell value rolls the API pods"

echo "helm values schema: $pass checks passed"
