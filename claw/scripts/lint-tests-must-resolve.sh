#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-tests-must-resolve.sh
#
# Refuse a test file that names something the compiler cannot resolve.
#
# Every package's tsconfig has `"include": ["src"]`, so `npm run typecheck`
# never opens the test directory. That is deliberate -- the suites build partial
# stubs and cast them, and holding them to the source's strictness would be a
# different project -- but it leaves one class of mistake with no reader at all:
# a name that does not exist. TypeScript would say so in a word; nothing runs
# TypeScript over these files, and the runtime does not say so at all, because
# the suites are written around seams that catch:
#
#   const CLEAR = '...';            // in the test above this one, not this one
#   async exec() { return { stdout: CLEAR }; }
#
# `exec` is a provider stub. A ReferenceError out of it is swallowed by the
# caller's own try/catch, the read is classified `unknown`, the branch under
# test is never reached -- and the test passes, green, having asserted nothing.
# That shipped: a regression test written for a real defect was landed, run, and
# reported as passing while the line it was meant to guard was not executed
# once. It was caught by reverting the fix and noticing the test still passed.
#
# So this guard runs tsc over `test/` and fails on the resolution errors only.
# The full type errors are left alone on purpose: there are ~200 of them across
# ~60 files, all of the "this stub is not really a ClaimedRun" kind, and none of
# them can make a test silently assert nothing. Turning those on is a separate
# piece of work with a separate argument; this is the half that is free today
# and that catches the failure this file is named after.
#
# Codes, all of them "you wrote a name that resolves to nothing":
#   TS2304   Cannot find name 'X'
#   TS2552   Cannot find name 'X'. Did you mean 'Y'?
#   TS2551   Property 'X' does not exist ... Did you mean 'Y'?
#   TS2503   Cannot find namespace 'X'
#   TS2686   'X' refers to a UMD global, but the current file is a module
#   TS18004  No value exists in scope for the shorthand property 'X'
#
# TS18004 is the same defect wearing shorthand: `return { stdout }` with no
# `stdout` in scope throws the identical ReferenceError from the identical
# stub, and reads as an ordinary object literal to everyone but the compiler.
#
# Usage:
#   lint-tests-must-resolve.sh --all         every package with a test directory
#   lint-tests-must-resolve.sh --self-test   prove the guard still catches one
#   lint-tests-must-resolve.sh               packages whose tests are staged

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$CLAW_DIR/.." && pwd)"

# The codes that mean "this name resolves to nothing".
CODES="TS2304|TS2552|TS2551|TS2503|TS2686|TS18004"

TSC="$CLAW_DIR/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "ERROR: $TSC is missing. Run npm install in claw/ first." >&2
  echo "       Refusing to report a clean tree without having compiled." >&2
  exit 2
fi
# Executable is not the same as runnable: the wrapper is a node script, so a
# PATH without node exits 127 and prints nothing a diagnostic filter can see.
if ! "$TSC" --version >/dev/null 2>&1; then
  echo "ERROR: $TSC is present but will not run (is node on PATH?)." >&2
  echo "       Refusing to report a clean tree without having compiled." >&2
  exit 2
fi

# A tsconfig that adds `test` to the package's own, written beside it so its
# relative "extends" and paths resolve, and removed however this exits.
lint_package() {
  local pkg_dir="$1"
  local name="${pkg_dir##*/}"
  [ -d "$pkg_dir/test" ] || return 0

  local cfg="$pkg_dir/tsconfig.lint-tests.json"
  cat >"$cfg" <<'JSON'
{
  "extends": "./tsconfig.json",
  "include": ["src", "test"],
  "compilerOptions": { "noEmit": true, "rootDir": "." }
}
JSON
  # tsc exits 1 for the type errors this guard deliberately ignores, so a
  # non-zero status is not by itself a failure -- but anything past its own
  # diagnostic range is the compiler failing to run rather than finding
  # something, and that must never read as a clean tree. 0/1 are "compiled,
  # here are the diagnostics"; 2 is a syntactic/config refusal, which for a
  # config this script just wrote means the guard is broken, not the tests.
  local out status
  set +e
  out="$(cd "$pkg_dir" && "$TSC" -p tsconfig.lint-tests.json 2>&1)"
  status=$?
  set -e
  rm -f "$cfg"
  if [ "$status" -gt 1 ]; then
    echo "ERROR: tsc exited $status for $name rather than reporting diagnostics." >&2
    printf '%s\n' "$out" | head -n 5 >&2
    echo "       Refusing to report a clean tree from a compile that did not run." >&2
    exit 2
  fi

  local hits
  hits="$(printf '%s\n' "$out" | grep -E "^test/.*error ($CODES)" || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$name:"
    printf '%s\n' "$hits"
    return 1
  fi
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  # Plant the exact mistake in a scratch package and require the guard to see
  # it, so a future change that quietly stops compiling the tests is caught by
  # this rather than by the next silently-passing regression test.
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/src" "$tmp/test"
  cat >"$tmp/tsconfig.json" <<JSON
{ "compilerOptions": { "target": "es2022", "module": "es2022",
  "moduleResolution": "bundler", "strict": true, "skipLibCheck": true,
  "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
JSON
  echo 'export const real = 1;' >"$tmp/src/index.ts"
  # Both shapes, because they are the same mistake and only one is obvious.
  for planted in 'export const used = NOT_A_REAL_NAME;' \
                 'export const used = { NOT_A_REAL_NAME };'; do
    echo "$planted" >"$tmp/test/a.test.ts"
    if lint_package "$tmp" >/dev/null 2>&1; then
      echo "ERROR: the self-test planted \`$planted\` and the guard passed." >&2
      echo "       The guard is not compiling the test directory any more." >&2
      exit 2
    fi
  done
  echo "lint-tests-must-resolve: self-test OK"
  exit 0
fi

pkgs=""
if [ "${1:-}" = "--all" ]; then
  for d in "$CLAW_DIR"/packages/*; do [ -d "$d/test" ] && pkgs+="$d"$'\n'; done
else
  if ! staged=$(git -C "$REPO_DIR" diff --cached --name-only --diff-filter=ACMR 2>&1); then
    echo "ERROR: could not read the staged file list from git:" >&2
    printf '       %s\n' "$(printf '%s\n' "$staged" | head -n 1)" >&2
    echo "       Refusing to report a clean tree without having looked. Use" >&2
    echo "       --all to lint the working tree outside a git repository." >&2
    exit 2
  fi
  # One package per staged test file; a package is compiled whole either way.
  for p in $(printf '%s\n' "$staged" \
      | grep -E '^claw/packages/[^/]+/test/.*\.ts$' \
      | cut -d/ -f3 | sort -u); do
    pkgs+="$CLAW_DIR/packages/$p"$'\n'
  done
  [ -z "$pkgs" ] && exit 0
fi

if [ -z "$pkgs" ]; then
  echo "ERROR: found no package with a test directory under claw/packages." >&2
  echo "       Refusing to report a clean tree from a set this guard never read." >&2
  exit 2
fi

violations=""
while IFS= read -r d; do
  [ -z "$d" ] && continue
  if ! out=$(lint_package "$d"); then
    violations+="$out"$'\n'
  fi
done <<< "$pkgs"

if [ -n "$violations" ]; then
  cat >&2 <<EOF
ERROR: a test names something that resolves to nothing.

$violations
This is not a style complaint. The test directory is outside \`typecheck\`, and
a bad name in a stub throws a ReferenceError that the seam around it catches --
so the branch under test is never reached and the test passes having asserted
nothing. Fix the name, then prove the test still fails without its fix.
EOF
  exit 1
fi

echo "lint-tests-must-resolve: OK"
