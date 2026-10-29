#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# a2a-public-url-chart.sh
#
# The ingress serves the API under a path (ingress.path, /claw-api by default)
# and rewrites it away, so the API cannot see the prefix a client has to use.
# An A2A agent card built without it advertises <host>/a2a, a path that 404s.
# The chart therefore has to hand the API CLAW_PUBLIC_URL: derived from the
# ingress by default, overridable by api.publicUrl, and absent when there is
# nothing to derive from (the API then falls back to forwarded headers).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chart_dir="$repo_root/claw/deploy/charts/claw"
release_values="$repo_root/scripts/release-tests/values/claw-release.yaml"

# shellcheck source=scripts/release-tests/forbidden-strings.sh
source "$repo_root/scripts/release-tests/forbidden-strings.sh"

for tool in helm rg; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required for the A2A public URL chart tests" >&2
    exit 1
  }
done
require_ripgrep "A2A public URL chart"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
err="$tmp/err"

ok()  { echo "  ok: $1"; }
bad() { echo "  FAIL: $1" >&2; exit 1; }

base=(-f "$release_values")

render() {
  local out="$1"; shift
  helm template a2a-url-test "$chart_dir" "$@" >"$out" 2>"$err" || bad "render failed: $(cat "$err")"
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

# The API Deployment's CLAW_PUBLIC_URL for the given chart arguments.
api_public_url() {
  local out="$tmp/render.yaml"
  render "$out" "${base[@]}" "$@"
  document_of "$out" "primus-claw/templates/api-deployment.yaml" >"$tmp/api.yaml"
  env_value "$tmp/api.yaml" CLAW_PUBLIC_URL
}

expect() {
  local why="$1" want="$2"; shift 2
  local got
  got="$(api_public_url "$@")"
  [ "$got" = "$want" ] || bad "$why: CLAW_PUBLIC_URL is \"$got\", want \"$want\""
  ok "$why"
}

echo "==> derived from the ingress"

expect "the shipped defaults carry the ingress prefix" \
  "https://claw.release.example/claw-api"
expect "another ingress path is followed" \
  "https://claw.release.example/portal/claw" --set-string ingress.path=/portal/claw
expect "a trailing slash on the path is dropped" \
  "https://claw.release.example/claw-api" --set-string ingress.path=/claw-api/
expect "an ingress at the root has no prefix to carry" \
  "https://claw.release.example" --set-string ingress.path=/
expect "an empty ingress path has no prefix to carry" \
  "https://claw.release.example" --set-string ingress.path=

echo "==> api.publicUrl"

expect "api.publicUrl wins over the ingress" \
  "http://claw.internal.example:8080/claw-api" --set-string api.publicUrl=http://claw.internal.example:8080/claw-api
expect "a trailing slash on api.publicUrl is dropped" \
  "https://gw.example/claw-api" --set-string api.publicUrl=https://gw.example/claw-api/
expect "api.publicUrl applies with no ingress at all" \
  "https://gw.example/claw-api" --set ingress.enabled=false --set-string api.publicUrl=https://gw.example/claw-api

echo "==> nothing to derive from"

expect "no ingress and no api.publicUrl leaves the variable unset" \
  "" --set ingress.enabled=false
render "$tmp/none.yaml" "${base[@]}" --set ingress.enabled=false
if rg -q 'CLAW_PUBLIC_URL' "$tmp/none.yaml"; then bad "CLAW_PUBLIC_URL rendered with nothing to derive it from"; fi
ok "no CLAW_PUBLIC_URL entry renders at all"

echo "==> where it renders"

render "$tmp/on.yaml" "${base[@]}"
if [ "$(rg -c 'name: CLAW_PUBLIC_URL$' "$tmp/on.yaml")" != 1 ]; then
  bad "CLAW_PUBLIC_URL should render in exactly one place, the API Deployment"
fi
document_of "$tmp/on.yaml" "primus-claw/templates/secret.yaml" >"$tmp/secret-doc.yaml"
if rg -q 'CLAW_PUBLIC_URL' "$tmp/secret-doc.yaml"; then bad "CLAW_PUBLIC_URL is in the shared Secret"; fi
ok "only the API Deployment renders it, not the shared Secret"

echo "A2A public URL chart: all checks passed"
