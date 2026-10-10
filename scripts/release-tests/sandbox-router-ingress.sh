#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# sandbox-router-ingress.sh
#
# Render tests for the sandbox chart's namespace admission and its optional
# static-prefix Ingress:
#   - defaults render no Ingress, no Namespace RBAC and no selector env;
#   - an enabled Ingress renders exactly one rule with exactly one Prefix path,
#     backed by the chart's own router Service and port;
#   - a namespace selector renders the env var and get/list/watch on namespaces;
#   - an enabled Ingress without a selector refuses to render.
#
# The renders are parsed as YAML, not grepped, so "exactly one" is a count of
# objects and paths rather than of matching lines.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chart_dir="$repo_root/sandbox/deploy/helm"

for tool in helm python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required for the sandbox router ingress tests" >&2
    exit 1
  }
done
python3 -c 'import yaml' 2>/dev/null || {
  echo "error: python3 PyYAML is required for the sandbox router ingress tests" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render() {
  local out="$1"
  shift
  helm template sbx "$chart_dir" --namespace sandbox-test \
    --set redis.password=render-test --set security.allowInsecureNoAuth=true \
    "$@" >"$out"
}

# check <render> <case> -- runs the Python assertions for one case.
check() {
  python3 - "$1" "$2" <<'PY'
import sys
import yaml

path, case = sys.argv[1], sys.argv[2]
docs = [d for d in yaml.safe_load_all(open(path)) if d]

def kind(k):
    return [d for d in docs if d.get("kind") == k]

def fail(msg):
    print(f"  FAIL [{case}]: {msg}", file=sys.stderr)
    sys.exit(1)

def env_of_controlplane():
    deps = [d for d in kind("Deployment") if d["metadata"]["name"] == "agent-sandbox-controlplane"]
    if len(deps) != 1:
        fail(f"expected one controlplane Deployment, got {len(deps)}")
    return {e["name"]: e.get("value") for e in deps[0]["spec"]["template"]["spec"]["containers"][0].get("env", [])}

def namespace_rules():
    out = []
    for cr in kind("ClusterRole"):
        for r in cr.get("rules", []):
            if "namespaces" in r.get("resources", []):
                out.append(r)
    return out

if case == "defaults":
    if kind("Ingress"):
        fail("default values rendered an Ingress")
    if namespace_rules():
        fail("default values granted access to namespaces")
    if "NAMESPACE_SELECTOR" in env_of_controlplane():
        fail("default values set NAMESPACE_SELECTOR")

elif case == "selector":
    if kind("Ingress"):
        fail("a selector alone rendered an Ingress")
    rules = namespace_rules()
    if len(rules) != 1 or sorted(rules[0]["verbs"]) != ["get", "list", "watch"] or rules[0]["apiGroups"] != [""]:
        fail(f"namespace RBAC is not exactly get/list/watch on core namespaces: {rules}")
    if env_of_controlplane().get("NAMESPACE_SELECTOR") != "example.com/sandbox=enabled":
        fail("NAMESPACE_SELECTOR did not carry the selector")

elif case == "ingress":
    ings = kind("Ingress")
    if len(ings) != 1:
        fail(f"expected exactly one Ingress, got {len(ings)}")
    ing = ings[0]
    if ing["metadata"]["name"] != "claw-router-entry":
        fail(f"Ingress name not taken from values: {ing['metadata']['name']}")
    if ing["metadata"].get("namespace") != "sandbox-test":
        fail("Ingress is not in the release namespace")
    if ing["spec"].get("ingressClassName") != "example-class":
        fail("ingressClassName not taken from values")
    if ing["metadata"].get("annotations") != {"example.com/source-allow": "192.0.2.0/24"}:
        fail(f"annotations not passed through verbatim: {ing['metadata'].get('annotations')}")
    rules = ing["spec"]["rules"]
    if len(rules) != 1:
        fail(f"expected one rule, got {len(rules)}")
    if rules[0].get("host") != "sandbox.example.com":
        fail("host not taken from values")
    paths = rules[0]["http"]["paths"]
    if len(paths) != 1:
        fail(f"expected exactly one path, got {len(paths)}")
    p = paths[0]
    if p["path"] != "/v1/namespaces/" or p["pathType"] != "Prefix":
        fail(f"path is not the Prefix /v1/namespaces/: {p}")
    svcs = [s for s in kind("Service")
            if s["metadata"].get("labels", {}).get("app.kubernetes.io/component") == "router"]
    if len(svcs) != 1:
        fail(f"expected one router Service, got {len(svcs)}")
    backend = p["backend"]["service"]
    if backend["name"] != svcs[0]["metadata"]["name"]:
        fail(f"backend {backend['name']} is not the chart's router Service {svcs[0]['metadata']['name']}")
    if backend["port"]["number"] != svcs[0]["spec"]["ports"][0]["port"]:
        fail("backend port is not the router Service port")
    if len(namespace_rules()) != 1:
        fail("an enabled Ingress must come with namespace RBAC")

else:
    fail("unknown case")
print(f"  ok: {case}")
PY
}

render "$tmp/defaults.yaml"
check "$tmp/defaults.yaml" defaults

render "$tmp/selector.yaml" --set-string router.config.namespaceSelector=example.com/sandbox=enabled
check "$tmp/selector.yaml" selector

render "$tmp/ingress.yaml" \
  --set-string router.config.namespaceSelector=example.com/sandbox=enabled \
  --set router.ingress.enabled=true \
  --set router.ingress.name=claw-router-entry \
  --set router.ingress.className=example-class \
  --set router.ingress.host=sandbox.example.com \
  --set-string 'router.ingress.annotations.example\.com/source-allow=192.0.2.0/24'
check "$tmp/ingress.yaml" ingress

# An Ingress without a selector would expose every namespace: refused.
if render "$tmp/refused.yaml" --set router.ingress.enabled=true 2>"$tmp/refused.err"; then
  echo "  FAIL [no-selector]: an enabled Ingress without a namespace selector rendered" >&2
  exit 1
fi
grep -q "router.ingress.enabled requires router.config.namespaceSelector" "$tmp/refused.err" || {
  echo "  FAIL [no-selector]: refused for the wrong reason:" >&2
  cat "$tmp/refused.err" >&2
  exit 1
}
echo "  ok: no-selector refused"
