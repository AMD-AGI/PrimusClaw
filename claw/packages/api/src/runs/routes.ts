// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform's account of a run.
 *
 *   GET /v1/runs/:runId
 *   GET /v1/runs?ids=a,b,c
 *   GET /v1/runs?state=terminal&since=<iso>&limit=N
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
 * Deliberately not here: what the run concluded. `stop_reason`, gains, whether
 * the optimization was any good -- that is the workload's vocabulary, it is still
 * growing, and an API of ours that knew those words would have to change when they
 * do and would mean nothing to any other workload.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import pino from "pino";
import { authMiddleware, getUser } from "../auth/middleware.js";
import { isAdmin } from "../auth/models.js";
import { db } from "../infra/db.js";
import { phaseOf, terminalFacts, type RunView } from "./platform-terminal.js";

const logger = pino({ name: "runs-routes" });

/**
 * Rows one batch call may return.
 *
 * The requirement is 200 in a single call -- the width of one sweep of the model
 * sweep at full concurrency. The ceiling is well above it so a caller that
 * batches two sweeps together is not silently truncated, and low enough that the
 * response stays a page rather than a dump.
 */
const MAX_BATCH = 1000;
const DEFAULT_LIMIT = 200;

interface RunRow {
  task_id: string;
  session_id: string;
  status: string;
  failure_reason: string | null;
  sandbox_workload_id: string | null;
  platform_kill_reason: string | null;
  platform_exit_code: number | null;
  platform_node: string | null;
  platform_message: string | null;
  created_at: string | Date | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  deadline_at: string | Date | null;
}

const SELECT_COLUMNS = `
  task_id, session_id, status, failure_reason, sandbox_workload_id,
  platform_kill_reason, platform_exit_code, platform_node, platform_message,
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
    exit_code: row.platform_exit_code,
  });
  // A reason recorded at the terminal wins over one re-derived here: it was read
  // from the platform at the moment the run ended, and the message it came from
  // may since have been trimmed or the pod garbage-collected.
  if (terminal && row.platform_kill_reason) {
    terminal.kill_reason = row.platform_kill_reason as typeof terminal.kill_reason;
    if (terminal.class !== "cancelled") terminal.class = "killed";
  }
  return {
    run_id: row.task_id,
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

/** Ids from `?ids=a,b,c`, de-duplicated and bounded. */
function parseIds(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id) seen.add(id);
    if (seen.size >= MAX_BATCH) break;
  }
  return [...seen];
}

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authMiddleware);

  /**
   * Rows this caller may see.
   *
   * Scoped by session ownership, the same rule the task surface applies, rather
   * than left open because the payload looks harmless. A run id plus a node name
   * is a map of who is running what and where, and the batch form hands over
   * hundreds at a time.
   */
  function scope(req: FastifyRequest): { clause: string; params: unknown[] } {
    const user = getUser(req);
    if (user && isAdmin(user)) return { clause: "", params: [] };
    return {
      clause: `AND session_id IN (SELECT session_id FROM claw_sessions WHERE user_id = $USER)`,
      params: [user?.userId ?? ""],
    };
  }

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
    const q = (req.query ?? {}) as {
      ids?: string;
      state?: string;
      since?: string;
      limit?: string;
    };
    const s = scope(req);

    if (q.ids) {
      const ids = parseIds(q.ids);
      if (ids.length === 0) {
        return reply.status(400).send({ ok: false, error: "ids must not be empty" });
      }
      const r = await db.query(
        `SELECT ${SELECT_COLUMNS} FROM claw_tasks
          WHERE task_id = ANY($1) ${s.clause.replace("$USER", "$2")}
          ORDER BY created_at`,
        [ids, ...s.params],
      );
      // Ids that matched nothing are absent rather than rendered as a run in an
      // unknown state: a caller polling its own dispatches must be able to tell
      // "not ours" from "not finished".
      return { runs: (r.rows as RunRow[]).map(toRunView), requested: ids.length };
    }

    const limit = Math.min(Math.max(Number(q.limit) || DEFAULT_LIMIT, 1), MAX_BATCH);
    const wantsTerminal = (q.state ?? "").toLowerCase() === "terminal";
    const since = q.since ? new Date(q.since) : null;
    if (since && Number.isNaN(since.getTime())) {
      return reply.status(400).send({ ok: false, error: "since must be an ISO timestamp" });
    }

    const params: unknown[] = [];
    const filters: string[] = [];
    if (wantsTerminal) filters.push(`status IN ('completed','failed','cancelled')`);
    if (since) {
      params.push(since.toISOString());
      filters.push(`completed_at >= $${params.length}`);
    }
    const scoped = s.clause.replace("$USER", `$${params.length + 1}`);
    if (s.params.length) params.push(...s.params);
    params.push(limit);

    const r = await db.query(
      `SELECT ${SELECT_COLUMNS} FROM claw_tasks
        WHERE ${filters.length ? filters.join(" AND ") : "TRUE"} ${scoped}
        ORDER BY completed_at DESC NULLS LAST
        LIMIT $${params.length}`,
      params,
    );
    logger.debug({ count: r.rowCount, wantsTerminal }, "runs.list");
    return { runs: (r.rows as RunRow[]).map(toRunView), limit };
  });
}
