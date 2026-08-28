#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Shared definitions for the release guards. Sourced by public-tree-scan.sh,
# which searches the working tree, and public-message-scan.sh, which searches
# commit messages and author identities.
#
# One list, deliberately. The tree scan and the message scan have to forbid the
# same strings, and a second copy is how they drift: an offline checker already
# went stale against this list once, reporting a placeholder as a live key
# because the exemption was added here and not there.

# Refuse to run rather than report a clean result we never looked at. Every
# search tolerates ripgrep's "no match" exit, which on a missing or PCRE2-less
# binary is indistinguishable from a search that never ran: the guard would
# report clean over content holding a live key. ripgrep is not preinstalled on
# GitHub's Ubuntu runners, so this is the expected failure.
require_ripgrep() {
  local who="$1"
  if ! command -v rg >/dev/null 2>&1; then
    echo "$who: ripgrep (rg) is required but not installed" >&2
    exit 2
  fi
  if ! rg --pcre2-version >/dev/null 2>&1; then
    echo "$who: this ripgrep lacks PCRE2; rg -P patterns cannot run" >&2
    exit 2
  fi
}

# Separates "found nothing" from "could not look". ripgrep exits 0 on a match,
# 1 on none, and 2 or above on error.
search() {
  local output status
  set +e
  output="$(rg "$@")"
  status=$?
  set -e
  if [ "$status" -gt 1 ]; then
    echo "release guard: ripgrep failed with exit $status for: $*" >&2
    exit 2
  fi
  printf '%s' "$output"
}

# Built from fragments so the guards do not match themselves, and so the
# release history rewrite cannot replace the rules it is scanning for. Each
# entry names something internal; the product and vendor names those things are
# built on are public and are deliberately not listed.
forbidden=(
  # Internal storage layout. Matched as a path, not as the bare product name:
  # the repository legitimately discusses running on WekaFS, and blocking the
  # vendor name would flag 248 ordinary sentences to catch 181 real paths.
  # This is also the likeliest string to come back, since developer working
  # copies live under this very prefix.
  "/weka""fs/"
  "/mnt/""weka"

  # Internal deployment endpoints. Matched as hostnames, not as the product
  # name: AMD-AGI/Primus-SaFE is a public repository that this tree correctly
  # references by name. These reached the history as real endpoints pasted
  # into values files and docs, 1122 times over, and deploying against the
  # clusters stays a normal thing to do, so they have a way back in.
  "primus""-safe.amd.com"
  "amddev""cloud.com"
  "core""42"
  "oci-""slc"
  "tw""325"

  # An internal cluster's DNS suffix. It reaches a repository through the
  # author field of a commit made on a login node with unconfigured git, and
  # through prose quoting such an address, which is why it is listed here and
  # was not worth listing while the only guard searched the working tree.
  "tensor""wave.lan"

  # Another internal cluster's DNS suffix. Matched as the suffix, not as the
  # provider name: the provider is public and naming it is fine, while a host
  # under this domain is an internal endpoint. One arrived as a chart default
  # for a Slurm controller address and the tree scan passed, because a guard
  # only blocks what it lists.
  "crusoe"".amd.com"

  # Internal component names.
  "primus""-cortex"
  "control-plane-""sandbox"
)

# Checked in the working tree but not in commit messages. This one is a
# default-credential lint rather than an internal identifier: it means
# something as the value of a configuration key and nothing as English, so
# matching it in prose only teaches contributors to avoid the phrase.
forbidden_tree_only=(
  "change""-me"
)

# Patterns a fixed string cannot express. Case-sensitive, so ripgrep needs -P.
forbidden_re=(
  # SaFE API key shape: 'ak-' plus a 40+ character body. Test fixtures that
  # need a key-shaped literal must spell EXAMPLE into it, which both keeps
  # this guard quiet and tells a reader the value is not live.
  'ak-(?!EXAMPLE)[A-Za-z0-9_-]{40,}'

  # A personal directory on an internal share. The mount point itself is
  # something this tree legitimately names; a per-developer home under it is
  # not, and one became a chart default for a report output directory. Only the
  # `<name>/` form is matched, so a bare filename under the mount point stays
  # allowed while `/shared_nfs/<user>/...` does not.
  '/shared_nfs/[A-Za-z][A-Za-z0-9._-]*/'
)

# Excluded from the tree scan because they hold the rules themselves. The
# fragments above already keep them from self-matching; this is the belt to
# that pair of braces, and is kept to exactly these files so the exclusion
# cannot grow into a blind spot.
guard_globs=(
  --glob '!scripts/release-tests/forbidden-strings.sh'
  --glob '!scripts/release-tests/public-tree-scan.sh'
  --glob '!scripts/release-tests/public-message-scan.sh'
  --glob '!.git/**'
)
