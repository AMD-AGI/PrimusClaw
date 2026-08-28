#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-no-nullish-env-default.sh
#
# Forbid `process.env.X ?? <default>` when the default is not the empty string.
# Use `||` instead, so a variable that is set-but-blank falls back to the
# default the same way an absent one does.
#
# Why this needs a guard rather than one careful review: `scripts/start-all.sh`
# runs `set -a; source .env`, which EXPORTS every key `.env.example` leaves
# deliberately empty. Those keys arrive as "" rather than undefined, and `??`
# substitutes only for undefined -- so the documented default silently loses to
# a blank string, and the failure shows up far from the config line:
#
#   Number("")     -> 0        a poller re-arming a 0 ms timer, dispatching none
#   parseInt("")   -> NaN      a limit that compares false against everything
#   ""             -> ""       a base URL that makes every callback relative
#
# All three shipped. The first pass fixed only the three `env()` helpers in
# api/brain/hands config.ts and left 25 direct `process.env` reads behind them,
# which is why this is a lint and not a code review note: the defect is a
# pattern, and the next one will be written by someone who never read the fix.
#
# `?? ""` is allowed and deliberately so: the fallback is already what a blank
# variable produces, so the two operators agree, and writing `??` there says
# "absent and blank are the same thing here" out loud. `a ?? process.env.B` is
# also untouched -- that is a nullish choice between two sources, and `||` would
# change which one wins when the first is legitimately "".
#
# Comment lines are skipped, for the same reason
# lint-no-direct-hands-calltool-in-workspace.sh skips them: the doc comment in
# api/src/config.ts explains this very hazard by quoting the forbidden form, and
# must not be read as an instance of it.
#
# Modes (same convention as the other lint guards in this directory):
#   (no args)  pre-commit: lints only the staged .ts files under claw/packages
#   --all      CI: lints every .ts file under claw/packages/*/src
#
# Exit codes:
#   0  no nullish env defaults
#   1  at least one found
#   2  invocation error

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--all]" >&2
  exit 2
}

mode="staged"
if [ "$#" -gt 0 ]; then
  case "$1" in
    --all)     mode="all" ;;
    -h|--help) usage ;;
    *)         usage ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# `\s*+` and `[^\]]*+` are possessive: without them the trailing (?!"") is
# reachable by backtracking the whitespace to zero width, which makes the
# lookahead inspect ` "` instead of `""` and lets every `?? ""` through as a
# violation. That mistake was made once already while writing this rule.
PATTERN='process\.env(?:\.\w+|\[[^\]]*+\])\s*+\?\?\s*+(?!"")'

if [ "$mode" = "all" ]; then
  files=$(find "$CLAW_DIR/packages" -type d -name dist -prune -o \
                -type d -name node_modules -prune -o \
                -path '*/src/*' -name '*.ts' -print)
else
  if ! staged_all=$(git diff --cached --name-only --diff-filter=ACMR 2>&1); then
    echo "ERROR: could not read the staged file list from git:" >&2
    printf '       %s\n' "$(printf '%s\n' "$staged_all" | head -n 1)" >&2
    echo "       Refusing to report a clean tree without having looked. Use" >&2
    echo "       --all to lint the working tree outside a git repository." >&2
    exit 2
  fi
  files=$(printf '%s\n' "$staged_all" | grep -E '^claw/packages/[^/]+/src/.*\.ts$' || true)
  [ -z "$files" ] && exit 0
  files=$(printf '%s\n' "$files" | sed "s#^claw/#$CLAW_DIR/#")
fi

if [ -z "$files" ]; then
  echo "ERROR: found no TypeScript sources to lint under claw/packages/*/src." >&2
  echo "       Refusing to report a clean tree from a set this guard never read." >&2
  exit 2
fi

violations=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  # Strip `//` line comments and `*` JSDoc continuations before matching.
  hits=$(grep -nP "$PATTERN" "$f" | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true)
  if [ -n "$hits" ]; then
    violations+="${f#"$CLAW_DIR/"}:"$'\n'"${hits}"$'\n'
  fi
done <<< "$files"

if [ -n "$violations" ]; then
  cat >&2 <<EOF
ERROR: a nullish default on process.env. A variable that is set-but-blank --
       which is what \`set -a; source .env\` produces for every key
       .env.example leaves empty -- will beat the default below.

$violations
Fix: use \`||\` instead of \`??\`, so blank and absent both take the default.
     If the two really must differ here, the fallback should be "" (which this
     guard allows) and the distinction stated in a comment.
EOF
  exit 1
fi

echo "lint-no-nullish-env-default: OK"
