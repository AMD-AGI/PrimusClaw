#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# identity-client-chart.sh
#
# The chart half of the shared identity client. It ships OFF, and "off" has to
# mean the render is what it was before the client existed: no IDENTITY_* entry
# in either Deployment, whatever else is set under `identity:`. When it is on,
# both Deployments get the same switch, and the client secret arrives as a
# reference to a Secret the operator made, never as a value in the chart.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chart_dir="$repo_root/claw/deploy/charts/claw"
release_values="$repo_root/scripts/release-tests/values/claw-release.yaml"

# shellcheck source=scripts/release-tests/forbidden-strings.sh
source "$repo_root/scripts/release-tests/forbidden-strings.sh"

for tool in helm rg; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required for the identity client chart tests" >&2
    exit 1
  }
done
require_ripgrep "identity client chart"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
err="$tmp/err"

ok()  { echo "  ok: $1"; }
bad() { echo "  FAIL: $1" >&2; exit 1; }

base=(-f "$release_values")
enabled=(
  --set identity.enabled=true
  --set-string identity.issuerUrl=https://idp.example.com
  --set-string identity.clientId=svc-claw
  --set-string identity.clientSecret.existingSecret=claw-identity-client
)

render() {
  local out="$1"; shift
  helm template identity-test "$chart_dir" "$@" >"$out" 2>"$err" || bad "render failed: $(cat "$err")"
}

refuses() {
  local why="$1" needle="$2"; shift 2
  if helm template identity-test "$chart_dir" "$@" >/dev/null 2>"$err"; then
    bad "the chart rendered what it must refuse: $why"
  fi
  rg -qF -- "$needle" "$err" || bad "$why: the refusal must name $needle, got: $(cat "$err")"
  ok "refused: $why"
}

# One Deployment's document out of a whole-chart render.
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

echo "==> off by default"

render "$tmp/default.yaml" "${base[@]}"
if rg -q 'IDENTITY_' "$tmp/default.yaml"; then
  bad "the default render carries an IDENTITY_ entry"
fi
ok "the default render has no IDENTITY_ entry"

# Everything else under identity: set, but not enabled. An operator can stage the
# values and flip one switch, and until then nothing renders.
render "$tmp/staged.yaml" "${base[@]}" \
  --set-string identity.issuerUrl=https://idp.example.com \
  --set-string identity.clientId=svc-claw \
  --set-string identity.clientSecret.existingSecret=claw-identity-client \
  --set identity.cache.positiveSeconds=45 --set-string identity.endpoints.jwks=http://idp.svc/jwks
cmp -s "$tmp/default.yaml" "$tmp/staged.yaml" || bad "staged values changed the render while identity.enabled is false"
ok "staged values change nothing while identity.enabled is false"

rg -q '^  enabled: false$' <(sed -n '/^identity:/,/^  issuerUrl/p' "$chart_dir/values.yaml") \
  || bad "values.yaml does not ship identity.enabled: false"
ok "values.yaml ships identity.enabled: false"

echo "==> enabled"

render "$tmp/on.yaml" "${base[@]}" "${enabled[@]}"
for template in api-deployment.yaml brain-deployment.yaml; do
  doc="$tmp/${template%.yaml}.on"
  document_of "$tmp/on.yaml" "primus-claw/templates/$template" >"$doc"
  [ "$(env_value "$doc" IDENTITY_CLIENT_ENABLED)" = "true" ] || bad "$template: IDENTITY_CLIENT_ENABLED is not true"
  [ "$(env_value "$doc" IDENTITY_ISSUER_URL)" = "https://idp.example.com" ] || bad "$template: IDENTITY_ISSUER_URL wrong"
  [ "$(env_value "$doc" IDENTITY_CLIENT_ID)" = "svc-claw" ] || bad "$template: IDENTITY_CLIENT_ID wrong"
  rg -N -A5 '^[[:space:]]*- name: IDENTITY_CLIENT_SECRET$' "$doc" | rg -q 'secretKeyRef:' \
    || bad "$template: the client secret is not a secretKeyRef"
  rg -N -A5 '^[[:space:]]*- name: IDENTITY_CLIENT_SECRET$' "$doc" | rg -q 'name: "claw-identity-client"' \
    || bad "$template: the client secret does not name the operator's Secret"
  rg -N -A5 '^[[:space:]]*- name: IDENTITY_CLIENT_SECRET$' "$doc" | rg -q 'key: "client-secret"' \
    || bad "$template: the client secret key is not the default"
  rg -N -A1 '^[[:space:]]*- name: IDENTITY_CLIENT_SECRET$' "$doc" | rg -q '^[[:space:]]*valueFrom:' \
    || bad "$template: the client secret is not read through valueFrom"
  # No optional member renders until it is set.
  for optional in IDENTITY_DISCOVERY_URL IDENTITY_INTROSPECTION_URL IDENTITY_TOKEN_URL IDENTITY_JWKS_URL \
      IDENTITY_INTROSPECTION_CACHE_SECONDS IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS \
      IDENTITY_STALE_IF_ERROR_SECONDS IDENTITY_REQUEST_TIMEOUT_MS IDENTITY_KEYS_REFRESH_SECONDS \
      IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS; do
    if rg -q "name: $optional\$" "$doc"; then bad "$template: $optional rendered although unset"; fi
  done
done
ok "API and Brain both get the switch, the issuer, the client id and a secretKeyRef"

# The secret never goes through the chart-managed Secret, and no other workload
# (the reaper) takes the client.
document_of "$tmp/on.yaml" "primus-claw/templates/secret.yaml" >"$tmp/secret-doc.yaml"
if rg -q 'IDENTITY_' "$tmp/secret-doc.yaml"; then bad "an IDENTITY_ entry is in the shared Secret"; fi
if [ "$(rg -c 'name: IDENTITY_CLIENT_ENABLED$' "$tmp/on.yaml")" != 2 ]; then
  bad "IDENTITY_CLIENT_ENABLED should render in exactly the two Deployments"
fi
ok "the shared Secret carries none of it, and only API and Brain render it"

echo "==> optional members"

render "$tmp/opt.yaml" "${base[@]}" "${enabled[@]}" \
  --set-string identity.discoveryUrl=http://idp.svc/.well-known/openid-configuration \
  --set-string identity.endpoints.introspection=http://idp.svc/introspect \
  --set-string identity.endpoints.token=http://idp.svc/token \
  --set-string identity.endpoints.jwks=http://idp.svc/jwks \
  --set identity.cache.positiveSeconds=45 \
  --set identity.cache.negativeSeconds=0 \
  --set identity.cache.staleIfErrorSeconds=0 \
  --set identity.requestTimeoutMs=1500 \
  --set identity.keysRefreshSeconds=120 \
  --set identity.exchangeRefreshSkewSeconds=10 \
  --set-string identity.clientSecret.key=secret-key
document_of "$tmp/opt.yaml" "primus-claw/templates/api-deployment.yaml" >"$tmp/api.opt"
want() { [ "$(env_value "$tmp/api.opt" "$1")" = "$2" ] || bad "$1 did not render as \"$2\", got \"$(env_value "$tmp/api.opt" "$1")\""; }
want IDENTITY_DISCOVERY_URL http://idp.svc/.well-known/openid-configuration
want IDENTITY_INTROSPECTION_URL http://idp.svc/introspect
want IDENTITY_TOKEN_URL http://idp.svc/token
want IDENTITY_JWKS_URL http://idp.svc/jwks
want IDENTITY_INTROSPECTION_CACHE_SECONDS 45
# Zero is the off switch for these two, so it has to survive: the chart's usual
# trap is a template that reads 0 as absent and drops the key.
want IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS 0
want IDENTITY_STALE_IF_ERROR_SECONDS 0
want IDENTITY_REQUEST_TIMEOUT_MS 1500
want IDENTITY_KEYS_REFRESH_SECONDS 120
want IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS 10
rg -N -A5 '^[[:space:]]*- name: IDENTITY_CLIENT_SECRET$' "$tmp/api.opt" | rg -q 'key: "secret-key"' \
  || bad "identity.clientSecret.key did not reach the secretKeyRef"
ok "every optional member renders when set, and zero survives"

# Blank leaves the variable unset, so the code default is in charge.
render "$tmp/blank.yaml" "${base[@]}" "${enabled[@]}" \
  --set-string identity.cache.positiveSeconds= --set-string identity.cache.staleIfErrorSeconds=
if rg -q 'IDENTITY_INTROSPECTION_CACHE_SECONDS|IDENTITY_STALE_IF_ERROR_SECONDS' "$tmp/blank.yaml"; then
  bad "a blank numeric value rendered an entry"
fi
ok "a blank numeric value renders nothing"

echo "==> refusals"

refuses "enabled with no issuer" "identity.issuerUrl is required" \
  "${base[@]}" --set identity.enabled=true --set-string identity.clientId=c --set-string identity.clientSecret.existingSecret=s
refuses "enabled with no client id" "identity.clientId is required" \
  "${base[@]}" --set identity.enabled=true --set-string identity.issuerUrl=https://i.example.com --set-string identity.clientSecret.existingSecret=s
refuses "enabled with no secret reference" "identity.clientSecret.existingSecret is required" \
  "${base[@]}" --set identity.enabled=true --set-string identity.issuerUrl=https://i.example.com --set-string identity.clientId=c
refuses "enabled as a string that is not a boolean" "identity.enabled: Invalid type" \
  "${base[@]}" --set-string identity.enabled=yes
for bad_number in -1 abc 1.5 9999999999; do
  refuses "identity.cache.positiveSeconds=$bad_number" "positiveSeconds" \
    "${base[@]}" --set-string "identity.cache.positiveSeconds=$bad_number"
done

# The same bounds for a value that arrives as a number (--set) rather than text.
for bad_number in -1 1000000000; do
  refuses "identity.cache.positiveSeconds=$bad_number as a number" "positiveSeconds" \
    "${base[@]}" --set "identity.cache.positiveSeconds=$bad_number"
done

echo "identity client chart: all checks passed"
