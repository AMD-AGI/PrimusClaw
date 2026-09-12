#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-metrics-must-register.sh
#
# Enforce Plan Y v2 (checkpoint-architecture-redesign §12.1) discipline
# in every metrics module listed in $targets:
#
#   1. Every `new Counter(...)`, `new Gauge(...)`, `new Histogram(...)`
#      or `new Summary(...)` MUST contain `registers: [registry]`
#      somewhere in its constructor argument object. Missing this
#      causes prom-client to register against its global default
#      registry; the metric then silently disappears from the pod's
#      /metrics endpoint (the route exposes ONLY the local registry).
#      This is the worst class of monitoring bug — everything looks
#      fine on the surface but data is lost.
#
#   2. Every `.labels(...)` argument MUST be a quoted string literal or a
#      bare identifier. A dynamic value — an interpolation, a property
#      read, a call — is unbounded cardinality, which OOMs Prometheus.
#      Bare identifiers stay legal because the helpers in these files take
#      literal-union parameters, so TypeScript has already closed the
#      domain at the call site. This is a text check, not a type check.
#
# Modes (same convention as the workspace-sync lint guard introduced in C7):
#
#   (no args)    pre-commit: lints the listed files that are staged for
#                commit (only fires when at least one is in the staged set).
#   --all        CI: lints the current working-tree copy of every target.
#   --self-test  Seed each violation into a copy of every target and require
#                the checks to reject it, so a guard that stopped guarding
#                fails CI rather than passing everything.
#
# Exit codes:
#   0  no violation
#   1  at least one violation found
#   2  invocation error (bad arg, file missing in CI mode)

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--all|--self-test]" >&2
  exit 2
}

mode="staged"
if [ "$#" -gt 0 ]; then
  case "$1" in
    --all)       mode="all" ;;
    --self-test) mode="self-test" ;;
    -h|--help)   usage ;;
    *)           usage ;;
  esac
fi

targets=(
  "claw/packages/brain/src/infra/metrics.ts"
  "claw/packages/api/src/infra/metrics.ts"
)

# ── Check 1: every metric constructor needs `registers: [registry]` ──
#
# State machine over the file:
#   in_def == 1 between the line containing `new (Counter|Gauge|Histogram|Summary)(`
#   and the matching `});`. has_register flips to 1 once we see the binding.
#   On close, if has_register is still 0, report (start_line + buffered body).
check_registers() {
  awk '
    /new (Counter|Gauge|Histogram|Summary)\(/ {
      start = NR; in_def = 1; has_register = 0; buf = $0; next
    }
    in_def {
      buf = buf "\n" $0
      if (/registers: \[registry\]/) has_register = 1
      if (/^\}\);|^\s*\}\);$/) {
        if (!has_register) printf "  metric defined at line %d missing registers: [registry]\n%s\n\n", start, buf
        in_def = 0
      }
    }
  ' "$1"
}

# ── Check 2: .labels(...) values must be literals or narrowed identifiers ──
#
# The argument list is read to its own closing paren, object braces dropped, and
# each `key: value` split off, so `.labels({ reason: err.message })` and any
# template interpolation are reported while `.labels({ kind, result })` and
# `.labels("turn")` pass.
check_labels() {
  awk '
    /\.labels\(/ {
      rest = substr($0, index($0, ".labels(") + 8)
      depth = 1; args = ""
      for (i = 1; i <= length(rest); i++) {
        c = substr(rest, i, 1)
        if (c == "(") depth++
        else if (c == ")") { depth--; if (depth == 0) break }
        args = args c
      }
      gsub(/[{}]/, "", args)
      n = split(args, parts, ",")
      for (i = 1; i <= n; i++) {
        v = parts[i]
        sub(/^[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*:/, "", v)
        gsub(/^[[:space:]]+/, "", v); gsub(/[[:space:]]+$/, "", v)
        if (v == "") continue
        if (v ~ /^"[^"]*"$/ || v ~ /^\047[^\047]*\047$/) continue
        if (v ~ /^[A-Za-z_$][A-Za-z0-9_$]*$/) continue
        printf "  line %d: .labels(...) value is neither a string literal nor a bare identifier: %s\n", NR, v
      }
    }
  ' "$1"
}

# Runs both passes over every argument, reports once, and answers 1 when any
# file failed either check.
scan_files() {
  local register_violations="" label_violations="" f
  for f in "$@"; do
    register_violations+=$(check_registers "$f")
    label_violations+=$(check_labels "$f")
  done

  if [ -n "$register_violations" ]; then
    cat >&2 <<EOF
ERROR: prom-client metric is missing 'registers: [registry]'

$register_violations

Hint: a metric without explicit registers: [registry] lands in
prom-client's global default registry, which the /metrics route
does NOT serve. The metric then silently disappears from monitoring.

Refs: checkpoint-architecture-redesign.md sec 12.1, sec 12.1.1
EOF
  fi

  if [ -n "$label_violations" ]; then
    cat >&2 <<EOF
ERROR: .labels(...) called with a value that is not a closed label domain

$label_violations

Hint: label values must come from a literal-union parameter or a string
literal. A message, an id or an interpolation is one new time series per
distinct value, and the old series never dies.
EOF
  fi

  [ -z "$register_violations" ] && [ -z "$label_violations" ]
}

if [ "$mode" = "self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  for target in "${targets[@]}"; do
    if [ ! -f "$target" ]; then
      echo "ERROR: $target not found in working tree." >&2
      exit 2
    fi
    unregistered="$tmp/unregistered.ts"
    # The field, not the header comment that quotes it.
    awk 'BEGIN { done = 0 } /^[[:space:]]*registers: \[registry\],?[[:space:]]*$/ && !done { done = 1; next } { print }' \
      "$target" > "$unregistered"
    if scan_files "$unregistered" >/dev/null 2>&1; then
      echo "ERROR: self-test: check 1 accepted a copy of $target with one" >&2
      echo "       'registers: [registry]' removed. The guard is not guarding." >&2
      exit 1
    fi
    interpolated="$tmp/interpolated.ts"
    cp "$target" "$interpolated"
    cat >> "$interpolated" <<'MUTANT'
counter.labels({ reason: `run-${err.message}` }).inc();
MUTANT
    if scan_files "$interpolated" >/dev/null 2>&1; then
      echo "ERROR: self-test: check 2 accepted an interpolated .labels() value" >&2
      echo "       appended to a copy of $target. The guard is not guarding." >&2
      exit 1
    fi
  done
  echo "lint-metrics-must-register: self-test OK"
  exit 0
fi

scan=()
if [ "$mode" = "staged" ]; then
  staged=$(git diff --cached --name-only --diff-filter=ACMR || true)
  for target in "${targets[@]}"; do
    if echo "$staged" | grep -qE "^${target}$"; then
      scan+=("$target")
    fi
  done
  [ "${#scan[@]}" -eq 0 ] && exit 0
else
  # Loudly, not as a warning. This guard scans hardcoded paths, so a missing
  # target means the file moved and the check no longer has anything to say --
  # which is indistinguishable from "no violations" to CI. Exiting 0 here
  # retired the guard on the first rename while keeping the pipeline green.
  for target in "${targets[@]}"; do
    if [ ! -f "$target" ]; then
      echo "ERROR: $target not found in working tree." >&2
      echo "       This guard scans hardcoded paths. If the file moved, update" >&2
      echo "       \$targets in this script; do not let the check retire silently." >&2
      exit 2
    fi
    scan+=("$target")
  done
fi

scan_files "${scan[@]}" || exit 1
exit 0
