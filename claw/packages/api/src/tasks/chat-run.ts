// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A row for the thing a chat turn is.
 *
 * A conversational run has, until now, had no persisted identity: no row, no
 * authoritative status, no deadline, no record of what it owns. Everything it
 * did was tracked by one column on the session -- `agent_status` -- which says
 * whether the session is busy and nothing about the run making it busy. A
 * surprising number of separate problems are that absence wearing different
 * hats. The sweeper cannot see a chat run that hung, because there is nothing
 * to see. The workspace collector cannot tell whose files these are, so it
 * infers ownership from paths and consequently dares not delete much. Nothing
 * can answer how many runs a tenant has in flight, or what happened during a
 * run that finished an hour ago.
 *
 * So chat turns start writing rows to the same table DAG nodes use. This is
 * the first half of that, and it mostly adds: concurrency is still gated by
 * `agent_status`, and the deadline backstop still leaves these rows alone (see
 * RUN_ROWS_SWEEPABLE), so there is room to compare the rows against the
 * sessions they shadow before anything depends on them being right.
 *
 * "Mostly", because the lease is not shadow. An expired lease is what tells the
 * sweeper a worker died, and the worker that later takes the delivery over
 * reads the row it closed and stands down -- so these rows are already load
 * bearing on the path this exists for, which is a run surviving the loss of the
 * pod running it.
 *
 * Every function here is best-effort and swallows its errors, reporting by
 * returning null. Callers that publish a turn must treat that null as a failed
 * dispatch -- a message with no row cannot be leased or reaped -- but the
 * refusal belongs there, not here. The systematic failure this leaves
 * uncovered -- the column not existing at all -- is caught at startup by the
 * schema guard instead.
 */
import { createHash, randomBytes } from "node:crypto";
import pino from "pino";
import { DOORBELL_SEMANTICS_VERSION, interruptSubject } from "@claw/protocol";
import type { RunLease } from "@claw/protocol";
import { RUN_FAT_PREPARING_RECONCILE } from "../config.js";
import type { PoolClient } from "pg";
import { db } from "../infra/db.js";
import { nc } from "../infra/nats.js";
import { metrics, type QueueEntryCause } from "../infra/metrics.js";
import { newTaskId } from "./ids.js";
import { insertTask } from "./db.js";
import { deadlineStampSql, RUN_BUDGET_DEFAULT_SEC, type RunOrigin } from "./run-budget.js";
import type { TaskStatus } from "./types.js";
import { recordRunUse, releaseRunUse } from "../workspace/store.js";
import { publishEvent } from "../events/store.js";

const logger = pino({ name: "chat-run" });

/**
 * Injection seam for the wire effects a Stop has to make.
 *
 * `nc` is a live binding on a frozen module namespace, so a test can only
 * substitute the call through an object like this one.
 */
export const chatRunPorts = {
  publishSessionEvent: publishEvent,
  publishInterrupt: (subject: string): void => { nc.publish(subject); },
};

// Same default the DAG expander uses: the API talking to itself, which works
// out of the box in dev and should be set explicitly in production.
const INTERNAL_BACKEND_URL =
  process.env.INTERNAL_BACKEND_URL || `http://127.0.0.1:${process.env.API_PORT || "8200"}`;

/** How a chat run ended, in the vocabulary the row uses. */
export type ChatRunOutcome = "completed" | "failed" | "cancelled";

/**
 * The message id a queued turn is dispatched under.
 *
 * Derived from the queued row rather than the clock, because the drain that
 * sends it can run twice for one message: publishing is not the last thing the
 * completion handler does, and anything after it failing brings the handler
 * back on redelivery with the queued row still there. A fresh `claw-<now>` each
 * time made the replay a different turn to everything downstream, and nothing
 * downstream could tell.
 *
 * The row's id is the one thing about a queued message that does not change
 * between attempts, and it is gone as soon as the turn is really dispatched, so
 * it cannot collide with a later one. What recognises the replay is the stream:
 * the publish carries this id as its message id, and the duplicate window drops
 * the second copy before any worker sees it.
 *
 * That is the whole of the protection, and it has to be, because nothing
 * downstream would notice a second turn that got past it. The transcript is
 * written by turn index with no uniqueness on the message, so a turn that ran
 * twice is simply in the history twice -- read back to the user, and fed to the
 * model on every later turn.
 *
 * The run row is not deduplicated either: `claw_tasks` is keyed by its own id,
 * so a replay whose publish is dropped still opens one. It is left open, and
 * `closeChatRun` ends it along with the row the worker is really executing,
 * because it matches on this message id and closes every row that carries it.
 *
 * The reaper that closes a run whose worker died does not match that way. It
 * matches on an expired lease, and the spare row never had one -- nothing writes
 * `lease_expires_at` until a worker renews -- so it used to be left at
 * `preparing`, where it was enough to hold the conversation's gate shut until
 * the hourly session reaper. `closeUnclaimedDispatchSiblings` in the sweeper
 * closes it alongside the row it reaps, keyed on this id being the one thing the
 * two rows share.
 */
/**
 * Give up this dispatch's claim on its own reconciliation marker.
 *
 * Compare-and-set on the exact horizon the insert wrote, because
 * reconciliation takes a row by extending that column: a publisher whose clear
 * matches nothing has been overtaken and no longer owns the outcome, so it must
 * report that rather than a verdict it cannot stand behind.
 *
 * @returns whether this caller still owned the row.
 */
export async function clearDispatchReconcile(
  taskId: string,
  horizon: Date | string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET dispatch_reconcile_at = NULL, dispatch_reconcile_action = NULL
      WHERE task_id = $1 AND dispatch_reconcile_at = $2`,
    [taskId, horizon],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Commit what is known about this row's publish, before the publish is made.
 *
 * `not_attempted` and `refused` are both proofs that no message for this row
 * can exist, and both outlive the process that observed them -- which is what
 * lets a compensation that failed be retried from row state alone. Only
 * `attempted` is ambiguous, and it must be durable *before* the call it
 * describes: a crash between writing it and publishing leaves a row that
 * correctly says a message may exist, while the reverse order leaves one that
 * lies about a message already on the stream.
 *
 * CASed on the state it replaces, so a receipt a holder disarmed in between is
 * not resurrected.
 *
 * @throws when the receipt is not durable -- the statement failed, or it matched
 *   no armed row. A publisher must let that throw stop it: a row still reading
 *   `not_attempted` while its message is on the stream is exactly what
 *   {@link NO_DELIVERY_IN_FLIGHT_SQL} destroys a live run on.
 */
export async function recordPublishState(
  taskId: string,
  publish: DispatchPublishState,
): Promise<void> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET metadata = jsonb_set(
              metadata, '{dispatch_compensation,publish}', to_jsonb($2::text)
            )
      WHERE task_id = $1
        AND metadata->'dispatch_compensation'->>'version' = '1'
        AND metadata->'dispatch_compensation'->>'state' = 'armed'`,
    [taskId, publish],
  );
  if ((r.rowCount ?? 0) === 0) {
    throw new Error(`chat_run.publish_state_unrecorded: ${taskId} is not armed for ${publish}`);
  }
}

/**
 * The compensation's own receipt write, which may not replace the failure it
 * compensates.
 *
 * Unlike the pre-publish write this one cannot fail open: the state it leaves
 * behind on failure is `attempted`, the ambiguous value every guard already
 * treats as a possible delivery.
 */
export async function noteRefusedPublish(taskId: string): Promise<void> {
  try {
    await recordPublishState(taskId, "refused");
  } catch (err) {
    logger.warn({ err, taskId }, "chat_run.publish_state_write_failed");
  }
}

/**
 * Record which stream message carries this row's work.
 *
 * Without it an ambiguous publish can only be resolved against the whole
 * stream; with it the sweeper can ask whether this row's own message has been
 * settled. Best-effort: a row whose sequence never lands falls back to the
 * whole-stream observation rather than blocking.
 */
export async function recordDispatchSeq(taskId: string, seq: number): Promise<void> {
  if (!Number.isFinite(seq) || seq <= 0) return;
  try {
    await db.query(
      `UPDATE claw_tasks
          SET metadata = jsonb_set(metadata, '{dispatch_seq}', to_jsonb($2::bigint))
        WHERE task_id = $1`,
      [taskId, seq],
    );
  } catch (err) {
    logger.warn({ err, taskId, seq }, "chat_run.dispatch_seq_write_failed");
  }
}

/** The receipt a fat row is opened with, before any publish is attempted. */
export function armedReceipt(publish: DispatchPublishState): DispatchCompensationRecord {
  return { version: 1, state: "armed", publish };
}

/** What a receipt on the row turned out to be. Only `valid` may be acted on. */
export type CompensationParse =
  | { kind: "absent" }
  | { kind: "valid"; record: DispatchCompensationRecord }
  | { kind: "unsupported"; version: number }
  | { kind: "invalid" };

const PUBLISH_STATES = new Set<string>(["not_attempted", "attempted", "refused"]);

/**
 * The only reader of `metadata.dispatch_compensation`.
 *
 * Fails closed in both directions: an unsupported version means a newer
 * deployment owns this row's contract and no writer here may change it, while a
 * malformed value must never be read as holder evidence and must never make an
 * otherwise eligible open orphan permanent.
 */
export function parseDispatchCompensationRecord(
  metadata: Record<string, unknown> | null | undefined,
): CompensationParse {
  const raw = metadata?.dispatch_compensation;
  if (raw === undefined || raw === null) {
    // A row that says it is fat owes a receipt; its absence is a broken
    // invariant rather than a legacy row.
    return metadata?.dispatch === "fat" ? { kind: "invalid" } : { kind: "absent" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid" };
  const record = raw as Record<string, unknown>;
  const version = Number(record.version);
  if (!Number.isInteger(version)) return { kind: "invalid" };
  if (!SUPPORTED_COMPENSATION_VERSIONS.includes(version as 1)) {
    return { kind: "unsupported", version };
  }
  if (record.state === "armed") {
    return typeof record.publish === "string" && PUBLISH_STATES.has(record.publish)
      ? { kind: "valid", record: armedReceipt(record.publish as DispatchPublishState) }
      : { kind: "invalid" };
  }
  if (record.state !== "terminal" && record.state !== "complete") return { kind: "invalid" };
  if (!("failure_reason" in record) || !("error_message" in record)) return { kind: "invalid" };
  return {
    kind: "valid",
    record: {
      version: 1,
      state: record.state,
      failure_reason: (record.failure_reason ?? null) as string | null,
      error_message: (record.error_message ?? null) as string | null,
    },
  };
}

/**
 * The parser's SQL image, for the two states a writer may act on.
 *
 * Exported once and reused verbatim wherever a predicate needs it, so the
 * statement and {@link parseDispatchCompensationRecord} cannot drift about what
 * is actionable.
 */
export const ACTIONABLE_RECEIPT_SQL = `
metadata->'dispatch_compensation'->>'version' = '1'
AND (
     (
          metadata->'dispatch_compensation'->>'state' = 'armed'
          AND metadata->'dispatch_compensation'->>'publish'
              IN ('not_attempted','attempted','refused')
     )
     OR (
          metadata->'dispatch_compensation'->>'state' = 'terminal'
          AND jsonb_exists(metadata->'dispatch_compensation', 'failure_reason')
          AND jsonb_exists(metadata->'dispatch_compensation', 'error_message')
     )
)`.trim();

/** The one shape no pass may act on or even fetch: a contract written by a newer deployment. */
export const UNSUPPORTED_RECEIPT_SQL = `
metadata->'dispatch_compensation'->>'version' IS NOT NULL
AND metadata->'dispatch_compensation'->>'version' <> '1'`.trim();

/**
 * Whether this row's null holder columns are trustworthy evidence that no
 * delivery is in flight for it.
 *
 * One guard, written once and bound by every no-holder terminalizer of a fat
 * row. `$fleet` is the deployment's assertion that every Brain takes a durable
 * SQL holder before its execution gate; `$settled` is a per-row observation of
 * the durable; the publish state answers it from the row itself; and the last
 * arm is construction, a doorbell row's claim writing owner and expiry in the
 * statement that takes it. The fat set is written positively so an unknown
 * dispatch value stays outside the guard.
 */
export const NO_DELIVERY_IN_FLIGHT_SQL = `
$fleet::boolean
OR $settled::boolean
OR metadata->'dispatch_compensation'->>'publish' IN ('not_attempted','refused')
OR NOT (
     origin = 'chat'
     AND (metadata->>'dispatch' = 'fat' OR metadata->>'dispatch' IS NULL)
)`.trim();

/**
 * Whether the durable has settled this row's delivery.
 *
 * Two forms: the whole stream drained past everything published before the
 * read, or this row's own recorded sequence is at or below the ack floor. The
 * second is what lets one live delivery hold only its own row rather than
 * every row in the batch.
 */
export function deliverySettledSql(wholeStreamParam: string, ackFloorParam: string): string {
  return `(
  ${wholeStreamParam}::boolean
  OR (
       ${ackFloorParam}::bigint IS NOT NULL
       AND (metadata->>'dispatch_seq') IS NOT NULL
       AND (metadata->>'dispatch_seq')::bigint <= ${ackFloorParam}::bigint
  )
)`;
}

/** Bind {@link NO_DELIVERY_IN_FLIGHT_SQL}'s two evidence arms to statement parameters. */
export function noDeliveryInFlightSql(fleetParam: string, settledParam: string): string {
  return NO_DELIVERY_IN_FLIGHT_SQL
    .replace("$fleet", fleetParam)
    .replace("$settled", settledParam);
}

export function queuedMessageId(pendingRowId: number | string): string {
  return `claw-pending-${pendingRowId}`;
}

/**
 * Which delivery carries this run's work.
 *
 * Explicit rather than inferred from whether a spec happens to be present: the
 * marker decides which reapers may touch the row, and a fat row that silently
 * lost it becomes indistinguishable from a legacy one.
 */
export type ChatDispatchKind = "fat" | "doorbell";

/**
 * The durable receipt a fat dispatch leaves on its own row.
 *
 * The row columns stay authoritative for status, reason, message and
 * timestamps; this records only what a later process needs in order to retry a
 * compensation the process that owed it did not finish.
 */
export type DispatchCompensationRecord =
  | { version: 1; state: "armed"; publish: DispatchPublishState }
  | {
    version: 1;
    state: "terminal" | "complete";
    failure_reason: string | null;
    error_message: string | null;
  };

/**
 * Whether a message for this row can exist.
 *
 * `not_attempted` and `refused` are both proofs that none does, and both
 * outlive the process that observed them, which is what makes a failed
 * compensation retryable from row state alone. Only `attempted` is ambiguous.
 */
export type DispatchPublishState = "not_attempted" | "attempted" | "refused";

export const SUPPORTED_COMPENSATION_VERSIONS = [1] as const;

export interface OpenChatRunInput {
  sessionId: string;
  userId: string;
  /**
   * What produced this run. `"a2a"` opens the row idempotently against
   * `idx_tasks_a2a_execution`, so a repeated `(session_id, message_id)` pair
   * writes nothing and returns null.
   */
  origin?: RunOrigin;
  /** Written to the `sandbox_spec` column, which is what the sandbox count reads. */
  sandboxSpec?: unknown;
  /** Which delivery carries the work. Fat rows get the compensation receipt. */
  dispatch: ChatDispatchKind;
  /**
   * The row id this turn was already handed off under, when one is recorded.
   *
   * A queued drain that publishes and then fails to delete its queue row comes
   * back to find the same message; without a durable identity it opens a second
   * run, and once the first is terminal no active-state uniqueness index can
   * stop the second executing. Supplying the recorded id makes the retry finish
   * that handoff instead.
   */
  taskId?: string;
  /**
   * Why this row is entering the queue.
   *
   * `admission` is a run held back by a soft ceiling, and is the only entry
   * whose wait is a queue wait: a `direct` row's transit through `queued` is
   * dispatch latency, and measuring it as a sojourn would make a bounded-waits
   * gate pass however bad the queue was.
   */
  queueEntryCause?: QueueEntryCause;
  /**
   * What a dispatch that never reports its publish outcome leaves for the
   * sweeper to finish. Absent for a caller with nothing to undo.
   */
  reconcileAction?: "idle_existing_session" | "delete_created_session";
  /** The chat message id, which is how Brain refers to this run. */
  messageId: string;
  prompt: string;
  workspaceId?: string;
  /**
   * The workspace the caller has already bound this turn to, if it has.
   *
   * Passed in rather than resolved here so a turn is bound exactly once. The
   * caller has to know the id before it writes anything -- a turn that cannot be
   * bound is refused, and the refusal must leave nothing behind -- and resolving
   * it a second time here would let the reference and the writer claim land on a
   * different workspace than the one the gate was told about. Absent for callers
   * that still leave the lookup to this function.
   */
  filesWorkspaceId?: string;
  /**
   * Whether this run should be recorded as a user of the session's workspace.
   *
   * On by default, because a run that is about to execute has to hold a
   * reference for as long as it is writing those files. The caller that says no
   * is opening a row for a turn whose binding has just been established as
   * impossible: there is no workspace to reference, and asking for one here
   * would put a second round trip -- and a second `workspace.ensure_failed` --
   * against the database that has just refused the first.
   */
  recordWorkspaceUse?: boolean;
  pluginId?: number;
  sandboxImage?: string;
  /**
   * Secret-free execute spec written to `claw_tasks.input`. Present when the
   * doorbell path is on: claim hydrates the request from this rather than
   * from the JetStream payload.
   */
  spec?: Record<string, unknown>;
  /** Defaults to `preparing`, which is "the doorbell is going out now". */
  status?: "queued" | "preparing";
  /**
   * Whether to mint a lease token at insert. The doorbell path issues the
   * token at claim time instead, because nothing holds it between the two.
   */
  issueLease?: boolean;
  /**
   * The transaction the admission decision was made on. The insert must run on
   * it, or the lock holder's own row is invisible to the read that admitted it.
   */
  client?: PoolClient;
}

/** What openChatRun hands back: the row's id, and how to keep it alive. */
export interface OpenChatRunResult {
  taskId: string;
  /**
   * The reconciliation horizon written with the row, which the publisher CASes
   * on to prove it still owns the outcome. Absent when none was armed.
   */
  reconcileAt?: Date;
  /** The workspace this run's files belong to, when one could be recorded. */
  workspaceId?: string;
  /**
   * Where the run renews its lease, and the token to do it with. Issued here
   * because this is where the row is created, and the token has to be a secret
   * the row can verify -- only its sha256 is stored.
   *
   * Absent when `issueLease` was false: the doorbell path mints the token at
   * claim time, and there is nothing to hand back at insert.
   */
  lease?: RunLease;
}

/**
 * Record that a chat turn is about to be dispatched.
 *
 * Written before the publish rather than after, so a process that dies between
 * the two leaves a record of a run that was attempted rather than no record at
 * all. Callers that go on to publish must treat a null return as a failed
 * dispatch: a message with no row has no lease and no deadline, and sits at
 * `running` until an operator notices. What closes a row that did open is
 * worth being exact about, because three different things can:
 *
 * - `closeChatRun`, from the `exec_complete` of a run that ended normally;
 * - `reapLostLeases`, once the lease this row hands the worker stops being
 *   renewed. Chat rows are not exempt from that one, and a worker that later
 *   takes the delivery over reads the terminal row and stands down;
 * - `teardownSession`, when the session the run belongs to is deleted.
 *
 * `reapStaleTasks`, the deadline backstop, is the one that still leaves these
 * rows alone unless `RUN_ROWS_SWEEPABLE` is set -- it is the only reaper that
 * publishes an interrupt, and an interrupt is keyed by session rather than by
 * run. With the flag on, the row is reachable through the never-claimed arm,
 * which matches on the `started_at` that `insertTask` stamps for a row opened
 * at `preparing`.
 *
 * The budget arm is the other half of that sentence, and it reaches the one
 * case the never-claimed arm cannot: a worker still heartbeating a stuck
 * engine, whose lease keeps `lease_expires_at` in the future. It matches on
 * `deadline_at`, so it applies exactly when `RUN_BUDGET_CHAT_SEC` is non-zero
 * -- 48 hours by default, `api.runBudgetChatSec` in the chart. Set that to zero
 * and no deadline is stamped, which leaves this case unreachable by either arm;
 * see the note on RUN_BUDGET_DEFAULT_SEC for what else a deadline buys.
 *
 * Opens directly at `preparing` because that is what the DAG dispatcher means by
 * it -- the execution message is going out now -- and there is no queue in front
 * of a chat turn to sit in.
 *
 * `message_id` goes in metadata rather than becoming the primary key: the id
 * is a millisecond timestamp, which is unique enough for a serialised
 * conversation and not unique enough to be a key.
 *
 * @returns the new row's id, or null if the row could not be written.
 */
export async function openChatRun(input: OpenChatRunInput): Promise<OpenChatRunResult | null> {
  const taskId = input.taskId ?? newTaskId();
  // Scoped to this run and to lease renewal alone. The chat path deliberately
  // does not get `callback_url`: those endpoints move rows between states, wake
  // the scheduler and open the backend tool surface, and these rows are still a
  // shadow record. A lease says only that a worker is alive, which is safe to
  // accept now.
  //
  // Withholding the address is not withholding the authorization, though, and
  // that is where the scope actually lives: all four internal task routes verify
  // against the hash written below, and their URLs differ from the lease one by a
  // path segment. `internalTaskAuth` accepts a row's token for the acting routes
  // only when the row has the `callback_url` that named them, which is what makes
  // the absence here a limit rather than a convention.
  const issueLease = input.issueLease !== false;
  const leaseToken = issueLease ? randomBytes(32).toString("hex") : null;
  const status = input.status ?? "preparing";
  try {
    const row = await insertTask({
      task_id: taskId,
      session_id: input.sessionId,
      origin: input.origin ?? "chat",
      sandbox_spec: input.sandboxSpec,
      onConflictDoNothing: input.origin === "a2a",
      dispatch_reconcile_action: input.reconcileAction ?? null,
      workspace_id: input.workspaceId ?? null,
      plugin_id: input.pluginId ?? null,
      name: input.prompt.slice(0, 64) || "chat",
      prompt: input.prompt,
      input: input.spec,
      status,
      internal_token_hash: leaseToken
        ? createHash("sha256").update(leaseToken).digest("hex")
        : null,
      metadata: {
        message_id: input.messageId,
        user_id: input.userId,
        ...(input.sandboxImage ? { sandbox_image: input.sandboxImage } : {}),
        dispatch: input.dispatch,
        ...(status === "queued" && input.queueEntryCause === "admission"
          ? { queued_since: new Date().toISOString() }
          : {}),
        // One spread writes both, so every doorbell row carries the version it
        // requires. The spec goes to the separate `input` column, where no
        // predicate here or in the reapers can see it.
        ...(input.dispatch === "doorbell"
          ? { doorbell_semantics: DOORBELL_SEMANTICS_VERSION }
          : { dispatch_compensation: armedReceipt("not_attempted") }),
      },
    }, input.client);
    // Only for the idempotent open: the pair already has its execution, and
    // recording a workspace use for a row that was not written would leak a
    // reference nothing releases.
    if (!row) return null;
    if (status === "queued") metrics.onQueueEntered(input.queueEntryCause ?? "direct");
    const workspaceId = input.recordWorkspaceUse === false
      ? undefined
      : await recordRunUse(input.sessionId, input.userId, taskId, input.filesWorkspaceId);
    return {
      taskId,
      reconcileAt: (row as { dispatch_reconcile_at?: Date | null }).dispatch_reconcile_at ?? undefined,
      workspaceId,
      ...(leaseToken ? {
        lease: {
          url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${taskId}/lease`,
          token: leaseToken,
        },
      } : {}),
    };
  } catch (err) {
    // A caller that supplied a transaction has writes riding on this one: the
    // failed statement has already aborted it, so a null return would report a
    // duplicate while its `COMMIT` silently discarded the session this row
    // names.
    if (input.client) throw err;
    logger.warn(
      { err, sessionId: input.sessionId, messageId: input.messageId },
      "chat_run.open_failed",
    );
    return null;
  }
}

/**
 * Move the session's open chat run to `running`.
 *
 * Identified by session rather than by run id because the event that triggers
 * this -- Brain reporting that it has a sandbox and is starting -- is a
 * session event and carries no run identifier. That is sound while a session
 * runs one turn at a time, which is precisely what `agent_status` guarantees
 * and what this table is not yet allowed to change.
 */
export async function markChatRunRunning(sessionId: string): Promise<void> {
  try {
    await db.query(
      `UPDATE claw_tasks
          SET status = 'running',
              ${deadlineStampSql(2, 3)}
        WHERE session_id = $1
          AND origin = 'chat'
          AND status = 'preparing'`,
      [sessionId, RUN_BUDGET_DEFAULT_SEC.chat, RUN_BUDGET_DEFAULT_SEC.dag_node],
    );
  } catch (err) {
    logger.warn({ err, sessionId }, "chat_run.mark_running_failed");
  }
}

/**
 * Close the chat run a completion event belongs to.
 *
 * Prefers the run whose recorded `message_id` matches. Events from a Brain
 * that predates this carry none; falling back to every open chat row on the
 * session would close a turn that is still running -- a session is not
 * actually one-turn-at-a-time across the queued-drain window or a forced
 * interrupt idle. The fallback therefore fires only when exactly one row is
 * open, which is the case the missing id was meant to cover.
 *
 * `error_message` is bounded here rather than trusted: it comes from a failure
 * path, and failure paths are where oversized strings come from.
 *
 * @returns the ids of the rows it closed, so a caller releasing resources acts
 *   only on rows this statement actually settled.
 */
export interface CloseChatRunTarget {
  /** The row the reporter says it held. Absent from a Brain older than this contract. */
  taskId?: string;
  /** The generation that reporter was issued. Absent when its acceptance returned none. */
  runClaim?: number;
}

interface ClosedRow {
  task_id: string;
  prior_status: string;
  queued_since: string | null;
}

export async function closeChatRun(
  sessionId: string,
  messageId: string | undefined,
  outcome: ChatRunOutcome,
  failureReason?: string,
  target: CloseChatRunTarget = {},
): Promise<string[]> {
  const reason = outcome === "completed" ? null : (failureReason ?? outcome);
  const message = outcome === "completed" ? null : (failureReason ?? "").slice(0, 2000) || null;
  try {
    const closed = target.taskId
      ? await closeNamedChatRun(sessionId, target, outcome, reason, message)
      : await closeUnnamedChatRun(sessionId, messageId, outcome, reason, message);
    if (!closed.length) {
      // Not an error on its own: a run swept, cancelled or already closed by a
      // duplicate event has nothing left to close. The one case that fires by
      // construction is an abandoned queued message, which closes its own row
      // and then publishes the event that ends the turn.
      const expected = failureReason === "workspace_bind_failed";
      logger[expected ? "debug" : "info"](
        { sessionId, messageId, taskId: target.taskId, outcome, failureReason },
        "chat_run.close_matched_nothing",
      );
      return [];
    }
    for (const row of closed) {
      if (row.prior_status === "queued") {
        metrics.observeQueueExit("chat", row.queued_since ?? null, "chat_closed");
      }
    }
    const closedIds = closed.map((row) => row.task_id);
    if (messageId) await closeDuplicateDispatchSiblings(sessionId, messageId, closedIds[0]);
    // The run is over, so it is no longer a reason to keep the files and no
    // longer the workspace's writer. A run that failed still counts as having
    // changed it: it may have written half of what it meant to.
    for (const taskId of closedIds) await releaseRunUse(taskId);
    return closedIds;
  } catch (err) {
    logger.warn({ err, sessionId, messageId, outcome }, "chat_run.close_failed");
    return [];
  }
}

/**
 * Close the exact row the reporter held, under the generation it was issued.
 *
 * A superseded report -- a stale generation, or an unfenced attempt whose row a
 * fenced successor now holds -- matches nothing, so it can neither close the row
 * nor release its workspace under the successor.
 */
async function closeNamedChatRun(
  sessionId: string,
  target: CloseChatRunTarget,
  outcome: ChatRunOutcome,
  reason: string | null,
  message: string | null,
): Promise<ClosedRow[]> {
  const r = await db.query(
    `WITH prior AS (
       SELECT status, metadata->>'queued_since' AS queued_since
         FROM claw_tasks WHERE task_id = $1
     )
     UPDATE claw_tasks
        SET status = $3, failure_reason = $4, error_message = $5, completed_at = NOW()
      WHERE task_id = $1
        AND session_id = $2
        AND origin IN ('chat','a2a')
        AND status = ANY($6::text[])
        AND (
             COALESCE(claim_count, 0) = $7::int
          OR ($7::int IS NULL AND metadata->>'lease_fenced' IS DISTINCT FROM 'true')
        )
      RETURNING task_id,
                (SELECT p.status FROM prior p) AS prior_status,
                (SELECT p.queued_since FROM prior p) AS queued_since`,
    [
      target.taskId, sessionId, outcome, reason, message,
      CLOSEABLE_RUN_STATUSES, target.runClaim ?? null,
    ],
  );
  return r.rows as ClosedRow[];
}

/**
 * Close the row a completion that names no task must have meant.
 *
 * Only ever a guess, so it refuses whenever the guess could be wrong: more than
 * one candidate, a row for this message that is already terminal -- the event's
 * own subject may be the closed one -- or a candidate whose holder is fenced,
 * because a fenced holder always names its task.
 */
async function closeUnnamedChatRun(
  sessionId: string,
  messageId: string | undefined,
  outcome: ChatRunOutcome,
  reason: string | null,
  message: string | null,
): Promise<ClosedRow[]> {
  const r = await db.query(
    `WITH prior AS (
       SELECT task_id, status, metadata->>'queued_since' AS queued_since
         FROM claw_tasks WHERE session_id = $1 AND origin IN ('chat','a2a')
     )
     UPDATE claw_tasks
        SET status = $3, failure_reason = $4, error_message = $5, completed_at = NOW()
      WHERE session_id = $1
        AND origin IN ('chat','a2a')
        AND metadata->>'lease_fenced' IS DISTINCT FROM 'true'
        AND (
          (
            status = ANY($2::text[])
            AND metadata->>'message_id' = $6
            AND NOT EXISTS (
              SELECT 1 FROM claw_tasks settled
               WHERE settled.session_id = $1
                 AND settled.origin IN ('chat','a2a')
                 AND settled.metadata->>'message_id' = $6
                 AND NOT (settled.status = ANY($2::text[]))
            )
          )
          OR (
            $6::text IS NULL
            AND status = ANY($7::text[])
            AND NOT EXISTS (
              SELECT 1 FROM claw_tasks other
               WHERE other.session_id = $1
                 AND other.origin IN ('chat','a2a')
                 AND other.status = ANY($2::text[])
                 AND other.task_id <> claw_tasks.task_id
            )
          )
        )
      RETURNING task_id,
                (SELECT p.status FROM prior p WHERE p.task_id = claw_tasks.task_id) AS prior_status,
                (SELECT p.queued_since FROM prior p WHERE p.task_id = claw_tasks.task_id)
                  AS queued_since`,
    [
      sessionId, CLOSEABLE_RUN_STATUSES, outcome, reason, message,
      messageId ?? null, GUESSABLE_RUN_STATUSES,
    ],
  );
  const closed = r.rows as ClosedRow[];
  if (closed.length > 1) {
    logger.warn({ sessionId, messageId, closed: closed.map((row) => row.task_id) }, "chat_run.close_ambiguous");
  }
  return closed;
}

/**
 * A replayed dispatch's spare row, closed as the duplicate it is.
 *
 * Never given the reporting run's outcome: this row executed nothing. It closes
 * only with no holder evidence and only under the shared rollback guard, so a
 * second publish that outlived the stream's duplicate window is left to the
 * sweeper rather than terminalized under the Brain still holding it.
 */
async function closeDuplicateDispatchSiblings(
  sessionId: string,
  messageId: string,
  closedTaskId: string,
): Promise<void> {
  await db.query(
    `WITH prior AS (
       SELECT task_id,
              CASE WHEN status = 'queued' THEN metadata->>'queued_since' END AS queued_since,
              status AS prior_status
         FROM claw_tasks WHERE session_id = $1
     )
     UPDATE claw_tasks
        SET status = 'failed',
            failure_reason = 'duplicate_dispatch_row',
            error_message = 'a sibling row for this turn carried the run',
            completed_at = NOW(),
            metadata = jsonb_set(
              claw_tasks.metadata, '{dispatch_compensation}',
              jsonb_build_object(
                'version', 1, 'state', 'terminal',
                'failure_reason', to_jsonb('duplicate_dispatch_row'::text),
                'error_message', to_jsonb('a sibling row for this turn carried the run'::text)
              )
            )
      FROM prior
      WHERE claw_tasks.session_id = $1
        AND claw_tasks.origin = 'chat'
        AND prior.task_id = claw_tasks.task_id
        AND claw_tasks.metadata->>'message_id' = $2
        AND claw_tasks.task_id <> $3
        AND claw_tasks.status = ANY($4::text[])
        AND claw_tasks.lease_owner IS NULL
        AND claw_tasks.lease_expires_at IS NULL
        AND COALESCE(claw_tasks.claim_count, 0) = 0
        AND NOT (${UNSUPPORTED_RECEIPT_SQL})
        AND (${noDeliveryInFlightSql("$5", "$6")})
      RETURNING prior.prior_status, prior.queued_since`,
    [sessionId, messageId, closedTaskId, CLOSEABLE_RUN_STATUSES, RUN_FAT_PREPARING_RECONCILE, false],
  ).then((r) => {
    for (const row of r.rows as Array<{ prior_status: string; queued_since: string | null }>) {
      if (row.prior_status === "queued") {
        metrics.observeQueueExit("chat", row.queued_since ?? null, "duplicate_closed");
      }
    }
  }).catch((err) => {
    logger.warn({ err, sessionId, messageId }, "chat_run.duplicate_sibling_close_failed");
  });
}

/**
 * What a completion may close from.
 *
 * `queued` belongs here: a lease judged lost puts a row back on the queue while
 * its worker may still be finishing, and the completion that follows found
 * nothing to close -- the row stayed queued, kept its workspace reference and
 * its slice of the admission count, and hours later the queue reaper archived a
 * completed run as one that never started.
 */
const CLOSEABLE_RUN_STATUSES = ["queued", "preparing", "running", "cancelling"] as const;

/**
 * What an unnamed completion may guess at.
 *
 * `queued` is excluded: with no id the fallback closes a row on the grounds that
 * it is the only open one, and a queued row is the one state where that
 * inference is wrong -- it is a turn that has not run, and the event in hand
 * belongs to a turn whose row is already terminal. It still counts as another
 * open row, so its presence stops the fallback guessing at anything else.
 */
const GUESSABLE_RUN_STATUSES = ["preparing", "running", "cancelling"] as const;

/**
 * Close a run that was persisted but will never execute.
 *
 * The row is written before the publish, so a publish that fails leaves one
 * describing a run nobody will ever execute. A doorbell opens at `queued`; a
 * fat message opens at `preparing`. The caller is already rolling the session
 * back to idle; this rolls back the other half.
 *
 * `failureReason` is what an operator filters on, so the one caller that is not
 * a failed publish says so instead: a queued turn abandoned because its workspace
 * could never be bound is the same event the DAG dispatcher records as
 * `workspace_bind_failed`, and reading it as a dispatch failure sends whoever
 * finds it looking at NATS.
 */
/**
 * @returns what this call actually established, which is three answers and
 *   not two. `closed` means the row is failed and nothing will execute it.
 *   `held` means a worker has it and is running the turn, so the caller must
 *   not roll back -- refusing a live turn deletes the user's message and then
 *   answers it. `unknown` means the statement itself failed and neither of
 *   those was established.
 *
 *   `unknown` used to be folded into `held`, on the grounds that a row nobody
 *   closed would be picked up by `reapExpiredQueuedRuns`. That is true only on
 *   the doorbell path: it selects `status = 'queued'` and
 *   `metadata->>'dispatch' = 'doorbell'`, and a fat row is `preparing` with
 *   neither. Nothing reaps that row -- `reapLostLeases` wants a non-null
 *   `lease_expires_at` and `insertTask` never writes one, `reapStaleTasks`
 *   skips chat unless RUN_ROWS_SWEEPABLE -- so folding the two together left
 *   the row occupying an admission slot fleet-wide *and* skipped the rollback
 *   that would at least have freed the session.
 */
/**
 * Why the close matched nothing, which is not one answer but two.
 *
 * A row a worker holds does not match, and neither does a row that is already
 * terminal -- including the one this very function closed a moment ago.
 * Reading both as `held` is how a second compensation on the same row reports
 * that a turn is running: `handOffAssembledRun` throws after a successful
 * close, the outer dispatch catch compensates again on the task id its own
 * `failRun` wrapper just remembered, and this returns `held` for a row it had
 * already failed. The caller then skips the rollback and answers `dispatched`,
 * so the user's message stays in the conversation with nothing coming.
 *
 * A terminal row is `closed`: nothing will execute it, which is exactly what
 * the caller needs to know and exactly what a first successful close means.
 */
async function verdictForUnmatchedRow(
  taskId: string,
  statuses: readonly TaskStatus[],
): Promise<FailDispatchVerdict> {
  const r = await db.query(
    `SELECT status, lease_owner, lease_expires_at, claim_count, metadata
       FROM claw_tasks WHERE task_id = $1`,
    [taskId],
  );
  const row = r.rows[0] as {
    status?: string;
    lease_owner?: string | null;
    lease_expires_at?: unknown;
    claim_count?: unknown;
    metadata?: Record<string, unknown> | null;
  } | undefined;
  // Gone entirely: whatever closed it, nothing is going to run it.
  if (!row) return "closed";
  const held = hasHolderEvidence(row);
  // Cancellation leaves the holder's lease on the row it moves to
  // `cancelling`, so that combination is a live turn rather than debris.
  if (row.status === "cancelling" && held) {
    logger.info({ taskId }, "chat_run.fail_dispatch_skipped_held");
    return "held";
  }
  if (!statuses.includes(String(row.status) as TaskStatus)) {
    logger.info({ taskId, status: row.status }, "chat_run.fail_dispatch_already_terminal");
    return "closed";
  }
  if (held) {
    logger.info({ taskId }, "chat_run.fail_dispatch_skipped_held");
    return "held";
  }
  const parsed = parseDispatchCompensationRecord(row.metadata);
  if (parsed.kind === "unsupported") {
    logger.warn(
      { taskId, version: parsed.version },
      "sweeper.unsupported_dispatch_compensation",
    );
    return "unknown";
  }
  // Open, unheld, and yet the UPDATE matched nothing: something changed under
  // the statement. Nothing was established, so say so.
  logger.warn({ taskId, status: row.status }, "chat_run.fail_dispatch_unmatched");
  return "unknown";
}

/**
 * Whether any durable trace of a holder exists.
 *
 * Deliberately broader than "is a lease live": an expired or released holder
 * belongs to the lease and retry lifecycle, not to a pass that reclassifies a
 * run as one that never executed.
 */
function hasHolderEvidence(row: {
  lease_owner?: string | null;
  lease_expires_at?: unknown;
  claim_count?: unknown;
}): boolean {
  return Boolean(row.lease_owner)
    || row.lease_expires_at != null
    || Number(row.claim_count ?? 0) > 0;
}

/**
 * The states a settle is willing to close from.
 *
 * Shared with the statement rather than restated beside it: the two had
 * already drifted once -- the SQL closed from three states and the check that
 * reads the outcome recognised four -- which quietly turned a `cancelling` row
 * into "a worker is running this".
 */
export const OPEN_RUN_STATUSES = ["queued", "preparing", "running"] as const;

/**
 * What a pass acting on durable evidence may close from.
 *
 * `cancelling` is here and absent from {@link OPEN_RUN_STATUSES} because
 * certain non-delivery has to reach a row a Stop moved there a moment earlier:
 * that row is never held, its message is known not to exist, and nothing else
 * would reclaim it.
 */
export const SWEEPABLE_RUN_STATUSES = [...OPEN_RUN_STATUSES, "cancelling"] as const;

/** What a compensation established about the row it was asked to close. */
export type FailDispatchVerdict = "closed" | "held" | "unknown";

export interface FailDispatchOptions {
  /** Which open states this caller may close from. Defaults to the request path's. */
  statuses?: readonly TaskStatus[];
  /**
   * The exact receipt value the caller read, letting a malformed one be
   * replaced without blindly overwriting a value that changed since the read.
   */
  observedReceipt?: unknown;
  /** Whether the deployment asserts every Brain takes a holder before its gate. */
  fleetAsserted?: boolean;
  /** Whether this row's delivery has been observed settled on the durable. */
  deliverySettled?: boolean;
}

/**
 * The row a dispatch compensation is allowed to act on, whatever it then does.
 *
 * Bound identically by the terminalizing UPDATE and by {@link
 * discardChatRunDispatch}'s DELETE, so the two cannot drift into disagreeing
 * about which rows are safe to touch. Takes its placeholders because the two
 * statements carry different numbers of parameters of their own, and Postgres
 * refuses a bind that supplies one the statement does not reference.
 */
function unheldOpenRowSql(
  task: string, statuses: string, receipt: string, fleet: string, settled: string,
): string {
  return `task_id = ${task}
          AND origin = 'chat'
          AND status = ANY(${statuses}::text[])
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND COALESCE(claim_count, 0) = 0
          AND (
               metadata->'dispatch_compensation'->>'version' = '1'
               OR metadata->'dispatch_compensation' IS NULL
               OR metadata->'dispatch_compensation' IS NOT DISTINCT FROM ${receipt}::jsonb
          )
          AND (${noDeliveryInFlightSql(fleet, settled)})`;
}

/**
 * The one terminalizing CAS, taking the states it may close from as a parameter
 * so that one predicate serves every caller.
 *
 * Status, owner, lease, claim count and receipt form one atomic decision: no
 * preliminary SELECT may authorize the write, because a row accepted between
 * the two would be closed underneath its holder. The guard is bound rather than
 * read from configuration here, because one caller is exempt by evidence -- a
 * publish that certainly failed knows no message exists.
 */
export async function failChatRunDispatch(
  taskId: string | null,
  reason: string,
  failureReason = "dispatch_failed",
  opts: FailDispatchOptions = {},
): Promise<FailDispatchVerdict> {
  // No row exists, so nothing can be holding anything and the caller may roll
  // its session back without guessing.
  if (!taskId) {
    logger.info({ reason, failureReason }, "chat_run.fail_dispatch_no_row");
    return "closed";
  }
  const statuses = opts.statuses ?? OPEN_RUN_STATUSES;
  const message = reason.slice(0, 2000);
  const observed = opts.observedReceipt === undefined ? null : JSON.stringify(opts.observedReceipt);
  try {
    // Only while no durable holder evidence exists: `peekNextQueued` matches
    // the row the instant `insertTask` commits, so claim-next can be running
    // the turn by the time the dispatch this compensates for fails. A holder
    // settles its own row.
    const r = await db.query(
      `WITH prior AS (SELECT status FROM claw_tasks WHERE task_id = $1)
       UPDATE claw_tasks
          SET status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END,
              failure_reason = ${SETTLED_REASON_SQL},
              error_message = $3,
              completed_at = NOW(),
              metadata = jsonb_set(
                metadata, '{dispatch_compensation}',
                jsonb_build_object(
                  'version', 1,
                  'state', 'terminal',
                  'failure_reason', ${SETTLED_REASON_SQL},
                  'error_message', $3::text
                )
              )
        WHERE ${unheldOpenRowSql("$1", "$4", "$5", "$6", "$7")}
        RETURNING task_id, session_id, status, (SELECT p.status FROM prior p) AS prior_status`,
      [
        taskId, failureReason, message, statuses, observed,
        opts.fleetAsserted ?? false, opts.deliverySettled ?? false,
      ],
    );
    // Every statement after a non-match must be a SELECT: attaching a receipt,
    // releasing a workspace or altering a session here would act on a row this
    // call did not establish anything about.
    if (!r.rowCount) return await verdictForUnmatchedRow(taskId, statuses);
    if ((r.rows[0] as { prior_status?: string }).prior_status === "queued") {
      metrics.onQueueExited("dispatch_failed");
    }
    // Reached only when the row was still unheld, so nothing ever executed and
    // the workspace is exactly as the run found it.
    await releaseRunUse(taskId, false);
    return "closed";
  } catch (err) {
    // No catch-only metadata write is attempted: it would have the same
    // unavailable dependency as the statement that just failed. The INSERT-time
    // armed receipt is what the sweeper retries from.
    logger.warn({ err, taskId }, "chat_run.fail_dispatch_failed");
    return "unknown";
  }
}

/**
 * Erase a refused run's row instead of recording it as failed.
 *
 * A turn the fleet declined is not a fault the caller should find recorded --
 * criterion: a refused create leaves nothing behind. Shares {@link
 * unheldOpenRowSql} and the unmatched-row verdict with {@link
 * failChatRunDispatch}, differing only in the verb, so a row a worker already
 * holds is still left to its holder and still answers `"held"`.
 *
 * @returns `closed` when the row is gone, `held` when a worker has it, and
 *   `unknown` for a row still open and unheld that the DELETE did not match --
 *   which is a row `peekNextQueued` can still claim and run.
 */
export async function discardChatRunDispatch(
  taskId: string | null,
  opts: FailDispatchOptions = {},
): Promise<FailDispatchVerdict> {
  if (!taskId) {
    logger.info({}, "chat_run.discard_dispatch_no_row");
    return "closed";
  }
  const statuses = opts.statuses ?? OPEN_RUN_STATUSES;
  const observed = opts.observedReceipt === undefined ? null : JSON.stringify(opts.observedReceipt);
  try {
    const r = await db.query(
      `DELETE FROM claw_tasks
        WHERE ${unheldOpenRowSql("$1", "$2", "$3", "$4", "$5")}
        RETURNING task_id`,
      [
        taskId, statuses, observed,
        opts.fleetAsserted ?? false, opts.deliverySettled ?? false,
      ],
    );
    if (!r.rowCount) return await verdictForUnmatchedRow(taskId, statuses);
    await releaseRunUse(taskId, false);
    return "closed";
  } catch (err) {
    logger.warn({ err, taskId }, "chat_run.discard_dispatch_failed");
    return "unknown";
  }
}

/**
 * The reason a settle records, which is not the caller's for a stopped turn.
 *
 * A user who pressed Stop is owed that answer rather than a dispatch failure,
 * and the row columns and the receipt must carry the same value.
 */
const SETTLED_REASON_SQL =
  "CASE WHEN status = 'cancelling' THEN 'cancelled_before_dispatch_confirmed' ELSE $2 END";

/**
 * Cancel doorbell rows that Stop can never reach over NATS.
 *
 * A queued turn has no worker listening on `interrupt.<sessionId>`. Preparing
 * without a holder is the same: dispatcher CAS or an unclaim in flight. A
 * leased preparing/running row is already in a Brain, so the NATS interrupt
 * still owns that half.
 *
 * All of which is true of a doorbell row and of nothing else, so the predicate
 * says so. The fat path opens at `preparing` and leaves `lease_owner` null
 * until the worker's first renewal -- the renewal endpoint is the only writer
 * of that column -- so for the whole of delivery, the workspace gate and the
 * lock wait, a live fat run is indistinguishable on status alone from a
 * doorbell nobody took. Cancelling one of those closes the row, releases the
 * workspace reference and idles the session while its JetStream message is
 * still on the stream and about to execute: the interrupt published beside
 * this call is core NATS, so if the worker has not subscribed yet it is simply
 * lost, and the run carries on with nothing recording it.
 */
export async function interruptUnstartedChatRuns(sessionId: string): Promise<number> {
  let rows: Array<{
    task_id: string; message_id: string | null; user_id: string | null; prompt: string | null;
    prior_status: string; queued_since: string | null;
  }>;
  try {
    const r = await db.query(
      `WITH prior AS (
         SELECT task_id, status, metadata->>'queued_since' AS queued_since
           FROM claw_tasks WHERE session_id = $1 AND origin = 'chat'
       )
       UPDATE claw_tasks
          SET status = 'cancelled',
              failure_reason = 'cancelled',
              error_message = 'interrupted before a worker claimed the run',
              completed_at = NOW()
        WHERE session_id = $1
          AND origin = 'chat'
          AND metadata->>'dispatch' = 'doorbell'
          AND (
            status = 'queued'
            OR (status = 'preparing' AND lease_owner IS NULL)
          )
        RETURNING task_id, prompt,
                  metadata->>'message_id' AS message_id,
                  COALESCE(metadata->>'user_id', input->>'user_id') AS user_id,
                  (SELECT p.status FROM prior p WHERE p.task_id = claw_tasks.task_id)
                    AS prior_status,
                  (SELECT p.queued_since FROM prior p WHERE p.task_id = claw_tasks.task_id)
                    AS queued_since`,
      [sessionId],
    );
    rows = r.rows as typeof rows;
    for (const row of rows) {
      if (row.prior_status === "queued") {
        metrics.observeQueueExit("chat", row.queued_since, "cancelled");
      }
    }
  } catch (err) {
    // Zero is "there was nothing to cancel", which is what a Stop reports
    // success on. A failed statement knows neither, so it must be the caller's
    // to answer.
    logger.warn({ err, sessionId }, "chat_run.interrupt_unstarted_failed");
    throw err;
  }
  if (!rows.length) return 0;
  for (const row of rows) {
    await releaseRunUse(row.task_id, false);
    await announceInterruptedUnstarted(sessionId, row);
  }
  // Anything non-terminal left on this session keeps the gate shut, whether or
  // not it carries a lease. `lease_owner IS NOT NULL` used to stand in for "a
  // Brain has this", which is the same mistake as the predicate above: it does
  // not see a fat row that is executing but has not renewed yet, and idling the
  // session under one lets the next message dispatch on top of a live run.
  const stillHeld = await db.query(
    `SELECT 1 FROM claw_tasks
      WHERE session_id = $1
        AND origin = 'chat'
        AND status IN ('queued','preparing','running','cancelling')
      LIMIT 1`,
    [sessionId],
  );
  if ((stillHeld.rowCount ?? 0) === 0) {
    await db.query(
      `UPDATE claw_sessions
          SET agent_status = 'idle', agent_gate_message_id = NULL, updated_at = NOW()
        WHERE session_id = $1 AND agent_status = 'running' AND deleted_at IS NULL`,
      [sessionId],
    );
  }
  return rows.length;
}

/**
 * Everything a Stop must reach durably on this session.
 *
 * The doorbell half is unchanged. The fat half is what a Stop could not reach
 * at all: a fat row sits at `preparing` with null holder columns for the whole
 * of delivery, so `cancelTask`'s status-only guess moved it to `cancelling`
 * and nothing reaped it from there -- the stale-task reaper skips chat, the
 * lost-lease reaper wants a lease this row never had, and the request path's
 * own state list excludes `cancelling`. The row and its session gate wedged
 * for the life of the deployment.
 *
 * Holder evidence is read in the statement that writes the new status, and it
 * is *current* evidence rather than the durable kind the compensation passes
 * use: a Stop asks whether a worker holds this row now. A positive claim count
 * is deliberately absent from that question -- it records that somebody once
 * held the row, and a requeued row carries one while being held by nobody.
 */
export async function interruptSessionRuns(sessionId: string): Promise<number> {
  const cancelled = await interruptUnstartedChatRuns(sessionId);
  return cancelled + await cancelUnheldFatRuns(sessionId);
}

/**
 * Both halves of a Stop: the wire interrupt, then the durable cancellation.
 *
 * The wire half reaches only a worker already subscribed, so its failure alone
 * is survivable. The durable half is what makes a Stop stick, and a caller told
 * `ok` for one that threw would never retry it, so that failure is rethrown.
 *
 * @returns how many runs the durable half settled.
 */
export async function stopSessionRuns(sessionId: string): Promise<number> {
  try {
    chatRunPorts.publishInterrupt(interruptSubject(sessionId));
  } catch (err) {
    logger.warn({ err, sessionId }, "chat_run.interrupt_publish_failed");
  }
  return await interruptSessionRuns(sessionId);
}

/**
 * Terminalize the fat rows on this session that no worker holds.
 *
 * Held rows keep today's `cancelling` handshake and their existing reapers.
 * While no arm of the shared guard holds, every fat row reads as held, so this
 * reproduces today's transition exactly.
 */
async function cancelUnheldFatRuns(sessionId: string): Promise<number> {
  return cancelUnheldFat("session_id = $1", sessionId);
}

/**
 * The same terminalization for one named row, for the cancel that names a task
 * rather than a session.
 */
export async function cancelUnheldFatRun(taskId: string): Promise<boolean> {
  return (await cancelUnheldFat("task_id = $1", taskId)) > 0;
}

async function cancelUnheldFat(scope: string, scopeValue: string): Promise<number> {
  const held = `(
    lease_owner IS NOT NULL
    OR lease_expires_at IS NOT NULL
    OR (status IN ('preparing','running') AND NOT (${noDeliveryInFlightSql("$2", "$3")}))
  )`;
  try {
    const r = await db.query(
      `WITH prior AS (
         SELECT task_id, status FROM claw_tasks WHERE ${scope} AND origin = 'chat'
       )
       UPDATE claw_tasks
          SET status = CASE WHEN ${held} THEN 'cancelling' ELSE 'cancelled' END,
              failure_reason = CASE WHEN ${held} THEN failure_reason
                                    ELSE 'cancelled_before_dispatch_confirmed' END,
              error_message = CASE WHEN ${held} THEN error_message
                                   ELSE $4::text END,
              completed_at = CASE WHEN ${held} THEN completed_at ELSE NOW() END,
              metadata = CASE
                WHEN ${held} THEN metadata
                ELSE jsonb_set(
                  metadata, '{dispatch_compensation}',
                  jsonb_build_object(
                    'version', 1, 'state', 'terminal',
                    'failure_reason', to_jsonb('cancelled_before_dispatch_confirmed'::text),
                    'error_message', to_jsonb($4::text)
                  )
                )
              END
        WHERE ${scope}
          AND origin = 'chat'
          AND (metadata->>'dispatch' = 'fat' OR metadata->>'dispatch' IS NULL)
          AND status IN ('preparing','running')
        RETURNING task_id, status,
                  (SELECT p.status FROM prior p WHERE p.task_id = claw_tasks.task_id) AS prior_status`,
      [
        scopeValue, RUN_FAT_PREPARING_RECONCILE, false,
        "the user stopped this turn before any worker took a lease on it",
      ],
    );
    const rows = r.rows as Array<{ task_id: string; status: string; prior_status?: string }>;
    const terminal = rows.filter((row) => row.status === "cancelled");
    const leftQueue = rows.filter((row) => row.prior_status === "queued").length;
    if (leftQueue) metrics.onQueueExited("cancelled", leftQueue);
    for (const row of terminal) await releaseRunUse(row.task_id, false);
    return terminal.length;
  } catch (err) {
    logger.warn({ err, scope: scopeValue }, "chat_run.cancel_unheld_fat_failed");
    throw err;
  }
}

/**
 * Break a session gate that an interrupt did not manage to close.
 *
 * The last resort behind Stop: a turn whose `exec_complete` never arrives
 * leaves `agent_status` at `running` for good, and every later message parks
 * behind it. Called on a timer, so by the time it runs the interrupt has had
 * its chance and anything still here is stuck.
 *
 * Unless it is not. This was the one writer of the column with no idea what
 * the session still held, so thirty seconds after a stop it handed the
 * conversation back whether or not a Brain was mid-turn, and the next message
 * dispatched alongside the live run. A lease still in the future is the single
 * unambiguous sign of a holder -- a worker renews it continuously and nothing
 * else writes it -- so that, and only that, stays its hand. A lapsed lease, or
 * none at all, is exactly the stuck case this exists for.
 *
 * @returns whether the gate was actually released.
 */
export async function forceIdleAfterInterrupt(
  sessionId: string,
  gateOwner: string | null = null,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE claw_sessions
        SET agent_status = 'idle', agent_gate_message_id = NULL, updated_at = NOW()
      WHERE session_id = $1
        AND agent_status = 'running'
        AND (NOT $2::boolean OR agent_gate_message_id = $3)
        AND NOT EXISTS (
          SELECT 1 FROM claw_tasks t
           WHERE t.session_id = $1
             AND t.origin = 'chat'
             AND t.status IN ('preparing','running','cancelling')
             AND (
               t.lease_expires_at > NOW()
               OR ($4::boolean AND ${UNSETTLED_FAT_DELIVERY_SQL})
             )
        )`,
    [sessionId, gateOwner !== null && gateOwnershipEnforced(), gateOwner, gateOwnershipEnforced()],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * A fat or legacy-fat delivery this session may still be holding.
 *
 * An absent lease is not an absent holder here: a fat run has null holder
 * columns for the whole of delivery, the workspace gate and the lock wait, so
 * handing the gate back on that evidence dispatches a second turn on top of a
 * live one. The cost is a gate that stays shut until the row is terminal, which
 * is bounded by the reconciliation pass that only runs under the same
 * assertion.
 */
const UNSETTLED_FAT_DELIVERY_SQL = `(
  t.origin = 'chat'
  AND (t.metadata->>'dispatch' = 'fat' OR t.metadata->>'dispatch' IS NULL)
  AND t.status IN ('preparing','running','cancelling')
)`;

/**
 * Whether a reader may act on the gate-ownership marker.
 *
 * Writers set it unconditionally from the moment this ships, so the value is
 * accurate for every new replica. Reading it is what must wait: a replica that
 * predates the column takes the gate without naming its turn and releases it
 * without clearing the marker, so a value one turn wrote can survive under a
 * later turn an old replica owns. Until the fleet assertion holds, releases
 * behave exactly as they do today.
 */
export function gateOwnershipEnforced(): boolean {
  return RUN_FAT_PREPARING_RECONCILE;
}

/** Take the session gate for one turn, naming the turn that holds it. */
export async function takeSessionGate(
  sessionId: string,
  messageId: string,
  client?: { query: (text: string, params?: unknown[]) => Promise<unknown> },
): Promise<void> {
  const q = client ?? db;
  await q.query(
    `UPDATE claw_sessions
        SET agent_status = 'running', agent_gate_message_id = $2, updated_at = NOW()
      WHERE session_id = $1 AND deleted_at IS NULL`,
    [sessionId, messageId],
  );
}

/**
 * Hand the gate back on behalf of one turn.
 *
 * The rollback clears the marker only while it still names the message being
 * rolled back: a later turn may already own the gate by the time a failed
 * dispatch gets here, and clearing it then would leave that turn unnamed.
 */
export async function releaseSessionGateForTurn(
  sessionId: string,
  messageId: string,
): Promise<void> {
  await db.query(
    `UPDATE claw_sessions
        SET agent_status = 'idle',
            agent_gate_message_id = NULL,
            updated_at = NOW()
      WHERE session_id = $1
        AND deleted_at IS NULL
        AND (NOT $3::boolean OR agent_gate_message_id IS NOT DISTINCT FROM $2)`,
    [sessionId, messageId, gateOwnershipEnforced()],
  );
}

async function announceInterruptedUnstarted(
  sessionId: string,
  row: { task_id: string; message_id: string | null; user_id: string | null; prompt: string | null },
): Promise<void> {
  const finalText = "Interrupted before the run started.";
  const of = (event: Record<string, unknown>): Record<string, unknown> => ({
    session_id: sessionId,
    message_id: row.message_id ?? undefined,
    task_id: row.task_id,
    ...event,
  });
  try {
    await chatRunPorts.publishSessionEvent(sessionId, of({
      type: "AssistantMessage",
      data: { content: [{ type: "text", text: finalText }] },
    }));
    await chatRunPorts.publishSessionEvent(sessionId, of({ type: "ResultMessage" }));
    await chatRunPorts.publishSessionEvent(sessionId, of({
      type: "exec_complete",
      user_id: row.user_id || "default",
      prompt: row.prompt ?? "",
      final_text: finalText,
      failed: false,
      interrupted: true,
      error_count: 0,
      skills_used: {},
    }));
  } catch (err) {
    logger.warn({ err, sessionId, taskId: row.task_id }, "chat_run.interrupt_unstarted_announce_failed");
  }
}
