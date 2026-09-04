// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform's account of a run.
 *
 *   GET /v1/runs/:runId
 *   GET /v1/runs?ids=a,b,c
 *   GET /v1/runs?session_ids=a,b,c
 *   GET /v1/runs?state=terminal&since=<iso>&limit=N&cursor=<opaque>
 *
 * Separate from `/v1/tasks/:id` on purpose. That surface answers in session
 * terms -- prompts, captures, DAG structure -- and a dispatcher above Claw needs
 * none of it. What it needs is three facts nobody else can supply: did the
 * process end, was it us, and why.
 *
 * The batch form is not a convenience. A dispatcher sweeps its live runs every
 * thirty seconds and the sweep in question is a couple of hundred wide, so a
 * per-run endpoint alone would be two hundred calls every half minute. Both forms
 * are one query, because the terminal facts are written when the run ends rather
 * than resolved on read.
 *
 * The batch form takes either key. A dispatcher above Claw never sees a task id --
 * it holds the session id `POST /v1/sessions` returned and stored that on its run
 * row -- so a surface that only answered to `ktsk_...` was one it could not call
 * at all, and `?ids=<session id>` gave it an empty `runs` array indistinguishable
 * from "none of those have finished". Both keys are columns on the row, so this is
 * a change of predicate rather than a join.
 *
 * A session owns many runs -- a DAG expands to a root plus a row per node, a batch
 * to one of those per input, a chat to a row per turn -- so `?session_ids=` can
 * answer with more runs than it was given ids. `run_id` remains the identity of a
 * run; `session_id` is what groups them.
 *
 * Deliberately not here: what the run concluded. `stop_reason`, gains, whether
 * the optimization was any good -- that is the workload's vocabulary, it is still
 * growing, and an API of ours that knew those words would have to change when they
 * do and would mean nothing to any other workload.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { isAdmin } from "../auth/models.js";
import { db } from "../infra/db.js";
import { phaseOf, terminalFacts, type RunView } from "./platform-terminal.js";

const logger = pino({ name: "runs-routes" });

/**
 * Rows one batch call may return.
 *
 * The requirement is 200 in a single call -- the width of one sweep of the model
 * sweep at full concurrency. This clears it with room for a caller that batches
 * two sweeps together, and stays a page rather than a dump.
 */
const MAX_BATCH = 1000;
const DEFAULT_LIMIT = 200;
const MAX_CURSOR_LENGTH = 2048;

/**
 * Ids one `?ids=` call may name, which is a smaller number than MAX_BATCH.
 *
 * A task id and its comma are 32 bytes, so 1000 of them is a ~32 KB query string
 * against Node's 16 KB limit on the request line and headers together. A caller
 * working up to a ceiling it was told about would get a transport error with no
 * mention of a size, on some requests and not others, depending on how many ids
 * that sweep happened to have. 500 is ~16 KB, and still more than twice the
 * required width.
 */
const MAX_IDS_PER_CALL = 500;

/**
 * Session ids one `?session_ids=` call may name, which is fewer than
 * MAX_IDS_PER_CALL for the reason that produced that number.
 *
 * A session id is a UUID, so with its comma it is 37 bytes against a task id's
 * 32, and the task-id ceiling applied here would be ~18.5 KB of request line --
 * back over the same 16 KB limit. Measured rather than reasoned about: 500 UUIDs
 * on this route answer HTTP 431 with no body, which is exactly the sizeless
 * transport error the task-id cap exists to keep callers away from. 350 is ~13 KB
 * and leaves room for the headers a real client sends, while still being well
 * over the 200-wide sweep this serves.
 *
 * Callers should read `max_ids` off the `too_many_ids` refusal rather than hold
 * either number, since which one applies depends on the parameter they used.
 */
const MAX_SESSION_IDS_PER_CALL = 350;

/** A way of naming runs outright in `GET /v1/runs`, and the column it matches. */
interface IdFilter {
  param: "ids" | "session_ids";
  column: "task_id" | "session_id";
  max: number;
}

/**
 * Both keys a caller might hold, because the systems either side of this API hold
 * different ones. Claw's own callers have the `ktsk_...` id the task surface
 * returns; a dispatcher above it has the session id from `POST /v1/sessions`,
 * which is what it stored on its run row and what every other contract between
 * the two is on. Both are columns on the row already, so neither costs a join --
 * what would cost is making one of the two sides keep a mapping.
 */
const ID_FILTERS: readonly IdFilter[] = [
  { param: "ids", column: "task_id", max: MAX_IDS_PER_CALL },
  { param: "session_ids", column: "session_id", max: MAX_SESSION_IDS_PER_CALL },
];

interface RunRow {
  task_id: string;
  session_id: string;
  status: string;
  failure_reason: string | null;
  sandbox_workload_id: string | null;
  platform_exit_code: number | null;
  platform_node: string | null;
  platform_message: string | null;
  platform_container_reason: string | null;
  created_at: string | Date | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  deadline_at: string | Date | null;
  /** PostgreSQL's exact text, preserving precision beyond JavaScript milliseconds. */
  cursor_completed_at?: string;
}

const SELECT_COLUMNS = `
  task_id, session_id, status, failure_reason, sandbox_workload_id,
  platform_exit_code, platform_node, platform_message, platform_container_reason,
  created_at, started_at, completed_at, deadline_at
`;

function iso(value: string | Date | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

/** One row as the contract renders it. */
export function toRunView(row: RunRow): RunView {
  const terminal = terminalFacts({
    status: row.status,
    failure_reason: row.failure_reason,
    pod_failed_message: row.platform_message ?? "",
    container_reason: row.platform_container_reason ?? "",
    exit_code: row.platform_exit_code,
  });
  return {
    run_id: row.task_id,
    session_id: row.session_id,
    phase: phaseOf(row.status),
    terminal,
    timestamps: {
      created_at: iso(row.created_at),
      started_at: iso(row.started_at),
      terminal_at: iso(row.completed_at),
    },
    placement: {
      node: row.platform_node ?? "",
      workload_id: row.sandbox_workload_id ?? "",
    },
  };
}

/** Ids from `?ids=a,b,c`, de-duplicated. Not bounded here -- see the caller. */
function parseIds(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

interface RunCursor {
  completedAt: string;
  taskId: string;
}

function encodeCursor(row: RunRow): string {
  const completedAt = row.cursor_completed_at ?? iso(row.completed_at);
  if (!completedAt) {
    logger.error({ runId: row.task_id }, "runs.terminal_missing_completed_at");
    throw new Error(`terminal run ${row.task_id} has no completed_at`);
  }
  return Buffer.from(JSON.stringify([completedAt, row.task_id]), "utf8").toString("base64url");
}

function decodeCursor(raw: string): RunCursor | null {
  if (!raw || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [completedAt, taskId] = value;
    if (
      typeof completedAt !== "string"
      || Number.isNaN(new Date(completedAt).getTime())
      || typeof taskId !== "string"
      || taskId.trim() === ""
    ) {
      return null;
    }
    // Keep the timestamp exactly as PostgreSQL returned it. Reformatting through
    // Date would truncate microseconds and can skip a neighbouring row.
    return { completedAt, taskId };
  } catch {
    return null;
  }
}

/** The predicate limiting a read to rows the caller owns, and its bind values. */
interface Scope {
  /** SQL fragment with `$USER` standing in for the parameter position. */
  clause: string;
  params: unknown[];
}

/**
 * Rows this caller may see.
 *
 * Scoped by session ownership, the same rule the task surface applies, rather
 * than left open because the payload looks harmless. A run id plus a node name
 * is a map of who is running what and where, and the batch form hands over
 * hundreds at a time.
 */
function scope(req: FastifyRequest): Scope {
  const user = getUser(req);
  if (user && isAdmin(user)) return { clause: "", params: [] };
  return {
    clause: `AND session_id IN (SELECT session_id FROM claw_sessions WHERE user_id = $USER)`,
    params: [user?.userId ?? ""],
  };
}

/** What `GET /v1/runs` reads off the query string. */
interface RunsQuery {
  ids?: string;
  session_ids?: string;
  state?: string;
  since?: string;
  limit?: string;
  cursor?: string;
}

/**
 * Answer for runs the caller named outright, by whichever key it holds.
 *
 * Returns null when the request named none, which is the listing form's cue to
 * take over.
 */
async function readNamedRuns(q: RunsQuery, s: Scope, reply: FastifyReply): Promise<unknown> {
  const named = ID_FILTERS.filter((f) => q[f.param]);
  // Refused rather than intersected, on the reasoning `too_many_ids` already
  // uses. A caller naming runs both ways does not know which key it is holding,
  // and every answer available here reads as confirmation that it does: an
  // intersection looks like a normal empty result when the two disagree, and
  // letting one parameter win silently ignores half the request.
  if (named.length > 1) {
    return reply.status(400).send({
      ok: false,
      error: "ids_and_session_ids_are_exclusive",
      detail: "name runs by task id or by session id, not both",
    });
  }
  const filter = named[0];
  if (!filter) return null;

  if (q.cursor !== undefined) {
    return reply.status(400).send({ ok: false, error: "cursor_not_allowed_with_ids" });
  }
  const ids = parseIds(q[filter.param] ?? "");
  if (ids.length === 0) {
    return reply.status(400).send({ ok: false, error: `${filter.param} must not be empty` });
  }
  // Refused rather than trimmed. This used to stop reading at the cap and
  // answer for the ids it had, and the response said `requested` = the
  // trimmed count -- so a caller over the limit was told about exactly the
  // runs it asked about, and never learnt that the rest of its dispatches
  // were not in the answer. A caller that has to chunk should be told to.
  if (ids.length > filter.max) {
    return reply.status(400).send({
      ok: false,
      error: "too_many_ids",
      detail: `${ids.length} ids; at most ${filter.max} per call`,
      max_ids: filter.max,
    });
  }
  const r = await db.query(
    // `filter.column` is one of two literals from ID_FILTERS, never caller text.
    `SELECT ${SELECT_COLUMNS} FROM claw_tasks
      WHERE ${filter.column} = ANY($1) ${s.clause.replace("$USER", "$2")}
      ORDER BY created_at, task_id`,
    [ids, ...s.params],
  );
  // Ids that matched nothing are absent rather than rendered as a run in an
  // unknown state: a caller polling its own dispatches must be able to tell
  // "not ours" from "not finished". `requested` counts the ids named, so for
  // `?session_ids=` it is a count of sessions and `runs` may be longer --
  // each run carries its `session_id` for the caller to group on.
  return { runs: (r.rows as RunRow[]).map(toRunView), requested: ids.length };
}

/** Walk terminal runs newest-first, one keyset page at a time. */
async function listTerminalRuns(q: RunsQuery, s: Scope, reply: FastifyReply): Promise<unknown> {
  const state = (q.state ?? "").trim().toLowerCase();
  if (state !== "terminal") {
    return reply.status(400).send({
      ok: false,
      error: "state must be 'terminal' when ids are not provided",
    });
  }
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (!/^\d+$/.test(q.limit)) {
      return reply.status(400).send({ ok: false, error: "limit must be a whole number" });
    }
    limit = Number(q.limit);
    if (limit < 1 || limit > MAX_BATCH) {
      return reply.status(400).send({
        ok: false,
        error: `limit must be between 1 and ${MAX_BATCH}`,
      });
    }
  }
  const hasCursor = q.cursor !== undefined;
  const cursor = hasCursor ? decodeCursor(q.cursor ?? "") : null;
  if (hasCursor && !cursor) {
    return reply.status(400).send({ ok: false, error: "invalid_cursor" });
  }
  const since = q.since?.trim() || null;
  if (since && Number.isNaN(new Date(since).getTime())) {
    return reply.status(400).send({ ok: false, error: "since must be an ISO timestamp" });
  }

  const params: unknown[] = [];
  const filters = [`status IN ('completed','failed','cancelled')`];
  if (since) {
    params.push(since);
    filters.push(`completed_at >= $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.completedAt, cursor.taskId);
    filters.push(
      `(completed_at, task_id) < ($${params.length - 1}::timestamptz, $${params.length})`,
    );
  }
  const scoped = s.clause.replace("$USER", `$${params.length + 1}`);
  if (s.params.length) params.push(...s.params);
  params.push(limit + 1);

  const r = await db.query(
    `SELECT ${SELECT_COLUMNS}, completed_at::text AS cursor_completed_at
       FROM claw_tasks
      WHERE ${filters.join(" AND ")} ${scoped}
      ORDER BY completed_at DESC NULLS LAST, task_id DESC
      LIMIT $${params.length}`,
    params,
  );
  logger.debug({ count: r.rowCount, state }, "runs.list");
  const fetched = r.rows as RunRow[];
  const malformed = fetched.find((row) => !(row.cursor_completed_at ?? iso(row.completed_at)));
  if (malformed) {
    logger.error({ runId: malformed.task_id }, "runs.terminal_missing_completed_at");
    return reply.status(500).send({
      ok: false,
      error: "terminal_run_missing_completed_at",
    });
  }
  const hasMore = fetched.length > limit;
  const page = hasMore ? fetched.slice(0, limit) : fetched;
  return {
    runs: page.map(toRunView),
    limit,
    has_more: hasMore,
    next_cursor: hasMore ? encodeCursor(page.at(-1)!) : null,
  };
}

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  // No auth hook here on purpose: index.ts registers authMiddleware once for the
  // whole app, and this instance is not encapsulated, so adding one here runs
  // auth twice on every request to every route -- not just these.

  app.get("/v1/runs/:runId", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const s = scope(req);
    const r = await db.query(
      `SELECT ${SELECT_COLUMNS} FROM claw_tasks
        WHERE task_id = $1 ${s.clause.replace("$USER", "$2")}`,
      [runId, ...s.params],
    );
    if ((r.rowCount ?? 0) === 0) {
      return reply.status(404).send({ ok: false, error: "run_not_found" });
    }
    return toRunView(r.rows[0] as RunRow);
  });

  app.get("/v1/runs", async (req, reply) => {
    const q = (req.query ?? {}) as RunsQuery;
    const s = scope(req);
    // Two reads behind one path: runs the caller can name, and a walk over the
    // ones it cannot. Naming wins when the request does it, so `state` is only
    // required of a request that named nothing.
    return await readNamedRuns(q, s, reply) ?? await listTerminalRuns(q, s, reply);
  });
}
