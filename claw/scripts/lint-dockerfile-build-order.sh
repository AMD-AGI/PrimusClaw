#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-dockerfile-build-order.sh
#
# Enforce that the `npm run build -w packages/<name>` sequence in
# claw/Dockerfile matches the "workspaces" array in claw/package.json.
#
# Why this needs a lint rather than a test: there are two copies of the
# workspace build order and only one of them is exercised by anything green.
# `npm run build` at the root is `npm run build --workspaces`, which walks the
# "workspaces" array in claw/package.json -- that array is ordered so a package
# is listed after everything it imports, and every local build, `make
# verify-claw` and the CI typecheck get their order from it. The Dockerfile
# cannot use --workspaces (it needs `npm prune --omit=dev` chained onto the same
# layer and it wants the failure attributed to a named package), so it hard-codes
# its own second copy of that order. Nothing compares the two.
#
# .github/workflows/build.yaml does build claw/Dockerfile on pull requests, so a
# broken order is not invisible to CI -- it surfaces there as a TS2307 partway
# through a buildah log, on a runner, minutes in. This guard exists to say the
# same thing in one line, before the commit, on a machine with no container
# runtime at all, and to name which two lists disagree instead of leaving that
# to be inferred from a compiler error about a missing module.
#
# The bug this prevents, which shipped exactly this way: the Dockerfile built
# packages/protocol before packages/utils. protocol imports @claw/utils, and
# @claw/utils resolves through its package.json "types" -> dist/index.d.ts, which
# does not exist until utils has been built. tsc therefore failed with
#
#   error TS2307: Cannot find module '@claw/utils' or its corresponding type
#   declarations.
#
# and the image could not be built at all -- exit 2 out of the builder stage, no
# tag produced, while `npm run build`, `npm test`, `make verify` and every check
# that does not build an image stayed green. That is how it reached a release
# branch: the tree was squashed into a first commit that no pull request had
# built. The user-visible failure is a release with no image behind it.
#
# The check is order-only and name-only: it does not try to re-derive the
# dependency graph from each package.json, because "workspaces" is already the
# repo's declared source of truth for that order (see the "//workspaces" note in
# claw/package.json). If a new package is added, add it to "workspaces" in
# dependency order and to the Dockerfile in the same position.
#
# Modes (same convention as the other lint guards in this directory):
#   (no args)  pre-commit: lints only when claw/Dockerfile or claw/package.json
#              is in the staged set.
#   --all      CI: lints the current working tree.
#
# Exit codes:
#   0  Dockerfile order matches "workspaces"
#   1  the two orders disagree
#   2  invocation error (bad arg, a file missing, neither list parseable)

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
DOCKERFILE_REL="claw/Dockerfile"
PACKAGE_JSON_REL="claw/package.json"
DOCKERFILE="$SCRIPT_DIR/../Dockerfile"
PACKAGE_JSON="$SCRIPT_DIR/../package.json"

if [ "$mode" = "staged" ]; then
  # git's exit status is taken on its own, before grep can mask it. Piping the
  # two together and swallowing the result with `|| true` reports an empty
  # staged set for "git is missing", "not a repository" and "nothing staged"
  # alike -- and the first two are the ones where exiting 0 means this guard
  # quietly did not run.
  if ! staged_all=$(git diff --cached --name-only --diff-filter=ACMR 2>&1); then
    # First line only: git answers some failures with its whole usage screen,
    # and the reason is always on the first line.
    echo "ERROR: could not read the staged file list from git:" >&2
    printf '       %s\n' "$(printf '%s\n' "$staged_all" | head -n 1)" >&2
    echo "       Refusing to report a clean tree without having looked. Use" >&2
    echo "       --all to lint the working tree outside a git repository." >&2
    exit 2
  fi
  staged=$(printf '%s\n' "$staged_all" \
            | grep -E "^(${DOCKERFILE_REL}|${PACKAGE_JSON_REL})$" || true)
  [ -z "$staged" ] && exit 0
fi

# Loudly, not as a warning. This guard reads two fixed paths, so a missing one
# means the file moved and the check no longer has anything to say -- which is
# indistinguishable from "the orders agree" to CI.
for f in "$DOCKERFILE:$DOCKERFILE_REL" "$PACKAGE_JSON:$PACKAGE_JSON_REL"; do
  path="${f%%:*}"; rel="${f##*:}"
  if [ ! -f "$path" ]; then
    echo "ERROR: $rel not found in working tree." >&2
    echo "       This guard reads hardcoded paths. If the file moved, update" >&2
    echo "       this script; do not let the check retire silently." >&2
    exit 2
  fi
done

# ── The declared order: the "workspaces" array in claw/package.json ──
#
# Matched on `"workspaces"` with the opening quote, so the adjacent
# `"//workspaces"` documentation key cannot start the capture.
declared=$(
  awk '
    /"workspaces"[[:space:]]*:[[:space:]]*\[/ { in_arr = 1; next }
    in_arr {
      if (/\]/) { in_arr = 0; next }
      if (match($0, /packages\/[A-Za-z0-9._-]+/)) {
        print substr($0, RSTART + 9, RLENGTH - 9)
      }
    }
  ' "$PACKAGE_JSON"
)

# ── The built order: `npm run build -w packages/<name>` in claw/Dockerfile ──
#
# Dockerfile comment lines are dropped first, for the same reason
# lint-no-direct-hands-calltool-in-workspace.sh drops `//` lines: a comment that
# names the very pattern being checked must not be read as an instance of it.
# Without this, documenting `npm run build -w packages/api` anywhere in the file
# is reported as a duplicate build of a package that is only built once.
#
# Both spellings npm accepts for the flag are matched. `-w` is what the
# Dockerfile uses today; `--workspace=packages/x` and `--workspace packages/x`
# are the same instruction, and a guard that silently stops seeing a build line
# because someone spelled the flag out is worse than no guard -- it would report
# the package as missing from the Dockerfile.
#
# `|| true` because grep exits 1 on no match, and under `set -e` that would
# abort here -- taking out the "found no build lines" diagnostic below, which
# is the case that most needs explaining.
built=$(
  { sed -E 's/^[[:space:]]*#.*$//' "$DOCKERFILE" \
      | grep -oE 'npm run build[[:space:]]+(-w|--workspace)[[:space:]=]+packages/[A-Za-z0-9._-]+' \
      || true; } \
    | sed -E 's#.*packages/##'
)

if [ -z "$declared" ]; then
  echo "ERROR: could not parse the \"workspaces\" array from $PACKAGE_JSON_REL." >&2
  echo "       Refusing to report a clean tree from a list this guard never read." >&2
  exit 2
fi
if [ -z "$built" ]; then
  echo "ERROR: found no 'npm run build -w packages/<name>' lines in $DOCKERFILE_REL." >&2
  echo "       Either the builder stage stopped naming its packages, or this" >&2
  echo "       guard's pattern no longer matches how it does. Fix one of them." >&2
  exit 2
fi

# A name repeated in the Dockerfile makes the sequence comparison below
# meaningless, so it is its own failure rather than a confusing diff.
dupes=$(printf '%s\n' "$built" | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "ERROR: $DOCKERFILE_REL builds the same workspace more than once:" >&2
  printf '         packages/%s\n' $dupes >&2
  exit 1
fi

if [ "$declared" != "$built" ]; then
  cat >&2 <<EOF
ERROR: the build order in $DOCKERFILE_REL does not match the
       "workspaces" array in $PACKAGE_JSON_REL.

  "workspaces" ($PACKAGE_JSON_REL, the declared dependency order):
$(printf '%s\n' "$declared" | sed 's/^/    packages\//')

  npm run build -w ... ($DOCKERFILE_REL, the order the image is built in):
$(printf '%s\n' "$built" | sed 's/^/    packages\//')

Hint: a workspace whose dependency has not been built yet cannot resolve that
dependency's types -- @claw/* packages point "types" at dist/index.d.ts, which
only exists after that package is built -- so tsc fails with
"TS2307: Cannot find module '@claw/<dep>'" and the image build dies in the
builder stage. Nothing else in CI reads this order: the root 'npm run build'
uses --workspaces and walks the array above instead.

Fix: make the Dockerfile sequence identical to "workspaces". If a new package
was added, put it in dependency order in BOTH lists.
EOF
  exit 1
fi

echo "lint-dockerfile-build-order: OK ($(printf '%s' "$built" | tr '\n' ' '))"
