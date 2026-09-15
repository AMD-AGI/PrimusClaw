#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
#
# Runs the Hands MCP server against a throwaway workspace and drives it with
# demo.mjs. Needs only Node and a build of Claw — no cluster, no GPU, no LLM key,
# no network egress.

set -euo pipefail

EXAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_DIR="$(cd "$EXAMPLE_DIR/../.." && pwd)"
HANDS_DIST="$CLAW_DIR/packages/hands/dist/index.js"

command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }

if [ ! -f "$HANDS_DIST" ]; then
  echo "error: $HANDS_DIST not found. Build first:" >&2
  echo "  cd claw && npm ci && npm run build" >&2
  exit 1
fi

WORKSPACE="$(mktemp -d)"
# Hands files its background-shell records here and refuses to start if it
# cannot: a process serving shells it keeps no record of leaves every later
# destroy gate reading an empty count as an empty sandbox. Its own directory,
# not one under $WORKSPACE -- the workspace is synced, and a sync must not be
# able to carry the records out or overwrite them. The built-in default is a
# system path a CI runner has no business writing to.
STATE_DIR="$(mktemp -d)"
# A random per-run token: the demo also asserts that a wrong token is rejected,
# so a fixed placeholder would make that check meaningless.
TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"

# Port 0 lets the kernel pick a free port, avoiding a clash with a real Hands on
# the 9100 default.
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

HANDS_PID=""
cleanup() {
  if [ -n "$HANDS_PID" ] && kill -0 "$HANDS_PID" 2>/dev/null; then
    kill "$HANDS_PID" 2>/dev/null || true
    wait "$HANDS_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKSPACE" "$STATE_DIR"
}
trap cleanup EXIT

echo "workspace: $WORKSPACE"
echo "port:      $PORT"
echo "state:     $STATE_DIR"

WORKSPACE_PATH="$WORKSPACE" MCP_PORT="$PORT" AUTH_INTERNAL_TOKEN="$TOKEN" \
HANDS_STATE_DIR="$STATE_DIR" \
  node "$HANDS_DIST" > "$WORKSPACE/hands.log" 2>&1 &
HANDS_PID=$!

# Wait for /health rather than sleeping a fixed interval.
for _ in $(seq 1 50); do
  if node -e "
    fetch('http://127.0.0.1:$PORT/health')
      .then(r => process.exit(r.ok ? 0 : 1))
      .catch(() => process.exit(1))
  " 2>/dev/null; then
    break
  fi
  if ! kill -0 "$HANDS_PID" 2>/dev/null; then
    echo "error: hands exited during startup. Log:" >&2
    cat "$WORKSPACE/hands.log" >&2
    exit 1
  fi
  sleep 0.2
done

# demo.mjs sits under claw/ so that ESM resolution finds the MCP SDK in
# claw/node_modules; ESM resolves from the importing file's location, not the cwd.
HANDS_URL="http://127.0.0.1:$PORT/mcp" \
HANDS_TOKEN="$TOKEN" \
WORKSPACE_PATH="$WORKSPACE" \
  node "$EXAMPLE_DIR/demo.mjs"
