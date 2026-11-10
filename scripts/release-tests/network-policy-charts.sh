#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# network-policy-charts.sh
#
# Render tests for the NetworkPolicies of both charts.
#
# Sandbox chart (agent-sandbox-controlplane):
#   - the policy admits every port a control-plane Service targets (derived from
#     the rendered Services and the container's named ports, not listed here);
#   - defaults admit pods only; extraIngressCIDRs adds exactly those ipBlocks.
#
# Claw chart (networkPolicy):
#   - defaults render no NetworkPolicy;
#   - enabled renders default-deny, the ingress allow list only when it has
#     CIDRs, and an egress allow list whose public rule excludes link-local
#     (cloud metadata) and the private ranges;
#   - sandboxEgress renders one policy per namespace, selecting the Hands pods,
#     and refuses to render without a namespace or with a CIDR without ports;
#   - the public rule also excludes Azure's host endpoint 168.63.129.16;
#   - sandboxIngress renders one ingress policy per sandbox namespace admitting
#     only the listed clients, plus the release's Brain and API pods exactly
#     when they reach Hands directly (kubernetes mode, or safe mode without
#     sandboxHandsViaRouter; admitClaw true/false overrides), and refuses an
#     empty client list or an unknown admitClaw.
#
# The renders are parsed as YAML, not grepped.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sandbox_chart="$repo_root/sandbox/deploy/helm"
claw_chart="$repo_root/claw/deploy/charts/claw"

for tool in helm python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required for the NetworkPolicy chart tests" >&2
    exit 1
  }
done
python3 -c 'import yaml' 2>/dev/null || {
  echo "error: python3 PyYAML is required for the NetworkPolicy chart tests" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render_sandbox() {
  local out="$1"
  shift
  helm template sbx "$sandbox_chart" --namespace sandbox-test \
    --set security.allowInsecureNoAuth=true "$@" >"$out"
}

render_claw() {
  local out="$1"
  shift
  helm template primus-claw "$claw_chart" --namespace claw-test \
    --set secret.create=false --set ingress.enabled=false --set postgres.enabled=false \
    "$@" >"$out"
}

check() {
  python3 - "$1" "$2" <<'PY'
import sys
import yaml

path, case = sys.argv[1], sys.argv[2]
docs = [d for d in yaml.safe_load_all(open(path)) if d]

def fail(msg):
    print(f"  FAIL [{case}]: {msg}", file=sys.stderr)
    sys.exit(1)

def policies():
    return [d for d in docs if d.get("kind") == "NetworkPolicy"]

def one(name, namespace=None):
    got = [p for p in policies() if p["metadata"]["name"] == name
           and (namespace is None or p["metadata"].get("namespace") == namespace)]
    if len(got) != 1:
        fail(f"expected one NetworkPolicy {name} in {namespace}, got {len(got)}")
    return got[0]

def ports(rule):
    return sorted((p.get("protocol", "TCP"), p["port"]) for p in rule.get("ports", []))

def ip_blocks(peers):
    return [p["ipBlock"]["cidr"] for p in peers if "ipBlock" in p]

def public_rules(egress):
    return [r for r in egress for p in r.get("to", []) if p.get("ipBlock", {}).get("cidr") == "0.0.0.0/0"]

def check_public(egress, want_ports):
    rules = public_rules(egress)
    if len(rules) != 1:
        fail(f"expected one public egress rule, got {len(rules)}")
    peer = rules[0]["to"][0]["ipBlock"]
    for must in ("169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
                 "168.63.129.16/32"):
        if must not in peer.get("except", []):
            fail(f"public egress does not exclude {must}")
    if ports(rules[0]) != sorted(("TCP", p) for p in want_ports):
        fail(f"public egress ports {ports(rules[0])}, want {want_ports}")

def check_dns(egress, node_local):
    rules = [r for r in egress if ("UDP", 53) in ports(r)]
    if len(rules) != 1:
        fail(f"expected one DNS rule, got {len(rules)}")
    peers = rules[0]["to"]
    if not any(p.get("podSelector", {}).get("matchLabels", {}).get("k8s-app") == "kube-dns" for p in peers):
        fail("DNS rule does not reach kube-dns")
    if ip_blocks(peers) != [f"{ip}/32" for ip in node_local]:
        fail(f"DNS ipBlocks {ip_blocks(peers)}, want {node_local}")

if case.startswith("sandbox-"):
    np = one("agent-sandbox-controlplane")
    rules = np["spec"]["ingress"]
    if len(rules) != 1:
        fail(f"expected one ingress rule, got {len(rules)}")
    admitted = {p["port"] for p in rules[0]["ports"]}
    # Every port a control-plane Service sends to must be admitted.
    dep = [d for d in docs if d.get("kind") == "Deployment" and d["metadata"]["name"] == "agent-sandbox-controlplane"][0]
    named = {p["name"]: p["containerPort"] for c in dep["spec"]["template"]["spec"]["containers"] for p in c.get("ports", [])}
    svcs = [d for d in docs if d.get("kind") == "Service"
            and d["spec"].get("selector", {}).get("app") == "agent-sandbox-controlplane"]
    if len(svcs) < 2:
        fail(f"expected the router and workloadmanager Services, got {len(svcs)}")
    for s in svcs:
        for p in s["spec"]["ports"]:
            target = p.get("targetPort", p["port"])
            target = named.get(target, target)
            if target not in admitted:
                fail(f"Service {s['metadata']['name']} targets port {target}, which the policy does not admit")
    blocks = ip_blocks(rules[0]["from"])
    want = {"sandbox-defaults": [], "sandbox-cidrs": ["10.244.0.0/16", "192.0.2.0/24"]}[case]
    if blocks != want:
        fail(f"ipBlocks {blocks}, want {want}")
    if not any(p == {"namespaceSelector": {}, "podSelector": {}} for p in rules[0]["from"]):
        fail("pods of every namespace are no longer admitted")

elif case == "claw-defaults":
    if policies():
        fail(f"default values rendered {len(policies())} NetworkPolicies")

elif case in ("claw-enabled", "claw-no-ingress"):
    deny = one("default-deny", "claw-test")["spec"]
    if deny["podSelector"] != {} or sorted(deny["policyTypes"]) != ["Egress", "Ingress"] \
            or deny.get("ingress") or deny.get("egress"):
        fail(f"default-deny is not a deny-all: {deny}")
    ingress = [p for p in policies() if p["metadata"]["name"] == "allow-ingress-pod-network"]
    if case == "claw-no-ingress":
        if ingress:
            fail("rendered an ingress allow list with no CIDRs")
    else:
        if len(ingress) != 1 or ip_blocks(ingress[0]["spec"]["ingress"][0]["from"]) != ["10.244.0.0/16"]:
            fail(f"ingress allow list wrong: {ingress}")
        if any("podSelector" in p or "namespaceSelector" in p for p in ingress[0]["spec"]["ingress"][0]["from"]):
            fail("ingress allow list uses selectors")
    egress = one("allow-egress", "claw-test")["spec"]["egress"]
    if not any(r.get("to") == [{"podSelector": {}}] and not r.get("ports") for r in egress):
        fail("own namespace is not reachable")
    check_dns(egress, ["169.254.20.10"] if case == "claw-enabled" else [])
    if case == "claw-enabled":
        check_public(egress, [80, 443, 5671])
        ns_any = [p["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"]
                  for r in egress if not r.get("ports") for p in r.get("to", []) if "namespaceSelector" in p]
        if ns_any != ["safe-ns", "identity-ns"]:
            fail(f"namespaces reachable on any port {ns_any}")
        minio = [r for r in egress if ("TCP", 9000) in ports(r)]
        if len(minio) != 1 or ports(minio[0]) != [("TCP", 9000)]:
            fail(f"object store rule {minio}")
        node = [r for r in egress if ip_blocks(r.get("to", [])) == ["192.0.2.0/24"]]
        if len(node) != 1 or ports(node[0]) != [("TCP", 443), ("TCP", 6443)]:
            fail(f"node subnet rule {node}")
    if [p for p in policies() if p["metadata"]["name"] == "claw-sandbox-egress"]:
        fail("sandbox egress rendered while sandboxEgress.enabled is false")

elif case == "claw-sandbox":
    got = sorted(p["metadata"]["namespace"] for p in policies() if p["metadata"]["name"] == "claw-sandbox-egress")
    if got != ["ws-a", "ws-b"]:
        fail(f"sandbox egress namespaces {got}")
    for ns in got:
        spec = one("claw-sandbox-egress", ns)["spec"]
        if spec["podSelector"] != {"matchLabels": {"primus-claw/component": "hands"}}:
            fail(f"selects {spec['podSelector']}, not the Hands pods")
        if spec["policyTypes"] != ["Egress"]:
            fail(f"policyTypes {spec['policyTypes']}")
        egress = spec["egress"]
        check_dns(egress, ["169.254.20.10"])
        check_public(egress, [80, 443, 22])
        cp = [r for r in egress for p in r.get("to", [])
              if p.get("podSelector", {}).get("matchLabels") == {"app": "agent-sandbox-controlplane"}]
        if len(cp) != 1 or ports(cp[0]) != [("TCP", 8080), ("TCP", 8081)] \
                or cp[0]["to"][0]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"] != "agent-sandbox-system":
            fail(f"control plane rule {cp}")
        if any(not r.get("ports") for r in egress):
            fail("a sandbox egress rule allows every port")
        node = [r for r in egress if ip_blocks(r.get("to", [])) == ["192.0.2.0/24"]]
        if len(node) != 1 or ports(node[0]) != [("TCP", 443)]:
            fail(f"node subnet rule {node}")
    if [p for p in policies() if p["metadata"]["name"] == "default-deny"]:
        fail("release policies rendered while networkPolicy.enabled is false")
    if [p for p in policies() if p["metadata"]["name"] == "claw-sandbox-ingress"]:
        fail("sandbox ingress rendered while sandboxIngress.enabled is false")

elif case.startswith("claw-sandbox-ingress"):
    got = sorted(p["metadata"]["namespace"] for p in policies() if p["metadata"]["name"] == "claw-sandbox-ingress")
    if got != ["ws-a", "ws-b"]:
        fail(f"sandbox ingress namespaces {got}")
    for ns in got:
        spec = one("claw-sandbox-ingress", ns)["spec"]
        if spec["podSelector"] != {"matchLabels": {"primus-claw/component": "hands"}}:
            fail(f"selects {spec['podSelector']}, not the Hands pods")
        if spec["policyTypes"] != ["Ingress"] or spec.get("egress"):
            fail(f"policyTypes {spec['policyTypes']}")
        rules = spec["ingress"]
        if len(rules) != 1 or rules[0].get("ports"):
            fail(f"expected one any-port ingress rule, got {rules}")
        peers = rules[0]["from"]
        want_cp = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "agent-sandbox-system"}},
                   "podSelector": {"matchLabels": {"app": "agent-sandbox-controlplane"}}}
        selectors = [p for p in peers if "ipBlock" not in p]
        claw = [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "claw-test"}},
                 "podSelector": {"matchLabels": {"app": "primus-claw", "component": c}}}
                for c in ("primus-claw-brain", "primus-claw-api")]
        admits_claw = {"claw-sandbox-ingress-direct": True, "claw-sandbox-ingress-router": False,
                       "claw-sandbox-ingress-k8s": True, "claw-sandbox-ingress-never": False,
                       "claw-sandbox-ingress-always": True}[case]
        want = [want_cp] + (claw if admits_claw else [])
        if selectors != want:
            fail(f"selector peers {selectors}, want {want}")
        if ip_blocks(peers) != ["192.0.2.10/32"]:
            fail(f"ipBlocks {ip_blocks(peers)}")
        if any(p.get("namespaceSelector") == {} or p.get("podSelector") == {} for p in peers):
            fail("an empty selector admits every pod")
else:
    fail("unknown case")
print(f"  ok [{case}]")
PY
}

# must_fail <case> <expected stderr fragment> <render args...>
must_fail() {
  local name="$1" want="$2"
  shift 2
  if render_claw "$tmp/$name.yaml" "$@" 2>"$tmp/$name.err"; then
    echo "  FAIL [$name]: rendered, want a refusal" >&2
    exit 1
  fi
  grep -qF "$want" "$tmp/$name.err" || {
    echo "  FAIL [$name]: refusal does not say '$want':" >&2
    cat "$tmp/$name.err" >&2
    exit 1
  }
  echo "  ok [$name]"
}

render_sandbox "$tmp/sandbox-defaults.yaml"
check "$tmp/sandbox-defaults.yaml" sandbox-defaults
render_sandbox "$tmp/sandbox-cidrs.yaml" \
  --set 'controlplane.networkPolicy.extraIngressCIDRs={10.244.0.0/16,192.0.2.0/24}'
check "$tmp/sandbox-cidrs.yaml" sandbox-cidrs

render_claw "$tmp/claw-defaults.yaml"
check "$tmp/claw-defaults.yaml" claw-defaults

cat >"$tmp/np.yaml" <<'YAML'
networkPolicy:
  enabled: true
  ingressCIDRs: [10.244.0.0/16]
  dnsIPs: [169.254.20.10]
  egressNamespaces: [safe-ns, identity-ns]
  egressNamespacePorts: [{namespace: minio, ports: [9000]}]
  egressCIDRs: [{cidr: 192.0.2.0/24, ports: [443, 6443]}]
  publicEgressPorts: [80, 443, 5671]
YAML
render_claw "$tmp/claw-enabled.yaml" -f "$tmp/np.yaml"
check "$tmp/claw-enabled.yaml" claw-enabled

render_claw "$tmp/claw-no-ingress.yaml" --set networkPolicy.enabled=true
check "$tmp/claw-no-ingress.yaml" claw-no-ingress

cat >"$tmp/sb.yaml" <<'YAML'
networkPolicy:
  dnsIPs: [169.254.20.10]
  sandboxEgress:
    enabled: true
    namespaces: [ws-a, ws-b]
    egressCIDRs: [{cidr: 192.0.2.0/24, ports: [443]}]
YAML
render_claw "$tmp/claw-sandbox.yaml" -f "$tmp/sb.yaml"
check "$tmp/claw-sandbox.yaml" claw-sandbox

must_fail claw-sandbox-no-namespace "needs networkPolicy.sandboxEgress.namespaces" \
  --set networkPolicy.sandboxEgress.enabled=true

cat >"$tmp/si.yaml" <<'YAML'
networkPolicy:
  sandboxEgress:
    namespaces: [ws-a, ws-b]
  sandboxIngress:
    enabled: true
    fromCIDRs: [192.0.2.10/32]
YAML
# Safe mode (the default) without the Router's port proxy: Brain and the API
# reach Hands by its cluster DNS name, so they are admitted.
render_claw "$tmp/claw-sandbox-ingress-direct.yaml" -f "$tmp/si.yaml"
check "$tmp/claw-sandbox-ingress-direct.yaml" claw-sandbox-ingress-direct
# Safe mode through the Router: the control plane alone.
render_claw "$tmp/claw-sandbox-ingress-router.yaml" -f "$tmp/si.yaml" --set-string secret.sandboxHandsViaRouter=true
check "$tmp/claw-sandbox-ingress-router.yaml" claw-sandbox-ingress-router
# Kubernetes mode: Brain and the API use the pod IP, the Router flag does not apply.
render_claw "$tmp/claw-sandbox-ingress-k8s.yaml" -f "$tmp/si.yaml" --set secret.clawDeployMode=kubernetes \
  --set-string secret.sandboxHandsViaRouter=true
check "$tmp/claw-sandbox-ingress-k8s.yaml" claw-sandbox-ingress-k8s
render_claw "$tmp/claw-sandbox-ingress-never.yaml" -f "$tmp/si.yaml" --set networkPolicy.sandboxIngress.admitClaw=false
check "$tmp/claw-sandbox-ingress-never.yaml" claw-sandbox-ingress-never
render_claw "$tmp/claw-sandbox-ingress-always.yaml" -f "$tmp/si.yaml" --set-string secret.sandboxHandsViaRouter=true \
  --set networkPolicy.sandboxIngress.admitClaw=true
check "$tmp/claw-sandbox-ingress-always.yaml" claw-sandbox-ingress-always
must_fail claw-sandbox-ingress-bad-admit "admitClaw must be auto, true or false" -f "$tmp/si.yaml" \
  --set networkPolicy.sandboxIngress.admitClaw=maybe

must_fail claw-sandbox-ingress-no-namespace "sandboxIngress.enabled needs networkPolicy.sandboxEgress.namespaces" \
  --set networkPolicy.sandboxIngress.enabled=true
cat >"$tmp/si-empty.yaml" <<'YAML'
networkPolicy:
  sandboxEgress:
    namespaces: [ws-a]
  sandboxIngress:
    enabled: true
    fromPods: []
    fromCIDRs: []
YAML
must_fail claw-sandbox-ingress-no-clients "sandboxIngress needs fromPods or fromCIDRs" -f "$tmp/si-empty.yaml"
cat >"$tmp/noports.yaml" <<'YAML'
networkPolicy:
  enabled: true
  egressCIDRs: [{cidr: 192.0.2.0/24}]
YAML
must_fail claw-cidr-without-ports "egressCIDRs[].ports is required" -f "$tmp/noports.yaml"

echo "NetworkPolicy chart tests passed"
