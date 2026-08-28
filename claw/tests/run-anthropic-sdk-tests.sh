#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# ═══════════════════════════════════════════════════════════════════════════
# Anthropic Managed Agents SDK compat layer -- test entry point.
#
# Runs claw-anthropic-sdk-rich-test.mjs against a live PrimusClaw
# deployment's /anthropic/v1/* compat layer using the real
# `@anthropic-ai/sdk` client (no mocking). 42 scenarios per run:
#   - V1-V19  input validation / auth error paths (design doc §11.2)
#   - V20-V39 P1/P2 method-surface coverage: agents/environments/sessions
#             list/retrieve/update/delete/archive, sessions.events.list,
#             sessions.resources.*, user.interrupt (design doc §11.6)
#   - E-A/B/C end-to-end: default runtime / skill plugin / MCP plugin,
#             each with a real LLM turn and a real K8s sandbox
#
# See primus-claw-anthropic-managed-agents-sdk-compat-design.html
# for the full design and primus-claw-anthropic-managed-agents-sdk-
# p1p2-implementation-verification-report-2026-07-12.html for the last
# 2-hour soak result (756/756 passed).
#
# Usage:
#   API_KEY=ak-... ANTHROPIC_BASE_URL=https://... ./run-anthropic-sdk-tests.sh
#
# Required:
#   API_KEY             ak-... API key with access to the target deployment.
#                         No default -- never hardcode this; the script
#                         fails fast if unset.
#   ANTHROPIC_BASE_URL  base URL of the target /anthropic/v1/* compat layer.
#                         No default -- prevents accidental requests to a
#                         public domain.
#
# Optional:
#   SKILL_PLUGIN_ID     plugin id wrapping a SKILL.md that injects a
#                         detectable marker string. default: 1
#   MCP_PLUGIN_ID       plugin id wrapping an MCP server exposing echo/add
#                         tools. default: 2
#
# Exit code mirrors the underlying node run: 0 on 42/42 pass, non-zero on any
# scenario failure (see [FAIL] lines in the output) or on a startup error
# (missing env var, missing node_modules, etc).
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_SCRIPT="$SCRIPT_DIR/claw-anthropic-sdk-rich-test.mjs"

export SKILL_PLUGIN_ID="${SKILL_PLUGIN_ID:-1}"
export MCP_PLUGIN_ID="${MCP_PLUGIN_ID:-2}"

if [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
  echo "ERROR: ANTHROPIC_BASE_URL is required; refusing to choose a public endpoint implicitly." >&2
  echo "  e.g.  ANTHROPIC_BASE_URL=https://<host>/claw-api-dev/anthropic API_KEY=ak-... $0" >&2
  exit 1
fi

if [ -z "${API_KEY:-}" ]; then
  echo "ERROR: API_KEY is required (an ak-... key with access to the target deployment)." >&2
  echo "  e.g.  API_KEY=ak-... $0" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required but not found on PATH." >&2
  exit 1
fi

if [ ! -f "$TEST_SCRIPT" ]; then
  echo "ERROR: test script not found: $TEST_SCRIPT" >&2
  exit 1
fi

if [ ! -d "$ROOT_DIR/node_modules/@anthropic-ai/sdk" ]; then
  echo "ERROR: @anthropic-ai/sdk not found under $ROOT_DIR/node_modules -- run 'npm install' in $ROOT_DIR first." >&2
  exit 1
fi

echo "════════════════════════════════════════════════════════"
echo "Anthropic Managed Agents SDK compat test"
echo "  baseURL:         $ANTHROPIC_BASE_URL"
echo "  skill plugin id: $SKILL_PLUGIN_ID"
echo "  mcp plugin id:   $MCP_PLUGIN_ID"
echo "════════════════════════════════════════════════════════"
echo ""

cd "$SCRIPT_DIR"
set +e
node --use-system-ca "$TEST_SCRIPT"
code=$?
set -e

echo ""
if [ "$code" -eq 0 ]; then
  echo "RESULT: PASS (all scenarios passed)"
else
  echo "RESULT: FAIL (exit code $code) -- see [FAIL] lines above"
fi
exit "$code"
