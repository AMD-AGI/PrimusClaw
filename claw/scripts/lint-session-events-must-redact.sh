#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-session-events-must-redact.sh
#
# Session events carry whatever the agent read or ran: `.env` contents, a token
# echoed by `bash`, an Authorization header from an HTTP tool call. Live events
# are masked once, at the subscription (events/store.ts::sanitizeSessionEvent),
# so every consumer of createSessionSubscription() inherits redaction.
#
# Reads that go straight to `claw_session_events` bypass that choke point. Three
# surfaces did exactly that -- the Anthropic events list, the Anthropic SSE
# history replay and the A2A artifact list -- and shipped raw event text while
# the SSE route masked it. This guard keeps a fourth from appearing:
#
#   Any route file that SELECTs the `data` column from claw_session_events MUST
#   also reference sanitizeSessionEvent or redactPublicJson.
#
# Scope is `packages/api/src/routes/` on purpose. Files outside it that read the
# same column (marketplace/skill-service.ts, sessions/context-builder.ts, events/consumer.ts) consume
# events for internal processing and must see the stored text; redacting there
# would corrupt skill statistics and context rebuilds, not protect a caller.
#
# Two modes, matching the other guards in this directory:
#
#   (no args)  pre-commit: lints staged route files only.
#   --all      CI: lints every route file in the working tree.
#
# Exit codes:
#   0  no violation
#   1  at least one violation found
#   2  invocation error (bad arg, or the scan target is missing/empty in CI mode)

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") [--all]" >&2
  exit 2
}

mode="staged"
if [ "$#" -gt 0 ]; then
  case "$1" in
    --all)     mode="all" ;;
    -h|--help) usage ;;
    *)         usage ;;
  esac
fi

routes_dir="claw/packages/api/src/routes"

if [ "$mode" = "staged" ]; then
  files=$(git diff --cached --name-only --diff-filter=ACMR \
           | grep -E "^${routes_dir}/.*\.ts$" || true)
  [ -z "$files" ] && exit 0
else
  # Loudly, not as a warning. This guard scans a hardcoded directory, so a
  # missing or emptied one means the routes moved and the check has nothing
  # left to say -- which CI cannot tell apart from "no violations". Exiting 0
  # here retired a security guard on the first rename, silently.
  if [ ! -d "$routes_dir" ]; then
    echo "ERROR: $routes_dir not found in working tree." >&2
    echo "       This guard scans a hardcoded path. If the routes moved, update" >&2
    echo "       \$routes_dir in this script; do not let the check retire." >&2
    exit 2
  fi
  files=$(find "$routes_dir" -name '*.ts' | sort)
  if [ -z "$files" ]; then
    echo "ERROR: $routes_dir contains no .ts files; the guard scanned nothing." >&2
    exit 2
  fi
fi

# A query is only a leak risk when it selects the event payload itself. DELETEs
# and metadata-only SELECTs (event_id, id, processed_at) are fine.
select_data_re='SELECT[^;]*[^_a-zA-Z]data[^;]*FROM claw_session_events'

violations=""
for file in $files; do
  [ -f "$file" ] || continue
  hits=$(grep -nE "$select_data_re" "$file" || true)
  [ -z "$hits" ] && continue
  if grep -qE 'sanitizeSessionEvent|redactPublicJson' "$file"; then
    continue
  fi
  violations="${violations}
  ${file}
$(echo "$hits" | sed 's/^/    /')"
done

if [ -n "$violations" ]; then
  cat >&2 <<EOF
ERROR: a route reads claw_session_events.data without redacting it
$violations

Hint: wrap the row payload in sanitizeSessionEvent() (events/store.ts) before it
reaches a client, the way routes/events.ts and the Anthropic-compatible routes
do. Stored events keep the raw text for audit; anything leaving the API is
masked.
EOF
  exit 1
fi

exit 0
