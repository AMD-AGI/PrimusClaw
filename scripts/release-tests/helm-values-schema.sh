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

# The nine env keys as the Secret spells them, which is the only form a pod
# ever sees.
assert_safe_defaults() {
  local render="$1" why="$2"
  rg -q '^\s*RUN_DOORBELL_DISPATCH: "false"$' "$render" \
    || bad "$why: RUN_DOORBELL_DISPATCH is not the shipped false"
  local admit_lines
  admit_lines="$(rg -c '^\s*ADMIT_[A-Z_]+: "0"$' "$render" || true)"
  [ "$admit_lines" = "8" ] \
    || bad "$why: expected eight ADMIT_* keys at \"0\", found ${admit_lines:-0}"
  ok "$why"
}

echo "==> chart defaults and the rollout test profile"

renders "chart defaults render" "$tmp/defaults.yaml" "${release_base[@]}"
assert_safe_defaults "$tmp/defaults.yaml" "chart defaults are Doorbell off and all eight ceilings zero"

renders "the rollout test profile renders" "$tmp/rollout.yaml" "${rollout_base[@]}"
assert_safe_defaults "$tmp/rollout.yaml" "the rolled-back state renders clean"

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
assert_safe_defaults "$tmp/r4.yaml" "the R4 render is the shipped default shape"

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

echo "helm values schema: $pass checks passed"
