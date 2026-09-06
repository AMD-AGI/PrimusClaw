<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Enabling background shells

`features.backgroundShell` turns on `bash(run_in_background=true)`, `bash_output`,
`kill_shell` and `wait`, and with them tightens the foreground `bash` ceiling from
ten hours (held under the MCP transport cap at 3540s) to 120s. Both halves ship
**off**. This guide is the procedure for turning them on for one deployment, the
readings that say whether it worked, and the way back.

Every step below is one row: a literal command, a decidable expectation, and what
a failure means. A step whose command errors, times out, or produces output
matching neither the pass nor a listed failure shape is a **FAIL, not a skip** — a
verifier that passes having learned nothing is worse than none.

Tools assumed, all already required by this repository's own scripts: `bash` and
`/bin/sh` with their builtins, `helm`, `kubectl`, `curl`, `jq`, `rg`, `sed`, `seq`,
`sleep`, `sort`, `tr`, `wc`. Nothing else.

## 0. Conventions

```sh
set -o pipefail   # a jq that failed must abort, not print an empty census that reads as a fleet of none
```

**Brain.** `BRAIN=http://primus-claw-brain.<NS>.svc.cluster.local:8100`. Name and
port are chart-fixed, so only the namespace is a placeholder, and it is reachable
from inside the cluster.

**Hands base URL.** The census reports `hands_url` ending in `/mcp`.
`<HANDS_URL>/health` is not a valid URL; strip the suffix exactly as the code does:

```sh
hands_base() { printf '%s\n' "$1" | sed -E 's#/mcp/?$##'; }
```

**The chart the deployment renders.** Every `helm template` below renders from the
directory `render_chart` uses, never a literal path. `CLAW_CHART_DIR` defaults to
`claw/deploy/charts/claw` and the values file is sourced afterwards, so the values
file overrides the default and a check pinned to the literal path can pass on a
chart the upgrade never deploys:

```sh
chart_dir() { ( . claw/deploy/values.<NS>.env >/dev/null 2>&1; printf '%s\n' "${CLAW_CHART_DIR:-claw/deploy/charts/claw}" ); }
```

**One bounded read per sandbox**, so a single dropped packet is not recorded as a
sandbox that failed to answer:

```sh
probe() { local a b; for a in $(seq 1 "$N_PROBE"); do
    b=$(curl -sf --max-time "$T_CURL" "$(hands_base "$1")/health") && { printf '%s' "$b"; return 0; }
    sleep "$I_POLL"; done; return 1; }
```

A non-zero return is `UNREACHABLE`, a reading in its own right — distinct from a
sandbox that answered without the field (`MISSING`) and from one that answered
`false`.

**One census, and it fails closed.** Every step that enumerates the fleet goes
through these two, so none invents its own guard and none reads a failed census as
a small one:

```sh
inventory() { local raw; raw=$(curl -sf --max-time "$T_CURL" -H "$ADMIN" "https://$API_HOST/v1/internal/sandbox/status") || return 3
  printf '%s' "$raw" | jq -e '.ok == true and (.unreadable // error("no unreadable field")) == 0 and ((.dag_handles | type) == "array")' >/dev/null || return 3
  printf '%s' "$raw"; }
rows() { printf '%s' "$1" | jq -r '[ (.sessions[] | {sid: .session_id, name: .sandbox_name, ns: .namespace, url: .hands_url, wid: .workload_id}),
    (.dag_handles[] | {sid: .dag_root_task_id, name: .sandbox_name, ns: .namespace, url: .hands_url, wid: .workload_id}) ]
  | unique_by([.name, .ns]) | .[] | [.sid, .name, .ns, .url, .wid] | @tsv'; }
```

Return 3 is `ABORT` at every call site, and three failures collapse into it
deliberately: a KV scan answering `{"ok":false,…}` at HTTP 200, which `curl -sf`
cannot see; a non-zero `unreadable`; and an absent `dag_handles`, which is a build
whose census cannot see a DAG-handle sandbox at all.

**A successful read that is empty is not an abort.** An empty fleet is the true
answer on a low-traffic deployment, and nothing to drain is not nothing readable.
`rows()` is what every step iterates instead of `.sessions[]`, deduplicated on the
`(sandbox_name, namespace)` pair a rollback deletes by, because a DAG handle whose
session key is stale or absent is a live sandbox nothing else here reaches.

**Credentials.** `/v1/internal/*` takes the cluster-wide `AUTH_INTERNAL_TOKEN`
(`ADMIN="Authorization: Bearer <INTERNAL_TOKEN>"`); `/v1/sessions*` and
`/v1/tasks/*` take the operator's own API key (`USER=…`); `<HANDS_BASE>/health` is
unauthenticated. `<HANDS_BASE>/internal/shells/*` takes the per-sandbox token,
which an operator cannot obtain — steps needing it are marked and have a
per-sandbox fallback.

## 1. Prerequisites

| # | Prerequisite | Why |
|---|---|---|
| PRE-1 | The deployed build carries this change: both `/health` payloads expose `bgShellEnabled`. Verified by **P0** | Every gate reads it. A build without it cannot be gated by this guide at all |
| PRE-2 | `BG_SHELL_ENABLED` and `BASH_MAX_TIMEOUT_SEC` are wired through `values.<NS>.env` | Otherwise the enablement is reverted by the next upgrade |
| PRE-3 | The foreground ceiling `S` satisfies `S <= brain.terminationGracePeriodSeconds` | A rolling update must not hand a run over with a command still writing |
| PRE-4 | If long foreground work must survive enablement, `brain.bashMaxTimeoutSec` is pinned first | Enablement otherwise moves the ceiling to 120s in the same step |
| PRE-5 | Thresholds fixed and written down: `T_KILLED`, `T_STALE`, `N_PROBE`, `T_CURL`, `I_POLL`, `N_FLEET`, `I_FLEET` | A threshold chosen after the reading is not a threshold |

## 2. Pre-enable checks

**P0 — the deployed build and chart can be gated by this guide.**

```sh
helm list -n "$NS" -o json | jq -r '.[] | select(.name=="primus-claw") | .chart'
kubectl get pods -n "$NS" -l app=primus-claw,component=primus-claw-brain \
  -o jsonpath='{range .items[*]}{.metadata.name}{"="}{.status.containerStatuses[0].imageID}{"\n"}{end}'
curl -sf "$BRAIN/health" | jq '{brainVersion, gateable: has("bgShellEnabled")}'
raw=$(inventory) || { echo 'CENSUS_FAILED'; exit 3; }
rows "$raw" | while IFS=$'\t' read -r sid name ns url wid; do printf '%s\t' "$sid"
      if body=$(probe "$url"); then
        printf '%s' "$body" | jq -c '{handsGateable: has("bgShellEnabled"), bgShellEnabled, bashMaxTimeoutSec}' || exit 3
      else echo '{"handsGateable":"UNREACHABLE"}'; fi
    done
```

- Expected: every pod's `imageID` resolves to the release image reference, manually
  confirmed against the release record; a chart line; `"gateable": true`.
- Expected, Hands side: one line per live sandbox. `"handsGateable": false` is a
  **reading, not a stop** — that sandbox runs a binary predating this change, and
  is part of the pre-change fleet G4 drives to zero. Record the count.
- Fail: `gateable: false` → the build predates this guide and **no gate here can be
  run against it**. Stop; there is no weaker substitute.

**P1 — the chart default is off in the artifact being deployed.**

```sh
helm template primus-claw "$(chart_dir)" -n "$NS" \
  --set secret.create=false --set ingress.enabled=false --set postgres.enabled=false \
  --show-only templates/brain-deployment.yaml | rg -A1 'name: BG_SHELL_ENABLED'
```

- Expected, exactly `- name: BG_SHELL_ENABLED` followed by `value: "false"`.
- Fail: any other value, or no match → the chart default moved or the template was
  renamed. **Stop.**

**P2 — the schema rejects a malformed value.**

```sh
out=$(helm template primus-claw "$(chart_dir)" -n "$NS" \
  --set secret.create=false --set ingress.enabled=false --set postgres.enabled=false \
  --set-string features.backgroundShell=yes 2>&1); rc=$?
printf '%s\n' "$out" | rg -m1 'features\.backgroundShell' || echo '(no message naming the key)'
echo "exit=$rc"
```

- Expected: non-zero exit and a message naming `features.backgroundShell`.
- P1 and P2 both render through `chart_dir()`, so what they assert about the
  default and the schema is asserted about the chart `upgrade.sh` will deploy
  rather than about the in-tree copy. A check pinned to the literal path passes on
  a chart the upgrade never touches.

## 3. Enable

1. Record the enablement where the next upgrade will read it:
   `BG_SHELL_ENABLED="true"` in `claw/deploy/values.<NS>.env`, and
   `BASH_MAX_TIMEOUT_SEC` if PRE-4 applies.
2. Run the deployment's usual upgrade entrypoint. It re-renders the Brain
   Deployment with both values.
3. Confirm every Brain replica agrees:

```sh
for p in $(kubectl get pods -n "$NS" -l component=primus-claw-brain -o name); do
  kubectl exec -n "$NS" "$p" -- curl -sf localhost:8100/health \
    | jq -c '{bgShellEnabled, bashForegroundMaxSec}'
done | sort -u
```

- Expected: exactly one line. More than one means the rollout is still in flight;
  wait. More than one after it settles is **SC-2**.

## 4. Gates

| Gate | Reads |
|---|---|
| G1 | The enablement is still in the values file after a second upgrade |
| G2 | Every Brain replica reports one `bgShellEnabled` / `bashForegroundMaxSec` pair |
| G3 | A background start returns a shell id, and `wait` returns its final output |
| G4 | Every sandbox created after enablement reports `bgShellEnabled: true` and a ceiling equal to Brain's; the pre-change fleet drains to zero |
| G5 | A run that ends takes its own shells and leaves a sibling run's |
| G6 | A sandbox held by a running shell appears in `keepalive.idle_handle_kept_background_work`, and in `keepalive.idle_handle_expired` once the work ends — correlated by `sandboxName`, not by session id, which outlives every sandbox written under it |
| G7 | Sandbox lifetime is enforced: idle reclamation fires, and the absolute deadline is not pushable |

**G7-d2 — the absolute deadline is enforced, and idle reclamation is not mistaken
for it.** Run against a canary session of its own, held busy throughout, so only
the absolute cap can fire. The deadline is read off whichever object carries it.

```sh
sb "$SESSION_ID" || exit 1
CLAIM=$(kubectl get sandbox -n "$SBNS" "$SBNAME" --ignore-not-found \
  -o jsonpath='{.metadata.ownerReferences[?(@.kind=="SandboxClaim")].name}')
if [ -n "$CLAIM" ]; then DEADLINE=$(kubectl get sandboxclaim -n "$SBNS" "$CLAIM" -o jsonpath='{.spec.lifecycle.shutdownTime}')
else DEADLINE=$(kubectl get sandbox -n "$SBNS" "$SBNAME" -o jsonpath='{.spec.lifecycle.shutdownTime}'); fi
[ -n "$DEADLINE" ] || { echo 'FAIL: no absolute deadline on the object that carries it'; exit 1; }
DEADLINE_EPOCH=$(date -d "$DEADLINE" +%s) || { echo 'FAIL: unparseable shutdownTime'; exit 1; }

for i in $(seq 1 "$N_FLEET"); do
  # Each refresh must SUCCEED. A dispatch that failed leaves the session idle,
  # and an idle session is reclaimed by a path that has nothing to do with the
  # absolute cap -- so a loop that ignores its own failures proves the wrong
  # thing about the CR that then disappears.
  tid=$(dispatch 'Run: echo alive') || { echo 'FAIL: activity dispatch failed; the session is no longer held busy'; exit 1; }
  [ -n "$tid" ] || { echo 'FAIL: activity dispatch returned no task id'; exit 1; }
  settle "$tid" >/dev/null || { echo 'FAIL: activity task never reached terminal; the session is not being held busy'; exit 1; }

  cr; rc=$?; [ "$rc" = 2 ] && exit 1
  now=$(date +%s)
  if [ "$rc" = 0 ]; then
    # Gone. Only acceptable at or after the deadline; before it, something else
    # took the sandbox and this row has proved nothing about the absolute cap.
    [ "$now" -ge "$DEADLINE_EPOCH" ] \
      || { echo "FAIL: the CR disappeared at $(date -Iseconds) but its shutdownTime is $DEADLINE — reclaimed by something other than the absolute cap"; exit 1; }
    break
  fi
  # Still present. Before the deadline that is correct and expected; the CR being
  # live right up to it is half of what this gate has to show.
  [ "$now" -lt "$DEADLINE_EPOCH" ] \
    || { echo "FAIL: the CR outlived its own shutdownTime $DEADLINE"; exit 1; }
  sleep "$I_FLEET"
done
[ "$rc" = 0 ] || { echo "FAIL: the CR outlived its own shutdownTime $DEADLINE"; exit 1; }
```

The three properties this gate needs, and which line carries each: every activity
refresh **succeeded** (so the session was genuinely held busy and the idle path
was not what fired); the CR was observed **live before** `DEADLINE` (so its
eventual absence is a transition, not a state it was already in); and its deletion
is accepted **only at or after** `DEADLINE`. A loop that discards failed
dispatches, or that accepts the CR's disappearance without looking at the clock,
passes on idle reclamation and says nothing about the absolute lifetime.

## 5. Stop conditions

Any one halts advancement and triggers §6.

| # | Condition | Detected by |
|---|---|---|
| SC-1 | Foreground commands that previously completed now hit the ceiling | The rate of `claw_bash_foreground_timeout_total{clamped="true"}` over the soak window, against the same rate over an equal window ending at enablement. Fault when it exceeds the baseline by more than `T_KILLED` |
| SC-2 | Brain replicas disagree on `bgShellEnabled` or `bashForegroundMaxSec` outside an active rollout | G2 re-run during soak |
| SC-3 | A sandbox created after enablement reports `bgShellEnabled: false`, or a ceiling differing from Brain's | G4 re-run during soak |
| SC-4 | Sandboxes held by G6's kept-alive event that never appear in `keepalive.idle_handle_expired` | G6's per-`sandboxName` correlation over the soak window |
| SC-5 | Keepalive probe-failure-dominant — the probe cannot answer, so orphan reclamation is unverifiable | Absolute log count per window against `T_STALE` |
| SC-6 | `/internal/shells/reap` returns non-2xx, or `stopped` is 0 for a run just counted above zero | G5's cleanup step |
| SC-7 | The enablement disappeared without anyone changing it | G1 re-run |

**SC-1's reading.** `claw_bash_foreground_timeout_total` is incremented where the
timeout happens: the sandbox marks a foreground command it stopped at its granted
second, Brain counts it on the way back, and the `clamped` label separates a
command that asked past the ceiling and met it — the regression a tightened
ceiling produces — from one that simply ran out of its own timeout.

```sh
timeouts() { curl -sf --max-time "$T_CURL" "$BRAIN/metrics" \
    | rg '^claw_bash_foreground_timeout_total\{[^}]*clamped="true"' \
    | rg -o '[0-9.]+$' || { echo 'ABORT: no reading'; return 1; }; }
```

A count of runs that ended in a killed state is **not** this signal and must not be
substituted for it: a clamped command is answered as a tool result and its run goes
on to complete normally, so the affected runs are indistinguishable from
unaffected ones in every terminal fact the platform exposes, and the count moves
for reasons that have nothing to do with the ceiling.

SC-6 is the severe one: the cooperative cleanup step is already broken and the
rollback falls through to R4/R5 only. Blocking even if nothing else is.

## 6. Rollback

Ordering is not free. The flip terminates nothing — it stops new spawns in
sandboxes created afterwards, signals no process, and does not reach a sandbox
already up — so R5 is mandatory, not cleanup. And R5 must follow R4: recycling
sandboxes before the Brain restart lands means the replacements are created by a
Brain still holding the old value and boot enabled again.

**R1 — take the inventory the rest of the rollback iterates.**

```sh
raw=$(inventory) || { echo 'ABORT: census unreadable; a failed read is not an empty fleet'; exit 3; }
rows "$raw" > /tmp/claw-rollback-fleet.tsv    # may legitimately be empty
wc -l < /tmp/claw-rollback-fleet.tsv
```

- Expected: a successful read. **An empty file is a valid result and R2–R5
  continue**: an empty fleet is the true answer on a low-traffic deployment or one
  already drained, and the flip and the Brain restart still have to happen.
  Piping `.sessions[]` through `jq -e` would exit non-zero on exactly that
  response and abort a rollback that has nothing wrong with it.
- Fail: `ABORT` → the census could not be read, or read incompletely. Do not
  proceed on a partial fleet list; fix the read first.

**R2 — stand down what can be stood down.** Per-handle termination, if wanted,
must happen here: `kill_shell` is the flag-guarded path and disappears at R3.

**R3 — flip the values file back.** `BG_SHELL_ENABLED=""` (or `"false"`), and
revert `BASH_MAX_TIMEOUT_SEC` if PRE-4 pinned it. Stand running work down first:
the Brain restart R4 carries aborts every live run, and each requeues itself.

**R4 — upgrade, and confirm every replica reports the old pair.** G2's command,
expecting one line with `bgShellEnabled: false`.

**R5 — recycle the sandboxes that are still enabled.** For each row of
`/tmp/claw-rollback-fleet.tsv`, delete the Sandbox by name and namespace — not
through the session control plane, which cannot name it. An empty file means
nothing to recycle, which is not a failure. Re-run P0's per-sandbox census
afterwards and expect no live sandbox reporting `bgShellEnabled: true`.

## 7. What this guide does not cover

- SaFE-mode deployments: neither the reap route nor the sandbox recycle has an
  operator-usable driver there, so R5 has nothing to run. Enablement under SaFE is
  refused rather than deferred.
- Script-mode steps bypass Brain's pre-dispatch gate: a script step naming
  `wait`, `bash_output`, `kill_shell` or `bash{run_in_background:true}` never
  reaches the switch. Hands' own per-tool refusal still applies, and the ceiling
  is enforced on that path exactly as on the router path.
