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

command -v "$promtool" >/dev/null 2>&1 || {
  echo "error: promtool is required for the rollout gate tests but was not found." >&2
  echo "  Run: bash scripts/release-tests/install-promtool.sh" >&2
  exit 1
}

"$promtool" test rules "$repo_root/claw/deploy/promql/rollout-gates.test.yaml"
