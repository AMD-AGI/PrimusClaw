#!/bin/bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# stop-all.sh — stop Claw local dev processes.
#
# Usage:
#   ./stop-all.sh           Stop the hands/brain/api tsx processes.
#   ./stop-all.sh -h        Show this help.
#
# Linux only: process discovery reads /proc and uses pgrep/ss.
#
# Safety: matches are scoped to processes whose cwd lives under this
# Claw tree, so it will not kill tsx from unrelated projects.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0 ;;
    *) echo "Unknown arg: $arg (use -h)"; exit 1 ;;
  esac
done

log() { echo "[stop-all] $(date +%H:%M:%S) $*"; }

# ---- Collect business tsx PIDs that belong to this Claw tree ----
# We match any process whose argv contains "tsx" + "src/index" (covers
# `npm exec tsx src/index.ts`, `sh -c tsx src/index.ts`, and the tsx
# preflight/loader node worker), plus start-all.sh itself, then filter
# by /proc/<pid>/cwd being inside SCRIPT_DIR.
collect_local_pids() {
  local pid cwd pids=""
  for pid in $(pgrep -f "tsx.*src/index" 2>/dev/null; pgrep -f "start-all\\.sh" 2>/dev/null); do
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
    [ -z "$cwd" ] && continue
    case "$cwd" in
      "$SCRIPT_DIR"*) pids="$pids $pid" ;;
    esac
  done
  echo "$pids" | xargs -n1 2>/dev/null | sort -u | xargs 2>/dev/null
}

BIZ_PIDS=$(collect_local_pids)

if [ -z "$BIZ_PIDS" ]; then
  log "No Claw tsx/start-all processes found."
else
  log "Sending SIGTERM to tsx/start-all PIDs: $BIZ_PIDS"
  # shellcheck disable=SC2086
  kill -TERM $BIZ_PIDS 2>/dev/null || true

  # Wait up to 5s for graceful shutdown, then escalate to SIGKILL.
  for _ in 1 2 3 4 5; do
    sleep 1
    alive=""
    for p in $BIZ_PIDS; do
      kill -0 "$p" 2>/dev/null && alive="$alive $p"
    done
    BIZ_PIDS="$alive"
    [ -z "$BIZ_PIDS" ] && break
  done

  if [ -n "$BIZ_PIDS" ]; then
    log "Still alive after 5s, SIGKILL: $BIZ_PIDS"
    # shellcheck disable=SC2086
    kill -KILL $BIZ_PIDS 2>/dev/null || true
  fi
fi

# ---- Final state report ----
log "Listeners on 8100/8200/9100:"
ss -ltn 2>/dev/null | awk 'NR==1 || $4 ~ /:(8100|8200|9100)$/' | sed 's/^/  /'

leftover=""
for pid in $(pgrep -f "tsx.*src/index" 2>/dev/null); do
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo "?")
  case "$cwd" in
    "$SCRIPT_DIR"*) leftover="$leftover\n  pid=$pid cwd=$cwd" ;;
  esac
done
if [ -n "$leftover" ]; then
  log "WARN: tsx procs still alive under this tree:"
  printf "$leftover\n"
else
  log "No Claw tsx procs remaining."
fi

log "Done."
