#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Evaluate the rollout gates of claw/docs/doorbell-rollout.md against the real
# PromQL engine.
#
# Every gate in that document is published as a literal expression an operator
# pastes into a query window, and three of the properties they are written
# against -- a bare comparison filtering, an empty vector not being zero, and
# min/max not seeing an absent replica -- fail silently. A wrong expression
# there reads as a passing gate, so the fixture is only worth having if it is
# actually run.
#
# Missing promtool is fatal rather than a skip: a gate suite that quietly does
# not run is the same as no gate suite, and worse for being believed.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
promtool="${PROMTOOL:-}"
if [ -z "$promtool" ] && [ -x "$repo_root/.tools/bin/promtool" ]; then
  promtool="$repo_root/.tools/bin/promtool"
fi
promtool="${promtool:-promtool}"

# Install it rather than only naming the installer. "Missing promtool is fatal
# rather than a skip" is about never reporting a pass this suite did not run --
# it is not a reason to stop at printing a command. The only caller that had an
# install step in front of it was lint.yaml; release-gates.yml runs
# `make release-verify` on a bare ubuntu runner, and `make verify-lint` runs on
# whatever a contributor happens to have. Both aborted here under `set -e`,
# taking every later gate -- Helm lint/render, the image build, the Hands
# self-check, the migration smoke -- with them, for a missing tool rather than
# for anything the release got wrong.
#
# Safe to do unasked: install-promtool.sh is idempotent and pins the version by
# digest, so this is a no-op when the binary is already there and a verified
# download when it is not. PROMTOOL=... still wins, and an install that fails
# leaves the original refusal below.
if ! command -v "$promtool" >/dev/null 2>&1; then
  bash "$repo_root/scripts/release-tests/install-promtool.sh" >&2 || true
  [ -z "${PROMTOOL:-}" ] && [ -x "$repo_root/.tools/bin/promtool" ] \
    && promtool="$repo_root/.tools/bin/promtool"
fi

command -v "$promtool" >/dev/null 2>&1 || {
  echo "error: promtool is required for the rollout gate tests but was not found," >&2
  echo "       and installing it failed. Check network access, or set PROMTOOL=..." >&2
  echo "  Run: bash scripts/release-tests/install-promtool.sh" >&2
  exit 1
}

"$promtool" test rules "$repo_root/claw/deploy/promql/rollout-gates.test.yaml"
