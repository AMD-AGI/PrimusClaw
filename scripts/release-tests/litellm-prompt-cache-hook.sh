#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# The LiteLLM chart can name a callback by module path, and that path only
# resolves if the image bakes a file of the same name into litellm.proxy.hooks.
# Two things have to hold, and neither shows up as a failed rollout until a
# real deploy:
#
#   1. The hook an operator opts into (the one the auto-routing example lists)
#      is shipped by the Dockerfile and build.sh under the same file name. A
#      rename that misses one starts a proxy that passes readiness with the
#      hook inert.
#   2. The chart's DEFAULT callbacks only name a hook when the default image
#      can import it. The pin the chart shipped predates deploy/litellm/ and
#      carries a different hook; naming ours by default made the pod fail to
#      start. A default callback that is not built in therefore requires every
#      image pin to be a tag build.sh wrote for the Dockerfile's LiteLLM base,
#      and the three pins to agree.
#
# Then run the hook's unit tests.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dir="$repo_root/deploy/litellm"

fail() { echo "error: $*" >&2; exit 1; }

command -v helm >/dev/null || fail "helm is required for this check"

render() {
  helm template litellm "$dir/charts/litellm" --show-only templates/configmap.yaml \
    --set-string secrets.masterKey=probe \
    --set-string secrets.databaseUrl=postgresql://probe.invalid/litellm "$@"
}

# 1. The opt-in hook: chart + Dockerfile + build.sh + README agree.
callbacks="$(render -f "$dir/values.autorouting.example.yaml" \
  | grep -oE 'litellm\.proxy\.hooks\.[A-Za-z0-9_]+\.proxy_handler_instance' | sort -u || true)"
[ -n "$callbacks" ] || fail "the auto-routing example's callbacks name no hook module"
[ "$(wc -l <<<"$callbacks")" -eq 1 ] || {
  echo "error: expected exactly one hook callback in the auto-routing example, got:" >&2
  echo "$callbacks" >&2
  exit 1
}

module="${callbacks#litellm.proxy.hooks.}"
module="${module%.proxy_handler_instance}"
file="$module.py"

[ -f "$dir/$file" ] || fail "the opt-in callback names $module but $file is not in deploy/litellm"
grep -qE "^proxy_handler_instance = " "$dir/$file" || fail "$file does not define proxy_handler_instance"
grep -qF "COPY $file /tmp/hooks/$file" "$dir/Dockerfile" || fail "Dockerfile does not COPY $file to /tmp/hooks"
grep -qF "/tmp/hooks/$file \"\$HOOKS_DIR/\"" "$dir/Dockerfile" || fail "Dockerfile does not install $file into litellm.proxy.hooks"
grep -qF -- "--from-file=$file=\"\$SCRIPT_DIR/$file\"" "$dir/build.sh" || fail "build.sh does not ship $file in the kaniko context"
grep -qF "/cm/$file " "$dir/build.sh" || fail "build.sh does not copy $file into the kaniko workspace"
grep -qF "$callbacks" "$dir/README.md" || fail "README.md does not show the callback $callbacks"

# 2. The default callbacks against the default image pins.
# toYaml writes a list inside a map as `callbacks:` followed by `- entry` lines
# at the same indent, or `callbacks: []` when empty.
default_callbacks="$(render | awk '
  /^ +callbacks:/ { on = ($0 !~ /\[\]/); next }
  on && /^ +- /   { sub(/^ +- /, ""); print; next }
  { on = 0 }')"
# A dotted entry is a module path the image has to import; a bare name
# (prometheus) is built into LiteLLM.
imported="$(grep -F . <<<"$default_callbacks" || true)"

values_tag="$(awk '/^image:/ {i=1; next} i && /^  tag:/ {gsub(/"/, "", $2); print $2; exit}' "$dir/charts/litellm/values.yaml")"
chart_tag="$(awk '/^appVersion:/ {gsub(/"/, "", $2); print $2}' "$dir/charts/litellm/Chart.yaml")"
deploy_default="$(grep -E '^LITELLM_IMAGE="\$\{LITELLM_IMAGE:-[^}]*\}"$' "$dir/deploy.sh" | head -1 || true)"
deploy_tag="${deploy_default%\}\"}"
deploy_tag="${deploy_tag##*:}"

[ -n "$values_tag" ] || fail "cannot read image.tag from charts/litellm/values.yaml"
[ -n "$chart_tag" ] || fail "cannot read appVersion from charts/litellm/Chart.yaml"
[ -n "$deploy_tag" ] || fail "cannot read the LITELLM_IMAGE default from deploy.sh"
[ "$values_tag" = "$chart_tag" ] && [ "$values_tag" = "$deploy_tag" ] \
  || fail "image pins disagree: values.yaml=$values_tag Chart.yaml=$chart_tag deploy.sh=$deploy_tag"

if [ -n "$imported" ]; then
  base="$(grep -oE '^FROM .*litellm:v[0-9.]+' "$dir/Dockerfile" | grep -oE 'v[0-9.]+' | head -1)"
  [ -n "$base" ] || fail "cannot read the pinned litellm version from the Dockerfile"
  [[ "$values_tag" =~ ^${base//./\\.}-[0-9]{12}$ ]] \
    || fail "the chart's default callbacks name $(tr '\n' ' ' <<<"$imported")but the image pin is $values_tag, not a build.sh tag ($base-<YYYYMMDDHHMM>); that image predates the hook and cannot import it"
  pin_note="default callbacks import: $(tr '\n' ' ' <<<"$imported")- pin $values_tag is a build.sh tag"
else
  pin_note="default callbacks import nothing; legacy pin $values_tag is fine"
fi

# -B: the hook is loaded from its path, and a cached .pyc is reused when the
# size and the mtime in seconds match -- two same-length edits in one second
# would be answered by the first one's bytecode.
python3 -I -B -m unittest discover -s "$dir/tests" -v

echo "LiteLLM prompt-cache hook: ok ($callbacks; $pin_note)"
