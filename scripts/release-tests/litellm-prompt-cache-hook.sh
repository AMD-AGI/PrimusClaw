#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# The LiteLLM chart names its default callback by module path, and that path only
# resolves if the image bakes a file of the same name into litellm.proxy.hooks.
# Three files have to agree -- the chart, the Dockerfile and build.sh -- and a
# rename that misses one starts a proxy that passes readiness with the hook
# inert. Check the agreement, then run the hook's unit tests.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dir="$repo_root/deploy/litellm"

command -v helm >/dev/null || { echo "error: helm is required for this check" >&2; exit 1; }

rendered="$(helm template litellm "$dir/charts/litellm" --show-only templates/configmap.yaml \
  --set-string secrets.masterKey=probe \
  --set-string secrets.databaseUrl=postgresql://probe.invalid/litellm)"
callbacks="$(grep -oE 'litellm\.proxy\.hooks\.[A-Za-z0-9_]+\.proxy_handler_instance' <<<"$rendered" | sort -u)"
[ -n "$callbacks" ] || { echo "error: the chart's default callbacks name no hook module" >&2; exit 1; }
[ "$(wc -l <<<"$callbacks")" -eq 1 ] || {
  echo "error: expected exactly one default hook callback, got:" >&2
  echo "$callbacks" >&2
  exit 1
}

module="${callbacks#litellm.proxy.hooks.}"
module="${module%.proxy_handler_instance}"
file="$module.py"

fail() { echo "error: $*" >&2; exit 1; }

[ -f "$dir/$file" ] || fail "chart default callback names $module but $file is not in deploy/litellm"
grep -qE "^proxy_handler_instance = " "$dir/$file" || fail "$file does not define proxy_handler_instance"
grep -qF "COPY $file /tmp/hooks/$file" "$dir/Dockerfile" || fail "Dockerfile does not COPY $file to /tmp/hooks"
grep -qF "/tmp/hooks/$file \"\$HOOKS_DIR/\"" "$dir/Dockerfile" || fail "Dockerfile does not install $file into litellm.proxy.hooks"
grep -qF -- "--from-file=$file=\"\$SCRIPT_DIR/$file\"" "$dir/build.sh" || fail "build.sh does not ship $file in the kaniko context"
grep -qF "/cm/$file " "$dir/build.sh" || fail "build.sh does not copy $file into the kaniko workspace"
grep -qF "$callbacks" "$dir/README.md" || fail "README.md does not show the default callback $callbacks"

# -B: the hook is loaded from its path, and a cached .pyc is reused when the
# size and the mtime in seconds match -- two same-length edits in one second
# would be answered by the first one's bytecode.
python3 -I -B -m unittest discover -s "$dir/tests" -v

echo "LiteLLM prompt-cache hook: ok ($callbacks)"
