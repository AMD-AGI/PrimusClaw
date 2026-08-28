#!/bin/bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -e
cd "$(dirname "$0")/.."

if [ -f .env ]; then set -a; source .env; set +a; fi
export BRAIN_ID="${BRAIN_ID:-brain-$(whoami)}"
echo "BRAIN_ID: $BRAIN_ID"

# MEMORY_BACKEND=remote routes memory through MEMORY_SERVICE_URL. Run that
# service yourself (see memory/memory-service/README.md); this script does not
# start it.

# Each service is started in its own subshell, from this script's directory
# rather than from the previous service's.
#
# `cd packages/hands && npx tsx src/index.ts &` backgrounds the whole AND-list,
# so the `cd` happens in a subshell and this shell never leaves the Claw root.
# The next two steps then resolved `../brain` and `../api` against that root,
# failed, and -- because `set -e` does not fire for a backgrounded list -- the
# script carried on to print "All started" having started only Hands.
#
# `exec` matters as much as the parentheses: without it `$!` is the subshell,
# not node, and the trap below would signal a shell that has already handed its
# process over, leaving the service running after Ctrl-C.
echo "Starting Hands..."
( cd packages/hands && exec npx tsx src/index.ts ) &
HANDS_PID=$!
echo "Hands PID: $HANDS_PID"
sleep 2

echo "Starting Brain..."
( cd packages/brain && exec npx tsx src/index.ts ) &
BRAIN_PID=$!
echo "Brain PID: $BRAIN_PID"
sleep 2

echo "Starting API..."
( cd packages/api && exec npx tsx src/index.ts ) &
API_PID=$!
echo "API PID: $API_PID"

echo "All started. API: http://localhost:${API_PORT:-8200}  BRAIN_ID: $BRAIN_ID"

trap 'kill $HANDS_PID $BRAIN_PID $API_PID 2>/dev/null || true' EXIT

wait
