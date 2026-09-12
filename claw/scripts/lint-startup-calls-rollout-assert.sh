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
# binds the port and can exit the process. The subprocess boot tests in
# claw/packages/api/test/startup-rollout-boot.test.ts prove the assertion runs
# on a configuration it refuses; they cannot see the ordering, because a boot
# whose configuration is accepted looks the same whether the check ran before
# the socket or after it.
#
# The ordering is the point. Below app.listen the pod serves traffic on a
# configuration the rollout rule forbids -- admission metering runs that the
# doorbell will never wake -- for as long as it takes the assertion to throw,
# and a rollback executed in the wrong order then fails a soak instead of CI.
#
# Modes (same convention as the other lint guards in this directory):
#
#   (no args)    pre-commit: lints index.ts only when it is staged.
#   --all        CI: lints the current working tree.
#   --self-test  Seed each violation into a copy of index.ts and require the
#                checks to reject it, so a guard that stopped guarding fails
#                CI rather than passing everything.
#
# Exit codes:
#   0  no violation
#   1  at least one violation found
#   2  invocation error (bad arg, file missing)

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REL="packages/api/src/index.ts"
TARGET="$SCRIPT_DIR/../$TARGET_REL"
BOOT_TEST_REL="test/startup-rollout-boot.test.ts"

# Runs every check over one file, reports against $label, and answers 1 when any
# check failed. A status rather than an exit, so the self-test can call it under
# `set -e` and treat a rejection as the expected outcome.
scan_file() {
  local file="$1" label="$2" fail=0 assert_line listen_line admission_line

  assert_line=$(grep -nE '^[[:space:]]*assertRolloutConfigAtStartup\(' "$file" | head -n 1 | cut -d: -f1)
  listen_line=$(grep -nE 'app\.listen\(' "$file" | head -n 1 | cut -d: -f1)

  if [ -z "$assert_line" ]; then
    echo "ERROR: $label: main() must call assertRolloutConfigAtStartup()" >&2
    echo "       beside the other fatal startup assertions. It is missing." >&2
    fail=1
  fi

  if [ -z "$listen_line" ]; then
    echo "ERROR: $label: no app.listen( found. This guard checks that the" >&2
    echo "       rollout assertion precedes it; update \$TARGET_REL in this" >&2
    echo "       script rather than letting the ordering check retire silently." >&2
    fail=1
  fi

  # The rollout assertion applies the enablement gauges on its way through, so an
  # assertion that can throw first would leave a started pod exporting neither.
  admission_line=$(grep -nE '^[[:space:]]*assertAdmissionSettings\(' "$file" | head -n 1 | cut -d: -f1)
  if [ -n "$admission_line" ] && [ -n "$assert_line" ] && [ "$assert_line" -gt "$admission_line" ]; then
    echo "ERROR: $label: assertRolloutConfigAtStartup() must run before" >&2
    echo "       assertAdmissionSettings(), which can throw before the rollout" >&2
    echo "       gauges have been applied." >&2
    fail=1
  fi

  if [ -n "$assert_line" ] && [ -n "$listen_line" ] && [ "$assert_line" -gt "$listen_line" ]; then
    echo "ERROR: $label: assertRolloutConfigAtStartup() is called at line" >&2
    echo "       $assert_line, below app.listen() at line $listen_line. The pod would" >&2
    echo "       serve traffic on a configuration the rollout rule forbids." >&2
    fail=1
  fi

  if [ "$fail" -ne 0 ]; then
    echo >&2
    echo "See claw/packages/api/src/startup/rollout-config.ts for the rule." >&2
    return 1
  fi
  return 0
}

require_target() {
  if [ ! -f "$TARGET" ]; then
    echo "lint-startup-calls-rollout-assert: $TARGET not found" >&2
    exit 2
  fi
}

# Deletes the call, so check 1 is the only one that can fire.
seed_missing_call() {
  awk '/^[[:space:]]*assertRolloutConfigAtStartup\(/ { next } { print }' "$TARGET" > "$1"
}

# Moves the call below the first line matching $2, which is how a real rollback
# regression looks: still present, still in main(), just too late. $2 must spell
# metacharacters as bracket expressions: awk applies escape processing to a -v
# assignment, and gawk drops the backslash of \( before the regex is compiled.
seed_call_below() {
  awk -v anchor="$2" '
    /^[[:space:]]*assertRolloutConfigAtStartup\(/ && !moved { call = $0; moved = 1; next }
    { print }
    $0 ~ anchor && moved && !placed { print call; placed = 1 }
  ' "$TARGET" > "$1"
}

reject_or_die() {
  local mutant="$1" what="$2"
  if scan_file "$mutant" "self-test/$(basename "$mutant" .ts)" >/dev/null 2>&1; then
    echo "ERROR: self-test: the guard accepted a copy of $TARGET_REL with" >&2
    echo "       $what. The guard is not guarding." >&2
    exit 1
  fi
}

# The boot test is the other half of the invariant and has its own runner. An
# absent runner is an invocation error, not a pass: reporting a clean self-test
# without it is the vacuous green this mode exists to remove.
run_boot_test() {
  local tsx="$SCRIPT_DIR/../node_modules/.bin/tsx"
  if [ ! -x "$tsx" ]; then
    echo "lint-startup-calls-rollout-assert: self-test needs $tsx to run" >&2
    echo "       $BOOT_TEST_REL. Install the workspace dependencies first." >&2
    exit 2
  fi
  ( cd "$SCRIPT_DIR/../packages/api" && "$tsx" --test "$BOOT_TEST_REL" )
}

if [ "$mode" = "self-test" ]; then
  require_target
  if [ ! -f "$SCRIPT_DIR/../packages/api/$BOOT_TEST_REL" ]; then
    echo "lint-startup-calls-rollout-assert: $BOOT_TEST_REL not found; the header" >&2
    echo "       above claims it proves the assertion runs at boot." >&2
    exit 2
  fi

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  seed_missing_call "$tmp/missing.ts"
  reject_or_die "$tmp/missing.ts" "the assertRolloutConfigAtStartup() call removed"

  seed_call_below "$tmp/below-listen.ts" 'app[.]listen[(]'
  reject_or_die "$tmp/below-listen.ts" "assertRolloutConfigAtStartup() moved below app.listen()"

  seed_call_below "$tmp/below-admission.ts" '^[[:space:]]*assertAdmissionSettings[(]'
  reject_or_die "$tmp/below-admission.ts" \
    "assertRolloutConfigAtStartup() moved below assertAdmissionSettings()"

  run_boot_test

  echo "lint-startup-calls-rollout-assert: self-test OK"
  exit 0
fi

if [ "$mode" = "staged" ]; then
  if ! git diff --cached --name-only | grep -q "$TARGET_REL"; then
    exit 0
  fi
fi

require_target
scan_file "$TARGET" "$TARGET_REL" || exit 1

echo "lint-startup-calls-rollout-assert: OK"
