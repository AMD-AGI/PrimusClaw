#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-drain-shutdown-guard.sh
#
# Enforce that the SIGTERM/SIGINT handler in claw/packages/brain/src/index.ts
# guards re-entry on the SHUTDOWN latch alone, never on the combined drain
# predicate.
#
# Why this needs a lint rather than a unit test: the handler is a closure inside
# installSignalHandlers() in index.ts, and index.ts calls main() at import time,
# so no test can import it without starting a Brain. DrainState itself is unit
# tested (test/drain-state.test.ts pins that beginShutdown() still returns true
# after beginVersionDrain()), but nothing there can see how index.ts wires it.
#
# The bug this prevents: the two drain reasons used to share one boolean, and
# the handler's re-entrancy guard was that boolean. A pod that had already
# version-drained -- the normal case during an upgrade, since upgrade.sh writes
# brain.min_version while the old pods are being terminated -- returned at the
# guard and skipped its entire shutdown: no ctrl.abort(SIGTERM_ABORT_REASON),
# so task-runner's handleSigtermAbort never ran and in-flight runs lost their
# checkpoint and their nak; no flushPendingRetries(), so deferred claims were
# dropped to time out on their leases; no nc.drain(); no process.exit(0), so
# the pod idled out the full 300s grace and was SIGKILLed.
#
# Modes (same convention as the other lint guards in this directory):
#   (no args)  pre-commit: lints index.ts only when it is staged.
#   --all      CI: lints the current working tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REL="packages/brain/src/index.ts"
TARGET="$SCRIPT_DIR/../$TARGET_REL"

if [ "${1:-}" != "--all" ]; then
  if ! git diff --cached --name-only | grep -q "$TARGET_REL"; then
    exit 0
  fi
fi

if [ ! -f "$TARGET" ]; then
  echo "lint-drain-shutdown-guard: $TARGET not found" >&2
  exit 1
fi

fail=0

# Matched loosely on purpose. An exact-string rule is brittle in both
# directions: it trips on a rename or a reformat that changes nothing, and it
# misses the regression written in any other shape. What matters is only that
# the shutdown latch, and not the combined predicate, is what gates re-entry.

# 1. Shutdown must be entered through the latch's own accessor. `beginShutdown`
#    returns false exactly when shutdown is already under way, which is the
#    only thing the handler may short-circuit on.
if ! grep -qE 'beginShutdown\(\)' "$TARGET"; then
  echo "ERROR: $TARGET_REL: the signal handler must enter shutdown through" >&2
  echo "       beginShutdown(), whose false return is the 'already shutting" >&2
  echo "       down' case. It is missing entirely." >&2
  fail=1
fi

# 2. Nothing may short-circuit on the combined predicate. isDraining() /
#    .draining answer 'should I stop taking work', which a version-drained pod
#    also answers yes to -- using it here is what made a SIGTERM arriving after
#    a version drain return without aborting sessions, flushing claims or
#    exiting. Covers `return`, `break` and an early-exit block on the same line.
if grep -nE '\b(isDraining\(\)|drainState\.draining)\b[^;]*\)[[:space:]]*(return|break|\{[[:space:]]*return)' "$TARGET" >/dev/null; then
  echo "ERROR: $TARGET_REL: found an early exit gated on the combined drain" >&2
  echo "       predicate. Gate re-entry on drainState.beginShutdown() instead:" >&2
  grep -nE '\b(isDraining\(\)|drainState\.draining)\b[^;]*\)[[:space:]]*(return|break|\{[[:space:]]*return)' "$TARGET" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo >&2
  echo "See claw/packages/brain/src/infra/drain-state.ts for the invariant." >&2
  exit 1
fi

echo "lint-drain-shutdown-guard: OK"
