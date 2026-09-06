#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-startup-calls-rollout-assert.sh
#
# Enforce that claw/packages/api/src/index.ts calls
# assertRolloutConfigAtStartup() in main(), above app.listen().
#
# Why a lint rather than a unit test: nothing in index.ts is exported and
# main() is invoked at module scope, so importing the file to check the call
# binds the port and can exit the process. The subprocess boot tests prove the
# assertion runs on a configuration it refuses; they cannot see the ordering,
# because a boot whose configuration is accepted looks the same whether the
# check ran before the socket or after it.
#
# The ordering is the point. Below app.listen the pod serves traffic on a
# configuration the rollout rule forbids -- admission metering runs that the
# doorbell will never wake -- for as long as it takes the assertion to throw,
# and a rollback executed in the wrong order then fails a soak instead of CI.
#
# Modes (same convention as the other lint guards in this directory):
#   (no args)  pre-commit: lints index.ts only when it is staged.
#   --all      CI: lints the current working tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REL="packages/api/src/index.ts"
TARGET="$SCRIPT_DIR/../$TARGET_REL"

if [ "${1:-}" != "--all" ]; then
  if ! git diff --cached --name-only | grep -q "$TARGET_REL"; then
    exit 0
  fi
fi

if [ ! -f "$TARGET" ]; then
  echo "lint-startup-calls-rollout-assert: $TARGET not found" >&2
  exit 1
fi

fail=0

assert_line=$(grep -nE '^[[:space:]]*assertRolloutConfigAtStartup\(' "$TARGET" | head -n 1 | cut -d: -f1)
listen_line=$(grep -nE 'app\.listen\(' "$TARGET" | head -n 1 | cut -d: -f1)

if [ -z "$assert_line" ]; then
  echo "ERROR: $TARGET_REL: main() must call assertRolloutConfigAtStartup()" >&2
  echo "       beside the other fatal startup assertions. It is missing." >&2
  fail=1
fi

if [ -z "$listen_line" ]; then
  echo "ERROR: $TARGET_REL: no app.listen( found. This guard checks that the" >&2
  echo "       rollout assertion precedes it; update \$TARGET_REL in this" >&2
  echo "       script rather than letting the ordering check retire silently." >&2
  fail=1
fi

if [ -n "$assert_line" ] && [ -n "$listen_line" ] && [ "$assert_line" -gt "$listen_line" ]; then
  echo "ERROR: $TARGET_REL: assertRolloutConfigAtStartup() is called at line" >&2
  echo "       $assert_line, below app.listen() at line $listen_line. The pod would" >&2
  echo "       serve traffic on a configuration the rollout rule forbids." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo >&2
  echo "See claw/packages/api/src/startup/rollout-config.ts for the rule." >&2
  exit 1
fi

echo "lint-startup-calls-rollout-assert: OK"
