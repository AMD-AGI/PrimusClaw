#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-no-direct-hands-calltool-in-workspace.sh
#
# Enforce the Plan Y v2 (checkpoint-architecture-redesign §5.5.2 / §6.3.2)
# invariant that workspace/sync.ts and workspace/reaper.ts NEVER call
# hands.callTool() directly — every RPC must go through withHandsTimeout()
# in clients/hands.ts so a wedged Hands sandbox cannot hang the SIGTERM
# grace window.
#
# Usage:
#   - Pre-commit  : invoke with no args; lints files staged for commit.
#   - CI          : invoke with --all to lint the current working tree
#                   (any commit on the branch may introduce a violation).
#
# Exit codes:
#   0  no violation (or no relevant files touched)
#   1  at least one direct hands.callTool() found in a guarded file
#   2  invocation error (bad arg, or the guarded files cannot be enumerated)

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--all]" >&2
  echo "  --all   lint the current working tree (CI mode)" >&2
  echo "  (none)  lint files staged for commit (pre-commit mode)" >&2
  exit 2
}

mode="staged"
if [ "$#" -gt 0 ]; then
  case "$1" in
    --all)    mode="all" ;;
    -h|--help) usage ;;
    *)        usage ;;
  esac
fi

# Guarded files: the sync and reaper modules under brain/src/workspace/.
# Reaper is included even though it lives in a separate PR — its eventual
# rsync calls must obey the same invariant from day one.
guard_re='^claw/packages/brain/src/workspace/(sync|reaper)([.-][a-zA-Z0-9_-]+)?\.ts$'

guard_dir="claw/packages/brain/src/workspace"

have_git=0
if git rev-parse --git-dir >/dev/null 2>&1; then
  have_git=1
fi

if [ "$mode" = "staged" ]; then
  # Nothing to diff against without a repository; this mode is a git operation.
  if [ "$have_git" -eq 0 ]; then
    echo "ERROR: pre-commit mode requires a git repository (run with --all outside one)." >&2
    exit 2
  fi
  target_files=$(git diff --cached --name-only --diff-filter=ACMR \
                  | grep -E "$guard_re" || true)
elif [ "$have_git" -eq 1 ]; then
  # CI mode: scan everything currently in the tree that matches.
  target_files=$(git ls-files \
                  | grep -E "$guard_re" || true)
else
  # Release verification also runs against exported trees that carry no .git.
  # Enumerate from the filesystem there: piping a failing `git ls-files` into
  # `|| true` yields an empty set, which made this guard exit 0 without reading
  # a single file -- it passed a planted violation.
  if [ ! -d "$guard_dir" ]; then
    echo "ERROR: no git repository and $guard_dir is missing; run from the repo root." >&2
    exit 2
  fi
  target_files=$(find "$guard_dir" -type f -name '*.ts' \
                  | grep -E "$guard_re" || true)
fi

if [ -z "$target_files" ]; then
  # In pre-commit mode an empty set just means this commit touches none of the
  # guarded modules. In CI mode it means the pattern matched nothing, which is
  # what a rename looks like from here -- and is indistinguishable from "no
  # violations" unless we say so.
  if [ "$mode" = "staged" ]; then
    exit 0
  fi
  echo "ERROR: $guard_re matched no file in the tree." >&2
  echo "       This guard scans a hardcoded pattern. If the modules moved," >&2
  echo "       update \$guard_re and \$guard_dir; do not let the check retire." >&2
  exit 2
fi

# A violation is any hands.callTool( occurrence that is NOT immediately
# part of a withHandsTimeout(...) call. We require withHandsTimeout to
# appear on the same line — the helper's signature accepts the hands
# instance + tool name + args in one call, so a single grep is sufficient.
#
# Comment lines (`//` line comments and `*` JSDoc continuation lines)
# are skipped so a docstring that names the very pattern being
# forbidden does not trip its own guard. Block-comment delimiters
# `/*` / `*/` are also skipped for the same reason.
violations=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ ! -f "$f" ]; then continue; fi
  file_violations=$(grep -nE 'hands\.callTool\(' "$f" \
                     | grep -vE '^[0-9]+:\s*(//|\*|/\*)' \
                     | grep -vE 'withHandsTimeout' || true)
  if [ -n "$file_violations" ]; then
    violations+="${f}:"$'\n'"${file_violations}"$'\n'
  fi
done <<< "$target_files"

if [ -n "$violations" ]; then
  cat >&2 <<EOF
ERROR: direct hands.callTool() detected in a workspace-{sync,reaper} module.
Every Hands MCP RPC inside these modules MUST go through withHandsTimeout()
(see claw/packages/brain/src/clients/hands.ts) so a wedged sandbox cannot
hang the SIGTERM grace window.

Offending lines:
${violations}
Refs: checkpoint-architecture-redesign.md sec 5.5.2, sec 6.3.2
EOF
  exit 1
fi

exit 0
