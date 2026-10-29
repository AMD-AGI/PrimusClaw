// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// Reads behind the A2A context/task model: a run row (the task), the session it
// ran in (the context) and the events written during that run.
//
// Every read is scoped by the caller. The session's `a2a_caller_id` is the
// tenant boundary for the A2A surface (see extractCallerId in a2a.ts), so a
// task that belongs to another caller is indistinguishable from one that does
// not exist.
// ---------------------------------------------------------------------------

import { db } from "../infra/db.js";
import { sanitizeSessionEvent } from "../events/store.js";
import type { RunEvent, RunRecord } from "./a2a-task-view.js";

// The event types the task view reads. A session also holds every tool output
// and thinking block, none of which a task needs.
const VIEW_EVENTS = [
  "AssistantMessage", "chat", "chatDelta", "toolUsed", "statusUpdate",
  "permissionRequest", "userQuestion", "decisionResult", "exec_complete",
];

const RUN_COLUMNS = `
  t.task_id, t.session_id, t.status, t.prompt, t.failure_reason, t.error_message,
  t.created_at, t.completed_at, t.metadata->>'message_id' AS message_id,
  s.context_id`;

function runOf(row: Record<string, unknown>): RunRecord {
  return {
    taskId: String(row.task_id),
    sessionId: String(row.session_id),
    contextId: String(row.context_id ?? ""),
    messageId: String(row.message_id ?? ""),
    status: String(row.status),
    prompt: (row.prompt as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: row.created_at as Date,
    completedAt: (row.completed_at as Date | null) ?? null,
  };
}

/** The run `taskId`, if it is an A2A run in a session this caller owns. */
export async function loadRunForCaller(taskId: string, callerId: string): Promise<RunRecord | null> {
  const r = await db.query(
    `SELECT ${RUN_COLUMNS}
       FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id
      WHERE t.task_id = $1 AND t.origin = 'a2a'
        AND s.a2a_caller_id = $2 AND s.deleted_at IS NULL`,
    [taskId, callerId],
  );
  return r.rows[0] ? runOf(r.rows[0] as Record<string, unknown>) : null;
}

/** The run `taskId` whoever owns it, for the push worker, which acts for no caller. */
export async function loadRun(taskId: string): Promise<RunRecord | null> {
  const r = await db.query(
    `SELECT ${RUN_COLUMNS}
       FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id
      WHERE t.task_id = $1 AND t.origin = 'a2a'`,
    [taskId],
  );
  return r.rows[0] ? runOf(r.rows[0] as Record<string, unknown>) : null;
}

/** The newest A2A run of a session, the one its live events belong to. */
export async function loadLatestRunOfSession(sessionId: string): Promise<RunRecord | null> {
  const r = await db.query(
    `SELECT ${RUN_COLUMNS}
       FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id
      WHERE t.session_id = $1 AND t.origin = 'a2a'
      ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1`,
    [sessionId],
  );
  return r.rows[0] ? runOf(r.rows[0] as Record<string, unknown>) : null;
}

/**
 * The events of one run, oldest first.
 *
 * The send writes a `UserMessage` event named by the run's message id; a run's
 * events are everything from there to the next `UserMessage` of the session.
 * Brain does not stamp every event with its turn, so the position in the log is
 * what ties an event to a run. A context runs one task at a time, which is what
 * makes the window unambiguous.
 */
export async function loadRunEvents(run: Pick<RunRecord, "sessionId" | "messageId">): Promise<RunEvent[]> {
  const start = `(SELECT id FROM claw_session_events
                   WHERE session_id = $1 AND event = 'UserMessage' AND event_id = $2
                     AND deleted_at IS NULL LIMIT 1)`;
  const r = await db.query(
    `SELECT e.id, e.event, e.created_at,
            CASE e.event
              WHEN 'toolUsed' THEN jsonb_build_object(
                'type', e.data->'type', 'tool', e.data->'tool', 'status', e.data->'status',
                'description', e.data->'description', 'actionId', e.data->'actionId')
              WHEN 'exec_complete' THEN jsonb_build_object(
                'type', e.data->'type', 'message_id', e.data->'message_id',
                'failed', e.data->'failed', 'interrupted', e.data->'interrupted',
                'failure_reason', e.data->'failure_reason', 'final_text', e.data->'final_text')
              ELSE e.data
            END AS data
       FROM claw_session_events e
      WHERE e.session_id = $1 AND e.deleted_at IS NULL
        AND e.event = ANY($3::text[])
        AND e.id >= COALESCE(${start}, 0)
        AND e.id < COALESCE((
              SELECT MIN(n.id) FROM claw_session_events n
               WHERE n.session_id = $1 AND n.event = 'UserMessage' AND n.deleted_at IS NULL
                 AND n.id > COALESCE(${start}, 0)), 9223372036854775807)
      ORDER BY e.id`,
    [run.sessionId, run.messageId, VIEW_EVENTS],
  );
  // The events leave this module only as a task view, and a task view repeats
  // whatever the agent said, so they are masked like every other event that
  // leaves the API.
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    event: String(row.event),
    createdAt: row.created_at as Date,
    data: sanitizeSessionEvent((row.data ?? {}) as Record<string, unknown>),
  }));
}

export interface ListRunsFilter {
  callerId: string;
  contextId?: string;
  /** Row statuses a state maps to; undefined for no restriction. */
  statuses?: string[];
  after?: Date;
  cursor?: { at: Date; taskId: string };
  limit: number;
}

const STATUS_AT = "COALESCE(t.completed_at, t.started_at, t.created_at)";

/** Runs of one caller, newest status first. Returns the rows and the count the filter matches. */
export async function listRunsForCaller(
  f: ListRunsFilter,
): Promise<{ runs: Array<RunRecord & { statusAt: Date }>; total: number }> {
  const where: string[] = ["t.origin = 'a2a'", "s.a2a_caller_id = $1", "s.deleted_at IS NULL"];
  const params: unknown[] = [f.callerId];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (f.contextId) add("s.context_id = ?", f.contextId);
  if (f.statuses) add("t.status = ANY(?::text[])", f.statuses);
  if (f.after) add(`${STATUS_AT} >= ?`, f.after);
  const filter = where.join(" AND ");
  const total = Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id WHERE ${filter}`,
    params,
  )).rows[0].n);
  const pageWhere = [filter];
  if (f.cursor) {
    params.push(f.cursor.at, f.cursor.taskId);
    pageWhere.push(`(${STATUS_AT} < $${params.length - 1} OR (${STATUS_AT} = $${params.length - 1} AND t.task_id < $${params.length}))`);
  }
  params.push(f.limit);
  const r = await db.query(
    `SELECT ${RUN_COLUMNS}, ${STATUS_AT} AS status_at
       FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id
      WHERE ${pageWhere.join(" AND ")}
      ORDER BY ${STATUS_AT} DESC, t.task_id DESC
      LIMIT $${params.length}`,
    params,
  );
  return {
    runs: (r.rows as Array<Record<string, unknown>>).map((row) => ({
      ...runOf(row), statusAt: row.status_at as Date,
    })),
    total,
  };
}

/**
 * Wait, briefly, for the run row to reach a terminal status.
 *
 * The end of a run reaches a stream as an event, and the consumer closes the
 * row from the same event a moment later. A caller told COMPLETED who then asks
 * `GetTask` must not read WORKING, so the stream's last word waits for the row.
 */
export async function settleRun(
  taskId: string,
  timeoutMs: number,
  pollMs = 100,
): Promise<RunRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await loadRun(taskId);
    if (!run) return null;
    if (run.status === "completed" || run.status === "failed"
      || run.status === "cancelled" || run.status === "cancelling") return run;
    if (Date.now() >= deadline) return run;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
