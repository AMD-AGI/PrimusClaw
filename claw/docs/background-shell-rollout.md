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
`sleep`, `sort`, `tr`, `wc`, `date` for the one epoch-seconds comparison G7-d2
makes against a field of a Kubernetes object, and `od` plus `openssl` for the
scoped credential below — there is no way to compute an HMAC or to escape a
scope byte by byte without them, and a step that cannot mint the credential
cannot reach the two routes that require it. Nothing else — in particular no
`python3`, `awk`, `comm`, `cut` or `xargs`, so a step cannot come to depend on a
tool a cluster-access host is not obliged to have.

A step needing a credential Claw issues to no operator is marked
**[needs TBD-7]**, and each such step says what happens without it: a step that
*counts* falls back to the run and task API, and a step that *reaps* is skipped
with R5 covering what it cannot reach. No step is left without a verdict.

## 0. Conventions

```sh
set -o pipefail   # a jq that failed must abort, not print an empty census that reads as a fleet of none
```

**The helpers are a file, not a paste.** Every decision below that has one
right answer lives in `claw/deploy/rollout-lib.sh` and is exercised by
`claw/packages/brain/test/rollout-lib.test.ts`. Source it once:

```sh
. claw/deploy/rollout-lib.sh
```

It provides `chart_dir`, `inventory_judge`, `inventory_rows`, `hands_base`,
`settle_verdict` and `deadline_verdict`, each returning `0` pass, `1` fail,
`3` abort.

**Proving the sandbox was touched.** Every weaker signal is satisfiable without
a command having run there: a task can complete without calling anything, a call
is counted before it runs and stays counted when it fails, and the task's output
is model-written text — a model handed a token in its prompt can echo it back
having done nothing. `settle_verdict` reads `by_tool_ok` instead, which the
agent loop increments from the tool's own result after the call returned and
only where that result was not an error. Nothing the model says reaches it.

```sh
ACTIVITY_PROMPT='Run: echo alive'
``` **Return 3 is
`ABORT` at every call site**: nothing could be read, which is never the same as
a clean reading.

**Brain.** `BRAIN=http://primus-claw-brain.<NS>.svc.cluster.local:8100`. Name and
port are chart-fixed, so only the namespace is a placeholder, and it is reachable
from inside the cluster. **This is the Service, so it answers from whichever
replica it picked** — fine for `/health`, which every replica answers
identically once a rollout has settled, and wrong for `/metrics`, which is a
per-process counter. Every metrics read below goes to every pod by name and
sums, never to the Service:

```sh
brain_pods() { kubectl get pods -n "$NS" -l app=primus-claw,component=primus-claw-brain \
    -o jsonpath='{range .items[*]}{.status.podIP}{"\n"}{end}' | rg -v '^$'; }
```

**The chart the deployment renders.** `chart_dir claw/deploy/values.<NS>.env`
resolves the directory `render_chart` uses: `CLAW_CHART_DIR` is a supported
override sourced from the values file, so a check pinned to the literal in-tree
path can validate a chart the upgrade never deploys. A values file that exists
and cannot be sourced **aborts** rather than falling back — the fallback is the
same wrong answer arrived at quietly.

**One census, and it fails closed.**

```sh
inventory() { local raw; raw=$(curl -sf --max-time "$T_CURL" -H "$ADMIN" "https://$API_HOST/v1/internal/sandbox/status") || return 3
  inventory_judge "$raw"; }
```

`inventory_judge` aborts on `{"ok":false}` at HTTP 200, which `curl -sf` cannot
see; on a non-zero `unreadable`, which is a live sandbox every consumer would
read as absent; and on an absent `dag_handles`, which is a build whose census
cannot see a DAG sandbox at all. **A successful read that is empty is not an
abort** — an empty fleet is the true answer on a low-traffic deployment, and
nothing to drain is not nothing readable. `inventory_rows` is what every step
iterates instead of `.sessions[]`, deduplicated on the provider-native deletion
identity: sandbox name plus namespace, or workload id plus namespace.

**One bounded read per sandbox**, so a single dropped packet is not recorded as
a sandbox that failed to answer:

```sh
probe() { local a b; for a in $(seq 1 "$N_PROBE"); do
    b=$(curl -sf --max-time "$T_CURL" "$(hands_base "$1")/health") && { printf '%s' "$b"; return 0; }
    sleep "$I_POLL"; done; return 1; }
```

A non-zero return is `UNREACHABLE`, a reading in its own right — distinct from a
sandbox that answered without the field (`MISSING`) and from one that answered
`false`.

**The per-sandbox and per-run helpers** the gates use are defined once here and
referred to by name below:

```sh
# The Sandbox CR for a session, resolved BEFORE any wait: after reclamation the
# status row is gone and nothing names it. Sets SBNAME and SBNS.
sb() { local raw sid name ns url wid; raw=$(inventory) || return 3
  while IFS=$'\t' read -r sid name ns url wid; do
    [ "$sid" = "$1" ] || continue
    SBNAME=$name; SBNS=$ns; return 0
  done <<<"$(inventory_rows "$raw")"
  echo "FAIL: $1 is in no inventory row" >&2; return 1; }
# present|gone for the resolved CR, or return 2 when kubectl itself failed.
cr() { local out; out=$(kubectl get sandbox -n "$SBNS" "$SBNAME" --ignore-not-found -o name 2>&1) || return 2
  [ -n "$out" ] && echo present || echo gone; }
# Submit one task, print its id, non-zero if it was not accepted.
dispatch() { curl -sf -X POST "https://$API_HOST/v1/sessions/$SESSION_ID/tasks" -H "$USER" \
    -H 'content-type: application/json' -d "$(jq -n --arg p "$1" '{prompt:$p}')" \
  | jq -er 'select(.ok == true) | .task_id // empty'; }
# Poll one task to terminal, printing the fields `settle_verdict` judges --
# including by_tool_ok, which the agent loop writes from the tool's own result.
# Reaching terminal is not succeeding, and completing is not refreshing.
settle() { local i b; for i in $(seq 1 "$N_POLL"); do
    b=$(curl -sf --max-time "$T_CURL" -H "$USER" "https://$API_HOST/v1/tasks/$1") || { sleep "$I_POLL"; continue; }
    printf '%s' "$b" | jq -e '.item.status | test("^(completed|failed|cancelled)$")' >/dev/null \
      && { printf '%s' "$b" | jq -c '.item | {status, out: (.output // "")[0:400], by_tool_ok: .tool_stats.by_tool_ok}'; return 0; }
    sleep "$I_POLL"; done; echo '{"status":"NOT_TERMINAL"}'; return 1; }
# One run's status, printed or refused -- never a blank line. A failed request
# and an answer carrying no status both return non-zero rather than reaching the
# caller as an empty field, which a "no bad status found" check would pass on.
run_status() { local b; b=$(curl -sf --max-time "$T_CURL" -H "$USER" "https://$API_HOST/v1/tasks/$1") || return 1
  printf '%s' "$b" | jq -er '.item.status' || return 1; }
```

**Credentials.** `/v1/internal/*` takes the cluster-wide `AUTH_INTERNAL_TOKEN`
(`ADMIN="Authorization: Bearer <INTERNAL_TOKEN>"`); `/v1/sessions*` and
`/v1/tasks/*` take the operator's own API key (`USER=…`); `<HANDS_BASE>/health` is
unauthenticated.

`<HANDS_BASE>/internal/shells/active` and `/internal/shells/reap` take a
**scoped credential**, `Authorization: Bearer <scope>.<proof>`, minted from the
per-sandbox `AUTH_CLAW_TOKEN`. The scope it proves is the only scope answered:
a request whose body names `owner` or `run` is refused `scope_not_in_body`
rather than read, so no step below may put either in a body, and a reap
additionally carries `cause` and `reclaim_op` so the termination is
attributable afterwards, `cause` from the closed set `dag_node_terminal`,
`run_cancelled`, `operator_kill_shell`, `sandbox_idle_reclaim`,
`sandbox_absolute_deadline`, `sandbox_replaced`, `retry_pending_unregistered`,
`session_cleanup` — anything else is refused with the accepted set named. The
sandbox token is not obtainable by an operator, so every step reaching these two
routes is `[needs TBD-7]`.

Every step below mints its credential **per pair**, through `scope_cred <owner>
<run>` (empty run for an owner-only scope). One credential hoisted out of a loop
proves one pair and is refused for every other, which reads as a route failure
rather than as the mistake it is.

The key is the **sandbox's own** `AUTH_CLAW_TOKEN`, not a fleet-wide one, so a
loop over several sandboxes fetches the token for each row before minting
anything for it. `hands_token` is that fetch, and it is what makes every caller
of `scope_cred` `[needs TBD-7]`: Claw issues this secret to no operator, and the
placeholder below states the shape rather than a supported retrieval:

```sh
# The sandbox's own internal token, for the sandbox named by this row.
# [needs TBD-7] -- no supported operator path to it exists; substitute the one
# your platform provides, and stop here if it has none.
hands_token() { local name="$1" ns="$2" tok
  tok=$(kubectl get secret -n "$ns" "claw-sandbox-$name" -o jsonpath='{.data.AUTH_CLAW_TOKEN}' 2>/dev/null \
    | { read -r b64; printf '%s' "$b64"; } | openssl base64 -d -A 2>/dev/null) \
    || { echo "no token for sandbox $name in $ns" >&2; return 1; }
  # Empty is not a token. Returning one lets a caller mint a proof over nothing,
  # which every route answers 401 -- a refusal that looks like the step working.
  [ -n "$tok" ] || { echo "empty token for sandbox $name in $ns" >&2; return 1; }
  printf '%s' "$tok"; }
# The scope the routes answer, for one pair, under one sandbox's token.
scope_cred() { local token="$1" owner="$2" run="$3" scope proof
  scope="$(printf '%s' "$owner" | scope_encode)/$( [ -n "$run" ] && printf '%s' "$run" | scope_encode || printf '.norun')"
  proof=$(printf '%s' "$scope" | openssl dgst -sha256 -hmac "$token" -hex | sed 's/^.* //')
  printf '%s.%s' "$scope" "$proof"; }
# Per-byte escaping: anything outside [A-Za-z0-9_-] becomes ~XX, so the two
# parts cannot span the separator and no two pairs encode alike.
scope_encode() { od -An -tx1 -v | tr -s ' ' '\n' | sed '/^$/d' | while read -r b; do
  c=$(printf "\\x$b"); case "$c" in [A-Za-z0-9_-]) printf '%s' "$c";;
  *) printf '~%s' "$(printf '%s' "$b" | tr 'a-f' 'A-F')";; esac; done; }
```

**Hands' own log has no reader.** Hands' diagnostics go to `HANDS_LOG_PATH`,
inside the Hands-owned state area (`$HANDS_STATE_DIR/hands.log`, under `/tmp`)
rather than the workspace, which is synced and world-writable inside the
sandbox. It is not the container's stdout, so `kubectl logs` against a sandbox
returns the workload's output and never a shell event. Nothing in this guide
reads it, and no step may be added that does — which is why every Hands-side
observability item below is informational.

## 1. Prerequisites

| # | Prerequisite | Why |
|---|---|---|
| PRE-1 | The deployed build carries this change: both `/health` payloads expose `bgShellEnabled`. Verified by **P0** | Every gate reads it. A build without it cannot be gated by this guide at all |
| PRE-2 | `BG_SHELL_ENABLED`, `SANDBOX_KEEPALIVE_TARGET_CEILING`, `SANDBOX_KEEPALIVE_RECONCILE_RESERVE`, `SANDBOX_KEEPALIVE_IDLE_DEADLINE_SEC` and `BASH_MAX_TIMEOUT_SEC` are wired through `values.<NS>.env` | Otherwise the enablement is reverted by the next upgrade, and the two capacity settings are what Brain refuses to start without |
| PRE-3 | `F <= S < G` holds for the configuration that will be in force **after** enablement. `F` is what the deployment asks a sandbox to enforce (`BASH_MAX_TIMEOUT_SEC` when PRE-4 pins, else the flag-derived default `F_ON`); `S` is the ceiling Brain advertises and forwards, which is `F` held under the transport clamp of 3540s; `G` is `brain.terminationGracePeriodSeconds` **as the enablement upgrade will render it**. Checked executably below | `F <= S` fails exactly where a pin exceeds the clamp, so the number recorded is not the number any sandbox enforces. `S < G` is strict: a command allowed to run for as long as the pod is allowed to shut down is truncated, not enforced. The currently deployed grace is the wrong source — neither entrypoint uses `--reuse-values`, so a hand-raised grace is reset by the very upgrade that enables the flag |
| PRE-4 | An explicit decision recorded on `brain.bashMaxTimeoutSec`: leave it empty and accept the flag-derived ceiling, or pin it through `BASH_MAX_TIMEOUT_SEC` in the values file, which is what makes the pin survive the next upgrade. Either way PRE-3 must pass on the result | Enablement moves the ceiling in the same step. Silence here is the top-ranked risk of the whole rollout |
| PRE-5 | Thresholds and windows fixed and written down before S1: `T_KILLED`, `T_STALE`, `T_ORPHAN`, `N_PROBE`, `T_CURL`, `I_POLL`, `N_POLL`, `N_FLEET`, `I_FLEET`, `N_BRAIN`, `T_BG`, `T_SHORT`, `W_BG`, `T_LEASE_GRACE`, and the three soak windows `W1 < W2 < W3`. `T_BG` must exceed both `N_POLL × I_POLL` and `T_SHORT`; `W_BG`, the soak workload's own command, must exceed `W3` | A threshold chosen after the reading is not a threshold, and a soak whose own workload ended before the window did measures an idle fleet. Brain's pod logs must also retain the keepalive events for at least `W3`: a window whose logs have rotated is not a soak |
| PRE-6 | Four facts recorded: whether the scoped credential of `[needs TBD-7]` is obtainable here (`TBD7=yes\|no`); whether `workload_id` is populated or empty on this deployment's sandboxes; **delete authority for the credential that will run R5**, per resource type and per namespace the census reports; and `AGENT_SANDBOX_WARM_POOL_SIZE`, which G7-e branches on. Checked executably below | Every rollback path below branches on one of them. The authority check has no substitute: RBAC is keyed on `(apiGroup, resource)`, so `pods` confers nothing on either custom resource, and one namespace says nothing about the others a workspace may have placed sandboxes in |
| PRE-7 | Deployment mode is Kubernetes/agent-sandbox, proved two ways and both must hold. Checked executably below | A SaFE-backed sandbox can only be stopped with its own per-sandbox platform key, which the status route deliberately never returns — so a SaFE enablement could not be rolled back. That **stops the rollout here**, before S1, rather than being acknowledged and continued past |

**PRE-3 as an executable check.** It runs before enabling, over the *intended*
values, because afterwards the violation is already live.

```sh
f=$( . claw/deploy/values.$NS.env >/dev/null 2>&1 && printf %s "${BASH_MAX_TIMEOUT_SEC:-}" ) \
  || { echo 'ABORT: the values file did not source; F is unknown'; exit 1; }
f=${f:-$F_ON}; s=$(( f > 3540 ? 3540 : f ))
helm template primus-claw "$(chart_dir claw/deploy/values.$NS.env)" -n "$NS" \
  --set secret.create=false --set ingress.enabled=false --set postgres.enabled=false \
  --show-only templates/brain-deployment.yaml >/tmp/claw-bg-grace.yaml \
  || { echo 'ABORT: render failed; the G enablement would apply is unknown'; exit 1; }
g=$(rg -N -o -r '$1' '^ *terminationGracePeriodSeconds: ([0-9]+)$' /tmp/claw-bg-grace.yaml); rc=$?
# rg 1 is the field genuinely absent, which means Kubernetes' own 30s. Anything
# above that is a failed read, which is not a default.
[ "$rc" -le 1 ] || { echo 'ABORT: could not read the rendered manifest'; exit 1; }
g=${g:-30}
[ "$f" -le "$s" ] && [ "$s" -lt "$g" ] \
  || { echo "ABORT: F=$f S=$s G=$g violates F <= S < G"; exit 1; }
```

- Expected: no output, exit 0. Any `ABORT` rejects the configuration, and
  nothing in §2 or §4 runs until it is changed.
- Fail `F > S`: the pin exceeds the transport clamp, so the number recorded is
  not the number a sandbox enforces. Lower it, or record the clamped value as
  the pin.
- Fail `S >= G`: raise `brain.terminationGracePeriodSeconds` in the values file,
  or lower the pin. A pin above the rendered grace is this failure, and is why
  PRE-4's decision is not free.

**PRE-6 as an executable check.** `TBD7` and the warm-pool size are recorded by
hand from the deployment's own settings; the two the cluster can answer are:

```sh
raw=$(inventory) || { echo 'ABORT: census unreadable; PRE-6 has no answer'; exit 1; }
inventory_rows "$raw" | while IFS=$'\t' read -r sid name ns url wid; do
  printf '%s\t%s\tworkload_id=%s\n' "$name" "$ns" "${wid:-(empty)}"
done
for ns in $(inventory_rows "$raw" | sed -E 's/^[^\t]*\t[^\t]*\t([^\t]*)\t.*/\1/' | sort -u); do
  for r in sandboxes.agents.x-k8s.io sandboxclaims.extensions.agents.x-k8s.io pods; do
    printf '%s %s ' "$ns" "$r"
    kubectl auth can-i delete "$r" -n "$ns" || echo REFUSED
  done
done
```

- Expected: one line per live sandbox, and `yes` for all three resource types in
  every namespace the census reported. An empty fleet prints no sandbox line and
  no authority line, which is a result: there is nothing recorded to check
  against yet, so re-run this once the fleet is non-empty.
- Fail: any `REFUSED` → **R5 option 2 has no substitute**, and the operator who
  runs it cannot terminate a sandbox they did not create. Obtain the delete verb
  or hand rollback to someone who already holds it, **before** the flag goes on.
- Fail: `ABORT` → the census could not be read, so neither the namespaces nor the
  resource identities R5 deletes by are known.

**PRE-7 as an executable check.** Both must hold.

```sh
rg -N '^CLAW_DEPLOY_MODE=' claw/deploy/values.$NS.env || echo '(absent: the kubernetes default)'
raw=$(inventory) || { echo 'ABORT: census unreadable; PRE-7 has no answer'; exit 1; }
printf '%s' "$raw" | jq -er '{safe_api: (.config.SAFE_API_URL // "(not set)"),
                              safe_sandboxes: ([.sessions[] | select(.has_platform_key)] | length)}'
```

- Expected: the first line absent or `CLAW_DEPLOY_MODE="kubernetes"`, **and**
  `{"safe_api":"(not set)","safe_sandboxes":0}`.
- Fail: anything else **stops the rollout here** and no step below runs. A SaFE
  sandbox is the one carrying a platform key, and stopping it needs that key,
  which no route returns. An unreadable answer is a **FAIL, not a skip**.

## 2. Pre-enable checks

**P0 — the deployed build and chart can be gated by this guide.**

```sh
helm list -n "$NS" -o json | jq -r '.[] | select(.name=="primus-claw") | .chart'
kubectl get pods -n "$NS" -l app=primus-claw,component=primus-claw-brain \
  -o jsonpath='{range .items[*]}{.metadata.name}{"="}{.status.containerStatuses[0].imageID}{"\n"}{end}'
curl -sf "$BRAIN/health" | jq '{brainVersion, gateable: has("bgShellEnabled")}'
raw=$(inventory) || { echo 'CENSUS_FAILED'; exit 3; }
inventory_rows "$raw" | while IFS=$'\t' read -r sid name ns url wid; do printf '%s\t' "$sid"
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
helm template primus-claw "$(chart_dir claw/deploy/values.$NS.env)" -n "$NS" \
  --set secret.create=false --set ingress.enabled=false --set postgres.enabled=false \
  --show-only templates/brain-deployment.yaml | rg -A1 'name: BG_SHELL_ENABLED'
```

- Expected, exactly `- name: BG_SHELL_ENABLED` followed by `value: "false"`.
- Fail: any other value, or no match → the chart default moved or the template was
  renamed. **Stop.**

**P2 — the schema rejects a malformed value.**

```sh
out=$(helm template primus-claw "$(chart_dir claw/deploy/values.$NS.env)" -n "$NS" \
  --set secret.create=false --set ingress.enabled=false --set postgres.enabled=false \
  --set-string features.backgroundShell=yes 2>&1); rc=$?
printf '%s\n' "$out" | rg -m1 'features\.backgroundShell' || echo '(no message naming the key)'
echo "exit=$rc"
```

- Expected: non-zero exit and a message naming `features.backgroundShell`.
- P1 and P2 both render through `chart_dir`, so what they assert about the
  default and the schema is asserted about the chart `upgrade.sh` will deploy
  rather than about the in-tree copy. A check pinned to the literal path passes
  on a chart the upgrade never touches, and a values file that cannot be sourced
  aborts here rather than quietly resolving to the default.
- Fail: exit 0 → the schema is absent or not applied to this chart, so the two
  keys this rollout turns on are unguarded. **Stop**, land the schema, re-run.
- Fail: non-zero exit with `(no message naming the key)` → the render broke on
  something else, and this step has told you nothing about the schema.

**P3 — the current running state is off.**

```sh
curl -sf "$BRAIN/health" | jq '{bgShellEnabled, bashForegroundMaxSec, draining}'
```

- Expected: `bgShellEnabled` false, `draining` false, and a
  `bashForegroundMaxSec` you **record as `F_OFF`**. G3 compares against it, and
  the number is not written down here: it depends on the build and on whether
  PRE-4 pinned, and a guide stating one would invite a gate that asserts a
  constant instead of the change.
- Fail: `bgShellEnabled: true` — already enabled somewhere; reconcile before
  staging. `draining: true` — mid-upgrade; wait. No answer at all — **FAIL**, the
  pods are unreachable and every later gate reads the same endpoint.

**P4 — the persisted flag is at a known off state.**

```sh
rg -n '^BG_SHELL_ENABLED=' claw/deploy/values.$NS.env || echo ABSENT
```

- Expected: `BG_SHELL_ENABLED=""`, `BG_SHELL_ENABLED="false"`, or `ABSENT` —
  three off states, all valid to proceed from and three different diagnoses.
- **Empty is the default-off state**: the bootstrap heredoc writes the key empty
  on first run, so empty is itself evidence PRE-2's wiring is present here.
  `"false"` is what R3 leaves. `ABSENT` — genuinely missing, which is not the
  same reading as empty — is a file written before the wiring landed, so it
  leaves PRE-2 unverified: confirm the wiring or the next upgrade reverts the
  flag.
- Fail: `"true"` — already staged by someone. Reconcile with P3.

**P5 — the termination path answers before it is needed. [needs TBD-7]**

The route is reached with a credential proving an owner and **no run**, so it
refuses without terminating anything: the whole chain — route, credential,
scope — is exercised and no shell is signalled.

```sh
# One inventory row supplies all three: the endpoint to call, and the name and
# namespace the sandbox's own token is fetched by. Unset variables would send
# this at nothing and read the refusal as a pass.
raw=$(inventory) || exit 3
HANDS_URL=; SBNAME=; SBNS=
while IFS=$'\t' read -r sid name ns url wid; do
  [ "$sid" = "$SESSION_ID" ] || continue
  HANDS_URL=$url; SBNAME=$name; SBNS=$ns; break
done <<<"$(inventory_rows "$raw")"
[ -n "$HANDS_URL" ] || { echo 'FAIL: no inventory row for the session; P5 measured nothing'; exit 1; }

# Into its own variable, and stop on an absent one: minting over an empty token
# turns this into a 401 the step would read as its expected refusal.
TOK=$(hands_token "$SBNAME" "$SBNS") \
  || { echo 'FAIL: no sandbox token; P5 is unexecutable here'; exit 1; }   # [needs TBD-7]

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "$(hands_base "$HANDS_URL")/internal/shells/reap" \
  -H "Authorization: Bearer $(scope_cred "$TOK" "$SESSION_ID" "")" \
  -H 'content-type: application/json' \
  -d '{"cause":"session_cleanup","reclaim_op":"p5"}'
```

- Expected: `400`. The absent-run bucket is the one set nothing may end by run,
  so the refusal proves the path works. A `401` here is a credential fault, not
  this check passing: the token stop above is what keeps the two apart.
- Fail: `401` → the credential is wrong or minted from the wrong secret, and R2
  would fail during rollback, when there is no time left to discover it. `404` →
  the route is not deployed; fall through to the substitute below.
- *Without TBD-7* the reap route is unreachable, so the check becomes whether
  the sandbox answers at all, which is what R6 depends on:

  ```sh
  curl -sf "$(hands_base "$HANDS_URL")/health" | jq -r '.service'
  ```

  Expected `hands`. No output means the sandbox is unreachable, so neither a
  reap nor R6 works against it: record it and treat R5 as the only rollback path
  there. This is the state the guide assumes by default, and why R2 is
  best-effort.

## 3. Enable

1. Record the enablement where the next upgrade will read it, in
   `claw/deploy/values.<NS>.env`:

   ```sh
   BG_SHELL_ENABLED="true"
   # Hands refuses to start without a child UID range or this explicit posture.
   # This acknowledgement does not isolate background-shell child processes.
   HANDS_CHILD_ISOLATION="unenforced"
   # Both REQUIRED with the flag on. Brain refuses to start without them: the
   # gap between two refreshes of one sandbox handle is derived from them, and a
   # sandbox hosting a live background shell is reclaimed if that gap is wrong.
   # The ceiling is the largest number of distinct ping targets one Brain
   # replica may face -- size it to this deployment's real fleet with headroom,
   # not to today's count. The reserve is how many of those slots are held back
   # so a target another replica created can always be taken on before it is
   # served; a few percent of the ceiling, never zero.
   SANDBOX_KEEPALIVE_TARGET_CEILING="200"
   SANDBOX_KEEPALIVE_RECONCILE_RESERVE="20"
   # The shortest idle reclaim in force here. Brain proves the worst-case gap
   # between two refreshes of one handle against it and refuses to start where
   # the gap is not under it, so a ceiling too large for the interval is
   # rejected here rather than found later as a reclaimed sandbox.
   SANDBOX_KEEPALIVE_IDLE_DEADLINE_SEC="900"
   # Only if PRE-4 applies.
   BASH_MAX_TIMEOUT_SEC=""
   ```

   These render as `features.keepaliveTargetCeiling` and
   `features.keepaliveReconcileReserve`; the chart ships both empty, which is
   why they must be set in the same change that sets the flag and not after it.
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

**The rollout unit is a deployment, not a percentage.** Both constants are read
once at module load and Brain forwards one value into every sandbox it creates,
so restarting a subset of a Deployment's replicas — which share one environment
— yields an inconsistent fleet, not a canary. Three stages, each a whole
deployment, and each repeats §2's checks, the enablement of §3, and then G1–G7
in order:

| Stage | What it is |
|---|---|
| S1 | A non-production environment running at least one long-running command, so the ceiling is exercised rather than assumed |
| S2 | One production-like environment, the lowest blast radius available |
| S3 | The rest, one deployment at a time |

**All seven gates must pass before the next stage, and there is no waiver.** A
gate that cannot be run is unverified, and unverified never advances a stage; a
gate blocked by an undeployed `[needs TBD-7]` is a reason to deploy it, not a
reason to record a note and continue — where it is undeployed, G5 is judged on
the run and task API instead and still returns a verdict.

| Gate | Reads | Exists because |
|---|---|---|
| G1 | The flag and the ceiling pin survived the render, in the Deployment and in the values file | Nothing else notices when the enablement is reverted by a routine upgrade, and a stage run on a reverted flag measured nothing |
| G2 | Every Brain replica reports one `bgShellEnabled` / `bashForegroundMaxSec` pair | Module-load evaluation means a value present in the Deployment and absent from a running pod is a real and silent state |
| G3 | The foreground ceiling moved as intended | Enabling tightens the foreground ceiling. That is the user-visible regression risk of the whole rollout, so it gets its own gate rather than a footnote |
| G4 | A sandbox created after the change agrees with Brain, and the fleet that predates it drains to zero | Brain and Hands agree only for sandboxes created after the change. This is the only gate that can see the mixed window |
| G5 | A background shell actually starts, and the reap that cleans the canary up answers | Schema presence is not capability: Hands refuses at the spawn point independently, so both gates must be observed to have opened |
| G6 | A sandbox held by a running shell appears in `keepalive.idle_handle_kept_background_work`, and in `keepalive.idle_handle_expired` once the work ends — correlated by `sandboxName`, not by session id, which outlives every sandbox written under it | Orphan reclamation and keepalive interaction are time-dependent and cannot be observed by a single request |
| G7 | The shipped semantics once a shell has started: cross-turn handles (G7-a, G7-b), cancellation (G7-c), sandbox idle and absolute lifetime (G7-d, G7-d2), a lost handle across a Hands restart (G7-e), and an in-flight rolling upgrade (G7-f) | G5 proves a shell can start. Only these prove it behaves, and each fails in a way no earlier gate reads |

A stage that skips G4 has not tested what distinguishes this rollout from a
plain config change; one that skips G7 has tested that the feature turns on, not
that it behaves.

**G1 — the flag, and the pin, survived the render.**

```sh
for v in BG_SHELL_ENABLED BASH_MAX_TIMEOUT_SEC; do
  printf '%s=' "$v"
  kubectl get deployment primus-claw-brain -n "$NS" \
    -o jsonpath="{range .spec.template.spec.containers[0].env[?(@.name=='$v')]}{.value}{end}"
  echo
done
rg -N '^BG_SHELL_ENABLED=' claw/deploy/values.$NS.env || echo ABSENT
```

- Expected: `BG_SHELL_ENABLED=true`, `BASH_MAX_TIMEOUT_SEC=` empty where PRE-4
  left the pin empty and the pinned number where it pinned, and the values file
  still carrying `BG_SHELL_ENABLED="true"`. That last line is the only evidence
  the enablement will survive the *next* upgrade, and re-reading it during soak
  is SC-7.
- Fail: the flag empty or `false` in the Deployment → the persistence path did
  not carry it. **Stop and fix the wiring**; do not re-apply by hand with
  `--set`, which reproduces the same defect one upgrade later.
- Fail: pinned but empty, or holding a value PRE-4 did not record → the pin is
  not persisted. G3 and R4 re-read this same line.

**G2 — every Brain replica loaded it.** §3's command, and the same reading:
exactly one line, carrying `"bgShellEnabled":true`. A `false` from any pod means
that pod predates the restart; the constants are read at module load, so it will
not pick the value up without one. Re-run `kubectl rollout status
deployment/primus-claw-brain -n "$NS"` and re-check. Two lines differing in
`bashForegroundMaxSec` after the rollout settles are mixed images: **stop**.

**G3 — the foreground ceiling moved as intended.**

```sh
curl -sf "$BRAIN/health" | jq '.bashForegroundMaxSec'
```

- Expected, unpinned: a value strictly less than the `F_OFF` recorded at P3.
- Expected, pinned: exactly the pinned number, which is the `S` PRE-3 computed.
  PRE-3 has already rejected a pin above the clamp and one at or above the
  grace, so on a configuration that reached this gate the advertised ceiling and
  the recorded pin are the same number, and anything else is a fault rather than
  a clamp.
- Fail: unchanged from `F_OFF` while the pin is empty → the two settings are not
  paired as the schema describes, which is the case where the model is promised
  one limit and the sandbox enforces another. **Stop.**
- Judgment, not a number: this gate asserts a direction and an equality. It does
  not assert a constant, because the constant is a property of the build.

**G4 — the new sandbox agrees, and the fleet that predates the change drains.**

An already-running sandbox is the wrong thing to read for *agreement* and the
right thing to read for *closure*, so steps a–d build a new one and step e polls
the pre-existing fleet to zero. Both halves must pass.

```sh
# a. a session owned by the operator running the gate
SESSION_ID=$(curl -sf -X POST "https://$API_HOST/v1/sessions" -H "$USER" \
  -H 'content-type: application/json' -d '{"name":"bg-rollout-canary"}' \
  | jq -r '.data.session_id // empty')
# b. one trivial task; dispatching it is what builds the sandbox
CANARY_RUN=$(dispatch "$ACTIVITY_PROMPT") || { echo 'FAIL: the canary task did not submit'; exit 1; }
settle_verdict "$(settle "$CANARY_RUN")" bash || exit 1
# c. the sandbox's own reading, which is what this gate exists for
raw=$(inventory) || { echo 'ABORT: census unreadable; G4 has no verdict'; exit 1; }
HANDS_URL=$(inventory_rows "$raw" | while IFS=$'\t' read -r sid name ns url wid; do
    [ "$sid" = "$SESSION_ID" ] && printf '%s\n' "$url"; done)
[ -n "$HANDS_URL" ] || { echo 'FAIL: the sandbox never registered; this gate measured nothing'; exit 1; }
probe "$HANDS_URL" | jq '{bgShellEnabled, bashMaxTimeoutSec}'
# d. the fleet that already existed: enumerated, classified, polled to zero
fleet() { set -o pipefail; local raw sid name ns url wid body cls
  raw=$(inventory) || return 3
  inventory_rows "$raw" | while IFS=$'\t' read -r sid name ns url wid; do
      body=$(probe "$url") || { printf '%s\tUNREACHABLE\n' "$name"; continue; }
      cls=$(printf '%s' "$body" | jq -r 'if has("bgShellEnabled") then (.bgShellEnabled|tostring) else "MISSING" end') || exit 3
      printf '%s\t%s\n' "$name" "$cls"
    done; }
for i in $(seq 1 "$N_FLEET"); do
  snap=$(fleet) || { echo 'ABORT: fleet enumeration failed; G4 has no verdict'; exit 1; }
  printf '%s\n' "$snap"; pre=0
  [ -n "$snap" ] && { pre=$(printf '%s\n' "$snap" | rg -cv '\ttrue$'); rc=$?
    [ "$rc" -le 1 ] || { echo 'ABORT: fleet classification unreadable'; exit 1; }; pre=${pre:-0}; }
  echo "pre_change=$pre"; [ "$pre" = 0 ] && break
  sleep "$I_FLEET"
done
[ "$pre" = 0 ] || { echo "FAIL: $pre pre-change sandbox(es) still live"; exit 1; }
```

Keep `$SESSION_ID`: G5 and G7-a to G7-c reuse this session. G7-d and G7-d2 each
need a canary of their own, for the reason each states.

- Expected, step c: `bgShellEnabled: true`, and a `bashMaxTimeoutSec` equal to
  Brain's `bashForegroundMaxSec` from G3.
- Expected, step d: `pre_change=0` before the polls run out. **Zero
  pre-change-or-unknown sandboxes is what lets the stage advance**, and nothing
  weaker: the count is `true` against everything else, never an allow-list.
  `false` is old code reporting honestly, `MISSING` a Hands binary predating the
  field, `UNREACHABLE` one that `probe` could not get an answer out of in
  `N_PROBE` bounded attempts, and a classification none of those anticipated
  counts as pre-change too — a sandbox that cannot say it is on the new code is
  not evidence that it is. An empty enumeration reads `0`; a failed one aborts.
- Size `N_FLEET × I_FLEET` to span the window: twice the sandbox idle-reuse
  interval plus `brain.sessionTimeout`.
- Fail, step d: `pre_change` still non-zero when the polls run out → the window
  has not closed and **the stage is not complete**. Recycle the survivors the way
  R5 does, without R3's flag change, or extend the window, then re-run. A sandbox
  stuck `UNREACHABLE` is a survivor like any other.
- Fail, step c: a sandbox created *after* the change reporting `false`, or the
  two ceilings differing → Brain is not forwarding what it advertises. **Stop and
  roll back.**

**G5 — functional canary: a background shell actually starts.**

Schema presence is not capability — Hands refuses independently at the spawn
point — so this gate observes the process, not the schema. Both branches judge
from the run record, which is written when the run ends and read back
afterwards, so nothing races the dispatch.

```sh
G5_RUN=$(dispatch "Run \`sleep $T_SHORT; echo BGCANARY-OK\` with run_in_background=true, report its shell id, wait for it with a $T_SHORT timeout, report verbatim what bash_output returns, then kill_shell it.") \
  || { echo 'FAIL: G5 did not submit'; exit 1; }
G5=$(settle "$G5_RUN") || { echo 'FAIL: G5 never reached terminal'; exit 1; }
printf '%s' "$G5" | jq -e '.by_tool_ok as $t | .status == "completed"
    and (["bash","bash_output","wait","kill_shell"] | map(($t[.] // 0) >= 1) | all)
    and (.out | test("BGCANARY-OK"))
    and ((.out | test("background shells are disabled")) | not)' >/dev/null \
  || { echo 'FAIL: G5'; exit 1; }
```

- Expected: no output and exit 0. The four names together are the schema
  assertion — three of them are published to the model only inside the flag's
  own conditional, and a shell id coming back at all proves `run_in_background`
  was published too. The marker proves the half a count cannot: only a shell
  that really ran puts it into what `bash_output` returned.
- The counts read `by_tool_ok`, not `by_tool`: a call is counted before it runs
  and stays counted when it fails, and a refusal on this path *returns* rather
  than throwing, so an attempted-call count is satisfied by a deployment that
  refused every one of them.
- Fail: a missing name → that tool was never published, so Brain's schema is
  still in its off shape. `background shells are disabled` in the output → the
  call reached Hands and was refused at the spawn point, which is the half a
  schema reading cannot see. Either **stops the stage**.
- Fail: `NOT_TERMINAL`, an unreadable body, or any other shape → **FAIL, not a
  skip**. Cross-check G2 and G4 before treating it as a background-shell finding:
  an `HTTP 401` or `403` on submit is an auth or ownership problem, not a reading
  about this feature.
- Clean the canary up before soak, which exercises the rollback path once.
  **[needs TBD-7]**:

  ```sh
  curl -sf -X POST "$(hands_base "$HANDS_URL")/internal/shells/reap" \
    -H "Authorization: Bearer $SCOPE_G5" -H 'content-type: application/json' \
    -d "{\"cause\":\"gate-cleanup\",\"reclaim_op\":\"g5\"}" | jq '{stopped, escalated, surviving}'
  ```

  Expected: `surviving: 0`, and `/internal/shells/active` then answering
  `running: 0` for the same scope. `surviving` above zero, or a non-2xx, is
  **SC-6** — the cooperative path is already broken, which is blocking on its
  own. Without the credential this cleanup is skipped and the canary's shell
  goes when its sandbox does.

**G6 — soak.** Hold the stage for its window: `W1` for S1, `W2` for S2, `W3` for
S3. Each is subject to two floors — at least twice the sandbox idle-reuse
interval, so pre-change sandboxes age out and the window is watched closing, and
at least the longest background command the environment routinely runs, so a
sandbox holding one has time to be reclaimed and the per-sandbox correlation
means something. The three are chosen at PRE-5 and written down, never published
here.

The soak needs work to observe: G5's canary was reaped at its cleanup step, and
the kept-alive event fires only where a probe answers `running > 0`, so a window
in which nothing ran produces the same empty reading as one in which nothing was
orphaned.

```sh
SOAK_RUN=$(dispatch "Run \`sleep $W_BG\` with run_in_background=true and shell_id=\"bg-soak\"; reply with only the shell id. Do not wait for it and do not kill_shell it.") \
  || { echo 'ABORT: the soak workload did not submit; G6 would measure an idle fleet'; exit 1; }
settle_verdict "$(settle "$SOAK_RUN")" bash \
  || { echo 'ABORT: the soak workload never started; G6 has nothing to observe'; exit 1; }
WSTART=$(jq -rn 'now|todate')
BRAIN_PODS_0=$(kubectl get pods -n "$NS" -l app=primus-claw,component=primus-claw-brain \
  -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}' | sort)
# --- at the end of the window ---
BRAIN_LOG=$(kubectl logs -n "$NS" -l app=primus-claw,component=primus-claw-brain \
  --tail=-1 --max-log-requests="$N_BRAIN" --since-time="$WSTART") \
  || { echo 'ABORT: brain logs unreadable; G6 has no result'; exit 1; }
BRAIN_PODS_1=$(kubectl get pods -n "$NS" -l app=primus-claw,component=primus-claw-brain \
  -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}' | sort)
[ "$BRAIN_PODS_1" = "$BRAIN_PODS_0" ] \
  || { echo 'ABORT: Brain pods changed during the window; the log is truncated and G6 has no result'; exit 1; }
ev() { printf '%s\n' "$BRAIN_LOG" \
  | jq -r --arg m "$1" 'select(.msg==$m) | .sandboxName // error("event without sandboxName")' \
  | sed '/^$/d' | sort -u; }
kept=$(ev keepalive.idle_handle_kept_background_work) || { echo 'ABORT: the kept-alive read failed, or Brain predates the field'; exit 1; }
reclaimed=$(ev keepalive.idle_handle_expired) || { echo 'ABORT: the companion read failed'; exit 1; }
[ -n "$kept" ] || { echo 'ABORT: nothing was held for background work; G6 observed no work and has no result'; exit 1; }
orphan=$(jq -rn --arg k "$kept" --arg r "$reclaimed" \
  '(($k|split("\n"))-[""]) - (($r|split("\n"))-[""]) | length') || { echo 'ABORT: the set difference failed'; exit 1; }
probe_fail=$(printf '%s\n' "$BRAIN_LOG" \
  | jq -r 'select(.msg|test("^keepalive[.]background_work_(answer_stale|check_failed|unreconciled)$"))|.msg' | wc -l) \
  || { echo 'ABORT: the probe-failure read failed'; exit 1; }
verdict=PASS
printf 'OBS-5\tnever_reclaimed=%s\tceiling=%s\theld=%s\n' "$orphan" "$T_ORPHAN" "$(printf '%s\n' "$kept" | sed '/^$/d' | wc -l)"
printf 'OBS-6\tcount=%s\tceiling=%s\n' "$probe_fail" "$T_STALE"
[ "$orphan" -le "$T_ORPHAN" ] || verdict=FAIL
[ "$probe_fail" -le "$T_STALE" ] || verdict=FAIL
echo "G6=$verdict"
```

- `--tail=-1` is not decoration: with a selector `kubectl logs` defaults to ten
  lines per pod, which caps every count below and turns a red window green.
  `--max-log-requests` covers its own selector concurrency cap, so a wider fleet
  is refused rather than short-read. The pod census is pinned when the window
  *opens* because `kubectl logs` reaches only containers alive now, and a Brain
  pod replaced at any point took its share of the window with it — a census
  taken only at the end cannot see that.
- Expected: `G6=PASS`, exit 0, and no stop condition fired for the whole window.
  A pass requires at least one probe observed answering `running > 0` — the
  non-empty `kept` above — because every threshold here counts what went wrong
  with background work and all of them read zero where none ran.
- Fail: `G6=FAIL`. **No result** — any `ABORT`, a mid-window Brain restart
  included — is neither a pass nor a skip: fix the read and re-run the whole
  window, which measured nothing. No third outcome and no waiver.
- Both readings are absolute counts, never ratios, compared literally against
  the thresholds PRE-5 fixed. `probe_fail` sums all three probe-failure events
  because `answer_stale` alone reads zero while every probe throws. A
  `probe_fail` of `0` is a pass — the one reading here exempt from the
  learned-nothing rule, and only because `pipefail` separates "matched nothing"
  from a read error.

**G7 — the behaviours the guide must show after enablement.** One task per row,
dispatched into `$SESSION_ID` and judged from the run record once the run ends —
never from a stream, which would race the dispatch, and never from a Hands-side
event, which has no reader. Every row is bounded by `N_POLL × I_POLL`, and a read
that errors, times out, returns `NOT_TERMINAL`, or matches neither the expected
nor a listed failure shape is a **FAIL, not a skip**.

`T_SHORT < T_BG` is what makes G7-a's `wait` run out with the shell still alive,
so its `kill_shell` terminates something: a kill that answers `already <status>`
ended nothing, and because that is an ordinary string on a successful call it
leaves the counts looking exactly like a pass.

```sh
A_RUN=$(dispatch "Run \`sleep $T_BG\` with run_in_background=true and shell_id=\"bg-tools-canary\"; report the shell id, read it once with bash_output, call wait on it with timeout_sec=$T_SHORT, then kill_shell it and reply with only the text kill_shell returned.") \
  || { echo 'FAIL: G7-a did not submit'; exit 1; }
printf '%s' "$(settle "$A_RUN")" | jq -e '.by_tool_ok as $t | .status=="completed"
    and (["bash","bash_output","wait","kill_shell"] | map(($t[.] // 0) >= 1) | all)
    and (.out | test("terminating")) and ((.out | test("already")) | not)' >/dev/null \
  || { echo 'FAIL: G7-a'; exit 1; }
B_RUN=$(dispatch "Run \`sleep $T_BG\` with run_in_background=true and shell_id=\"bg-turn-canary\"; reply with only the shell id. Do not wait for it and do not kill_shell it.") \
  || { echo 'FAIL: G7-b start did not submit'; exit 1; }
settle "$B_RUN" >/dev/null || exit 1
B_READ=$(dispatch 'Call bash_output on shell_id "bg-turn-canary" and reply with only the text it returns.') \
  || { echo 'FAIL: G7-b read did not submit'; exit 1; }
printf '%s' "$(settle "$B_READ")" | jq -e '.status=="completed"
    and ((.by_tool_ok.bash_output // 0) >= 1)
    and (.out | test("Status: running")) and ((.out | test("not found")) | not)' >/dev/null \
  || { echo 'FAIL: G7-b'; exit 1; }
```

- G7-a expects a completed run, all four tools with a *successful* call each, and
  the kill answering `terminating`. Fail: a missing name → that tool was never
  published, so the schema is still in its off shape; `already` → `wait`
  outlasted the shell and the kill was a no-op, so the row proved publication and
  not termination: raise `T_BG` or lower `T_SHORT` and **re-run it**.
- G7-b expects the handle to still resolve in a *second* turn, reporting
  `Status: running`. It uses its own shell rather than G7-a's, which is killed
  and then dropped one reap delay after exit and stops resolving before a second
  turn can be dispatched. Fail: `not found (possibly lost after sandbox rebuild)`
  while the inventory still reports the same `hands_url` → handles are not
  surviving turns; **stop**.

**G7-c — a cancelled run does not reach the shells it started.** The prompt makes
the run `wait` on its own shell, so the run is still live when the cancel is
issued; without that barrier the run can already be terminal and the cancel
answers `404 not_found_or_terminal`, which tests nothing.

```sh
CANCEL_RUN=$(dispatch "Run \`sleep $T_BG\` with run_in_background=true and shell_id=\"bg-cancel-canary\", report the shell id, then call wait on that shell id with a $T_BG timeout. Do not kill_shell it.") \
  || { echo 'FAIL: G7-c did not submit'; exit 1; }
live=0; for i in $(seq 1 "$N_POLL"); do
  st=$(run_status "$CANCEL_RUN") || { echo 'FAIL: status unreadable; G7-c has no verdict'; exit 1; }
  case "$st" in
    running|cancelling) live=1; break ;;
    completed|failed|cancelled) echo "FAIL: run reached $st before the cancel; re-run G7-c"; exit 1 ;;
  esac
  sleep "$I_POLL"; done
[ "$live" = 1 ] || { echo 'FAIL: the run never reached running; G7-c tested nothing'; exit 1; }
curl -sf -X POST --max-time "$T_CURL" -H "$USER" "https://$API_HOST/v1/tasks/$CANCEL_RUN/cancel" \
  | jq -e '.cancelled == 1' >/dev/null \
  || { echo 'FAIL: the cancel was refused; the barrier did not hold, re-run G7-c'; exit 1; }
C_READ=$(dispatch 'Call bash_output on shell_id "bg-cancel-canary" and reply with only the text it returns.') \
  || { echo 'FAIL: G7-c read did not submit'; exit 1; }
printf '%s' "$(settle "$C_READ")" | jq -e '.status=="completed"
    and ((.by_tool_ok.bash_output // 0) >= 1) and ((.out | test("not found")) | not)' >/dev/null \
  || { echo 'FAIL: the handle did not outlive the cancelled run'; exit 1; }
```

- Expected: the cancel answers `cancelled == 1`, and the shell **survives it**.
  That survival is the pass: the run-end reap is scoped to graph nodes, and a
  task submitted to a session carries neither identifier, so cancelling it
  cannot reap. The explicit reap, or R5's infra-layer termination where the
  credential is unavailable, must then end it.
- Fail: the shell gone straight after the cancel is a fail-to-advance rather
  than a bonus — the reap scope has moved, so re-derive it before continuing.
  A shell still alive **after** an explicit reap is SC-6. Either **stops the
  stage and rolls back**.

**G7-d — the sandbox idle timeout, on its own.** Against `$IDLE_SESSION`, a
canary created exactly as G4 creates its own and then left alone: a held
background shell postpones the idle clock, so this row may not use
`$SESSION_ID`. Resolve the resource identity **before** the wait — after
reclamation the row is gone and nothing names the CR. Size `N_FLEET × I_FLEET`
past the idle-reuse interval and `brain.sessionTimeout`, and deliberately short
of `brain.maxSessionDuration`, so only the idle path can fire.

```sh
sb "$IDLE_SESSION" || exit 1
gone=0
for i in $(seq 1 "$N_FLEET"); do
  raw=$(inventory) || { echo 'ABORT: census unreadable; a failed read is not an empty fleet'; exit 1; }
  inventory_rows "$raw" | rg -qF -- "$SBNAME"$'\t'"$SBNS" || { gone=1; break; }
  sleep "$I_FLEET"
done
[ "$gone" = 1 ] || { echo 'FAIL: the sandbox never left the inventory; the idle clock did not fire'; exit 1; }
for i in $(seq 1 "$N_FLEET"); do
  state=$(cr); rc=$?; [ "$rc" = 2 ] && { echo 'ABORT: kubectl could not answer; a failed get is not a deletion'; exit 1; }
  [ "$state" = gone ] && break
  sleep "$I_FLEET"
done
[ "$state" = gone ] || { echo 'FAIL: the handle expired but the Sandbox CR was not reclaimed'; exit 1; }
```

- Expected: the sandbox leaves the inventory **and** the CR is reported gone, and
  G6's `ev keepalive.idle_handle_expired` carries that same `sandboxName`. Both
  halves are needed: the status route enumerates the key-value store rather than
  Kubernetes, and expiry there deletes only that key.
- Fail: absent from the inventory with the CR still present → the handle expired
  without the workload being reclaimed; **stop**. Still listed and present past
  the poll window → work is holding the sandbox past the idle limit, which is
  SC-4; **stop**.
- **No control-plane request appears in this row and none may be added**: every
  successful read of a sandbox session refreshes its last-activity stamp by
  design, so a step that polled it would suppress the timeout it claims to
  verify.

**G7-e — a Hands restart, and the lost handle.** Its branch is decided by the
`AGENT_SANDBOX_WARM_POOL_SIZE` recorded at PRE-6, and this guide reads that value
and never changes it. At `0`, Hands is restarted in place: the operating-system
process survives, the handle is lost, and `hands_url` is unchanged. Above `0`,
the in-place path is refused outright and the next run rebuilds the sandbox, so
the handle is lost, `hands_url` changes and the recorded process is gone — all
three are the pass there, and Brain's own refusal is what is asserted instead. A
row that does not say which branch it took is unverified.

- Expected, either branch: the exact lost-handle text observed through
  `bash_output` after the restart. Fresh output from the old handle is the
  failure this row exists to catch.
- Fail: on the `0` branch, a dead recorded process or a changed `hands_url`. On
  the branch above `0`, a handle that is *not* lost, an unchanged `hands_url`,
  or no refusal logged. Either way the restart was not verified: **stop and roll
  back**.

**G7-f — behaviour during an active rolling upgrade**, with a built and pushed
tag different from the deployed one.

```sh
before=$(kubectl get deployment primus-claw-brain -n "$NS" -o json) || exit 1
OLD_GEN=$(printf '%s' "$before" | jq -er '.metadata.generation') || exit 1
OLD_REV=$(printf '%s' "$before" | jq -er '.metadata.annotations["deployment.kubernetes.io/revision"]') || exit 1
inflight() { local d; d=$(kubectl get deployment primus-claw-brain -n "$NS" -o json) || return 2
  printf '%s' "$d" | jq -e --argjson g "$OLD_GEN" --arg r "$OLD_REV" --arg t "$NEW_TAG" \
    '(.metadata.generation > $g) and (.metadata.annotations["deployment.kubernetes.io/revision"] != $r)
     and (.spec.template.metadata.labels["brain-version"] == $t)
     and (.status.observedGeneration == .metadata.generation)
     and (((.status.updatedReplicas // 0) != .spec.replicas)
          or ((.status.readyReplicas // 0) != (.status.updatedReplicas // 0)))' >/dev/null; }
TAG=$NEW_TAG bash claw/deploy/upgrade.sh -n "$NS" >/tmp/claw-bg-upgrade.log 2>&1 & UP=$!
seen=0; for i in $(seq 1 "$N_POLL"); do
  inflight; rc=$?
  [ "$rc" -gt 1 ] && { wait "$UP"; echo 'ABORT: the Deployment was unreadable'; exit 1; }
  [ "$rc" = 0 ] && { seen=1; break; }
  sleep "$I_POLL"; done
sample=0
if [ "$seen" = 1 ]; then
  pods=$(kubectl get pods -n "$NS" -l app=primus-claw,component=primus-claw-brain -o name) || { wait "$UP"; exit 1; }
  [ -n "$pods" ] && sample=1
  for p in $pods; do
    inflight && kubectl exec -n "$NS" "$p" -- curl -sf localhost:8100/health \
      | jq -ec 'select(has("bgShellEnabled") and has("bashForegroundMaxSec") and has("draining"))
                | {bgShellEnabled, bashForegroundMaxSec, draining}' && inflight || { sample=0; break; }
  done
fi
if wait "$UP"; then up=0; else up=$?; fi
[ "$seen" = 1 ] && [ "$sample" = 1 ] && [ "$up" = 0 ] \
  || { echo 'FAIL: no complete in-flight sample, or the upgrade failed'; sed -n '1,200p' /tmp/claw-bg-upgrade.log; exit 1; }
```

- Expected: at least one per-pod health sample **bracketed** by reads proving the
  new generation is controller-observed and still incomplete. Mixed values or
  `"draining":true` are observations during that sample, not failures. The
  upgrade then exits zero, and G2 and G3 are re-run afterwards and must both
  pass.
- Fail: no observed incomplete state, completion during a per-pod sample, an
  unreadable Deployment or `/health`, a non-zero upgrade exit, or a failing
  post-rollout G2/G3. Any of them means G7-f has no successful in-flight verdict.

**G7-d2 — the absolute deadline is enforced, and idle reclamation is not mistaken
for it.** Run with `SESSION_ID` rebound to a canary session of its own, created
as G4 creates its own and then held busy throughout, so only the absolute cap can
fire. The deadline is read off whichever object carries it: a claim-owned
sandbox carries none itself, and its claim is where the platform places the cap.

```sh
sb "$SESSION_ID" || exit 1
CLAIM=$(kubectl get sandbox -n "$SBNS" "$SBNAME" --ignore-not-found \
  -o jsonpath='{.metadata.ownerReferences[?(@.kind=="SandboxClaim")].name}')
if [ -n "$CLAIM" ]; then DEADLINE=$(kubectl get sandboxclaim -n "$SBNS" "$CLAIM" -o jsonpath='{.spec.lifecycle.shutdownTime}')
else DEADLINE=$(kubectl get sandbox -n "$SBNS" "$SBNAME" -o jsonpath='{.spec.lifecycle.shutdownTime}'); fi
[ -n "$DEADLINE" ] || { echo 'FAIL: no absolute deadline on the object that carries it'; exit 1; }
DEADLINE_EPOCH=$(date -d "$DEADLINE" +%s) || { echo 'FAIL: unparseable shutdownTime'; exit 1; }

SEEN_LIVE=false
for i in $(seq 1 "$N_FLEET"); do
  # Each refresh must SUCCEED. A dispatch that failed leaves the session idle,
  # and an idle session is reclaimed by a path that has nothing to do with the
  # absolute cap -- so a loop that ignores its own failures proves the wrong
  # thing about the CR that then disappears.
  tid=$(dispatch "$ACTIVITY_PROMPT") || { echo 'FAIL: activity dispatch failed; the session is no longer held busy'; exit 1; }
  settle_verdict "$(settle "$tid")" bash || exit 1

  state=$(cr); rc=$?; [ "$rc" = 2 ] && { echo 'ABORT: kubectl could not answer'; exit 1; }
  now=$(date +%s)
  # Recorded, not inferred: without a look that found the CR present before the
  # deadline, a first look finding it gone proves only that it is gone now.
  [ "$state" = present ] && [ "$now" -lt "$DEADLINE_EPOCH" ] && SEEN_LIVE=true

  deadline_verdict "$state" "$SEEN_LIVE" "$now" "$DEADLINE_EPOCH"; v=$?
  [ "$v" = 0 ] && break
  [ "$v" = 1 ] && exit 1
  sleep "$I_FLEET"
done
[ "$v" = 0 ] || { echo "FAIL: no verdict reached within $N_FLEET looks"; exit 1; }
```

The three properties this gate needs, and which line carries each: every activity
refresh **succeeded** (so the session was genuinely held busy and the idle path
was not what fired); the CR was observed **live before** `DEADLINE` (so its
eventual absence is a transition, not a state it was already in); and its deletion
is accepted **only at or after** `DEADLINE`. A loop that discards failed
dispatches, or that accepts the CR's disappearance without looking at the clock,
passes on idle reclamation and says nothing about the absolute lifetime.

## 5. Observability items

The table separates items by **reachability**, because that is what decides
whether one may carry a gate. A **gate-bearing** item is readable with the tools
§0 declares: Brain's own structured log events, the two `/health` payloads, the
foreground-timeout metric, the run and task API, and the identity fields on the
sandbox census. **Informational** items are Hands-side, and unreadable today:
they go to `HANDS_LOG_PATH` inside the sandbox's Hands-owned state area rather
than to a container's stdout, so no declared tool can count them. They are
listed as what to wire up when that lands, and they carry **no threshold and no
gate** — writing one down would invite a step that reads zero forever and calls
it green.

| # | Signal | Reach | Read as |
|---|---|---|---|
| OBS-1 | `shell.background.start` | informational | The rate of background spawns. What G5 would assert on if it could; it uses OBS-9 instead |
| OBS-2 | `shell.background.exit` / `shell.background.error` | informational | The background completion mix. Both are emitted **only** for non-foreground shells, so nothing here says anything about foreground timeouts |
| OBS-2f | `claw_bash_foreground_timeout_total{clamped="true"}`, and the `shell.foreground.timeout` event behind it | **gate** (SC-1) | The ceiling change biting. The event is the direct signal and has no reader; the metric is the readable form of the same fact, which is why SC-1 reads it and not a count of runs |
| OBS-3 | `shell.background.run_end_terminate` / `run_end_kill` | informational | Run-end reap is firing. SC-6 reads the reap route's own answer instead |
| OBS-4 | `shell.background.shutdown_terminate` / `shutdown_kill`, `hands.shutdown` | informational | Sandbox teardown took background work with it. G7-d and R6 read the sandbox inventory instead |
| OBS-5 | `keepalive.idle_handle_kept_background_work` | **gate** (G6, SC-4) | An idle sandbox was kept alive because work was running. Fault when the number of distinct `sandboxName`s held here and absent from `keepalive.idle_handle_expired` over the same window exceeds `T_ORPHAN`. The correlation is per **sandbox generation**: the session id these events also carry is a store key that outlives every sandbox written under it, so correlating on it would let a dead generation's reclamation excuse a live generation's orphan. Rising alone is not a fault — it rises with legitimate long work |
| OBS-6 | `keepalive.background_work_answer_stale`, `background_work_check_failed`, `background_work_unreconciled` | **gate** (G6, SC-5) | Probe health: the **sum of the three, as an absolute count per window**, never a ratio — an ordinary successful probe logs nothing at all, so there is nothing to divide by. All three are ways the probe failed to answer, and watching the first alone reads zero while every probe throws. The third fires where a run of unanswered probes has left a handle unreconciled; it never becomes an idle verdict, so a count here is work nobody could account for rather than work that ended. Fault above `T_STALE`: probes are not landing inside the sweep and OBS-5 cannot be trusted. **A zero count is a pass**, printed and tested all the same |
| OBS-7 | The reap route's own `{stopped, escalated, surviving}` answer | **gate** (G5, R2) — the answer only | Every explicit reap with its outcome. The audit trail is kept caller-side, because the route's own log line is written where nothing can read it |
| OBS-8 | Brain `/health` `bgShellEnabled` and `bashForegroundMaxSec`; Hands `/health` `bgShellEnabled` and `bashMaxTimeoutSec` | **gate** (G2, G3, G4, SC-2, SC-3, R4, R6) | Fleet-level and per-sandbox configuration state. Divergence across Brain pods outside a rollout is always a fault; a sandbox differing from Brain is the mixed window, which G4 closes by measurement |
| OBS-9 | `.item.status`, `.item.output` and `.item.tool_stats.by_tool_ok` on the task API; the terminal facts on the run listing | **gate** (G5, G7, R8) | Per-run tool-call outcomes and terminal facts, written when the run ends and read back afterwards. The only tool-level evidence here that is neither streamed nor raced — and `by_tool_ok` rather than `by_tool`, because a call is counted before it runs and stays counted when it fails |
| OBS-10 | `sandbox_name`, `namespace` and `provider` on the sandbox census | **gate** (G7-d, G7-d2, G7-e, R1, R5, R6) | The resource identity behind a session id. Without it no step can name the Sandbox it must watch or delete, and **none may fall back to a label selector**: the session-id label reaches the custom resource only on the direct create path and is absent entirely on the warm-pool path, so a label sweep silently misses exactly the sandboxes a rollback must reach |

`T_ORPHAN`, `T_STALE` and SC-1's `T_KILLED` are the only thresholds anything here
compares against. Each is fixed per environment at PRE-5 and held constant across
stages; none is published here, because a real threshold is environment detail
and one chosen after seeing the data is not a gate.

Not available, and this guide must not imply otherwise: a background-shell
dashboard panel, any per-tenant aggregate, a stall prompt for a background shell,
and any reading of a Hands-side event.

## 6. Stop conditions

Any one halts advancement and triggers §7.

| # | Condition | Detected by |
|---|---|---|
| SC-1 | Foreground commands that previously completed now hit the ceiling | The rate of `claw_bash_foreground_timeout_total{clamped="true"}` over the soak window, against the same rate over an equal window ending at enablement. Fault when it exceeds the baseline by more than `T_KILLED` |
| SC-2 | Brain replicas disagree on `bgShellEnabled` or `bashForegroundMaxSec` outside an active rollout | G2 re-run during soak |
| SC-3 | A sandbox created after enablement reports `bgShellEnabled: false`, or a ceiling differing from Brain's | G4 re-run during soak |
| SC-4 | Sandboxes held by G6's kept-alive event that never appear in `keepalive.idle_handle_expired` | G6's per-`sandboxName` correlation over the soak window |
| SC-5 | Keepalive probe-failure-dominant — the probe cannot answer, so orphan reclamation is unverifiable | Absolute log count per window against `T_STALE` |
| SC-6 | `/internal/shells/reap` returns non-2xx, reports `surviving` above zero, or ends nothing for a run `/internal/shells/active` had just counted above zero | OBS-7, at G5's cleanup step |
| SC-7 | The enablement disappeared without anyone changing it | G1 re-run |

**SC-1's reading.** `claw_bash_foreground_timeout_total` is incremented where the
timeout happens: the sandbox marks a foreground command it stopped at its granted
second, Brain counts it on the way back, and the `clamped` label separates a
command that asked past the ceiling and met it — the regression a tightened
ceiling produces — from one that simply ran out of its own timeout.

```sh
# Summed over every replica, by pod IP. The counter is process-local, so a
# baseline read that landed on one replica and a soak read that landed on
# another are two different populations -- and the fleet's own rollout,
# rescheduling or scale-out silently moves work between them.
timeouts() { local ip v total=0 seen=0
  for ip in $(brain_pods); do
    v=$(curl -sf --max-time "$T_CURL" "http://$ip:8100/metrics" \
        | rg '^claw_bash_foreground_timeout_total\{[^}]*clamped="true"' \
        | rg -o '[0-9.]+$') || { echo 'ABORT: a replica did not answer; a partial sum is not a reading' >&2; return 1; }
    total=$(( total + ${v%%.*} )); seen=$(( seen + 1 ))
  done
  [ "$seen" -gt 0 ] || { echo 'ABORT: no Brain replicas found' >&2; return 1; }
  printf '%s\n' "$total"; }
```

A replica that does not answer aborts the read rather than shrinking the sum:
the counters are per-process, so a missing replica is missing timeouts, which
reads as a quiet window.

Both label series are initialised at Brain startup, so a window in which nothing
timed out reads `0` rather than producing no line at all — an absent series and
a quiet window are the same text to a scraper, and only one of them is a
reading. An `ABORT` here therefore means the metric is genuinely unreachable.

A count of runs that ended in a killed state is **not** this signal and must not be
substituted for it: a clamped command is answered as a tool result and its run goes
on to complete normally, so the affected runs are indistinguishable from
unaffected ones in every terminal fact the platform exposes, and the count moves
for reasons that have nothing to do with the ceiling.

SC-6 is the severe one: the cooperative cleanup step is already broken and the
rollback falls through to R4/R5 only. Blocking even if nothing else is.

## 7. Rollback

Ordering is normative, and it is not free. The flip terminates nothing — it
stops new spawns in sandboxes created afterwards, signals no process, and does
not reach a sandbox already up — so R5 is mandatory, not cleanup. R5 must follow
R4: recycling sandboxes before the Brain restart lands means the replacements are
created by a Brain still holding the old value and boot enabled again. R2 comes
before R3 because after the flip an agent mid-turn can no longer clean up after
itself, and per-handle termination, if wanted, must happen there too:
`kill_shell` is the one path the flag removes, so it can never be the rollback
plan. What survives the flag going off is the reap route, the SIGTERM Hands
takes on shutdown, and sandbox reclamation — the last two are what carry the
guarantee, because the first needs a credential an operator may not hold.

**R1 — record what exists, before anything changes.**

```sh
raw=$(inventory) || { echo 'ABORT: census unreadable; a failed read is not an empty fleet'; exit 3; }
inventory_rows "$raw" > /tmp/claw-rollback-fleet.tsv    # may legitimately be empty
wc -l < /tmp/claw-rollback-fleet.tsv > /tmp/claw-rollback-count.txt
sed -n 1p /tmp/claw-rollback-count.txt
# the pre-rollback status of the runs R8 will judge, captured before anything is killed
: > /tmp/claw-rollback-runs.tsv
for run in $RUN_IDS; do
  st=$(run_status "$run") || { echo "ABORT: $run status unreadable; R8 would verify nothing for it"; exit 1; }
  printf '%s\t%s\n' "$run" "$st" >> /tmp/claw-rollback-runs.tsv
done
```

- Expected: a successful read, and a status recorded for every run.
  **An empty file is a valid result and R2–R5
  continue**: an empty fleet is the true answer on a low-traffic deployment or
  one already drained, and the flip and the Brain restart still have to happen. Piping `.sessions[]` through `jq -e` would exit
  non-zero on exactly that response and abort a rollback that has nothing wrong
  with it.
- The row order is `session_id`, `sandbox_name`, `namespace`, `hands_url`,
  `workload_id`, and every reader below parses with `IFS=$'\t' read`, so an
  empty field stays empty rather than shifting the next column into it.
  **Recording the namespace per row is what makes R5 complete**: a sandbox's
  namespace is chosen per request, so one deployment's sandboxes may span
  several and a sweep of one would leave the rest running.
- The first column is a session id for a session row and a graph root id for a
  handle row, so R5, R6 and R7 address sandboxes by `(sandbox_name, namespace)`.
  Only R7's per-owner count reads the first column, where a graph root **is** the
  owner.
- `$RUN_IDS` is the runs the operator knows — their own dispatches, and the roots
  the task API reports for them. No route lists non-terminal runs, so a run
  nobody enumerated is not fenced by R3 and R8's same-id check is the only thing
  that sees one come back.
- Fail: `ABORT` → the census could not be read, or read incompletely. Do not
  proceed on a partial fleet list; fix the read first. **No namespace-level
  teardown is offered or authorized here**: R5 has no allow-list and fails
  closed.

**R2 — reap known background work while the cooperative path still exists.
[needs TBD-7]** Best-effort by construction, and labelled so: the route is keyed
by run and nothing enumerates the runs holding background shells, so this sweeps
R1's sandboxes once per run the operator knows.

```sh
while IFS=$'\t' read -r sid name ns url wid; do
  tok=$(hands_token "$name" "$ns") \
    || { echo "$name SKIPPED_NO_TOKEN"; continue; }   # [needs TBD-7]
  for run in $RUN_IDS; do
    printf '%s %s\t' "$name" "$run"
    curl -sf -X POST --max-time "$T_CURL" "$(hands_base "$url")/internal/shells/reap" \
      -H "Authorization: Bearer $(scope_cred "$tok" "$sid" "$run")" -H 'content-type: application/json' \
      -d "{\"cause\":\"sandbox_replaced\",\"reclaim_op\":\"$RECLAIM_OP\"}" \
      | jq -c '{stopped, escalated, surviving}' || echo '{"error":"unreachable"}'
  done
done < /tmp/claw-rollback-fleet.tsv
```

- `scope_cred <token> <owner> <run>` mints the credential proving that one pair,
  under the token of the sandbox this row names, and both are fetched **inside**
  the loop: the scope comes from the credential and a body
  naming either field is refused, so a single credential hoisted out of the loop
  addresses one pair and silently fails on every other — which is why this step
  is `[needs TBD-7]`. `cause` is `sandbox_replaced`, from the closed vocabulary
  the route accepts; a value outside it is refused with the accepted set named.
  `$RECLAIM_OP` names this rollback, so every termination it causes is
  attributable afterwards.
- Expected: `surviving: 0` on every line. `{"stopped":0,"escalated":0,
  "surviving":0}` for a run that started nothing is normal and not an error.
- Fail: `surviving` above zero, or a non-2xx → **SC-6**, and the cooperative path
  is already broken. Record it and continue; R2 is never a gate, and R5 closes
  what it could not.
- Without the credential R2 is skipped entirely — a loss of graceful wind-down,
  not of correctness.

**R3 — turn the flag off through the persistence path.** The fence runs first,
and it is not optional: the Brain restart R3 carries aborts every live run and
each one requeues itself, so rolling Brain over live work re-runs it on the next
replica. A cancelled row is terminal, and a redelivery that finds one is
terminated rather than re-run, which is what makes this not a re-execution.

```sh
while IFS=$'\t' read -r run was; do
  case "$was" in completed|failed|cancelled) continue ;; esac
  curl -sf -X POST --max-time "$T_CURL" -H "$USER" "https://$API_HOST/v1/tasks/$run/cancel" >/dev/null \
    || { echo "ABORT: $run would not cancel; rolling Brain now would re-run it"; exit 1; }
done < /tmp/claw-rollback-runs.tsv
for i in $(seq 1 "$N_POLL"); do
  live=0
  # not a pipeline, so `live` survives the loop and a failed read exits here
  while IFS=$'\t' read -r run was; do
    st=$(run_status "$run") || { echo "ABORT: $run status unreadable; the fence has no verdict"; exit 1; }
    case "$st" in completed|failed|cancelled) ;; *) live=$((live + 1)) ;; esac
  done < /tmp/claw-rollback-runs.tsv
  [ "$live" = 0 ] && break
  sleep "$I_POLL"
done
[ "$live" = 0 ] || { echo "ABORT: $live run(s) still live; R3 does not proceed"; exit 1; }
f=claw/deploy/values.$NS.env
rg -q '^BG_SHELL_ENABLED=' "$f" || printf 'BG_SHELL_ENABLED=\n' >> "$f"
sed -i 's|^BG_SHELL_ENABLED=.*$|BG_SHELL_ENABLED="false"|' "$f"
rg -c '^BG_SHELL_ENABLED="false"$' "$f"   # must print 1; P4 then reads "false"
```

- Then run the deployment's usual upgrade entrypoint, and expect
  `kubectl rollout status deployment/primus-claw-brain -n "$NS"` to report the
  rollout finished.
- Write `"false"`, not empty. Empty means "no opinion" and renders the same
  result today, but it stops being a record of a decision.
- Revert `BASH_MAX_TIMEOUT_SEC` only if PRE-4 pinned it *for* the enablement. R3
  turns the flag off and does not clear the pin.
- Fail: any `ABORT` above → **do not run the upgrade**. A run that will not
  cancel is one this rollback would re-execute.
- Fail: the rollout stalls → flag state is now mixed across replicas, the one
  point where the fleet is genuinely inconsistent. Complete or reverse it first.
- **This step terminates nothing.** The fence ends the runs, not their shells,
  which is R5's job.

**R4 — confirm every Brain replica has the new value.** Re-run G2, then G1.
Expected: one line, `"bgShellEnabled":false`, with `bashForegroundMaxSec` back at
P3's `F_OFF` — or still the pinned number, with G1's `BASH_MAX_TIMEOUT_SEC` line
showing that same value.

- Fail: any pod still `true` → it did not restart, and the constants are read at
  module load. **Do not proceed to R5**: the replacements would be built by a
  Brain still forwarding `true`.
- Fail: pinned but now empty → the R3 edit dropped it from the values file.
  Restore it first; R5's replacements boot with whatever Brain forwards then.

**R5 — close the mixed window: recycle the sandboxes from R1.** Only after R4 is
green, and in order of preference.

1. **Fast path, for sessions the operator's own credential created.** Deleting
   the session tears the sandbox down through Brain, needs no sandbox
   credential, and is **creator-only with no administrative bypass** — and it is
   asynchronous, so a 200 means *accepted*, not *terminated*. The record leaving
   the census is the completion signal, and a handle row's first column names no
   session, so its delete answers 404 and it is option 2's to end.
2. **Infra-layer termination — the guaranteed path in Kubernetes mode.** By the
   **name and namespace R1 recorded**, never by a label selector and never by pod
   label.

   ```sh
   n=$(sed -n 1p /tmp/claw-rollback-count.txt) && [ -n "$n" ] \
     || { echo 'ABORT: R1 recorded no census, so no allow-list exists and no namespace-wide teardown is authorized here. Escalate to the cluster owner'; exit 1; }
   [ "$n" = 0 ] && { echo 'R5 complete: the census read an empty fleet, so there is nothing to terminate'; exit 0; }
   for ns in $(sed -E 's/^[^\t]*\t[^\t]*\t([^\t]*)\t.*/\1/' /tmp/claw-rollback-fleet.tsv | sort -u); do
     for r in sandboxes.agents.x-k8s.io sandboxclaims.extensions.agents.x-k8s.io pods; do
       kubectl auth can-i delete "$r" -n "$ns" --quiet \
         || { echo "ABORT: this credential cannot delete $r in $ns"; exit 1; }
     done
   done
   fail=0
   while IFS=$'\t' read -r sid name ns url wid; do
     # A NotFound get or delete is success: a sandbox reclaimed between R1 and
     # here is already closed, and its claim, which carries the same name, still
     # has to go.
     pod=$(kubectl get sandbox -n "$ns" "$name" --ignore-not-found \
       -o jsonpath='{.metadata.annotations.agents\.x-k8s\.io/pod-name}') || { fail=1; continue; }
     [ -n "$pod" ] && { kubectl delete pod -n "$ns" "$pod" --ignore-not-found --grace-period=30 --wait=true || fail=1; }
     kubectl delete sandboxclaim -n "$ns" "$name" --ignore-not-found --wait=true || fail=1
     kubectl delete sandbox -n "$ns" "$name" --ignore-not-found --grace-period=30 --wait=true || fail=1
   done < /tmp/claw-rollback-fleet.tsv
   [ "$fail" -eq 0 ] || { echo 'ABORT: at least one deletion failed'; exit 1; }
   ```

   Both preflights are mandatory, in that order. A **missing or unreadable**
   count is a stop and an escalation, never a wider selector: an inventory that
   was never recorded is not an allow-list. A count of `0` is the opposite
   reading — R1 read the fleet and it was empty — and R5 is complete without
   deleting anything, which is what lets an empty-fleet rollback reach R6 at all.
   Beyond that the file *is* the allow-list, so a name that was never inventoried
   is never passed to `kubectl delete`. Authority is checked **per namespace and
   per resource type**, because access is keyed on the pair and delete on pods
   grants nothing over either custom resource. The order — Pod, then claim, then
   Sandbox — is what the warm-pool path needs: the adopted pod is orphaned from
   its owner and survives a bare Sandbox delete, blocking pool replenishment,
   and its name comes from the Sandbox's annotation rather than being the
   Sandbox's own. `--grace-period=30` gives the sandbox's shutdown room,
   `--wait=true` the evidence, and `fail` carries any non-zero deletion past the
   loop.
3. Idle reclamation, by waiting the idle clock out. Slowest, and unavailable
   where there is no idle clock.

- **An `ABORT` from the authority check has no fallback**, and this guide says so
  rather than assuming the permission: option 1 reaches only the operator's own
  sessions and option 3 only waits. An operator who fails that check cannot
  execute R5 against sandboxes they did not create, and must obtain the delete
  verb or hand rollback to someone who holds it. **No SaFE branch appears here
  and none may be added** — the only stop request that exists takes a per-sandbox
  key no route returns, which is why PRE-7 stops a SaFE rollout before S1.
- Expected: the recorded sandboxes leaving the census, or every survivor
  reporting `bgShellEnabled: false` at R6. An empty file means
  nothing to recycle, which is not a failure — R6 still runs, and so does the
  rest of the rollback.
- Fail: a sandbox that will neither drain nor delete → escalate to process-level
  supervision on that node. No finer-grained tool is left.

**R6 — verify the window is closed.**

```sh
raw=$(inventory) || { echo 'ERROR: census unreadable - R6 can classify nothing'; exit 1; }
live=$(inventory_rows "$raw" | sed -E 's/^[^\t]*\t([^\t]*\t[^\t]*)\t.*/\1/')
: > /tmp/claw-rollback-gone.tsv          # the survivor filter R7 reads
while IFS=$'\t' read -r sid name ns url wid; do
  printf '%s\t' "$name"
  if ! printf '%s\n' "$live" | rg -qxF -- "$name"$'\t'"$ns"; then
    echo '{"gone":true}'; printf '%s\t%s\n' "$name" "$ns" >> /tmp/claw-rollback-gone.tsv
  elif body=$(probe "$url"); then
    printf '%s\n' "$body" | jq -c '{bgShellEnabled, bashMaxTimeoutSec}'
  else
    echo '{"error":"unreachable"}'       # still listed, no answer: retry or escalate
  fi
done < /tmp/claw-rollback-fleet.tsv
```

- `gone` comes from the census's own inventory, never from a failed request to
  the sandbox: a stale URL, a name that does not resolve and a timeout are
  indistinguishable and prove nothing, so each is `error`.
- Expected: every line `{"gone":true}` or `{"bgShellEnabled":false, …}`.
- Fail: any surviving `true` → R5 is incomplete for that sandbox. Any
  `{"error":…}`, or the `ERROR` exit → R6 verified nothing there; retry, then
  escalate to R5 option 2 rather than assume.

**R7 — confirm no background work is still running. [needs TBD-7]** Over every
sandbox R1 recorded that R6 did not prove gone.

```sh
while IFS=$'\t' read -r sid name ns url wid; do
  rg -qxF -- "$name"$'\t'"$ns" /tmp/claw-rollback-gone.tsv && continue   # R6 proved it gone
  tok=$(hands_token "$name" "$ns") \
    || { echo "$name SKIPPED_NO_TOKEN"; continue; }   # [needs TBD-7]
  for owner in "$sid" $DAG_ROOT_IDS; do
    printf '%s %s\t' "$name" "$owner"
    curl -sf -X POST --max-time "$T_CURL" "$(hands_base "$url")/internal/shells/active" \
      -H "Authorization: Bearer $(scope_cred "$tok" "$owner" "")" -H 'content-type: application/json' -d '{}' \
      | jq -r '.running' || echo NO_ANSWER
  done
done < /tmp/claw-rollback-fleet.tsv
```

- The owner is proved by the credential, so each owner in the loop mints its own
  through `scope_cred`, under this row's own sandbox token — the session id for an ordinary run, the graph root for a
  node of one. `$sid` alone misses the second, and one credential reused across
  the loop addresses only the owner it was minted for. Shells started with no owner sit in a bucket of
  their own, so a `0` here is a negative result about one owner and not about the
  sandbox.
- Expected: `0`.
- Fail: above zero → pre-rollback work is still alive in a sandbox no tool can
  ask to stop. Return to R2 for that run, or R5 option 2 for that sandbox.
- Without the credential R7 is not executable, and the fallback is R5 option 2
  for every surviving sandbox: the work is terminated without being counted.

**R8 — interrupted work is neither reported successful nor re-run.** Rollback
kills processes mid-flight, so the last thing to verify is that nothing
downstream was told the work finished, and that nothing put it back. Each run is
judged against what R1 recorded it as, because the runs are not one population:
a background shell is meant to outlive the turn that started it, so the
principal cross-turn case reaches rollback with its creating task already
`completed`, and that record is correct and immutable.

| R1 status | What rollback must show | Why |
|---|---|---|
| non-terminal | ends `failed` or `cancelled`, never `completed` | its shells were killed under it, so a `completed` here is work reported successful that was not |
| already terminal | **unchanged** from the recorded value | the record describes the turn, which did finish; a status that moved afterwards is a fault in its own right |

```sh
while IFS=$'\t' read -r run was; do
  now=$(run_status "$run") || { echo "ABORT: $run status unreadable; R8 verified nothing for it"; exit 1; }
  case "$was" in
    completed|failed|cancelled) [ "$now" = "$was" ] || echo "MOVED $run $was -> $now" ;;
    *) printf '%s' "$now" | rg -qx 'failed|cancelled' || echo "BAD $run $was -> $now" ;;
  esac
done < /tmp/claw-rollback-runs.tsv
for run in $RUN_IDS; do
  printf '%s\t' "$run"
  curl -sf --max-time "$T_CURL" -H "$USER" "https://$API_HOST/v1/tasks/$run" \
    | jq -r '.item.metadata.retried_into // "none"' || echo NO_ANSWER
done
sleep "$T_LEASE_GRACE"          # the lease has to have been given up before the re-read means anything
while IFS=$'\t' read -r run was; do
  now=$(run_status "$run") || { echo "ABORT: $run status unreadable on the re-read"; exit 1; }
  printf '%s' "$now" | rg -qx 'completed|failed|cancelled' || echo "BACK $run $now"
done < /tmp/claw-rollback-runs.tsv
```

- Expected: no output from the first loop, `none` for every run in the second,
  and no `BACK` line from the third.
- Fail: a `BAD` line → a run that was still live when its shells were reaped did
  not end `failed`/`cancelled`, and every consumer downstream has been told it
  finished. A `MOVED` line → a terminal record was rewritten after the fact.
  Either **blocks rollback sign-off**. An unreadable status reaches the
  comparison as an `ABORT` rather than passing quietly.
- Fail: a task id from the second loop → the work was re-submitted under a new
  id, which names a person or a caller. Stop before re-enabling.
- Fail: a `BACK` line → the automatic path: a lost lease returns a row to the
  queue **keeping its task id**, and R3's Brain restart is precisely what loses
  that lease. Cancel each one explicitly and re-read before signing off.
- **A killed background process leaves no record of its own.** For an
  already-terminal run nothing observable says whether its shell ran to
  completion or was killed by R5: the shell's outcome was never part of the task
  record, and the events that would say are Hands-side and unreadable. R8
  therefore verifies the guarantee **over the run record** — nothing newly marked
  successful, nothing re-run — and the process's own fate stays unrepresented. A
  step claiming to check it would be verifying nothing.

## 8. What this guide does not cover

- SaFE-mode deployments: neither the reap route nor the sandbox recycle has an
  operator-usable driver there, so R5 has nothing to run. Enablement under SaFE is
  refused rather than deferred.
- Script-mode steps bypass Brain's pre-dispatch gate: a script step naming
  `wait`, `bash_output`, `kill_shell` or `bash{run_in_background:true}` never
  reaches the switch. Hands' own per-tool refusal still applies, and the ceiling
  is enforced on that path exactly as on the router path.
