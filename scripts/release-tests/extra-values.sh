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

echo "==> upgrade.sh refuses a colliding mount before it applies anything"
# The reason the script has to be the one to stop: the API server's own refusal
# comes at kubectl apply, and upgrade.sh applies api before it renders brain. The
# collision here is in brain, and the first render is api's, so the run has to end
# there with no cluster call that changes anything.
mkdir -p "$tmp/bin" "$tmp/home"
cat >"$tmp/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$KUBECTL_LOG"
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
trap 'rm -rf "$tmp"; rm -f "$values_file"' EXIT
upgrade() { # exit status of an upgrade.sh run against the values file written for it
  : >"$tmp/kubectl.log"
  env -i HOME="$tmp/home" PATH="$tmp/bin:$PATH" KUBECTL_LOG="$tmp/kubectl.log" MOCK_TAG=release-test TAG=release-test \
    bash "$repo_root/claw/deploy/upgrade.sh" -n "$namespace" --skip-health --skip-shared-assets >"$tmp/upgrade.log" 2>&1
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

echo "extra-values: all checks passed"
