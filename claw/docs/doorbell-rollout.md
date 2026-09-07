<!--
Copyright Advanced Micro Devices, Inc.
SPDX-License-Identifier: MIT
-->

# Doorbell dispatch rollout

How to turn on Doorbell chat dispatch and cluster-wide admission one value at a
time, what to watch at each step, and how to get back to the shipped defaults.

## What this document is

A procedure for two chart values and the eight ceilings beside them:
`features.runDoorbellDispatch`, which decides whether a chat turn is published
as a doorbell or as a full execute request, and `api.admitSoftRuns`,
`api.admitHardRuns`, `api.admitSoftSandboxes`, `api.admitHardSandboxes`,
`api.admitSoftGpuNodes`, `api.admitHardGpuNodes`, `api.admitTreeMaxNodes` and
`api.admitTreeMaxDepth`, each of which enforces one admission dimension and
each of which ships as `"0"`, meaning "not enforced".

A third value, `features.brainDoorbellExecution`, is the Brain-side
kill-switch. It ships **on**, it is not part of any stage below, and rolling
Doorbell back does not touch it -- see *Rollback*.

Every gate below is a PromQL expression you can paste into a query window. Each
is written to answer `1` when it passes and `0` when it fails, including when
nothing is reporting -- see *Why the expressions look like this*.

## What this document is not

- **Not a source of numbers.** Every threshold here is written as a shape with
  a `$name` you substitute. The ceilings themselves are capacity data and this
  repository does not carry them.
- **Not a soak schedule.** No SLO or burn-rate artefact exists in this tree to
  anchor a duration against, so each stage states its criterion -- one full
  peak cycle and at least one Brain rolling restart -- and leaves the number to
  you.
- **Not a dashboard.** The gates are queries, not panels; inventing panels
  means inventing thresholds.

## Preconditions

1. Every API and Brain replica runs an image that understands the doorbell
   protocol and the reconciled unclaim/fail-claim reason vocabulary, and the
   fleet's floor has been asserted:

   ```
   POST /v1/internal/brain/doorbell-semantics   {"semantics": <version>}
   ```

   An API publishes a doorbell only while `features.runDoorbellDispatch` is
   true **and** it has observed a floor at least as high as the semantics
   version it implements. Every other state -- no assertion yet, a revoked
   one, an unparseable one, a lost watch -- resolves to fat dispatch, which is
   slower and never incorrect, so a stage that never starts is the failure
   mode rather than a mixed fleet being handed a message it cannot read. The
   API refuses an assertion above its own version.
2. No legacy `preparing` rows are outstanding from a previous attempt.
   Reconciling them is gated on `RUN_FAT_PREPARING_RECONCILE`, the API's
   assertion that every Brain able to receive a task takes a durable holder
   before it executes; it ships off and is read from the API process
   environment, not from a chart value. Turning it on before every replica on
   both sides is new lets a reaper close a delivery that is about to run.
3. Prometheus reaches the API `/metrics` endpoint of every replica, and P1
   below passes.
4. Every run-creating path is routed through admission, so a ceiling means what
   it says. All four origins reach `decideAdmission`: `chat` from the session
   create, `a2a` from both send paths, and `dag_node` and `task` from the DAG
   expander.

## Applying a value

Every stage below changes chart values and nothing else. Two paths deliver
them, and both restart the API pods, which is required: every one of these
values reaches a pod as an environment variable, read once at startup.

`features.runDoorbellDispatch` and `features.brainDoorbellExecution` render the
**same** environment variable, `RUN_DOORBELL_DISPATCH`, once per deployment
from its own value. The eight ceilings reach the API through the shared
Secret.

- **Through the deploy scripts.** The durable record is
  `claw/deploy/values.<namespace>.env`; a key left empty there means "use the
  chart default". `deploy/upgrade.sh` re-renders from that file alone, so a
  value staged only on a `helm` command line is reverted by the next ordinary
  upgrade -- mid-stage, and with no error.
- **Through Helm directly.** `helm upgrade` with the value in your own values
  file, or `--set-string api.admitSoftRuns=<n>` and
  `--set features.runDoorbellDispatch=true`.

The chart refuses two combinations at render time, before anything is applied:
a soft ceiling above its own hard ceiling, and any non-zero ceiling while
`features.runDoorbellDispatch` is not true. The second is the rollback ordering
rule, enforced at the point the mistake is made.

## The two selector variants

The two documented scrape modes attribute a sample to a deployment
differently, so every gate exists in two forms that differ only in the
selector:

```promql
# A -- ServiceMonitor mode (serviceMonitor.enabled=true)
{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}
# B -- annotation mode (prometheus.io/scrape, plain Prometheus)
{namespace="$ns", service="claw-api"}
```

Every gate below is written with **A**. Substituting **B** verbatim gives the
annotation-mode form; `$N` means the same in both, `count()` counting one
series per replica. `claw/deploy/promql/rollout-gates.test.yaml` evaluates both
forms of every gate against the PromQL engine.

`pod` is written by the scrape and never by the application, and only the
Prometheus Operator adds it. **B** therefore keys on `service="claw-api"`, the
label the application sets itself and a ServiceMonitor overwrites with the
Service name -- which is why **A** matches both spellings.

**B is scoped to one release per namespace.** Nothing in annotation mode
identifies a release, so **B** discriminates only to "an API replica in this
namespace". Running more than one release of this chart in one namespace under
annotation-only scraping makes these gates unusable -- every expression would
aggregate both releases and `$N` their combined count. Enable the
ServiceMonitor and use **A**.

## Notation

| Symbol | Meaning |
|---|---|
| `$ns` | The release namespace |
| `$N` | The expected API replica count |
| `$w` | The evaluation window, one per soak sample |
| `$k_windows` | How many consecutive `$w` evaluations a share gate must fail before the stage aborts |
| `$intended` | A regex of the dimension names enabled so far |
| `$intended_reason` | A regex of the reject reasons the enabled dimensions produce |
| `$k` | The number of dimensions enabled so far |
| `$dQ` | The change in `Q(chat)` across the window |
| `Q(chat)` | Not PromQL. The waiting backlog, read directly with the query below |

`Q(chat)` is:

```sql
SELECT COUNT(*) FROM claw_tasks WHERE origin='chat' AND status='queued'
  AND metadata->>'dispatch'='doorbell';
```

Thresholds you record **before** the stage begins, as ratios and window counts:
`$err_max`, `$skip_max`, `$stuck_max`, `$race_max`, `$claim_min`,
`$byid_fail_max`, `$wait_max`, `$requeue_max`, `$exhaust_max`, `$k_windows`.
Substitute your own; none is a capacity figure.

### Why the expressions look like this

Three PromQL properties decide the shape of every gate, and each of them fails
silently:

- A bare comparison **filters** rather than answering, so every gate ends in a
  `bool` comparison and yields one sample: `1` for pass, `0` for fail.
- `sum` and `count` over an empty vector return **empty**, not `0`, so every
  query closes with `or vector(0)`.
- `min` and `max` cannot see a replica that is not reporting, so fleet
  completeness is its own gate and is read first.

**Rates, not single increments.** A gate over a fault that legitimately happens
once must not fail on that occurrence, or every healthy soak aborts. Those
gates are share-of-traffic comparisons against a recorded ceiling and fail the
stage only when they fail at **all** of `$k_windows` consecutive evaluations.
Only gates whose single occurrence *is* the correctness failure stay at zero
tolerance, and each says so.

## P1 -- precheck, before any flip

**The API metrics surface is live**

```promql
(count({__name__=~"claw_api_.*", namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) or vector(0)) > bool 0
```

**Every expected replica is up, with all eight dimension series**

```promql
(count(claw_api_doorbell_dispatch_enabled{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) or vector(0)) == bool $N
```

```promql
(count(claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) or vector(0)) == bool (8 * $N)
```

**Every replica agrees on the Doorbell switch -- one of these two**

```promql
(sum(claw_api_doorbell_dispatch_enabled{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"} == bool 0) or vector(0)) == bool $N
```

```promql
(sum(claw_api_doorbell_dispatch_enabled{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"} == bool 1) or vector(0)) == bool $N
```

**No replica disagrees, and admission is off everywhere**

```promql
(sum(min by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) != bool max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

**A dispatch baseline exists**

```promql
(sum(rate(claw_api_admission_decision_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) > bool 0
```

This proves the decision counter is on the live path rather than merely
registered. With all ceilings zero the early admit is the only path admission
takes, so a counter that skipped it would read zero here and be
indistinguishable from a broken build.

## Common gates (C)

Every stage from 0 onward requires all of these, and a later stage inherits
exactly this set -- never another stage's stage-specific rows. Where a later
stage deliberately permits what C forbids it says so, and the exception is
named in C.

**Fleet complete**

```promql
(count(claw_api_doorbell_dispatch_enabled{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) or vector(0)) == bool $N
```

```promql
(count(claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) or vector(0)) == bool (8 * $N)
```

**Flip propagated**

```promql
(sum(claw_api_doorbell_dispatch_enabled{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"} == bool 1) or vector(0)) == bool $N
```

**Admission errors are a negligible share**

```promql
(((sum(increase(claw_api_admission_decision_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", decision="error"}[$w])) or vector(0))) / clamp_min((sum(increase(claw_api_admission_decision_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)), 1)) < bool $err_max
```

Sustained over `$k_windows`.

**Dispatch failure share**

```promql
((((sum(increase(claw_api_run_dispatch_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", outcome="open_failed"}[$w])) or vector(0)) + (sum(increase(claw_api_run_dispatch_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", outcome="error"}[$w])) or vector(0)))) / clamp_min((sum(increase(claw_api_run_dispatch_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)), 1)) < bool $err_max
```

Sustained over `$k_windows`. The denominator carries no `outcome` matcher, so
it is `dispatched + queued + rejected + open_failed + error`: a hand-off outage
raises the numerator against a denominator that does not move, instead of
shrinking both.

**By-id claims are happening at all**

```promql
(sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="by_id"}[$w])) or vector(0)) > bool 0
```

Zero tolerance and **no denominator**. With Doorbell on, an absence of by-id
claim traffic means the wakeup path is not running, and every ratio over that
mode is vacuously satisfied.

**Claims are succeeding**

```promql
((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="by_id", outcome="claimed"}[$w])) or vector(0)) / clamp_min((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="by_id"}[$w])) or vector(0)), 1)) >= bool $claim_min
```

`$claim_min` is **strictly positive** and comes from the Stage 0 canary below,
never from a pre-flip window. The denominator is **all** `by_id` outcomes
including `error`, so a throwing claim path is a falling ratio rather than
numerator and denominator shrinking together.

**Unsuccessful by-id outcomes are a bounded share**

```promql
((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="by_id", outcome=~"missing|busy|unclaimable"}[$w])) or vector(0)) / clamp_min((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="by_id"}[$w])) or vector(0)), 1)) < bool $byid_fail_max
```

The complement of the row above, bound directly rather than through a
threshold: `missing`, `busy` and `unclaimable` are the three ways a doorbell
wakeup finds nothing to take, and `$byid_fail_max` is strictly below `1`. Read
with the volume row, which is what keeps a window of no traffic from satisfying
it.

**Claim errors are a negligible share**

```promql
((((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", outcome="error"}[$w])) or vector(0))) + ((sum(increase(claw_api_run_claim_skipped_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", cause="error"}[$w])) or vector(0)))) / clamp_min((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)), 1)) < bool $err_max
```

Sustained over `$k_windows`.

**Candidates are not persistently untakeable**

```promql
((((sum(increase(claw_api_run_claim_skipped_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", cause="unclaimable"}[$w])) or vector(0)) + (sum(increase(claw_api_run_claim_skipped_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", cause="exhausted"}[$w])) or vector(0)))) / clamp_min((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="next"}[$w])) or vector(0)), 1)) < bool $skip_max
```

Sustained over `$k_windows`. A single `unclaimable` or `exhausted` skip is an
ordinary transient. The raced cause is excluded entirely: a row another pod won
a microsecond earlier is normal concurrent progress.

**The backlog is not stuck**

```promql
((((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="next", outcome="all_skipped"}[$w])) or vector(0)) + (sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="next", outcome="retry_limit"}[$w])) or vector(0)))) / clamp_min((sum(increase(claw_api_run_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", mode="next"}[$w])) or vector(0)), 1)) < bool $stuck_max
```

**Or** `Q(chat)` falling, at each of `$k_windows` evaluations. Neither term
alone is a fault -- `all_skipped` with a falling `Q` is the queue draining
under contention -- and only both, sustained, is a stall.

**No run is executing despite a refusal**

```promql
(sum(increase(claw_api_run_dispatch_held_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) == bool 0
```

Zero tolerance: one increment is one run that executed after being refused or
after its publish failed.

**No queue timeouts**

```promql
(sum(increase(claw_api_run_queue_timeout_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) == bool 0
```

Zero tolerance: a timeout is a lost turn.

**Requeue is quiet**

```promql
(sum(increase(claw_api_doorbell_lease_requeued_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) <= bool $requeue_max
```

`$requeue_max` is the pre-flip baseline.

**Requeue and terminal close are not failing**

```promql
(((sum(increase(claw_api_run_unclaim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", outcome="error"}[$w])) or vector(0)) + (sum(increase(claw_api_run_fail_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", outcome="error"}[$w])) or vector(0))) / clamp_min((sum(increase(claw_api_run_unclaim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) + (sum(increase(claw_api_run_fail_claim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)), 1)) < bool $err_max
```

Sustained over `$k_windows`. A throw out of the unclaim or fail-claim path is a
lease still held by a holder that gave up, and no other gate sees it.

**No version skew**

```promql
(sum(increase(claw_api_run_unclaim_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", reason="unspecified"}[$w])) or vector(0)) == bool 0
```

Zero tolerance: any occurrence means the reconciled reason vocabulary is not
deployed on both sides.

**Exhaustion is not rising**

```promql
(sum(increase(claw_api_run_claim_exhausted_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) <= bool $exhaust_max
```

`$exhaust_max` is the pre-flip baseline.

**C-soft -- no refusals at all**

```promql
(sum(increase(claw_api_admission_rejected_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) == bool 0
```

**The one exception in C:** the hard sub-stages of Stage 2, Stage 3 and Stage
3T replace this row with their own, because refusing over a ceiling is what
those stages exist to observe.

Read `F` and `S` **before** any other gate: agreement and "nothing enabled" are
both satisfied by an empty fleet, and `A` is believed before `E($k)` is.

## Stage 0 -- Doorbell on, all eight ceilings zero

Set `features.runDoorbellDispatch: true`, leave every ceiling at `"0"`, apply,
and wait for the rollout. Then C, plus:

**No replica disagrees, and nothing is enabled**

```promql
(sum(min by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) != bool max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

**The by-id canary fixes `$claim_min`.** Issue a bounded set of chat turns
after the flip, each of which must be claimed. `$claim_min` is that window's
own `claimed / all by_id` ratio less your margin, and Stage 0's soak does not
begin until it is recorded **greater than zero**. Record `$byid_fail_max` from
the same window.

**Why `$claim_min` cannot be a pre-flip baseline.** The by-id route is reached
only by the Brain's doorbell intake, so with Doorbell off no by-id claim
happens at all: numerator and denominator are both zero pre-flip,
`clamp_min(..., 1)` turns the ratio into `0`, and a `$claim_min` read from it is
`0`. `>= bool 0` is then satisfied by every possible post-flip reading -- by no
claims at all, and by a window that is 100% `missing` / `busy` / `unclaimable`,
which is exactly the doorbell-wakeup failure Stage 0 exists to catch. The
volume row supplies the positive denominator the ratio needs, the canary
supplies a threshold a real reading can fall below, and the unsuccessful-share
row bounds the failure directly.

**Advance when** every gate has held continuously for one full peak cycle
including at least one Brain rolling restart.

## Stage 1 -- one soft ceiling non-zero

Set one `api.admitSoft*` to a non-zero value. C, including C-soft, plus:

**Enforcement propagated**

```promql
(sum(min by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) != bool max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 1
```

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", dimension!~"$intended"})) or vector(0)) == bool 0
```

`$intended` is the one dimension turned on.

**Queuing is happening at all**

```promql
(sum(increase(claw_api_run_queue_entered_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", cause="admission"}[$w])) or vector(0)) > bool 0
```

Otherwise the ceiling is above real usage and the stage tested nothing. On the
entry counter rather than the queue *decision*: only the former means a row was
durably written and survived the post-insert veto.

**The queue accounts for itself**

```promql
(sum(increase(claw_api_run_queue_entered_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) == bool ((sum(increase(claw_api_run_queue_exited_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) + $dQ)
```

Every arrival at `queued` is an entry and every terminal writer an exit, so a
cancellation, a duplicate cleanup and a lost lease coming back are terms rather
than leaks.

**The queue is actually draining**

```promql
(sum(increase(claw_api_run_queue_exited_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", outcome="claimed"}[$w])) or vector(0)) > bool 0
```

And `Q(chat)` not ending above where it started.

**Waits are bounded**

```promql
(histogram_quantile(0.99, sum by (le) (rate(claw_api_run_queue_wait_seconds_bucket{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", outcome="claimed"}[$w]))) < bool $wait_max) or vector(0)
```

`$wait_max` well below `RUN_QUEUE_MAX_SEC`. The `or vector(0)` sits outside the
comparison deliberately: with no bucket samples `histogram_quantile` yields an
empty vector and the comparison yields nothing, so the fallback has to supply
the **failing** value rather than a passing quantile.

**Nothing times out**

```promql
(sum(increase(claw_api_run_queue_timeout_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)) == bool 0
```

## Stage 2 -- add the hard ceiling on the same dimension

C **without C-soft**, plus Stage 1's rows **except its Enforcement-propagated
row**, whose enabled-dimension count of `1` the row below replaces, plus:

**Enforcement propagated**

```promql
(sum(min by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) != bool max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 2
```

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", dimension!~"$intended"})) or vector(0)) == bool 0
```

`$intended` is the intended dimension pair.

**Rejections, if any, are the intended reason**

```promql
(sum(increase(claw_api_admission_rejected_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", reason!~"$intended_reason"}[$w])) or vector(0)) == bool 0
```

`$intended_reason` is the reason the enabled dimension produces. This row
stands in for C-soft.

**Races are not the dominant refusal path**

```promql
((sum(increase(claw_api_admission_rejected_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", stage="post_insert"}[$w])) or vector(0)) / clamp_min((sum(increase(claw_api_admission_rejected_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}[$w])) or vector(0)), 1)) < bool $race_max
```

A rising `post_insert` share means creates are colliding on the last slot.

**Refusals do not produce runs**

```promql
(sum(increase(claw_api_run_dispatch_held_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", cause="hard_limit_exceeded"}[$w])) or vector(0)) == bool 0
```

## Stage 3 -- the remaining paired dimensions, one at a time

Sandboxes first, then GPU nodes; a soft sub-stage then a hard sub-stage for
each. **Every sub-stage, soft and hard alike, carries the same rows:**

| Inherited from | Rows | Note |
|---|---|---|
| C | all of it | the hard sub-stages drop C-soft, as Stage 2 does |
| Stage 1 | Queuing is happening at all; The queue accounts for itself; The queue is actually draining; Waits are bounded; Nothing times out | verbatim, **including on the hard sub-stages** |
| Stage 2 | Rejections are the intended reason; Races are not the dominant refusal path; Refusals do not produce runs | verbatim, on the soft sub-stages too |
| neither | the three propagation rows below | these **replace** Stage 1's and Stage 2's propagation rows |

**Why a hard sub-stage still carries Stage 1's queue rows.** A hard ceiling
does not remove the soft one. A create that is above the soft ceiling and below
the hard one is still answered `queue`, so the whole queue path stays live
under a hard sub-stage: its accounting can leak, its waits can run away and its
drain can stop while every rejection, race and held gate reads `1`. A hard
sub-stage carrying only refusal rows passes through exactly that regression.

**Why the propagation rows are replaced rather than inherited.** Stage 1 fixes
the enabled-dimension count at `1` and Stage 2 at `2`; every Stage 3 sub-stage
has at least three enabled, so inheriting either predicate would make the stage
unpassable -- the two cannot hold at once.

`$k` and `$intended` are **cumulative**: every dimension enabled so far, not
the one this sub-stage turned on, since `dimension!~"$intended"` must not fire
on an earlier stage's ceiling.

| Sub-stage | `$k` | `$intended` |
|---|---|---|
| 3-sandbox soft | 3 | `soft_runs\|hard_runs\|soft_sandboxes` |
| 3-sandbox hard | 4 | the above plus `hard_sandboxes` |
| 3-gpu soft | 5 | the above plus `soft_gpu_nodes` |
| 3-gpu hard | 6 | the above plus `hard_gpu_nodes` |

**No replica disagrees**

```promql
(sum(min by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) != bool max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

**Exactly the intended dimensions are enabled**

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool $k
```

**Nothing unintended is enabled**

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", dimension!~"$intended"})) or vector(0)) == bool 0
```

## Stage 3T -- the two tree ceilings

Not a soft/hard pair: a tree cap is consulted before any usage is loaded and
refuses outright, with no queue arm and no post-insert half. Each is one
single-step stage, run after Stage 3, one dimension at a time.

| | Stage 3T-nodes | Stage 3T-depth |
|---|---|---|
| Value changed | `api.admitTreeMaxNodes` `"0"` -> `k` | `api.admitTreeMaxDepth` `"0"` -> `d` |
| Boundary workload | a real DAG create expanding to exactly `k` nodes, then one to `k + 1` | a real DAG create of depth exactly `d`, then one of depth `d + 1` |
| Expected result | the first admits; the second is refused | the first admits; the second is refused |
| Rollback step | set `api.admitTreeMaxNodes` back to `"0"` | set `api.admitTreeMaxDepth` back to `"0"` |

Every C gate applies unchanged except C-soft, which the positive-rejection gate
below replaces because a tree cap refuses and never queues. The propagation
rows are Stage 3's three, with `$k` one higher than before the stage and
`$intended` cumulative.

**Stage 3T-nodes: the boundary create was refused, and only for that reason**

```promql
(sum(increase(claw_api_admission_rejected_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", stage="pre_insert", reason="tree_nodes_exceeded"}[$w])) or vector(0)) > bool 0
```

```promql
(sum(increase(claw_api_admission_rejected_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", reason!="tree_nodes_exceeded"}[$w])) or vector(0)) == bool 0
```

**Stage 3T-depth: the boundary create was refused, and only for that reason**

```promql
(sum(increase(claw_api_admission_rejected_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", stage="pre_insert", reason="tree_depth_exceeded"}[$w])) or vector(0)) > bool 0
```

```promql
(sum(increase(claw_api_admission_rejected_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", reason!="tree_depth_exceeded"}[$w])) or vector(0)) == bool 0
```

**The positive rejection is the gate, not a formality.** A ceiling that admits
everything looks exactly like a ceiling real traffic never approaches, and only
the `k + 1` create incrementing the counter tells the two apart. The dimensions
are produced on every ask -- `sessionTreeShape` for `chat` and `a2a`, `dagShape`
for the expander -- so a stage that reports no rejection has found a gap in that
production, not a quiet fleet.

## Stop conditions

Abort and roll back at any stage the moment any of these fires. Each is the
failure of a gate above.

| Condition | Why it is fatal |
|---|---|
| The held gate returns `0` | A run executed after its create was refused or its publish failed. The correctness failure the whole feature exists to avoid. |
| The dispatch failure share or the admission error share returns `0` | Creates are failing or throwing out of the hand-off, or admission's own usage queries are. |
| `F` returns `0` for longer than one rollout | A replica is not reporting. Under the ordering rule below that is what a wrong-order config looks like from outside: the pod exits before `/metrics` is ever bound. |
| Both `D0` and `D1` return `0` for longer than one rollout | A stuck replica, so the fleet is split over whether a chat turn is published as a doorbell. Revoking the capability floor closes every publisher's gate without waiting for that pod. |
| The version-skew gate returns `0` | API and Brain disagree about the reason vocabulary. |
| The by-id volume gate returns `0`, or the claim-share or unsuccessful-share gate returns `0` | The doorbell wakeup path is not running, or it is running and taking nothing. |
| The claim-error, skip or backlog share returns `0` -- each sustained over `$k_windows`, the backlog one only while `Q(chat)` does not fall | The claim path is throwing, candidates are being terminalized rather than taken, or a backlog nobody can take is persisting. Never one increment. |
| The wait-bound gate returns `0` | Timeouts are imminent; abort before they start. |
| The requeue/terminal-close error share returns `0`, sustained over `$k_windows` | A NAK'd run is not going back on the queue and an abandoned one is not being closed, so the row stays `running` under a holder that gave up until its lease lapses. |
| The intended-reason gate or `U` returns `0` | Something set a ceiling nobody asked for. |

Three are worth writing out, because none of them is a gate a stage reads
every window:

**Runs are waiting out the queue without ever getting a worker**

```promql
(sum(increase(claw_api_run_queue_timeout_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", ever_held="false"}[$w])) or vector(0)) > bool 0
```

Returning `1` here is the stop condition: the ceiling is starving the fleet.

**Runs are losing workers and not being re-claimed**

```promql
(sum(increase(claw_api_run_queue_timeout_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", ever_held="true"}[$w])) or vector(0)) > bool 0
```

Returning `1` here is the stop condition: requeue is not converging.

**Runs are being killed by queueing rather than by their own faults**

```promql
(sum(increase(claw_api_run_claim_exhausted_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", reason="lock_contention_exhausted"}[$w])) or vector(0)) > bool $exhaust_max
```

Returning `1`, sustained over `$k_windows`. A single exhaustion is not this.

## Rollback

### The rule

> **Clear the admission ceilings first -- or atomically apply a config the
> validator accepts. Disable Doorbell second. Never the reverse.**

The reverse order passes through a state where Doorbell dispatch is off while
admission ceilings are configured, which the API refuses to start in: the pods
restart, refuse to start and never bind `/metrics`, so the externally visible
symptom is `F` failing and you are mid-rollback with no serving API. The chart
refuses to render that combination for the same reason.

The "atomically" alternative is **not** "keep the ceilings, flip Doorbell
only". It is **one config load landing directly on a validator-compatible final
state** -- normally all eight ceilings `"0"` *and* `runDoorbellDispatch: false`
together. It buys never sitting in the R1-to-R4 window and costs the R3 drain
check, so it is for an emergency where a duplicated run is the lesser risk.

### Procedure

| Step | Action | Verification before proceeding |
|---|---|---|
| **R0** | Record the current state: `$N`, and the Doorbell and enforcement gauges from every API pod; capture `helm get values`. | The recorded state is what R6 compares against. |
| **R1** | In one values change, set all eight `api.admit*` to `"0"`. Apply. **Or** (R1') apply one upgrade that lands directly on the validator-compatible final state and skip to R6. | `helm template` of the new values succeeds. |
| **R2** | Wait for the API rollout to complete. | `F`, `S`, `A` and `E(0)` below. |
| **R3** | Confirm the *waiting* backlog has drained before touching dispatch. | The current-state query and its companion below. |
| **R4** | Set `features.runDoorbellDispatch: false`. Apply. | `helm template` succeeds. |
| **R5** | Wait for the rollout; leave Brain running and `features.brainDoorbellExecution` at `true`. New chat dispatch goes fat; rows already `queued` stay claimable, so the backlog drains rather than stranding. | `D0`, and the R3 row count still `0`. |
| **R6** | Declare rolled back. | `F`, `A`, `E(0)` and `D0`, and an `helm get values` diff against R0 showing only the intended edits. |

**R2 and R6 read exactly this**, `F` first: a replica that refused the config
exports nothing at all, so the other three would agree among the survivors.

**R2 / R6**

```promql
(count(claw_api_doorbell_dispatch_enabled{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) or vector(0)) == bool $N
```

```promql
(count(claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) or vector(0)) == bool (8 * $N)
```

```promql
(sum(min by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"}) != bool max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

```promql
(sum(max by (dimension) (claw_api_admission_enforced{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"})) or vector(0)) == bool 0
```

```promql
(sum(claw_api_doorbell_dispatch_enabled{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*"} == bool 0) or vector(0)) == bool $N
```

**R3 is marker-scoped rather than a plain queue count.** Doorbell is still on
at R3 and ordinary traffic is still flowing: every admitted hand-off opens its
row at `queued` and books a `direct` arrival, so an unfiltered arrival check
never reaches `0` and R3 could never complete, while an unfiltered row count
flickers for every row in transit to a worker. Both halves are therefore
restricted to rows that actually waited.

```sql
SELECT COUNT(*) FROM claw_tasks WHERE origin='chat' AND status='queued'
  AND metadata->>'dispatch'='doorbell' AND metadata->>'queued_since' IS NOT NULL;
```

Returns `0`. Its companion over a full window -- necessary, never sufficient
alone:

```promql
(sum(increase(claw_api_run_queue_entered_total{namespace="$ns", service=~"(primus-)?claw-api", pod=~"primus-claw-api-.*", cause!="direct"}[$w])) or vector(0)) == bool 0
```

R1 has already zeroed all eight ceilings, so admission short-circuits to
`admit` and no new waiting arrival can be minted; what R3 waits out is the soft
backlog admitted before R1 plus any lease returning through requeue.

**Leave the Brain kill-switch alone.** `features.brainDoorbellExecution`
renders the same `RUN_DOORBELL_DISPATCH` variable on the Brain deployment, and
a Brain reading it false executes no doorbell run by any route: it declines one
on the wire and its claim-next loop takes no doorbell row. Setting it false
during R5 is what would strand the backlog R5 waits for.

**The Doorbell message-class backlog is what R7 below covers.** Pull-loop
claims are not doorbell message claims: the pull loop polls the database, while
a doorbell *message* is claimed on the by-id path, so a falling `mode="next"`
claim rate says nothing about whether JetStream still holds undelivered run
doorbells. R5 does not claim to prove it, and R6 declares the values rolled
back and nothing more.

### R7 -- before an incompatible Brain may bind the durable

Only needed when the rollback continues into an image that implements a lower
doorbell semantics version than the one now deployed. A row count is not the
precondition: a row can sit `queued` for hours safely, while an outstanding
doorbell *message* delivered to a binary with no notion of one is cast straight
to an execute request with no validation.

1. **Close the barrier and let it drain.** Revoke the floor fleet-wide, with no
   rollout, then read every API pod:

   ```
   DELETE /v1/internal/brain/doorbell-semantics
   GET    /v1/internal/brain/doorbell-gate?version=<the incoming image's>
   ```

   Every pod must answer `gate: 0` **and** `in_flight: 0`. A closed gate with a
   non-zero in-flight count is a dispatch that read the gate open and can still
   reach the stream; wait, and if it does not drain in the time one dispatch
   takes, stop the rollback. Only once both hold fleet-wide is the rest of this
   list a measurement rather than a moving target.
2. **Nothing outstanding on the durable.** From the `brain-workers` consumer
   info: `num_pending`, `num_ack_pending` and `num_redelivered` all `0`. The
   durable carries both message classes, which makes this conservative in the
   right direction.
3. **No incompatible run is non-terminal.** The same `doorbell-gate` reply
   carries `incompatible_runs`, counting rows the incoming version could not
   execute across `queued`, `preparing`, `running` and `cancelling` -- not only
   `queued`, because a claimed row is not queued and becomes queued again the
   moment a draining replica releases it. It must be `0`, and it is re-read
   after the last compatible replica is gone, since that shutdown is itself a
   requeue event.

## Metric reference

Every series carries the `claw_api_` prefix and is exported by the API. Label
domains are closed enumerations.

| Metric | Type | Labels |
|---|---|---|
| `claw_api_admission_decision_total` | Counter | `origin`, `decision` |
| `claw_api_admission_rejected_total` | Counter | `origin`, `stage`, `reason` |
| `claw_api_admission_enforced` | Gauge | `dimension` |
| `claw_api_doorbell_dispatch_enabled` | Gauge | -- |
| `claw_api_run_dispatch_total` | Counter | `path`, `outcome` |
| `claw_api_run_dispatch_held_total` | Counter | `cause` |
| `claw_api_run_claim_total` | Counter | `mode`, `outcome` |
| `claw_api_run_claim_skipped_total` | Counter | `cause` |
| `claw_api_run_claim_exhausted_total` | Counter | `mode`, `reason` |
| `claw_api_run_unclaim_total` | Counter | `reason`, `outcome` |
| `claw_api_run_fail_claim_total` | Counter | `reason`, `outcome` |
| `claw_api_run_queue_entered_total` | Counter | `cause` |
| `claw_api_run_queue_exited_total` | Counter | `outcome` |
| `claw_api_run_queue_wait_seconds` | Histogram | `origin`, `outcome` |
| `claw_api_run_queue_timeout_total` | Counter | `ever_held` |
| `claw_api_doorbell_lease_requeued_total` | Counter | -- |

| Label | Values |
|---|---|
| `origin` | `chat`, `task`, `dag_node`, `a2a` |
| `decision` | `admit`, `queue`, `reject`, `error` |
| `reason` (rejected) | `runs_hard_limit`, `sandboxes_hard_limit`, `gpu_nodes_hard_limit`, `tree_nodes_exceeded`, `tree_depth_exceeded` |
| `stage` | `pre_insert`, `post_insert` |
| `dimension` | `soft_runs`, `hard_runs`, `soft_sandboxes`, `hard_sandboxes`, `soft_gpu_nodes`, `hard_gpu_nodes`, `tree_max_nodes`, `tree_max_depth` |
| `path` | `chat`, `pending` |
| `outcome` (dispatch) | `dispatched`, `queued`, `rejected`, `publish_unknown`, `open_failed`, `error` |
| `cause` (held) | `hard_limit_exceeded`, `hard_limit_recheck_threw`, `doorbell_publish_failed` |
| `mode` | `by_id`, `next` |
| `outcome` (claim) | `claimed`, `empty`, `all_skipped`, `retry_limit`, `missing`, `busy`, `unclaimable`, `deferred`, `exhausted`, `error` |
| `cause` (claim skip) | `raced`, `unclaimable`, `deferred`, `exhausted`, `error` |
| `reason` (exhausted) | `lock_contention_exhausted`, `max_retries_exceeded` |
| `reason` (unclaim) | `lock_contention`, `retry`, `drain`, `hydrate_failed`, `unspecified` |
| `reason` (fail-claim) | `session_deleted`, `claim_abandoned`, `workspace_unbound` |
| `outcome` (unclaim, fail-claim) | `accepted`, `not_holder`, `error` |
| `cause` (queue entry) | `admission`, `direct`, `requeue` |
| `outcome` (queue exit) | `claimed`, `timed_out`, `budget_exhausted`, `duplicate_closed`, `dispatch_failed`, `chat_closed`, `cancelled` |
| `outcome` (queue wait) | `claimed`, `timed_out` |
| `ever_held` | `true`, `false` |

`unspecified` exists only as a metric label: a request body carrying it as an
unclaim reason is still rejected. A non-trivial rate means version skew.

## What this document does not contain

- Production ceiling values, replica counts or any other capacity figure.
- A soak duration per stage.
- Dashboard panels, alert rules or an SLO artefact.
