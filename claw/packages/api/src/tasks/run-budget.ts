// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How long a run is allowed to burn compute.
 *
 * `BRAIN_TASK_TIMEOUT_SEC` used to answer two questions at once: "how long may
 * this run take" and "is the worker running it still alive". Those want time
 * scales three orders of magnitude apart, so one number was necessarily wrong
 * both ways -- six hours kills a healthy ten-hour job, and waits six hours to
 * notice a worker that died in seconds. Liveness belongs to the lease; this
 * module owns the other half.
 *
 * `deadline_at` means **the moment the run's active budget is exhausted**, and
 * that meaning is fixed from here on even though the implementation does not
 * yet honour all of it. Today the deadline is stamped when the run starts, so
 * queue time is already excluded. Time spent parked in `waiting_external`, or
 * blocked on a question to the user, is not excluded yet and still burns
 * budget. Closing that gap means pausing and resuming the clock, not
 * redefining the column -- which is the point of naming it a budget now rather
 * than after chat runs move onto this table and make an unpausable wall clock
 * actively wrong.
 */

import { envInt } from "../config.js";

/** Which kind of run this is. Each gets its own default rather than sharing one constant. */
export type RunScope = "chat" | "dag_node";

/**
 * What produced a run, as recorded on the row.
 *
 * Distinct from {@link RunScope}, which is about how long the run may take:
 * `task` and `dag_node` are produced by different callers but want the same
 * budget, whereas the difference that matters to a sweeper deciding what it is
 * allowed to reap is exactly the one between a conversation and everything
 * else.
 */
export type RunOrigin = "chat" | "task" | "dag_node";

/**
 * A duration in seconds that must be positive to mean anything.
 *
 * No longer used for budgets -- those take {@link envBudgetSec}, where zero is
 * the off switch. What is left here is the backstop grace and the queue
 * ceiling, and a zero in either is not a shorter interval but a broken one: a
 * grace of zero races the run it exists to defer to, and a queue ceiling of
 * zero fails a row the instant it is enqueued.
 */
function envSec(key: string, fallback: number): number {
  return envInt(key, fallback, { min: 1 });
}

/**
 * A budget, where zero is the off switch rather than an instant expiry.
 *
 * Separate from {@link envSec} because the two answer differently to the same
 * input. `min: 1` rejects a zero and falls back to the default, so setting a
 * budget to 0 used to be a silent no-op that left the ceiling in place -- the
 * operator reads the setting they wrote, the fleet keeps the one they replaced,
 * and the only trace is a line in the settings-problem log. An off switch that
 * does nothing is worse than no off switch, because it is believed.
 *
 * Zero reaches the SQL and is turned into a NULL `deadline_at` there, which is
 * a state every reader already handles: the reapers all test
 * `deadline_at IS NOT NULL` before acting, `peekNextQueued` and the claim
 * predicate both admit `deadline_at IS NULL`, the row's index is partial on the
 * same condition, and Brain arms no timer for a request that carries none. So
 * "no budget" is not a new case being introduced here; it is the case that has
 * always described a row nobody stamped.
 */
function envBudgetSec(key: string, fallback: number): number {
  return envInt(key, fallback, { min: 0 });
}

/** A budget of this many seconds means the scope has no deadline at all. */
export const RUN_BUDGET_OFF = 0;

/**
 * Defaults per scope.
 *
 * Split because the two shapes of run are produced by different callers and
 * recorded differently, not because one is inherently shorter. A chat turn is
 * usually seconds, but the agent workloads this fleet exists for -- an
 * inference-optimization skill that installs a toolchain, launches a server and
 * then watches it for hours -- arrive as chat turns too, and they are the runs
 * a budget actually decides the fate of.
 *
 * The chat scope defaults to 48 hours. A chat row carries a lease and
 * `reapStaleTasks` skips it by default, so nothing caps a live chat turn at the
 * global timeout and all 48 hours are reachable.
 *
 * `dag_node` defaults to 72 hours so multi-day jobs are expressible without
 * disabling the safety ceiling. Both defaults are deployment policy and can be
 * set to zero when an operator deliberately wants no deadline.
 *
 * Liveness is independent of these numbers. Current chat, standalone task, and
 * DAG dispatches all issue a short renewable lease. A healthy long run keeps
 * renewing it; a dead worker is closed by the lost-lease reaper. A row that
 * never receives its first renewal still reaches `BRAIN_TASK_TIMEOUT_SEC`, even
 * when its execution deadline is much later, because an unclaimed run has not
 * started spending that budget.
 *
 * `deadline_at` is also carried on the ExecuteRequest so Brain can stop a live
 * run gracefully and report `run_budget_exhausted` before the sweeper's grace
 * period expires.
 */
export const RUN_BUDGET_DEFAULT_SEC: Record<RunScope, number> = {
  chat: envBudgetSec("RUN_BUDGET_CHAT_SEC", 48 * 60 * 60),
  dag_node: envBudgetSec("RUN_BUDGET_DAG_NODE_SEC", 72 * 60 * 60),
};

/**
 * Grace the backstop waits past the deadline before stepping in.
 *
 * The run is expected to stop itself and report why; the sweeper only exists
 * for the case where it cannot, because the process holding it is gone. Without
 * a gap the two race, and the sweeper -- which knows nothing about what the run
 * had done so far -- usually wins.
 */
export const RUN_BUDGET_BACKSTOP_GRACE_SEC = envSec("RUN_BUDGET_BACKSTOP_GRACE_SEC", 5 * 60);

/**
 * How long a doorbell may sit at `queued` before the sweeper gives up.
 *
 * Separate from {@link RUN_BUDGET_DEFAULT_SEC}: that clock is execution
 * budget, stamped when a worker claims. This one is wait time, judged from
 * `queued_at`. Sharing `deadline_at` for both made a long queue steal the
 * turn's run time, or kill it before anyone claimed it.
 */
export const RUN_QUEUE_MAX_SEC = envSec("RUN_QUEUE_MAX_SEC", 2 * 60 * 60);

/**
 * SQL that stamps the deadline when a run starts.
 *
 * Computed in the database from the row itself so it cannot disagree with the
 * `started_at` written in the same statement, and wrapped in COALESCE so a
 * status re-entry or a redelivery does not silently hand the run a second
 * budget. This is the only implementation of the rule: keeping a second copy in
 * TypeScript meant the tests could agree with a version of it that never ran.
 *
 * The CASE prefers what the row says it is. The fallback -- a DAG root means a
 * graph node, anything else is a conversation -- is what rows written before
 * `origin` existed have to be read with, and it is wrong for a standalone task:
 * those have no DAG root and so were given the budget meant for a chat turn
 * rather than the one for a job of its own kind. That costs something now
 * rather than hypothetically: the defaults moved apart in this change, so such
 * a row takes the chat scope's 48h where its kind is configured for 24h, and
 * any deployment that tunes the two further apart widens the gap. Recorded
 * origin fixes it going forward without rewriting old rows.
 *
 * `budget_sec` is where a per-node declaration will arrive; nothing writes it
 * yet, so today every run takes a scope default.
 *
 * The outer `NULLIF(..., 0)` is the off switch, and it is outside rather than
 * inside on purpose: zero means the same thing wherever it is written, so a
 * scope default of 0 and a declared `budget_sec` of 0 both stamp no deadline
 * instead of one meaning "off" and the other "I did not say". A NULL here
 * makes the whole `NOW() + (... * INTERVAL '1 second')` NULL, so the stamp
 * leaves `deadline_at` as it found it -- which for a fresh row is unset, the
 * state every reader of this column already treats as "no budget".
 *
 * Parameters are the two scope defaults, in that order.
 */
const BUDGET_SECONDS_SQL = `NULLIF(
  COALESCE(
    (@META@->'derived'->>'budget_sec')::int,
    CASE
      WHEN @ORIGIN@ = 'chat' THEN $CHAT$
      WHEN @ORIGIN@ IN ('task','dag_node') THEN $DAG$
      WHEN @DAGROOT@ IS NULL THEN $CHAT$
      ELSE $DAG$
    END
  ),
  0
)`;

/**
 * Wind a row's clocks back when it goes back on the queue.
 *
 * Both stamps are written with COALESCE -- `started_at = COALESCE(started_at,
 * NOW())` beside {@link DEADLINE_STAMP_SQL} -- so that a status re-entry or a
 * redelivery cannot hand one run two budgets. That is the right rule for a run
 * resuming, and the wrong one for a run starting over: the second claim
 * inherits the first attempt's `started_at` and `deadline_at`, so whatever the
 * row spent waiting between the two is charged to its execution budget, and a
 * row requeued late enough arrives already past a deadline nobody spent.
 *
 * `queued_at` is the same argument from the other side. It is what
 * `reapExpiredQueuedRuns` judges the wait by, and leaving it at the first
 * enqueue means a requeue is measured from a queue the row already left. When
 * `RUN_QUEUE_MAX_SEC` and `RUN_BUDGET_CHAT_SEC` were both two hours -- which
 * they were by default until this change raised the chat budget -- and with the
 * requeue pass running earlier in the same tick than the queue reaper, a single
 * recoverable worker loss was closed as `queue_timeout` on the spot. Resetting
 * `queued_at` is what fixes that, so the reset is not conditional on the two
 * ever being equal again: any deployment that configures a chat budget near the
 * queue ceiling brings the collision back with it.
 *
 * `deadline_at` is deliberately NOT cleared, and that is the line between the
 * two stamps. `started_at` is per attempt -- it answers "has this try shown
 * signs of life", and the stale reaper's legacy arm measures from it, so it
 * has to follow the attempt. `deadline_at` is per turn: it is the only
 * absolute bound on how long one chat turn may occupy the fleet. Clearing it
 * handed every requeue a fresh budget, and with the claim ceiling at 22 that
 * turned a two-hour cap into a forty-four-hour one. A row that outlives its
 * deadline is not owed another; it is owed a terminal state, which is
 * `reapExpiredDoorbellRuns`'s job.
 *
 * The cost is queue position: `peekNextQueued` orders by `queued_at ASC`, so a
 * requeued row now sorts behind rows that arrived while it was executing
 * rather than ahead of them. That is the trade -- going to the back of a queue
 * it can still be served from, instead of staying at the front of one it is
 * about to be failed out of.
 */
export const RUN_REQUEUE_RESET_SQL = `queued_at = NOW(),
            started_at = NULL`;

const DEADLINE_STAMP_SQL = `deadline_at = COALESCE(
  deadline_at,
  NOW() + (${BUDGET_SECONDS_SQL} * INTERVAL '1 second')
)`;

function bindBudgetSql(
  fragment: string,
  ids: { meta: string; origin: string; dagRoot: string },
  chatParam: number,
  dagParam: number,
): string {
  return fragment
    .replaceAll("@META@", ids.meta)
    .replaceAll("@ORIGIN@", ids.origin)
    .replaceAll("@DAGROOT@", ids.dagRoot)
    .replaceAll("$CHAT$", `$${chatParam}::int`)
    .replaceAll("$DAG$", `$${dagParam}::int`);
}

/**
 * Bind the UPDATE stamp to concrete positional parameters.
 *
 * `replaceAll`, because each placeholder appears more than once: the CASE has a
 * branch for what the row says it is and a branch for inferring it from the
 * shape of older rows. Replacing only the first left the rest as literal text
 * for the database to choke on.
 */
export function deadlineStampSql(chatParam: number, dagParam: number): string {
  return bindBudgetSql(
    DEADLINE_STAMP_SQL,
    { meta: "metadata", origin: "origin", dagRoot: "dag_root_task_id" },
    chatParam,
    dagParam,
  );
}

/**
 * The same budget, written for INSERT, where VALUES cannot name columns.
 *
 * Chat rows open at `preparing` and never pass through `transitionStatus`, so
 * the UPDATE stamp above never runs for them. Naming the INSERT parameters
 * here is how that path gets a deadline without a second copy of the CASE.
 */
export function deadlineAtInsertSql(args: {
  metadataParam: number;
  originParam: number;
  dagRootParam: number;
  chatParam: number;
  dagParam: number;
}): string {
  const seconds = bindBudgetSql(
    BUDGET_SECONDS_SQL,
    {
      meta: `$${args.metadataParam}::jsonb`,
      origin: `$${args.originParam}::text`,
      dagRoot: `$${args.dagRootParam}::text`,
    },
    args.chatParam,
    args.dagParam,
  );
  return `NOW() + (${seconds} * INTERVAL '1 second')`;
}
