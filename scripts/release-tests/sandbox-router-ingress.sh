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
#   - an enabled Ingress without a selector refuses to render;
#   - the control plane's ClusterRole, rendered and in both plain manifests,
#     grants every rule the controllers' RBAC markers declare, and the
#     generated roles say exactly what the markers do.
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
  REPO_ROOT="$repo_root" python3 - "$1" "$2" <<'PY'
import os
import re
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

def grants(docs):
    return {(g, res, v) for d in docs if d.get("kind") == "ClusterRole" for r in d.get("rules", [])
            for g in r.get("apiGroups", []) for res in r.get("resources", []) for v in r.get("verbs", [])}

def load(rel):
    return [d for d in yaml.safe_load_all(open(os.path.join(os.environ["REPO_ROOT"], rel))) if d]

def marker_grants():
    out = set()
    for sub in ("controllers", "extensions/controllers"):
        for dirpath, _, files in os.walk(os.path.join(os.environ["REPO_ROOT"], "sandbox", sub)):
            for f in sorted(files):
                if not f.endswith(".go") or f.endswith("_test.go"):
                    continue
                for m in re.finditer(r"^//\s*\+kubebuilder:rbac:(\S+)", open(os.path.join(dirpath, f)).read(), re.M):
                    fields = dict(kv.split("=", 1) for kv in m.group(1).split(","))
                    for g in fields["groups"].split(";"):
                        for res in fields["resources"].split(";"):
                            for v in fields["verbs"].split(";"):
                                out.add(("" if g in ("core", '""') else g, res, v))
    return out

if case == "defaults":
    # The markers are what the controllers watch and write; a grant missing
    # here fails their cache sync, and the control plane never starts.
    wanted = marker_grants()
    if ("", "pods", "create") not in wanted:
        fail(f"read no Pod grant from the controllers' RBAC markers, so nothing was checked: {sorted(wanted)}")
    generated = grants(load("sandbox/k8s/rbac.generated.yaml") + load("sandbox/k8s/extensions-rbac.generated.yaml"))
    if generated != wanted:
        fail(f"sandbox/k8s/*rbac.generated.yaml is not what the markers declare (run go generate in sandbox/): "
             f"missing {sorted(wanted - generated)}, extra {sorted(generated - wanted)}")
    roles = [d for d in kind("ClusterRole") if d["metadata"]["name"].startswith("agent-sandbox-controlplane")]
    for name, granted in (("the chart", grants(roles)),
                          ("deploy/k8s", grants(load("sandbox/deploy/k8s/controlplane.yaml"))),
                          ("deploy/k8s-kata", grants(load("sandbox/deploy/k8s-kata/controlplane.yaml")))):
        if not wanted <= granted:
            fail(f"{name}'s control-plane ClusterRole lacks {sorted(wanted - granted)}")
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
    # Only readiness may wait for the namespace cache: a startup probe on
    # /health/ready restarts the control plane when the cache cannot sync.
    c0 = [d for d in kind("Deployment") if d["metadata"]["name"] == "agent-sandbox-controlplane"][0]["spec"]["template"]["spec"]["containers"][0]
    probes = {p: c0.get(p, {}).get("httpGet", {}).get("path") for p in ("startupProbe", "readinessProbe", "livenessProbe")}
    if probes != {"startupProbe": "/health/live", "readinessProbe": "/health/ready", "livenessProbe": "/health/live"}:
        fail(f"probe paths: {probes}")

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

# refused <name> <expected error text> <helm args...> -- the render must fail,
# and for the stated reason.
refused() {
  local name="$1" want="$2"
  shift 2
  if render "$tmp/refused.yaml" "$@" 2>"$tmp/refused.err"; then
    echo "  FAIL [$name]: rendered, want refused" >&2
    exit 1
  fi
  grep -qF "$want" "$tmp/refused.err" || {
    echo "  FAIL [$name]: refused for the wrong reason:" >&2
    cat "$tmp/refused.err" >&2
    exit 1
  }
  echo "  ok: $name refused"
}

# An Ingress without a selector would expose every namespace.
refused no-selector "router.ingress.enabled requires router.config.namespaceSelector" \
  --set router.ingress.enabled=true

# A blank selector is a mistake, not "serve every namespace".
refused blank-selector "router.config.namespaceSelector is only whitespace" \
  --set-string 'router.config.namespaceSelector=  '

# A prefix wider than the namespaced routes would expose unadmitted ones.
for path in / /v1/ /v1/namespaces; do
  refused "ingress-path=$path" "router.ingress.path must start with /v1/namespaces/" \
    --set-string router.config.namespaceSelector=example.com/sandbox=enabled \
    --set router.ingress.enabled=true --set-string "router.ingress.path=$path"
done
