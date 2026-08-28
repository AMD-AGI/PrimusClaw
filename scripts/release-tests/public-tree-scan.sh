#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Searches the working tree for internal strings that must not ship publicly.
# Commit messages and author identities are the other way these strings reach
# a repository, and are covered by public-message-scan.sh.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# shellcheck source=scripts/release-tests/forbidden-strings.sh
source "$repo_root/scripts/release-tests/forbidden-strings.sh"

require_ripgrep "public tree scan"

# The set to search is what git can see, not what a filesystem walk finds.
#
# ripgrep honours every .gitignore in the tree, and --hidden only lifts the
# dotfile filter -- so a file that is ignored but tracked anyway (`git add -f`,
# which is how a values.<ns>.env or a stray credential file gets committed)
# was skipped by the walk while still being published. That is the exact shape
# this guard exists to stop, and it reported "clean" on it.
#
# `git ls-files -c -o --exclude-standard` is tracked files plus untracked ones
# git would not ignore: a superset of both what ships and what the old walk
# covered, and it excludes node_modules and build output by construction rather
# than by a growing list of --glob exclusions.
#
# Refusing to run without git is deliberate, and the same choice
# require_ripgrep makes: a clean result from a set this guard never enumerated
# is worse than no result.
if ! command -v git >/dev/null 2>&1; then
  echo "public tree scan: git is required to enumerate the published file set" >&2
  exit 2
fi
if ! mapfile -d '' -t tree_files < <(git ls-files -c -o --exclude-standard -z 2>/dev/null); then
  echo "public tree scan: could not list files with git (not a repository?)" >&2
  exit 2
fi
if [ "${#tree_files[@]}" -eq 0 ]; then
  echo "public tree scan: git listed no files; refusing to report a clean tree" >&2
  exit 2
fi

failed=false
for literal in "${forbidden[@]}" "${forbidden_tree_only[@]}"; do
  matches="$(search -ni -F --hidden "${guard_globs[@]}" "$literal" -- "${tree_files[@]}")"

  if [ -n "$matches" ]; then
    printf '%s\n' "$matches"
    echo "public tree contains forbidden internal/default literal: $literal" >&2
    failed=true
  fi
done

for pattern in "${forbidden_re[@]}"; do
  matches="$(search -n -P --hidden "${guard_globs[@]}" "$pattern" -- "${tree_files[@]}")"

  if [ -n "$matches" ]; then
    printf '%s\n' "$matches"
    echo "public tree matches forbidden internal pattern: $pattern" >&2
    failed=true
  fi
done

if [ "$failed" = "true" ]; then
  exit 1
fi

echo "public tree scan: clean"
