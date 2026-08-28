#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Searches commit messages and author identities for the same internal strings
# public-tree-scan.sh keeps out of the working tree.
#
# A tree scan cannot see either. Both have put an internal hostname into this
# repository: a commit made where git was unconfigured carries the machine's
# address in its author field, and a message explaining why some endpoint is
# being removed tends to quote the endpoint. History is the one part of a
# repository that cannot be corrected by a follow-up commit, so the check has
# to run before the merge rather than after.
#
# Usage: public-message-scan.sh [<range>]   (default: origin/main..HEAD)

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# shellcheck source=scripts/release-tests/forbidden-strings.sh
source "$repo_root/scripts/release-tests/forbidden-strings.sh"

require_ripgrep "public message scan"

range="${1:-origin/main..HEAD}"

if ! git rev-list --quiet "$range" -- 2>/dev/null; then
  echo "public message scan: cannot resolve range '$range'." >&2
  echo "  A shallow checkout is the usual cause; fetch-depth: 0 fixes it." >&2
  exit 2
fi

scan_file="$(mktemp)"
trap 'rm -f "$scan_file"' EXIT

# One file, every line prefixed with the commit it came from, so a single pass
# per literal can still say which commit is at fault. Collected in one git call
# rather than three per commit, which over a full-history range is the
# difference between a second and twenty.
commits="$(git rev-list --count "$range")"
git log --format='%x01%H%nauthor %an <%ae>%ncommitter %cn <%ce>%n%B' "$range" |
  awk 'BEGIN { mark = sprintf("%c", 1) }
       substr($0, 1, 1) == mark { sha = substr($0, 2, 9); next }
       { print sha, $0 }' >"$scan_file"

if [ "$commits" -eq 0 ]; then
  echo "public message scan: no commits in $range"
  exit 0
fi

failed=false
for literal in "${forbidden[@]}"; do
  matches="$(search -ni -F "$literal" "$scan_file")"

  if [ -n "$matches" ]; then
    printf '%s\n' "$matches" | sed 's|^[0-9]*:||'
    echo "commit message or author identity contains forbidden internal/default literal: $literal" >&2
    failed=true
  fi
done

for pattern in "${forbidden_re[@]}"; do
  matches="$(search -n -P "$pattern" "$scan_file")"

  if [ -n "$matches" ]; then
    printf '%s\n' "$matches" | sed 's|^[0-9]*:||'
    echo "commit message or author identity matches forbidden internal pattern: $pattern" >&2
    failed=true
  fi
done

if [ "$failed" = "true" ]; then
  echo "History cannot be corrected by a follow-up commit; amend or rebase these" >&2
  echo "commits before merging." >&2
  exit 1
fi

echo "public message scan: clean ($commits commits in $range)"
