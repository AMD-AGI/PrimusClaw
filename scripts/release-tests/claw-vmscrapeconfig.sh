#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# claw-vmscrapeconfig.sh
#
# Render-time contract of the chart's VMScrapeConfigs (vmscrapeconfig.yaml):
# off by default; placed in the namespace the VMAgent selects while service
# discovery still targets the release namespace; each keeping only its own
# Service's "http" endpoints; job set from the Service name; named so two
# releases cannot overwrite each other; refused together with serviceMonitor.
#
# The failure these guard against is silent: a scrape object the VMAgent does
# not select, or one whose discovery looks in the wrong namespace, is accepted,
# reported operational, and scrapes nothing.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chart_dir="$repo_root/claw/deploy/charts/claw"
release_values="$repo_root/scripts/release-tests/values/claw-release.yaml"

command -v helm >/dev/null 2>&1 || {
  echo "error: helm is required for the VMScrapeConfig render tests" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
err="$tmp/err"

pass=0
ok()  { pass=$((pass + 1)); echo "  ok: $1"; }
bad() { echo "  FAIL: $1" >&2; exit 1; }

render() {
  local out="$1"; shift
  helm template scrape-test "$chart_dir" -n claw-ns -f "$release_values" "$@" \
    >"$out" 2>"$err" || bad "render failed: $(cat "$err")"
}

# The VMScrapeConfig documents only, each followed by a line holding just "==".
# Everything else in the render is dropped so a match below cannot come from
# another kind.
scrapes_of() {
  awk '
    function flush() { if (index(doc, "\nkind: VMScrapeConfig\n")) print substr(doc, 2) "\n=="; doc = "" }
    /^---$/ { flush(); next }
    { doc = doc "\n" $0 }
    END { doc = doc "\n"; flush() }
  ' "$1"
}

# The one VMScrapeConfig whose metadata.name is exactly $2.
scrape_named() {
  scrapes_of "$1" | awk -v want="  name: $2" '
    /^==$/ { if (hit) { printf "%s", doc; exit } doc = ""; hit = 0; next }
    { doc = doc $0 "\n"; if ($0 == want) hit = 1 }
  '
}

has_line() {
  local doc="$1" line="$2" why="$3"
  printf '%s' "$doc" | grep -qxF -- "$line" || bad "$why: missing line '$line' in:
$doc"
}

# Line $2 is immediately followed by line $3 -- for a relabel rule, where the
# source label and the regex only mean something together.
has_pair() {
  local doc="$1" first="$2" second="$3" why="$4"
  printf '%s' "$doc" | awk -v a="$first" -v b="$second" '
    prev == a && $0 == b { found = 1 } { prev = $0 } END { exit !found }
  ' || bad "$why: '$first' is not followed by '$second' in:
$doc"
}

# 1. Off by default: the release values render no VMScrapeConfig at all.
render "$tmp/default.yaml"
[ -z "$(scrapes_of "$tmp/default.yaml")" ] || bad "a default render contains a VMScrapeConfig"
ok "default render has no VMScrapeConfig"

# 2. Placed in another namespace: lives there, discovers the release namespace,
#    keeps only its own Service's http port, and is prefixed with the release
#    namespace.
render "$tmp/placed.yaml" --set vmScrapeConfig.enabled=true --set vmScrapeConfig.namespace=monitoring
count="$(scrapes_of "$tmp/placed.yaml" | grep -cx '==' || true)"
[ "$count" = 2 ] || bad "expected 2 VMScrapeConfigs (api, brain), got $count"
ok "two VMScrapeConfigs rendered"
for component in api brain; do
  doc="$(scrape_named "$tmp/placed.yaml" "claw-ns-primus-claw-$component")"
  [ -n "$doc" ] || bad "no VMScrapeConfig named claw-ns-primus-claw-$component"
  has_line "$doc" "  namespace: monitoring" "$component lives in the VMAgent's namespace"
  has_pair "$doc" "        names:" "          - claw-ns" "$component discovers the release namespace"
  has_pair "$doc" "      sourceLabels: [__meta_kubernetes_service_label_component]" \
    "      regex: primus-claw-$component" "$component keeps only its own Service"
  has_pair "$doc" "      sourceLabels: [__meta_kubernetes_endpoint_port_name]" \
    "      regex: http" "$component keeps only the http port"
  has_pair "$doc" "      sourceLabels: [__meta_kubernetes_service_name]" \
    "      targetLabel: job" "$component takes job from the Service name"
  has_line "$doc" "  metricsPath: /metrics" "$component scrapes /metrics"
  ok "$component: in monitoring, discovering claw-ns/primus-claw-$component:http, job=Service name"
done

# 3. Release namespace (default placement): unprefixed name and no namespace
#    override, so helm's -n decides where it lands.
render "$tmp/local.yaml" --set vmScrapeConfig.enabled=true
doc="$(scrape_named "$tmp/local.yaml" "primus-claw-brain")"
[ -n "$doc" ] || bad "no VMScrapeConfig named primus-claw-brain in the release-namespace render"
if printf '%s' "$doc" | grep -q '^  namespace:'; then
  bad "release-namespace placement must not set metadata.namespace:
$doc"
fi
has_pair "$doc" "        names:" "          - claw-ns" "brain discovers the release namespace"
ok "release-namespace placement: unprefixed, no namespace override"

# 4. Extra relabel rules are appended after the chart's own, and metric
#    relabel rules reach the spec under the VictoriaMetrics field name.
render "$tmp/relabel.yaml" --set vmScrapeConfig.enabled=true \
  --set 'vmScrapeConfig.relabelConfigs[0].targetLabel=team' \
  --set 'vmScrapeConfig.relabelConfigs[0].replacement=claw' \
  --set 'vmScrapeConfig.metricRelabelConfigs[0].action=drop' \
  --set 'vmScrapeConfig.metricRelabelConfigs[0].regex=nodejs_.*'
doc="$(scrape_named "$tmp/relabel.yaml" "primus-claw-brain")"
has_pair "$doc" "      targetLabel: node" "    - replacement: claw" "the extra relabel rule follows the chart's last rule"
has_line "$doc" "  metricRelabelConfigs:" "metricRelabelConfigs is passed through"
has_line "$doc" "      regex: nodejs_.*" "the metricRelabelConfigs entry is the one given"
ok "relabelConfigs appended, metricRelabelConfigs passed through"

# 5. Refused together with serviceMonitor, and the refusal names both keys.
if helm template scrape-test "$chart_dir" -n claw-ns -f "$release_values" \
    --set vmScrapeConfig.enabled=true --set serviceMonitor.enabled=true >/dev/null 2>"$err"; then
  bad "the chart rendered vmScrapeConfig and serviceMonitor together"
fi
grep -qF "vmScrapeConfig.enabled and serviceMonitor.enabled are mutually exclusive" "$err" \
  || bad "the refusal must name both keys, got: $(cat "$err")"
ok "vmScrapeConfig + serviceMonitor refused, naming both keys"

echo "claw VMScrapeConfigs: $pass checks passed"
