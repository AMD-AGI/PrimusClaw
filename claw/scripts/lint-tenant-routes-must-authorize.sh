#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# lint-tenant-routes-must-authorize.sh
#
# The tenant boundary on `/v1/sessions/:id/*`, `/v1/tasks/:taskId/*` and
# `/v1/task-dags/:id/*` is enforced by a function call INSIDE each handler
# (requireSessionRow / requireSessionScope / requireSessionAccess /
# requireTaskAccess / a canAccessSession* predicate), not by a route-level hook.
# The global preHandler in index.ts only authenticates the caller; it has no idea
# which session or task the path refers to, so it cannot decide ownership.
#
# The consequence is that a handler added or refactored without that call is
# silently open to every authenticated user, and nothing else in the build says
# so: the predicates keep passing their own unit tests, and the route keeps
# answering 200. This guard states the requirement structurally:
#
#   Any handler registered on a tenant-scoped path MUST reference an
#   authorization gate.
#
# test/routes-authz.test.ts covers the same ground behaviourally for three
# representative routes. This script is the cheap part that scales to all of
# them; the tests are the part that proves a denial is really a denial.
#
# `/v1/internal/tasks/:taskId/*` is deliberately not matched: those routes carry
# a per-task token checked by their own route-level preHandler (internalTaskAuth)
# and have no session owner to compare against.
#
# A handler that enforces ownership some other way -- by handing the caller's id
# to a store function that filters on it, say -- satisfies the guard with a
# `// authz: <reason>` comment. The escape hatch is a comment rather than a
# widened pattern so that the reason is written down next to the route, and so a
# reviewer can tell "checked elsewhere" apart from "not checked".
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

# Only double-quoted path literals: a template literal like
# `/v1/sessions/${id}/files/...` is a URL being built for a response, not a
# route registration.
path_re='"/v1/(sessions|tasks|task-dags)/:'
gate_re='require(SessionRow|SessionScope|SessionAccess|TaskAccess)|canAccessSession|canWriteSession|canExecuteTaskDag|canReadTaskDag|// *authz:'

# A handler's window runs from its own path literal to the next one (or EOF).
# Nesting is not parsed on purpose: a gate token anywhere in that window means
# someone wrote an ownership check for this route, which is what we want to know.
violations=""
for file in $files; do
  [ -f "$file" ] || continue
  grep -qE "$path_re" "$file" || continue
  unguarded=$(awk -v path_re="$path_re" -v gate_re="$gate_re" '
    function flush() {
      if (route != "" && !guarded) print "    " lineno ": " route
    }
    $0 ~ path_re {
      flush()
      route = $0
      sub(/^[ \t]+/, "", route)
      lineno = NR
      guarded = 0
      next
    }
    route != "" && $0 ~ gate_re { guarded = 1 }
    END { flush() }
  ' "$file")
  [ -z "$unguarded" ] && continue
  violations="${violations}
  ${file}
${unguarded}"
done

if [ -n "$violations" ]; then
  cat >&2 <<EOF
ERROR: a tenant-scoped route does not reference an authorization gate
$violations

Hint: read the row through requireSessionRow / requireSessionScope (routes/sessions.ts)
or requireTaskAccess (routes/tasks.ts) and return early when it is null -- the reply has
already been sent at that point. Ownership cannot be checked by the global auth
middleware, which sees the caller but not which tenant the path belongs to.

If the route does enforce ownership by another route, say where, with a
"// authz: <reason>" comment inside the handler.
EOF
  exit 1
fi

exit 0
