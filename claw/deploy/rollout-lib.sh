#!/usr/bin/env bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Executable rollout decisions shared by the operator guide and its tests.
# Read failures abort so they cannot be mistaken for a small or healthy fleet.

# 0 pass, 1 fail (a real, judged failure), 3 abort (nothing could be read, which
# is never the same as a clean reading).
ROLLOUT_PASS=0
ROLLOUT_FAIL=1
ROLLOUT_ABORT=3

# The chart directory the deployment actually renders from.
#
# CLAW_CHART_DIR is a supported override and the values file is sourced after
# the default is set, so a check pinned to the literal in-tree path can validate
# a chart the upgrade never deploys. A values file that exists and cannot be
# sourced aborts: falling back to the default there is the same wrong answer,
# arrived at quietly.
chart_dir() {
  local values_file="$1" default="${2:-claw/deploy/charts/claw}"
  if [ -n "$values_file" ] && [ -e "$values_file" ]; then
    local resolved
    # The subshell's own exit code, not the last command's: a values file with
    # a syntax error leaves `source` non-zero while the print that follows it
    # succeeds, so `set -e` alone reports the default as if it had been read.
    resolved=$( . "$values_file" >/dev/null 2>&1 || exit 9
                printf '%s\n' "${CLAW_CHART_DIR:-$default}" ) || {
      echo "ABORT: $values_file exists and could not be sourced; the chart this deployment renders is unknown" >&2
      return "$ROLLOUT_ABORT"
    }
    printf '%s\n' "$resolved"
    return "$ROLLOUT_PASS"
  fi
  printf '%s\n' "$default"
}

# Judge one census body. Prints it on success; aborts on anything less.
#
# Three failures collapse into one abort deliberately: `{"ok":false}` at HTTP
# 200, which curl cannot see; a non-zero `unreadable`, which is a live sandbox
# every consumer would read as absent; and an absent `dag_handles`, which is a
# build whose census cannot see a DAG sandbox at all. An empty fleet is none of
# those -- it is the true answer on a low-traffic deployment, and every step
# after it still has to run.
inventory_judge() {
  local raw="$1"
  [ -n "$raw" ] || { echo "ABORT: empty census response" >&2; return "$ROLLOUT_ABORT"; }
  printf '%s' "$raw" | jq -e '
      .ok == true
      and (.unreadable // error("no unreadable field")) == 0
      and ((.dag_handles | type) == "array")
      and ((.sessions | type) == "array")
    ' >/dev/null 2>&1 || {
    echo "ABORT: census unreadable or incomplete; a failed read is not an empty fleet" >&2
    return "$ROLLOUT_ABORT"
  }
  printf '%s' "$raw"
}

# Both halves of the fleet as tab-separated rows, deduplicated on the provider's
# durable deletion identity.
inventory_rows() {
  printf '%s' "$1" | jq -r '
    [ (.sessions[] | {sid: .session_id, name: .sandbox_name, ns: .namespace, url: .hands_url, wid: .workload_id}),
      (.dag_handles[] | {sid: .dag_root_task_id, name: .sandbox_name, ns: .namespace, url: .hands_url, wid: .workload_id}) ]
    | unique_by(if (.name // "") != "" then ["sandbox", .name, .ns] else ["workload", .wid, .ns] end)
    | .[] | [.sid, .name, .ns, .url, .wid] | @tsv'
}

# The Hands base url for a recorded MCP url. `<HANDS_URL>/health` is not one.
hands_base() { printf '%s\n' "$1" | sed -E 's#/mcp/?$##'; }

# Whether one dispatched activity task actually refreshed the sandbox.
#
# Every weaker signal is satisfiable without a command having run there. A
# terminal state is not a successful one. A completed run is not a run that
# touched the sandbox: a model can answer without calling anything. A counted
# call is not a call that worked -- `by_tool` is incremented before the tool
# executes, a pre-hook can reject it immediately afterwards, and a failed
# command comes back as result text with the task still completing. And the
# task's own output is model-written text: a model handed a token in its prompt
# can echo it back having done nothing at all, so nothing said there is
# evidence.
#
# `by_tool_ok` is none of those: the agent loop increments it from the tool's
# own result, after the call returned and only where that result was not an
# error. It is produced by the machinery, not by the model.
settle_verdict() {
  local body="$1" tool="${2:-bash}" status ok
  status=$(printf '%s' "$body" | jq -r '.status // "MISSING"' 2>/dev/null) || {
    echo "FAIL: activity result unparseable" >&2; return "$ROLLOUT_FAIL"; }
  case "$status" in
    completed) ;;
    NOT_TERMINAL|MISSING)
      echo "FAIL: activity task never reached terminal ($status); the session is not being held busy" >&2
      return "$ROLLOUT_FAIL" ;;
    *)
      echo "FAIL: activity task ended $status; a failed refresh leaves the session idle, and an idle session is reclaimed by the wrong path" >&2
      return "$ROLLOUT_FAIL" ;;
  esac

  # An absent field and a zero count are different facts: the first is a build
  # that cannot answer, which leaves the gate no reading at all, and passing on
  # it would make the gate vacuous exactly where it is introduced.
  printf '%s' "$body" | jq -e 'has("by_tool_ok")' >/dev/null 2>&1 || {
    echo "FAIL: activity result carries no by_tool_ok; this build cannot report whether $tool succeeded, so G7-d2 has no reading" >&2
    return "$ROLLOUT_FAIL"; }
  ok=$(printf '%s' "$body" | jq -r --arg t "$tool" '.by_tool_ok[$t] // 0' 2>/dev/null) || ok=0
  case "$ok" in
    ''|*[!0-9]*)
      echo "FAIL: by_tool_ok.$tool is not a count" >&2; return "$ROLLOUT_FAIL" ;;
  esac
  [ "$ok" -ge 1 ] || {
    echo "FAIL: the activity task completed with no successful $tool call, so no command ran in the sandbox and nothing refreshed it" >&2
    return "$ROLLOUT_FAIL"; }
  return "$ROLLOUT_PASS"
}

# Whether a sandbox's absolute lifetime was enforced, or something else took it.
#
# Three facts, and dropping any one lets idle reclamation pass as the absolute
# cap. `seen_live_before` is whether the CR was observed present at a moment
# before the deadline: without it, a first look that finds the CR already gone
# proves only that it is gone now. `cr_state` is present|gone. `now`/`deadline`
# are epoch seconds.
deadline_verdict() {
  local cr_state="$1" seen_live_before="$2" now="$3" deadline="$4"

  if [ "$seen_live_before" != "true" ]; then
    echo "FAIL: the CR was never observed live before $deadline, so its absence proves nothing" >&2
    return "$ROLLOUT_FAIL"
  fi
  if [ "$cr_state" = "gone" ]; then
    if [ "$now" -lt "$deadline" ]; then
      echo "FAIL: the CR disappeared at $now, before its shutdownTime $deadline -- reclaimed by something other than the absolute cap" >&2
      return "$ROLLOUT_FAIL"
    fi
    return "$ROLLOUT_PASS"
  fi
  if [ "$now" -ge "$deadline" ]; then
    echo "FAIL: the CR outlived its own shutdownTime $deadline" >&2
    return "$ROLLOUT_FAIL"
  fi
  # Still present, still before the deadline: correct so far, keep watching.
  return "$ROLLOUT_ABORT"
}
