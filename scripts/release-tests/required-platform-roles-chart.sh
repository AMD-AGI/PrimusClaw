#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# required-platform-roles-chart.sh
#
# api.requiredPlatformRoles is the chart's spelling of CLAW_REQUIRED_PLATFORM_ROLES,
# the platform roles of which a caller must hold one to use Claw at all. Empty is
# today's behaviour, so the default render must carry nothing; set, it reaches the
# API Deployment and nowhere else (Brain authenticates nobody with it, and the
# shared Secret is not where a setting goes); and a value that could not survive
# the comma-separated list it renders into is refused at render time.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chart_dir="$repo_root/claw/deploy/charts/claw"
release_values="$repo_root/scripts/release-tests/values/claw-release.yaml"

# shellcheck source=scripts/release-tests/forbidden-strings.sh
source "$repo_root/scripts/release-tests/forbidden-strings.sh"

for tool in helm rg; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required for the required-platform-roles chart tests" >&2
    exit 1
  }
done
require_ripgrep "required platform roles chart"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
err="$tmp/err"

ok()  { echo "  ok: $1"; }
bad() { echo "  FAIL: $1" >&2; exit 1; }

base=(-f "$release_values")

render() {
  local out="$1"; shift
  helm template roles-test "$chart_dir" "${base[@]}" "$@" >"$out" 2>"$err" || bad "render failed: $(cat "$err")"
}

# One template's document out of a whole-chart render.
document_of() {
  awk -v want="$2" '
    /^# Source: /  { emit = ($3 == want) }
    emit           { print }
  ' "$1"
}

# `name:` and `value:` are separate lines, so assert the pair.
env_value() {
  local doc="$1" key="$2"
  rg -N -A1 "^[[:space:]]*- name: $key\$" "$doc" | rg -o '^[[:space:]]*value: "(.*)"$' -r '$1' || true
}

refused() {
  local why="$1"; shift
  if helm template roles-test "$chart_dir" "${base[@]}" "$@" >"$tmp/refused.yaml" 2>"$err"; then
    bad "$why: the chart rendered"
  fi
  rg -q 'requiredPlatformRoles' "$err" || bad "$why: refused, but not naming api.requiredPlatformRoles: $(head -c 400 "$err")"
  ok "$why"
}

echo "==> default"

render "$tmp/default.yaml"
if rg -q 'CLAW_REQUIRED_PLATFORM_ROLES' "$tmp/default.yaml"; then
  bad "the default render carries CLAW_REQUIRED_PLATFORM_ROLES"
fi
ok "nothing renders while api.requiredPlatformRoles is empty"

echo "==> set"

render "$tmp/one.yaml" --set-json 'api.requiredPlatformRoles=["default"]'
document_of "$tmp/one.yaml" "primus-claw/templates/api-deployment.yaml" >"$tmp/api.yaml"
[ "$(env_value "$tmp/api.yaml" CLAW_REQUIRED_PLATFORM_ROLES)" = "default" ] \
  || bad "the API Deployment does not get CLAW_REQUIRED_PLATFORM_ROLES=default"
ok "one role renders as itself"

render "$tmp/two.yaml" --set-json 'api.requiredPlatformRoles=["default","system-admin"]'
document_of "$tmp/two.yaml" "primus-claw/templates/api-deployment.yaml" >"$tmp/api2.yaml"
[ "$(env_value "$tmp/api2.yaml" CLAW_REQUIRED_PLATFORM_ROLES)" = "default,system-admin" ] \
  || bad "two roles do not render as a comma-separated list"
ok "two roles render comma-separated, in order"

[ "$(rg -c 'name: CLAW_REQUIRED_PLATFORM_ROLES$' "$tmp/two.yaml")" = 1 ] \
  || bad "CLAW_REQUIRED_PLATFORM_ROLES should render in exactly one place, the API Deployment"
document_of "$tmp/two.yaml" "primus-claw/templates/secret.yaml" >"$tmp/secret-doc.yaml"
if rg -q 'CLAW_REQUIRED_PLATFORM_ROLES' "$tmp/secret-doc.yaml"; then bad "CLAW_REQUIRED_PLATFORM_ROLES is in the shared Secret"; fi
ok "only the API Deployment renders it"

echo "==> refused at render time"

refused "a role with a comma in it would become two" --set-json 'api.requiredPlatformRoles=["a,b"]'
refused "a role with a space in it would become two" --set-json 'api.requiredPlatformRoles=["a b"]'
refused "an empty role name" --set-json 'api.requiredPlatformRoles=[""]'
refused "a string is not a list" --set-string api.requiredPlatformRoles=default

echo "required platform roles chart: all checks passed"
