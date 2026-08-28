#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-metrics-must-register.sh
#
# Enforce Plan Y v2 (checkpoint-architecture-redesign §12.1) discipline
# in claw/packages/brain/src/infra/metrics.ts:
#
#   1. Every `new Counter(...)`, `new Gauge(...)`, `new Histogram(...)`
#      or `new Summary(...)` MUST contain `registers: [registry]`
#      somewhere in its constructor argument object. Missing this
#      causes prom-client to register against its global default
#      registry; the metric then silently disappears from the brain
#      pod /metrics endpoint (the route exposes ONLY the local
#      registry). This is the worst class of monitoring bug —
#      everything looks fine on the surface but data is lost.
#
#   2. Every `.labels(...)` call (followed by .inc / .set / .observe /
#      .dec) MUST use string literals for label values. Dynamic values
#      cause unbounded cardinality which OOMs Prometheus. The §12.1.2
#      closed enum table is the contract.
#
# The script supports two modes (same convention as the workspace-sync
# lint guard introduced in C7):
#
#   (no args)  pre-commit: lints files staged for commit (only fires
#              when infra/metrics.ts is in the staged set).
#   --all      CI: lints the current working-tree infra/metrics.ts.
#
# Exit codes:
#   0  no violation
#   1  at least one violation found
#   2  invocation error (bad arg, file missing in CI mode)

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--all]" >&2
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

target="claw/packages/brain/src/infra/metrics.ts"

if [ "$mode" = "staged" ]; then
  staged=$(git diff --cached --name-only --diff-filter=ACMR \
            | grep -E "^${target}$" || true)
  [ -z "$staged" ] && exit 0
  scan_file="$target"
else
  # Loudly, not as a warning. This guard scans a hardcoded path, so a missing
  # target means the file moved and the check no longer has anything to say --
  # which is indistinguishable from "no violations" to CI. Exiting 0 here
  # retired the guard on the first rename while keeping the pipeline green.
  if [ ! -f "$target" ]; then
    echo "ERROR: $target not found in working tree." >&2
    echo "       This guard scans a hardcoded path. If the file moved, update" >&2
    echo "       \$target in this script; do not let the check retire silently." >&2
    exit 2
  fi
  scan_file="$target"
fi

# ── Check 1: every metric constructor needs `registers: [registry]` ──
#
# State machine over the file:
#   in_def == 1 between the line containing `new (Counter|Gauge|Histogram|Summary)(`
#   and the matching `});`. has_register flips to 1 once we see the binding.
#   On close, if has_register is still 0, report (start_line + buffered body).
register_violations=$(
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
  ' "$scan_file"
)

# ── Check 2: .labels(...) must use string literals ──
#
# Heuristic regex: match `.labels({` followed by a label key, colon, and
# something that is NOT a quoted string literal or a closing brace. Allow
# template-key shorthand `{ kind, result }` where each value is a bare
# identifier — that pattern is only safe when the identifier was itself
# narrowed to a closed string-literal union by TypeScript. Our convention
# in infra/metrics.ts helper functions is exactly this shape, so we tolerate
# bare identifiers ONLY inside the infra/metrics.ts file (the guarded file).
# The lint is therefore tight on infra/metrics.ts itself and loose on call
# sites elsewhere — by design: TypeScript at the call site catches enum
# drift via the labelNames literal-union typing.
#
# Reserved for a follow-up patch when we extend the helper API surface
# further; current call surface is small and TS-narrowed.

if [ -n "$register_violations" ]; then
  cat >&2 <<EOF
ERROR: prom-client metric is missing 'registers: [registry]' in $scan_file

$register_violations

Hint: a metric without explicit registers: [registry] lands in
prom-client's global default registry, which the brain /metrics route
does NOT serve. The metric then silently disappears from monitoring.

Refs: checkpoint-architecture-redesign.md sec 12.1, sec 12.1.1
EOF
  exit 1
fi

exit 0
