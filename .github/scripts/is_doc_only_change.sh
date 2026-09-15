#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Exit 0 when every path is documentation or repo-metadata only; 1 otherwise.
# Patterns match CONTRIBUTING.md "Canonical paths-ignore list" and GitHub's
# workflow paths-ignore (root LICENSE*, not nested names).
set -euo pipefail

is_doc_only_path() {
  local p="${1#./}"
  case "$p" in
    *.md) return 0 ;;
    docs | docs/*) return 0 ;;
    COPYRIGHT | CODEOWNERS | .gitattributes) return 0 ;;
    LICENSE*)
      case "$p" in
        */*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

self_test() {
  local p
  for p in \
    sandbox/docs/API.md \
    README.md \
    docs/conf.py \
    LICENSE \
    LICENSE-MIT \
    COPYRIGHT \
    CODEOWNERS \
    .gitattributes; do
    is_doc_only_path "$p" || {
      echo "expected doc-only: $p" >&2
      return 1
    }
  done
  for p in \
    .github/CODEOWNERS \
    .github/workflows/tests-coverage.yml \
    memory/memory-service/src/x.py \
    LICENSE/nested \
    claw/README.ts; do
    if is_doc_only_path "$p"; then
      echo "expected suite: $p" >&2
      return 1
    fi
  done
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi

if [ "$#" -gt 0 ]; then
  for p in "$@"; do
    is_doc_only_path "$p" || exit 1
  done
  exit 0
fi

while IFS= read -r p || [ -n "${p:-}" ]; do
  [ -z "${p:-}" ] && continue
  is_doc_only_path "$p" || exit 1
done
exit 0
