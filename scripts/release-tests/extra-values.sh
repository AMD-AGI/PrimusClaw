#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# extra-values.sh
#
# claw/deploy/extra-values.py turns EXTRA_* lines of values.<ns>.env into the
# api.extra* / brain.extra* chart values that upgrade.sh and deploy.sh render
# with. Whatever it cannot express is a setting the next upgrade.sh silently
# reverts, so what it does express has to be exact: nothing set renders nothing,
# each setting lands on the one container it names, a ConfigMap mount and a
# Secret mount sit side by side without sharing a volume name, and a malformed
# entry stops the render instead of being dropped. So does a mount path that is
# used twice in one container, or that the chart itself mounts there: the API
# server rejects that Deployment only at kubectl apply, after api has rolled, so
# the render has to be where it stops. What the chart mounts is read from the
# chart (charts/claw/mount-paths.json, which the Deployments render from too), and
# this test checks that file against the rendered Deployments.
#
# An env var whose value lives in a Secret (EXTRA_SECRET_ENV_{API,BRAIN}_<NAME>=
# "<secret>:<key>") is a setting of the same kind: without it a secretKeyRef env
# var can only be patched onto the live Deployment, and the next upgrade.sh drops
# it. It must render as valueFrom.secretKeyRef on the container it names, refuse
# a malformed reference without echoing what was typed (a literal secret put in the
# wrong place must not reach a log), and refuse a name that is set twice in one
# container: by an EXTRA_ENV_* entry, or by the chart itself. The chart's names
# depend on what is switched on in this very render (a NATS credential read back
# from the cluster, a CA ConfigMap, the identity client), so that last one is
# decided on the rendered Deployment, before anything is applied.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
chart_dir="$repo_root/claw/deploy/charts/claw"
release_values="$repo_root/scripts/release-tests/values/claw-release.yaml"
script="$repo_root/claw/deploy/extra-values.py"

for tool in helm python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required for the extra-values tests" >&2
    exit 1
  }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
err="$tmp/err"

ok()  { echo "  ok: $1"; }
bad() { echo "  FAIL: $1" >&2; exit 1; }

# Runs the script with exactly the variables given and nothing else from the
# caller's environment, so a stray EXTRA_* in a developer shell cannot move it.
extra() {
  env -i PATH="$PATH" "$@" python3 "$script"
}

echo "==> nothing set renders nothing"
[ "$(extra | python3 -c 'import json,sys; print(json.load(sys.stdin))')" = "{}" ] \
  || bad "an empty environment did not give {}"
ok "empty environment gives {}"

echo "==> every kind lands on the container it names"
extra \
  EXTRA_ENV_API_APP_FLAG=true \
  "EXTRA_ENV_API_APP_JSON={\"a\":1,\"b\":[2,3]}" \
  EXTRA_ENV_BRAIN_BRAIN_FLAG=on \
  "EXTRA_CONFIGMAP_MOUNTS_BRAIN=cm-one:/etc/one cm-two:/etc/two" \
  EXTRA_SECRET_MOUNTS_API=sec-one:/var/run/one \
  "EXTRA_SECRET_MOUNTS_BRAIN=sec-two:/var/run/two sec-three:/var/run/three" \
  >"$tmp/all.json"
python3 - "$tmp/all.json" <<'PY' || bad "the rendered values are not what the settings name"
import json, sys
got = json.load(open(sys.argv[1]))
want = {
    "api": {
        "extraEnv": [
            {"name": "APP_FLAG", "value": "true"},
            {"name": "APP_JSON", "value": '{"a":1,"b":[2,3]}'},
        ],
        "extraVolumes": [{"name": "extra-secret-0", "secret": {"secretName": "sec-one"}}],
        "extraVolumeMounts": [{"name": "extra-secret-0", "mountPath": "/var/run/one", "readOnly": True}],
    },
    "brain": {
        "extraEnv": [{"name": "BRAIN_FLAG", "value": "on"}],
        "extraVolumes": [
            {"name": "extra-cm-0", "configMap": {"name": "cm-one"}},
            {"name": "extra-cm-1", "configMap": {"name": "cm-two"}},
            {"name": "extra-secret-0", "secret": {"secretName": "sec-two"}},
            {"name": "extra-secret-1", "secret": {"secretName": "sec-three"}},
        ],
        "extraVolumeMounts": [
            {"name": "extra-cm-0", "mountPath": "/etc/one", "readOnly": True},
            {"name": "extra-cm-1", "mountPath": "/etc/two", "readOnly": True},
            {"name": "extra-secret-0", "mountPath": "/var/run/two", "readOnly": True},
            {"name": "extra-secret-1", "mountPath": "/var/run/three", "readOnly": True},
        ],
    },
}
if got != want:
    sys.stderr.write("got:  %s\nwant: %s\n" % (json.dumps(got, sort_keys=True), json.dumps(want, sort_keys=True)))
    sys.exit(1)
PY
ok "env, ConfigMap mounts and Secret mounts reach only the container they name"

echo "==> a ConfigMap-only file renders what it did before Secret mounts existed"
extra EXTRA_CONFIGMAP_MOUNTS_BRAIN=cm-one:/etc/one >"$tmp/cm.json"
python3 - "$tmp/cm.json" <<'PY' || bad "a ConfigMap-only setting changed shape"
import json, sys
got = json.load(open(sys.argv[1]))
want = {"brain": {
    "extraVolumes": [{"name": "extra-cm-0", "configMap": {"name": "cm-one"}}],
    "extraVolumeMounts": [{"name": "extra-cm-0", "mountPath": "/etc/one", "readOnly": True}],
}}
sys.exit(0 if got == want else 1)
PY
ok "the volume stays extra-cm-0 and nothing else appears"

echo "==> a malformed entry stops the render"
refuses() {
  local why="$1" needle="$2"; shift 2
  if extra "$@" >/dev/null 2>"$err"; then
    bad "accepted: $why"
  fi
  grep -qF -- "$needle" "$err" || bad "$why: the refusal must name $needle, got: $(cat "$err")"
  ok "refused: $why"
}
refuses "a Secret entry with no mount path"          EXTRA_SECRET_MOUNTS_API    EXTRA_SECRET_MOUNTS_API=sec-one
refuses "a Secret entry with a relative mount path"  EXTRA_SECRET_MOUNTS_BRAIN  EXTRA_SECRET_MOUNTS_BRAIN=sec-one:var/run
refuses "a Secret entry that is the root"            EXTRA_SECRET_MOUNTS_BRAIN  EXTRA_SECRET_MOUNTS_BRAIN=sec-one:/
refuses "a Secret name with capitals"                EXTRA_SECRET_MOUNTS_API    EXTRA_SECRET_MOUNTS_API=Sec_One:/var/run/one
refuses "a ConfigMap entry with no mount path"       EXTRA_CONFIGMAP_MOUNTS_API EXTRA_CONFIGMAP_MOUNTS_API=cm-one
refuses "an env name that is not a variable name"    EXTRA_ENV_API_1BAD         EXTRA_ENV_API_1BAD=x

echo "==> a mount path used twice in one container stops the render"
# Naming the variable is not enough when two of them are involved: the reader has
# to be told which entry the refused one collides with.
also_names() { grep -qF -- "$1" "$err" || bad "the refusal must also name $1, got: $(cat "$err")"; }
refuses "a ConfigMap and a Secret at one path (brain)" EXTRA_SECRET_MOUNTS_BRAIN \
  EXTRA_CONFIGMAP_MOUNTS_BRAIN=cm-one:/etc/x EXTRA_SECRET_MOUNTS_BRAIN=sec-one:/etc/x
also_names EXTRA_CONFIGMAP_MOUNTS_BRAIN
refuses "a Secret and a ConfigMap at one path (api)" EXTRA_SECRET_MOUNTS_API \
  EXTRA_CONFIGMAP_MOUNTS_API=cm-one:/etc/x EXTRA_SECRET_MOUNTS_API=sec-one:/etc/x
also_names EXTRA_CONFIGMAP_MOUNTS_API
refuses "two Secrets at one path" EXTRA_SECRET_MOUNTS_API \
  "EXTRA_SECRET_MOUNTS_API=sec-one:/etc/x sec-two:/etc/x"
refuses "two ConfigMaps at one path" EXTRA_CONFIGMAP_MOUNTS_BRAIN \
  "EXTRA_CONFIGMAP_MOUNTS_BRAIN=cm-one:/etc/x cm-two:/etc/x"
# The API server compares the strings it is given, but the runtime mounts the
# directory, so the same directory written another way is refused too.
for spelling in /etc/x/ /etc//x //etc/x /etc/./x /etc/y/../x; do
  refuses "/etc/x written as $spelling" EXTRA_SECRET_MOUNTS_BRAIN \
    EXTRA_CONFIGMAP_MOUNTS_BRAIN=cm-one:/etc/x "EXTRA_SECRET_MOUNTS_BRAIN=sec-one:$spelling"
done
refuses "a Secret at the root written as /." EXTRA_SECRET_MOUNTS_BRAIN EXTRA_SECRET_MOUNTS_BRAIN=sec-one:/.

# Different containers have different mount tables, and so do different paths.
extra \
  EXTRA_CONFIGMAP_MOUNTS_API=cm-one:/etc/x EXTRA_SECRET_MOUNTS_BRAIN=sec-one:/etc/x \
  EXTRA_SECRET_MOUNTS_API=sec-two:/etc/y EXTRA_CONFIGMAP_MOUNTS_BRAIN=cm-two:/etc/y/z \
  >/dev/null 2>"$err" || bad "refused paths that are free in their own container: $(cat "$err")"
ok "the same path in api and brain, and a path under another, are accepted"

echo "==> the chart renders the mounts into the right Deployment"
extra \
  EXTRA_CONFIGMAP_MOUNTS_BRAIN=cm-one:/etc/one \
  EXTRA_SECRET_MOUNTS_API=sec-one:/var/run/one \
  EXTRA_SECRET_MOUNTS_BRAIN=sec-two:/var/run/two \
  >"$tmp/chart-values.json"
helm template extra-test "$chart_dir" -f "$release_values" -f "$tmp/chart-values.json" >"$tmp/render.yaml" 2>"$err" \
  || bad "the chart refused the extra values: $(cat "$err")"

# One Deployment's document out of a whole-chart render.
document_of() {
  awk -v want="$2" '
    /^# Source: /  { emit = ($3 == want) }
    emit           { print }
  ' "$1"
}
document_of "$tmp/render.yaml" primus-claw/templates/api-deployment.yaml   >"$tmp/api.yaml"
document_of "$tmp/render.yaml" primus-claw/templates/brain-deployment.yaml >"$tmp/brain.yaml"

has() { # file, python regex over the whole document
  python3 - "$1" "$2" <<'PY'
import re, sys
sys.exit(0 if re.search(sys.argv[2], open(sys.argv[1]).read(), re.M) else 1)
PY
}
has "$tmp/api.yaml"   '- name: extra-secret-0\n\s+secret:\n\s+secretName: sec-one\n' || bad "api does not carry the Secret volume"
has "$tmp/api.yaml"   '- mountPath: /var/run/one\n\s+name: extra-secret-0\n\s+readOnly: true\n' || bad "api does not mount the Secret read-only"
has "$tmp/brain.yaml" '- configMap:\n\s+name: cm-one\n\s+name: extra-cm-0\n' || bad "brain does not carry the ConfigMap volume"
has "$tmp/brain.yaml" '- name: extra-secret-0\n\s+secret:\n\s+secretName: sec-two\n' || bad "brain does not carry the Secret volume"
has "$tmp/brain.yaml" '- mountPath: /etc/one\n\s+name: extra-cm-0\n\s+readOnly: true\n' || bad "brain does not mount the ConfigMap read-only"
has "$tmp/brain.yaml" '- mountPath: /var/run/two\n\s+name: extra-secret-0\n\s+readOnly: true\n' || bad "brain does not mount the Secret read-only"
if has "$tmp/api.yaml" 'sec-two|cm-one'; then bad "api carries a mount that was set for brain"; fi
if has "$tmp/brain.yaml" 'sec-one'; then bad "brain carries a mount that was set for api"; fi
ok "each Deployment carries its own mounts, read-only, and none of the other's"

echo "==> every directory the chart mounts is refused, in the container it mounts it into"
# Render with every switch that adds a mount turned on, so the Deployments show
# every directory the chart can mount (the release values leave the optional ones off).
helm template extra-test "$chart_dir" -f "$release_values" \
  --set-string tls.extraCACertsConfigMap=ca-cm --set-string tls.extraCACertsKey=ca.crt \
  --set grantSigningKey.enabled=true --set-string sandboxTemplate.codeInterpreterYaml=x \
  >"$tmp/render-all.yaml" 2>"$err" || bad "the chart did not render with every mount switch on: $(cat "$err")"
document_of "$tmp/render-all.yaml" primus-claw/templates/api-deployment.yaml   >"$tmp/api-all.yaml"
document_of "$tmp/render-all.yaml" primus-claw/templates/brain-deployment.yaml >"$tmp/brain-all.yaml"
mount_paths_of() { sed -n 's/^[[:space:]]*\(-[[:space:]]*\)\{0,1\}mountPath:[[:space:]]*//p' "$1" | sort -u; }
mount_paths_of "$tmp/api-all.yaml"   >"$tmp/api.paths"
mount_paths_of "$tmp/brain-all.yaml" >"$tmp/brain.paths"
[ -s "$tmp/api.paths" ] && [ -s "$tmp/brain.paths" ] || bad "found no mountPath in a rendered Deployment, so there is nothing to compare"

# Every mountPath of a Deployment comes from mount-paths.json. A path typed into
# a template again would be one extra-values.py never hears about.
if grep -n 'mountPath:' "$chart_dir/templates/api-deployment.yaml" "$chart_dir/templates/brain-deployment.yaml" \
    | grep -vF 'include "primus-claw.mountPath"'; then
  bad "a Deployment template writes a mountPath instead of taking it from mount-paths.json"
fi
python3 - "$chart_dir/mount-paths.json" "$tmp/api.paths" "$tmp/brain.paths" <<'PY' || bad "mount-paths.json is not what the chart renders"
import json, sys
want = json.load(open(sys.argv[1]))
if sorted(want) != ["api", "brain"]:
    sys.exit("mount-paths.json must describe exactly api and brain, got %s" % sorted(want))
for key, listing in (("api", sys.argv[2]), ("brain", sys.argv[3])):
    got = sorted(l.strip() for l in open(listing) if l.strip())
    exp = sorted(want[key].values())
    if got != exp:
        sys.exit("%s: the chart renders %s, mount-paths.json says %s" % (key, got, exp))
PY
ok "the Deployments mount exactly what mount-paths.json lists, and take it from there"

for tag in API BRAIN; do
  lower="$(echo "$tag" | tr '[:upper:]' '[:lower:]')"
  while read -r path; do
    refuses "the chart's own $path in $lower, as a Secret"    "EXTRA_SECRET_MOUNTS_$tag"    "EXTRA_SECRET_MOUNTS_$tag=sec-one:$path"
    refuses "the chart's own $path in $lower, as a ConfigMap" "EXTRA_CONFIGMAP_MOUNTS_$tag" "EXTRA_CONFIGMAP_MOUNTS_$tag=cm-one:$path"
    refuses "the chart's own $path/ in $lower, with a trailing slash" "EXTRA_SECRET_MOUNTS_$tag" "EXTRA_SECRET_MOUNTS_$tag=sec-one:$path/"
  done <"$tmp/$lower.paths"
done

# The other container's table is not this one's: the chart mounts /var/run/claw/grant
# into api only and /etc/claw into brain only.
extra EXTRA_SECRET_MOUNTS_BRAIN=sec-one:/var/run/claw/grant EXTRA_SECRET_MOUNTS_API=sec-two:/etc/claw \
  >/dev/null 2>"$err" || bad "refused a path the chart mounts into the other container only: $(cat "$err")"
ok "a path the chart mounts into one container stays free in the other"

echo "==> a Secret-backed env var renders valueFrom.secretKeyRef on the container it names"
extra \
  EXTRA_ENV_API_APP_FLAG=true \
  EXTRA_SECRET_ENV_API_IDENTITY_CLIENT_SECRET=claw-api-identity-v2:client_secret \
  EXTRA_SECRET_ENV_API_IDENTITY_CLIENT_ID=claw-api-identity-v2:client_id \
  EXTRA_SECRET_ENV_BRAIN_A2A_PEER_TOKEN_CI=a2a-peer-ci:token \
  EXTRA_SECRET_ENV_BRAIN_TLS_CERT=my.secret-1:tls.crt \
  EXTRA_SECRET_MOUNTS_API=sec-one:/var/run/one \
  >"$tmp/secret-env.json"
python3 - "$tmp/secret-env.json" <<'PY' || bad "the rendered values are not what the Secret env settings name"
import json, sys
got = json.load(open(sys.argv[1]))
def ref(name, secret, key):
    return {"name": name, "valueFrom": {"secretKeyRef": {"name": secret, "key": key}}}
want = {
    "api": {
        "extraEnv": [
            {"name": "APP_FLAG", "value": "true"},
            ref("IDENTITY_CLIENT_ID", "claw-api-identity-v2", "client_id"),
            ref("IDENTITY_CLIENT_SECRET", "claw-api-identity-v2", "client_secret"),
        ],
        "extraVolumes": [{"name": "extra-secret-0", "secret": {"secretName": "sec-one"}}],
        "extraVolumeMounts": [{"name": "extra-secret-0", "mountPath": "/var/run/one", "readOnly": True}],
    },
    "brain": {
        "extraEnv": [
            ref("A2A_PEER_TOKEN_CI", "a2a-peer-ci", "token"),
            ref("TLS_CERT", "my.secret-1", "tls.crt"),
        ],
    },
}
if got != want:
    sys.stderr.write("got:  %s\nwant: %s\n" % (json.dumps(got, sort_keys=True), json.dumps(want, sort_keys=True)))
    sys.exit(1)
PY
ok "api and brain each get only their own references, after the plain entries, next to the mounts"

extra EXTRA_SECRET_ENV_BRAIN_ONLY_THIS=sec-one:token >"$tmp/secret-env-only.json"
python3 - "$tmp/secret-env-only.json" <<'PY' || bad "a Secret env var alone must render only brain.extraEnv"
import json, sys
got = json.load(open(sys.argv[1]))
want = {"brain": {"extraEnv": [{"name": "ONLY_THIS", "valueFrom": {"secretKeyRef": {"name": "sec-one", "key": "token"}}}]}}
sys.exit(0 if got == want else 1)
PY
ok "a Secret env var alone adds no volume and touches no other container"

echo "==> a malformed Secret env reference stops the render"
refuses "a Secret env entry with no key"            EXTRA_SECRET_ENV_API_TOKEN EXTRA_SECRET_ENV_API_TOKEN=sec-one
refuses "a Secret env entry with an empty key"      EXTRA_SECRET_ENV_API_TOKEN EXTRA_SECRET_ENV_API_TOKEN=sec-one:
refuses "a Secret env entry with no Secret name"    EXTRA_SECRET_ENV_BRAIN_TOKEN EXTRA_SECRET_ENV_BRAIN_TOKEN=:token
refuses "a blank Secret env entry"                  EXTRA_SECRET_ENV_API_TOKEN EXTRA_SECRET_ENV_API_TOKEN=
refuses "a Secret name with capitals"               EXTRA_SECRET_ENV_API_TOKEN EXTRA_SECRET_ENV_API_TOKEN=Sec_One:token
refuses "a Secret name of 254 characters"           EXTRA_SECRET_ENV_API_TOKEN "EXTRA_SECRET_ENV_API_TOKEN=$(python3 -c 'print("a" * 254)'):token"
refuses "a key with a slash"                        EXTRA_SECRET_ENV_API_TOKEN EXTRA_SECRET_ENV_API_TOKEN=sec-one:a/b
refuses "a key with a second colon"                 EXTRA_SECRET_ENV_API_TOKEN EXTRA_SECRET_ENV_API_TOKEN=sec-one:a:b
refuses "a key with a space"                        EXTRA_SECRET_ENV_API_TOKEN "EXTRA_SECRET_ENV_API_TOKEN=sec-one:a b"
refuses "a key of .."                               EXTRA_SECRET_ENV_API_TOKEN EXTRA_SECRET_ENV_API_TOKEN=sec-one:..
refuses "a key starting with .."                    EXTRA_SECRET_ENV_API_TOKEN EXTRA_SECRET_ENV_API_TOKEN=sec-one:..data
refuses "a key of 254 characters"                   EXTRA_SECRET_ENV_API_TOKEN "EXTRA_SECRET_ENV_API_TOKEN=sec-one:$(python3 -c 'print("k" * 254)')"
refuses "a Secret env name that is not a variable name" EXTRA_SECRET_ENV_API_1BAD EXTRA_SECRET_ENV_API_1BAD=sec-one:token
refuses "a Secret env entry with no name at all"    EXTRA_SECRET_ENV_API_ EXTRA_SECRET_ENV_API_=sec-one:token

# What was typed is a Secret name and a key. When it is the secret itself, put in
# the wrong variable, the refusal must still not repeat it: this output reaches
# terminals and CI logs.
literal="hunter2-not-a-reference"
if extra "EXTRA_SECRET_ENV_API_TOKEN=$literal" >/dev/null 2>"$err"; then bad "accepted a literal value as a Secret reference"; fi
grep -qF -- EXTRA_SECRET_ENV_API_TOKEN "$err" || bad "the refusal must name EXTRA_SECRET_ENV_API_TOKEN, got: $(cat "$err")"
if grep -qF -- "$literal" "$err"; then bad "the refusal printed the value it was given: $(cat "$err")"; fi
ok "a literal value in a Secret env variable is refused without being printed"

echo "==> an env var set twice in one container stops the render"
refuses "a plain and a Secret entry for one name (api)" EXTRA_SECRET_ENV_API_TOKEN \
  EXTRA_ENV_API_TOKEN=x EXTRA_SECRET_ENV_API_TOKEN=sec-one:token
also_names EXTRA_ENV_API_TOKEN
refuses "a plain and a Secret entry for one name (brain)" EXTRA_SECRET_ENV_BRAIN_TOKEN \
  EXTRA_ENV_BRAIN_TOKEN=x EXTRA_SECRET_ENV_BRAIN_TOKEN=sec-one:token
also_names EXTRA_ENV_BRAIN_TOKEN
refuses "an empty plain entry and a Secret entry for one name" EXTRA_SECRET_ENV_API_TOKEN \
  EXTRA_ENV_API_TOKEN= EXTRA_SECRET_ENV_API_TOKEN=sec-one:token
extra EXTRA_ENV_API_TOKEN=x EXTRA_SECRET_ENV_BRAIN_TOKEN=sec-one:token EXTRA_SECRET_ENV_API_OTHER=sec-one:token \
  >/dev/null 2>"$err" || bad "refused one name set in two different containers: $(cat "$err")"
ok "the same name in api and brain, or under another name, is accepted"

echo "==> a Secret env var the chart already renders in the container is refused, from the rendered Deployment"
# The chart's own names depend on this render (a NATS credential read back from the
# cluster, a CA ConfigMap, the identity client), so they are read from what helm
# rendered for the container, never from a list kept beside the chart. Only a name
# set through EXTRA_SECRET_ENV_* is held to it: a plain EXTRA_ENV_* that replaces a
# chart value is how a setting without a chart key has always been overridden.
rendered() { # API|BRAIN, then VAR=value settings, then "--" and extra helm arguments
  local tag="$1"; shift
  local lower; lower="$(echo "$tag" | tr '[:upper:]' '[:lower:]')"
  local -a vars=() hargs=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  [ $# -gt 0 ] && shift
  hargs=("$@")
  extra ${vars[@]+"${vars[@]}"} >"$tmp/r-values.json" 2>"$err" || return 2
  helm template extra-test "$chart_dir" -f "$release_values" -f "$tmp/r-values.json" ${hargs[@]+"${hargs[@]}"} \
    --show-only "templates/${lower}-deployment.yaml" >"$tmp/r-render.yaml" 2>"$err" || return 2
  env -i PATH="$PATH" ${vars[@]+"${vars[@]}"} python3 "$script" --check-rendered "$tag" "$tmp/r-render.yaml" 2>"$err"
}
accepted_render() {
  local why="$1"; shift
  rendered "$@" || bad "refused: $why: $(cat "$err")"
  ok "accepted: $why"
}
refused_render() {
  local why="$1" needle="$2"; shift 2
  local rc=0
  rendered "$@" || rc=$?
  [ "$rc" = 1 ] || bad "not refused by the render check (rc=$rc): $why: $(cat "$err")"
  grep -qF -- "$needle" "$err" || bad "$why: the refusal must name $needle, got: $(cat "$err")"
  ok "refused: $why"
}

accepted_render "a name the chart does not render (api)" API \
  EXTRA_SECRET_ENV_API_IDENTITY_CLIENT_SECRET=claw-api-identity-v2:client_secret \
  EXTRA_SECRET_ENV_API_IDENTITY_CLIENT_ID=claw-api-identity-v2:client_id
accepted_render "a name the chart does not render (brain)" BRAIN \
  EXTRA_SECRET_ENV_BRAIN_A2A_PEER_TOKEN_CI=a2a-peer-ci:token
accepted_render "nothing set renders and checks nothing" API
refused_render "POSTGRES_HOST in api" POSTGRES_HOST API EXTRA_SECRET_ENV_API_POSTGRES_HOST=sec-one:host
also_names EXTRA_SECRET_ENV_API_POSTGRES_HOST
refused_render "POSTGRES_PASSWORD in brain" POSTGRES_PASSWORD BRAIN EXTRA_SECRET_ENV_BRAIN_POSTGRES_PASSWORD=sec-one:pw
refused_render "CHECKPOINT_WRITE_VERSION in brain" CHECKPOINT_WRITE_VERSION BRAIN EXTRA_SECRET_ENV_BRAIN_CHECKPOINT_WRITE_VERSION=sec-one:v
refused_render "NODE_OPTIONS in api" NODE_OPTIONS API EXTRA_SECRET_ENV_API_NODE_OPTIONS=sec-one:opts
# The same name is free in the container that does not render it.
accepted_render "CHECKPOINT_WRITE_VERSION in api, which the chart does not set there" API \
  EXTRA_SECRET_ENV_API_CHECKPOINT_WRITE_VERSION=sec-one:v

# What the chart renders follows what is switched on in this render.
accepted_render "NODE_EXTRA_CA_CERTS while no CA ConfigMap is set" API EXTRA_SECRET_ENV_API_NODE_EXTRA_CA_CERTS=sec-one:ca
refused_render "NODE_EXTRA_CA_CERTS once the chart renders it" NODE_EXTRA_CA_CERTS API \
  EXTRA_SECRET_ENV_API_NODE_EXTRA_CA_CERTS=sec-one:ca -- --set-string tls.extraCACertsConfigMap=ca-cm
identity_on=(--set identity.enabled=true --set-string identity.issuerUrl=https://idp.example.com
  --set-string identity.clientId=cid --set-string identity.clientSecret.existingSecret=idp-secret)
accepted_render "IDENTITY_CLIENT_SECRET while the chart's identity client is off" API \
  EXTRA_SECRET_ENV_API_IDENTITY_CLIENT_SECRET=claw-api-identity-v2:client_secret
refused_render "IDENTITY_CLIENT_SECRET once the chart renders the identity client" IDENTITY_CLIENT_SECRET API \
  EXTRA_SECRET_ENV_API_IDENTITY_CLIENT_SECRET=claw-api-identity-v2:client_secret -- "${identity_on[@]}"
refused_render "IDENTITY_CLIENT_SECRET in brain, which renders the identity client too" IDENTITY_CLIENT_SECRET BRAIN \
  EXTRA_SECRET_ENV_BRAIN_IDENTITY_CLIENT_SECRET=claw-api-identity-v2:client_secret -- "${identity_on[@]}"

echo "==> the render check reads a Deployment's env blocks as they are written"
cat >"$tmp/synthetic.yaml" <<'EOF'
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers:
      - name: init
        env:
        - name: SHARED_NAME
          value: "x"
      containers:
      - name: main
        env:
        # a comment inside the block

        - name: OTHER
          value: "1"
        - name: "QUOTED_NAME"
          value: x
        - {name: FLOW_NAME, value: x}
        - name: SHARED_NAME
          valueFrom:
            secretKeyRef:
              key: k
              name: s
        - name: OTHER
          valueFrom:
            secretKeyRef:
              key: k
              name: s
        - name: QUOTED_NAME
          valueFrom:
            secretKeyRef:
              key: k
              name: s
        - name: FLOW_NAME
          valueFrom:
            secretKeyRef:
              key: k
              name: s
        volumeMounts:
        - name: VOLUME_NAME
          mountPath: /x
      - name: second
        env:
          - name: DEEP_NAME
            value: x
          - name: DEEP_NAME
            value: y
        args: ["x"]
EOF
# Each file stands for a whole render: the chart's entries first, then the Secret
# ones the settings add. A name listed once in a container is the Secret entry alone.
synthetic() { env -i PATH="$PATH" "$@" python3 "$script" --check-rendered API "$tmp/synthetic.yaml" 2>"$err"; }
synthetic EXTRA_SECRET_ENV_API_SHARED_NAME=s:k || bad "a name in an init container and once in the main one was refused: $(cat "$err")"
synthetic EXTRA_SECRET_ENV_API_VOLUME_NAME=s:k || bad "a volume mount name was read as an env var: $(cat "$err")"
for dup in OTHER QUOTED_NAME FLOW_NAME DEEP_NAME; do
  if synthetic "EXTRA_SECRET_ENV_API_$dup=s:k"; then bad "$dup, written twice in a container, was accepted"; fi
  grep -qF -- "$dup" "$err" || bad "the refusal for $dup must name it, got: $(cat "$err")"
done
ok "init-container env, comments, blank lines, quoted names, flow items and deeper indents are read as written"
if env -i PATH="$PATH" EXTRA_SECRET_ENV_API_TOKEN=s:k python3 "$script" --check-rendered API "$tmp/missing.yaml" 2>"$err"; then
  bad "a Deployment that could not be read was a pass"
fi
grep -qF -- "$tmp/missing.yaml" "$err" || bad "the refusal must name the unreadable file, got: $(cat "$err")"
env -i PATH="$PATH" python3 "$script" --check-rendered API "$tmp/missing.yaml" 2>"$err" \
  || bad "with no Secret env set there is nothing to read, yet it refused: $(cat "$err")"
ok "an unreadable Deployment is a refusal; with nothing to check it is not read"

echo "==> the chart renders a Secret-backed env var into the Deployment it names"
extra \
  EXTRA_SECRET_ENV_API_IDENTITY_CLIENT_SECRET=claw-api-identity-v2:client_secret \
  EXTRA_SECRET_ENV_BRAIN_A2A_PEER_TOKEN_CI=a2a-peer-ci:token \
  >"$tmp/secret-chart-values.json"
helm template extra-test "$chart_dir" -f "$release_values" -f "$tmp/secret-chart-values.json" >"$tmp/render-secret.yaml" 2>"$err" \
  || bad "the chart refused the Secret env values: $(cat "$err")"
document_of "$tmp/render-secret.yaml" primus-claw/templates/api-deployment.yaml   >"$tmp/api-secret.yaml"
document_of "$tmp/render-secret.yaml" primus-claw/templates/brain-deployment.yaml >"$tmp/brain-secret.yaml"
has "$tmp/api-secret.yaml"   '- name: IDENTITY_CLIENT_SECRET\n\s+valueFrom:\n\s+secretKeyRef:\n\s+key: client_secret\n\s+name: claw-api-identity-v2\n' || bad "api does not carry the Secret-backed env var"
has "$tmp/brain-secret.yaml" '- name: A2A_PEER_TOKEN_CI\n\s+valueFrom:\n\s+secretKeyRef:\n\s+key: token\n\s+name: a2a-peer-ci\n' || bad "brain does not carry the Secret-backed env var"
if has "$tmp/api-secret.yaml" 'A2A_PEER_TOKEN_CI|a2a-peer-ci'; then bad "api carries a Secret env var that was set for brain"; fi
if has "$tmp/brain-secret.yaml" 'IDENTITY_CLIENT_SECRET|claw-api-identity-v2'; then bad "brain carries a Secret env var that was set for api"; fi
ok "each Deployment carries its own secretKeyRef env var, and none of the other's"

echo "==> upgrade.sh refuses a colliding mount before it applies anything"
# The reason the script has to be the one to stop: the API server's own refusal
# comes at kubectl apply, and upgrade.sh applies api before it renders brain. The
# collision here is in brain, and the first render is api's, so the run has to end
# there with no cluster call that changes anything.
mkdir -p "$tmp/bin" "$tmp/home"
cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$KUBECTL_LOG"
# $WORK_DIR goes with upgrade.sh's EXIT trap, so an applied manifest is copied
# out now or not at all.
if [ "${1:-}" = apply ] && [ -n "${KUBECTL_APPLIED:-}" ]; then
  prev=""
  for a in "$@"; do
    [ "$prev" = -f ] && cp "$a" "$KUBECTL_APPLIED/$(basename "$a")"
    prev="$a"
  done
fi
case " $* " in *" --ignore-not-found "*) exit 0 ;; esac
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"get sc"*) printf 'fast (default)\n' ;;
  *"get pods"*) printf '%s true\n' "${MOCK_TAG:-none}" ;;
  *"get secret"*|*"get deploy"*|*"get statefulset"*|*"get pod"*) exit 1 ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/kubectl"
namespace="claw-extra-values-$$"
values_file="$repo_root/claw/deploy/values.${namespace}.env"
deploy_namespace="claw-extra-deploy-$$"
deploy_values_file="$repo_root/claw/deploy/values.${deploy_namespace}.env"
trap 'rm -rf "$tmp"; rm -f "$values_file" "$deploy_values_file"' EXIT
upgrade() { # exit status of an upgrade.sh run (extra flags as arguments) against the values file written for it
  : >"$tmp/kubectl.log"
  rm -rf "$tmp/applied"; mkdir -p "$tmp/applied"
  env -i HOME="$tmp/home" PATH="$tmp/bin:$PATH" KUBECTL_LOG="$tmp/kubectl.log" KUBECTL_APPLIED="$tmp/applied" MOCK_TAG=release-test TAG=release-test \
    bash "$repo_root/claw/deploy/upgrade.sh" -n "$namespace" --skip-health --skip-shared-assets "$@" >"$tmp/upgrade.log" 2>&1
}
mutations='(^| )(apply|patch|rollout|delete|create|scale|replace|annotate|label)( |$)'

printf 'REGISTRY="docker.io/primussafe"\nEXTRA_CONFIGMAP_MOUNTS_BRAIN="cm-one:/etc/x"\nEXTRA_SECRET_MOUNTS_BRAIN="sec-one:/var/run/y"\n' >"$values_file"
upgrade || bad "upgrade.sh did not complete with valid mounts: $(tail -5 "$tmp/upgrade.log")"
grep -q 'apply .*brain-deployment.yaml' "$tmp/kubectl.log" || bad "the stub cluster saw no apply for brain on a valid file, so it cannot show one is absent"
ok "a valid file runs through to the brain apply"

for collision in "EXTRA_SECRET_MOUNTS_BRAIN=sec-one:/etc/x" "EXTRA_SECRET_MOUNTS_BRAIN=sec-one:/etc/claw"; do
  printf 'REGISTRY="docker.io/primussafe"\nEXTRA_CONFIGMAP_MOUNTS_BRAIN="cm-one:/etc/x"\n%s\n' "$(echo "$collision" | sed 's/=\(.*\)/="\1"/')" >"$values_file"
  if upgrade; then bad "upgrade.sh went ahead with $collision"; fi
  grep -qF EXTRA_SECRET_MOUNTS_BRAIN "$tmp/upgrade.log" || bad "upgrade.sh did not name EXTRA_SECRET_MOUNTS_BRAIN for $collision: $(tail -5 "$tmp/upgrade.log")"
  if grep -Eq "$mutations" "$tmp/kubectl.log"; then bad "upgrade.sh changed the cluster before refusing $collision: $(grep -E "$mutations" "$tmp/kubectl.log")"; fi
  ok "refused before any change to the cluster: $collision"
done
rm -f "$values_file"

echo "==> upgrade.sh renders a Secret-backed env var into each Deployment it applies"
printf 'REGISTRY="docker.io/primussafe"\nEXTRA_ENV_API_APP_FLAG="true"\nEXTRA_SECRET_ENV_API_IDENTITY_CLIENT_SECRET="claw-api-identity-v2:client_secret"\nEXTRA_SECRET_ENV_API_IDENTITY_CLIENT_ID="claw-api-identity-v2:client_id"\nEXTRA_SECRET_ENV_BRAIN_A2A_PEER_TOKEN_CI="a2a-peer-ci:token"\n' >"$values_file"
# --dry-run is the operator's own render check: it must show the reference too.
upgrade --dry-run || bad "upgrade.sh --dry-run did not complete with valid Secret env settings: $(tail -5 "$tmp/upgrade.log")"
has "$tmp/applied/api-deployment.yaml"   '- name: IDENTITY_CLIENT_SECRET\n\s+valueFrom:\n\s+secretKeyRef:\n\s+key: client_secret\n\s+name: claw-api-identity-v2\n' || bad "the dry-run api manifest has no IDENTITY_CLIENT_SECRET secretKeyRef"
has "$tmp/applied/api-deployment.yaml"   '- name: IDENTITY_CLIENT_ID\n\s+valueFrom:\n\s+secretKeyRef:\n\s+key: client_id\n\s+name: claw-api-identity-v2\n' || bad "the dry-run api manifest has no IDENTITY_CLIENT_ID secretKeyRef"
has "$tmp/applied/api-deployment.yaml"   '- name: APP_FLAG\n\s+value: "true"\n' || bad "the dry-run api manifest lost the plain env var"
has "$tmp/applied/brain-deployment.yaml" '- name: A2A_PEER_TOKEN_CI\n\s+valueFrom:\n\s+secretKeyRef:\n\s+key: token\n\s+name: a2a-peer-ci\n' || bad "the dry-run brain manifest has no A2A_PEER_TOKEN_CI secretKeyRef"
if has "$tmp/applied/brain-deployment.yaml" 'IDENTITY_CLIENT|APP_FLAG'; then bad "the brain manifest carries an env var set for api"; fi
ok "upgrade.sh --dry-run renders each reference into the Deployment it names"
upgrade || bad "upgrade.sh did not complete with valid Secret env settings: $(tail -5 "$tmp/upgrade.log")"
has "$tmp/applied/api-deployment.yaml"   '- name: IDENTITY_CLIENT_SECRET\n\s+valueFrom:\n\s+secretKeyRef:\n\s+key: client_secret\n' || bad "the applied api manifest has no IDENTITY_CLIENT_SECRET secretKeyRef"
has "$tmp/applied/brain-deployment.yaml" '- name: A2A_PEER_TOKEN_CI\n\s+valueFrom:\n\s+secretKeyRef:\n' || bad "the applied brain manifest has no A2A_PEER_TOKEN_CI secretKeyRef"
ok "the same render is what a real upgrade applies"

echo "==> upgrade.sh refuses a doubled env var before it applies anything"
# The brain render comes after api has been applied, so a name the chart renders in
# brain has to be caught before the first apply, not at the brain render.
for collision in \
  "EXTRA_SECRET_ENV_BRAIN_POSTGRES_HOST|sec-one:host" \
  "EXTRA_SECRET_ENV_API_POSTGRES_PASSWORD|sec-one:pw"; do
  var="${collision%%|*}"; ref="${collision#*|}"
  printf 'REGISTRY="docker.io/primussafe"\nEXTRA_SECRET_ENV_API_IDENTITY_CLIENT_SECRET="claw-api-identity-v2:client_secret"\n%s="%s"\n' "$var" "$ref" >"$values_file"
  if upgrade; then bad "upgrade.sh went ahead with $var, which the chart already renders"; fi
  grep -qF -- "$var" "$tmp/upgrade.log" || bad "upgrade.sh did not name $var: $(tail -5 "$tmp/upgrade.log")"
  if grep -Eq "$mutations" "$tmp/kubectl.log"; then bad "upgrade.sh changed the cluster before refusing $var: $(grep -E "$mutations" "$tmp/kubectl.log")"; fi
  ok "refused before any change to the cluster: $var"
done
printf 'REGISTRY="docker.io/primussafe"\nEXTRA_ENV_BRAIN_TOKEN="x"\nEXTRA_SECRET_ENV_BRAIN_TOKEN="sec-one:token"\n' >"$values_file"
if upgrade; then bad "upgrade.sh went ahead with one name set both plain and from a Secret"; fi
grep -qF -- EXTRA_ENV_BRAIN_TOKEN "$tmp/upgrade.log" || bad "upgrade.sh did not name EXTRA_ENV_BRAIN_TOKEN: $(tail -5 "$tmp/upgrade.log")"
if grep -Eq "$mutations" "$tmp/kubectl.log"; then bad "upgrade.sh changed the cluster before refusing a doubled name: $(grep -E "$mutations" "$tmp/kubectl.log")"; fi
ok "refused before any change to the cluster: EXTRA_ENV_BRAIN_TOKEN and EXTRA_SECRET_ENV_BRAIN_TOKEN"
rm -f "$values_file"

echo "==> upgrade.sh renders the grant signing key from GRANT_SIGNING_KEY_ENABLED"
# The chart reserves /var/run/claw/grant in api for this volume, so EXTRA_SECRET_MOUNTS_API cannot
# carry it: without the forwarded switch an upgrade drops the mount and both env vars from api.
printf 'REGISTRY="docker.io/primussafe"\nGRANT_SIGNING_KEY_ENABLED="true"\n' >"$values_file"
upgrade || bad "upgrade.sh did not complete with GRANT_SIGNING_KEY_ENABLED: $(tail -5 "$tmp/upgrade.log")"
has "$tmp/applied/api-deployment.yaml" '- name: grant-signing-key\n\s+secret:\n\s+secretName: primus-claw-grant-signing-key\n' || bad "the applied api manifest has no grant-signing-key Secret volume"
has "$tmp/applied/api-deployment.yaml" '- name: grant-signing-key\n\s+mountPath: /var/run/claw/grant\n' || bad "the applied api manifest does not mount the grant signing key"
has "$tmp/applied/api-deployment.yaml" '- name: GRANT_SIGNING_KEY_FILE\n\s+value: /var/run/claw/grant/signing-key.pem\n' || bad "the applied api manifest has no GRANT_SIGNING_KEY_FILE"
has "$tmp/applied/brain-deployment.yaml" '- name: AGENT_SANDBOX_GRANT_URL\n' || bad "the applied brain manifest has no AGENT_SANDBOX_GRANT_URL"
ok "GRANT_SIGNING_KEY_ENABLED=true mounts the key into api and sets the grant URL in api and brain"
printf 'REGISTRY="docker.io/primussafe"\n' >"$values_file"
upgrade || bad "upgrade.sh did not complete without GRANT_SIGNING_KEY_ENABLED: $(tail -5 "$tmp/upgrade.log")"
if has "$tmp/applied/api-deployment.yaml" 'grant-signing-key|GRANT_SIGNING_KEY_FILE'; then bad "the api manifest carries the grant signing key while it is off"; fi
ok "a file that does not set it renders no grant signing key"
rm -f "$values_file"

echo "==> deploy.sh refuses a doubled env var before it installs the chart"
# deploy.sh installs the whole chart with `helm upgrade --install`, not through
# render_chart, so it needs the same check on its own path.
mkdir -p "$tmp/dbin" "$tmp/dhome" "$tmp/dvalues"
real_helm="$(command -v helm)"
cat >"$tmp/dbin/helm" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"\$HELM_CAPTURE"
if [[ "\${1:-}" == "status" ]]; then exit 1; fi
if [[ "\${1:-}" == "template" ]]; then exec "$real_helm" "\$@"; fi
for ((i=1; i<=\$#; i++)); do
  if [[ "\${!i}" == "-f" ]]; then j=\$((i+1)); cp "\${!j}" "\$HELM_VALUES_DIR/\$(basename "\${!j}")"; fi
done
exit 0
EOF
cat >"$tmp/dbin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"config current-context"*) echo release-test ;;
  *"get sc"*) printf 'fast (default)\n' ;;
  *"get pods"*) printf '%s true\n' "${MOCK_TAG:-none}" ;;
  *"get secret"*|*"get deploy"*|*"get statefulset"*|*"get pod"*)
    case " $* " in *" --ignore-not-found "*) exit 0 ;; esac
    exit 1 ;;
esac
exit 0
EOF
printf '#!/usr/bin/env bash\n[[ "${1:-}" == "rand" ]] && { echo "0123456789abcdef0123456789abcdef"; exit 0; }\nexit 0\n' >"$tmp/dbin/openssl"
printf '#!/usr/bin/env bash\nexit 0\n' >"$tmp/dbin/curl"
chmod +x "$tmp/dbin/helm" "$tmp/dbin/kubectl" "$tmp/dbin/openssl" "$tmp/dbin/curl"
deploy() { # VAR=value settings as arguments; exit status of a deploy.sh run from them
  : >"$tmp/helm.args"; rm -f "$tmp/dvalues"/* "$deploy_values_file"
  env -i HOME="$tmp/dhome" PATH="$tmp/dbin:$PATH" HELM_CAPTURE="$tmp/helm.args" HELM_VALUES_DIR="$tmp/dvalues" \
    NAMESPACE="$deploy_namespace" DOMAIN="extra.example" STORAGE_CLASS="release-test-sc" MOCK_TAG=release-test TAG=release-test \
    S3_ACCESS_KEY=ak S3_SECRET_KEY=sk "$@" \
    bash "$repo_root/claw/deploy/deploy.sh" --skip-pgo --skip-nats --skip-pg --skip-lifecycle --skip-shared-assets >"$tmp/deploy.log" 2>&1
}
deploy EXTRA_SECRET_ENV_API_IDENTITY_CLIENT_SECRET=claw-api-identity-v2:client_secret EXTRA_SECRET_ENV_BRAIN_A2A_PEER_TOKEN_CI=a2a-peer-ci:token \
  || bad "deploy.sh did not complete with valid Secret env settings: $(tail -5 "$tmp/deploy.log")"
grep -q '^upgrade --install primus-claw ' "$tmp/helm.args" || bad "deploy.sh did not install the chart on a valid file"
has "$tmp/dvalues/claw-extra-values.json" '"name": "IDENTITY_CLIENT_SECRET",\s+"valueFrom": \{\s+"secretKeyRef": \{\s+"key": "client_secret",\s+"name": "claw-api-identity-v2"' \
  || bad "the install did not carry the Secret env var"
ok "a fresh deploy installs the chart with the Secret-backed env vars"
for collision in "EXTRA_SECRET_ENV_BRAIN_POSTGRES_HOST=sec-one:host" "EXTRA_SECRET_ENV_API_POSTGRES_PASSWORD=sec-one:pw" "EXTRA_SECRET_ENV_API_NODE_OPTIONS=sec-one:opts"; do
  if deploy "$collision"; then bad "deploy.sh went ahead with $collision, which the chart already renders"; fi
  grep -qF -- "${collision%%=*}" "$tmp/deploy.log" || bad "deploy.sh did not name ${collision%%=*}: $(tail -5 "$tmp/deploy.log")"
  if grep -q '^upgrade ' "$tmp/helm.args"; then bad "deploy.sh installed the chart despite $collision"; fi
  ok "refused before the chart is installed: ${collision%%=*}"
done
deploy GRANT_SIGNING_KEY_ENABLED=true || bad "deploy.sh did not complete with GRANT_SIGNING_KEY_ENABLED: $(tail -5 "$tmp/deploy.log")"
has "$tmp/dvalues/claw-values.json" '"grantSigningKey": \{\s+"enabled": true' || bad "the install did not turn grantSigningKey on"
ok "a fresh deploy forwards GRANT_SIGNING_KEY_ENABLED"
rm -f "$deploy_values_file"

echo "extra-values: all checks passed"
