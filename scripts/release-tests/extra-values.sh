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
# entry stops the render instead of being dropped.

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

echo "extra-values: all checks passed"
