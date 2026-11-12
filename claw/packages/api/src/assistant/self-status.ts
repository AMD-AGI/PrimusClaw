// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the assistant itself has been running (`claw_self_status`), and who it is: in the chat (Teams) the person talks to it as Clawy, and
 * "clawy最近运行如何" was answered by searching Dispatron and GitHub for the name and then asking the person what Clawy is.
 *
 * Counts only, over the whole deployment, from Claw's own tables: messages received, how soon the first reply came, how many got
 * none, how the work items went, how the runs and their sandboxes went, and the build running. Never a message's text, a user, a
 * session's settings or an error message: a failure is named by its `failure_reason` code, which Claw writes itself.
 *
 * Every read is bounded: one read-only transaction under its own statement timeout, every scan cut at a row limit (and the answer
 * says when a limit was reached), and the two tables without an index on their creation time (`claw_tasks`, `claw_work_items`)
 * are read by their primary key, whose ULID begins with the time it was made (`tasks/ids.ts`).
 */
import { readFileSync } from "node:fs";
import { CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_SELF_STATUS, CLAW_BUILD } from "../config.js";
import { inTransaction, type Querier } from "../infra/db.js";
import { chatSurface } from "./chat-surface.js";

export function selfStatusOn(): boolean {
  return CLAW_ASSISTANT_ENABLED && CLAW_ASSISTANT_SELF_STATUS;
}

/** router-self-v1: Clawy is the assistant itself, with claw_self_status; counts answered from a result's counts, never by counting a cut list. */
export const ROUTER_SELF_PROMPT_VERSION = "router-self-v1";

/**
 * What the router is told about itself, and about counting what a lookup returned. After the rest of the system prompt. `where`:
 * where the user talks to it (`ChatSurface.where`, "in Teams").
 */
export function renderRouterSelfSection(selfStatus: boolean, where: string = chatSurface(undefined).where): string {
  const lines = [
    "Who you are",
    `${where.charAt(0).toUpperCase()}${where.slice(1)} people call you Clawy: Clawy is you, PrimusClaw's (Claw's) assistant ${where}. It is not a job, a plan, a repository or a board to look up, and a question about Clawy, about you or about Claw itself is about you.`,
  ];
  if (selfStatus) {
    lines.push(
      "When the user asks how you (Clawy, Claw) have been running, whether you have problems, how fast or how reliable you are (clawy最近运行如何, 你最近稳定吗, how is Clawy doing), call claw_self_status and answer from its numbers in a few lines: messages, how soon the first reply came (p50, p90), how many got no reply, how the items and runs went, how many sandboxes failed, and the version running. Never search other systems for the name, and never ask the user what Clawy is. This is the one question where the system's own failures are the answer: give them as the numbers and reason codes say, nothing more.",
    );
  } else {
    lines.push("You have no tool that measures how you have been running: when asked, say so in one line; never search other systems for the name.");
  }
  lines.push(
    "",
    "Counting what a lookup returned",
    "When a result gives a count (total_count, totalCount, in_result) or counts by a field (by, by_repo), answer how many from those numbers. A result that says it is cut (complete false, shown less than the count, not_shown, or a note that it was cut) holds only some of the items: never count its items as the answer, and never call a number uncertain because a list was cut when the counts are given. A count of one kind across every page (running workloads, open pull requests in one repository) is the total the tool answers when called with that filter. To name items that were not shown, call the tool again narrowed (a pool, a repository, a status) or with its paging.",
  );
  return lines.join("\n");
}

const DAY_HOURS = 24;
const MAX_HOURS = 7 * 24;
/** No scan reads more rows than this; a count that reaches it is said to be at least that. */
export const SELF_STATUS_ROW_CAP = 20_000;
/** The first-reply latencies are of at most this many of the latest messages. */
export const SELF_STATUS_LATENCY_SAMPLE = 2_000;
/** A message without a reply this long after it is counted as unanswered; younger ones are not judged yet. */
const REPLY_WINDOW_MIN = 10;
const STATEMENT_TIMEOUT_MS = 5_000;
const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

/**
 * The build running: CLAW_BUILD (set in the image by CI to the tag it publishes, see claw/Dockerfile), else the tag `deploy/build.sh` wrote into the image as packages/api/BUILD
 * (beside src/ and dist/, two levels up from this file in either), else null. Read once: an image does not change under a process.
 */
export function buildOf(fromEnv: string = CLAW_BUILD, file: URL = new URL("../../BUILD", import.meta.url)): string | null {
  if (fromEnv) return fromEnv;
  try {
    const tag = readFileSync(file, "utf8").trim();
    return /^[\w.+-]{1,64}$/.test(tag) ? tag : null;
  } catch {
    return null;
  }
}
const BUILD = buildOf();

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The smallest ULID made at `ms` or later (`tasks/ids.ts`): its 10 time characters followed by the lowest random part. */
export function ulidFloor(ms: number): string {
  let out = "";
  let n = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    const mod = n % 32;
    out = ALPHABET[mod] + out;
    n = (n - mod) / 32;
  }
  return `${out}${"0".repeat(16)}`;
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;
}

function seconds(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

const int = (v: unknown): number => Number(v ?? 0) || 0;

/**
 * The failure reasons named by their code: the ones Claw itself writes (`tasks/types.ts` FailureReason, the sandbox reasons of
 * `infra/db.ts`, the dispatcher's and the sweeper's). Any other value is counted as other and never repeated: a failed script step
 * leaves its tool's error text in the column (`brain/src/tasks/script-runner.ts`), which is another user's and may say anything,
 * whatever its shape.
 */
const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "agent_error", "brain_timeout", "cancelled", "claim_abandoned", "dag_root_stuck", "dag_validation_failed", "deps_failed",
  "dispatch_failed", "dispatch_retried", "dispatch_timeout", "duplicate_dispatch_row", "external_timeout", "missing_platform_key",
  "queue_timeout", "review_turn_budget_used", "run_budget_exhausted", "sandbox_bootstrap_failed", "sandbox_create_failed",
  "sandbox_died", "sandbox_exited_before_ready", "sandbox_gone", "sandbox_handle_missing", "sandbox_health_failed",
  "sandbox_pending_timeout", "sandbox_start_timeout", "sandbox_status_unreadable", "sandbox_timed_out", "sandbox_workload_terminal",
  "script_step_failed", "session_deleted", "threw", "unclaimable", "upstream_timeout", "worker_lost", "workspace_bind_failed",
  "workspace_unbound",
]);

export interface SelfStatus {
  window_hours: number;
  since: string;
  version: { build: string | null; api_started_at: string };
  messages: { received: number; at_least: boolean };
  first_reply: {
    judged: number; answered: number; handed_to_chat: number; unanswered: number; unanswered_rate: number | null;
    p50_s: number | null; p90_s: number | null; sample_cap: number;
  };
  router_turns: { total: number; failed: number; failure_rate: number | null; by_status: Record<string, number>; at_least: boolean };
  items: { created: number; by_outcome: Record<string, number>; at_least: boolean };
  runs: {
    total: number; failed: number; failure_rate: number | null; by_status: Record<string, number>;
    top_failure_reasons: Array<{ reason: string; count: number }>; at_least: boolean;
  };
  sandboxes: { runs_with_sandbox: number; failed: number; failure_rate: number | null };
  notes: string[];
}

/** The numbers, read in one bounded, read-only transaction. `hours` is the window (default a day, at most a week). */
export async function readSelfStatus(hours: number = DAY_HOURS, now: number = Date.now(), tx = inTransaction): Promise<SelfStatus> {
  const h = Number.isFinite(hours) ? Math.min(Math.max(Math.round(hours), 1), MAX_HOURS) : DAY_HOURS;
  const sinceMs = now - h * 3_600_000;
  const since = new Date(sinceMs).toISOString();
  const settled = new Date(now - REPLY_WINDOW_MIN * 60_000).toISOString();
  const taskFloor = `ktsk_${ulidFloor(sinceMs)}`;
  const itemFloor = `kwi_${ulidFloor(sinceMs)}`;
  return tx(async (q: Querier) => {
    await q("SET TRANSACTION READ ONLY");
    await q(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

    const received = int((await q(
      `SELECT count(*) AS n FROM (SELECT 1 FROM claw_assistant_messages WHERE received_at >= $1 LIMIT ${SELF_STATUS_ROW_CAP}) m`,
      [since],
    )).rows[0]?.n);

    // The first thing said to the user after their message (a system fallback is not a reply), within REPLY_WINDOW_MIN; a review
    // the turn handed to the chat is answered by the chat itself, so it is counted apart rather than as unanswered.
    const reply = (await q(
      `WITH m AS (
         SELECT message_id, user_id, received_at FROM claw_assistant_messages
          WHERE received_at >= $1 AND received_at < $2
          ORDER BY received_at DESC LIMIT ${SELF_STATUS_LATENCY_SAMPLE}
       ), r AS (
         SELECT m.received_at, s.first_at, h.handed
           FROM m
           LEFT JOIN LATERAL (
             SELECT s.created_at AS first_at FROM claw_assistant_says s
              WHERE s.user_id = m.user_id AND s.created_at >= m.received_at
                AND s.created_at < m.received_at + make_interval(mins => ${REPLY_WINDOW_MIN}) AND NOT s.fallback
              ORDER BY s.created_at LIMIT 1
           ) s ON true
           LEFT JOIN LATERAL (
             SELECT true AS handed FROM claw_assistant_review_handoffs h
              WHERE h.user_id = m.user_id AND h.message_id = m.message_id LIMIT 1
           ) h ON true
       )
       SELECT count(*) AS judged,
              count(first_at) AS answered,
              count(*) FILTER (WHERE first_at IS NULL AND handed) AS handed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_at - received_at)) AS p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM first_at - received_at)) AS p90
         FROM r`,
      [since, settled],
    )).rows[0] ?? {};
    const judged = int(reply.judged);
    const answered = int(reply.answered);
    const handed = int(reply.handed);
    const unanswered = Math.max(0, judged - answered - handed);

    // Router turns: the runs of a router session, which is an assistant's own or one a person's message came to in the window (an
    // assistant whose session was replaced keeps its earlier one's messages, and their turns).
    const turnRows = (await q(
      `WITH rs AS (
         SELECT session_id FROM (SELECT session_id FROM claw_assistants LIMIT ${SELF_STATUS_ROW_CAP}) a
         UNION
         SELECT session_id FROM (
           SELECT session_id FROM claw_assistant_messages WHERE received_at >= $1 LIMIT ${SELF_STATUS_ROW_CAP}
         ) m
       )
       SELECT status, count(*) AS n FROM (
         SELECT t.status FROM claw_tasks t JOIN rs ON rs.session_id = t.session_id
          WHERE t.task_id >= $2 AND t.task_id LIKE 'ktsk\\_%' AND t.created_at >= $1
          LIMIT ${SELF_STATUS_ROW_CAP}
       ) t GROUP BY status`,
      [since, taskFloor],
    )).rows;
    const turnsByStatus = Object.fromEntries(turnRows.map((r) => [String(r.status), int(r.n)]));
    const turns = Object.values(turnsByStatus).reduce((a, b) => a + b, 0);
    const turnsFailed = turnsByStatus.failed ?? 0;

    const itemRows = (await q(
      `SELECT bucket, count(*) AS n FROM (
         SELECT CASE
                  WHEN outcome IN ('accepted', 'answered') THEN 'succeeded'
                  WHEN board_state = 'needs_you' AND last_report_kind = 'ready' THEN 'ready_to_accept'
                  WHEN last_report_kind IN ('failed', 'blocked') THEN 'failed'
                  WHEN outcome IN ('stopped', 'dropped') THEN 'stopped'
                  WHEN board_state = 'needs_you' THEN 'waiting_for_user'
                  ELSE 'in_progress'
                END AS bucket
           FROM claw_work_items
          WHERE item_id >= $2 AND item_id LIKE 'kwi\\_%' AND created_at >= $1
          LIMIT ${SELF_STATUS_ROW_CAP}
       ) i GROUP BY bucket`,
      [since, itemFloor],
    )).rows;
    const itemsByOutcome = Object.fromEntries(itemRows.map((r) => [String(r.bucket), int(r.n)]));
    const items = Object.values(itemsByOutcome).reduce((a, b) => a + b, 0);

    const runRows = (await q(
      `SELECT status, failure_reason,
              (sandbox_workload_id IS NOT NULL OR failure_reason LIKE 'sandbox%') AS sandbox,
              count(*) AS n
         FROM (
           SELECT status, failure_reason, sandbox_workload_id FROM claw_tasks
            WHERE task_id >= $2 AND task_id LIKE 'ktsk\\_%' AND created_at >= $1
            LIMIT ${SELF_STATUS_ROW_CAP}
         ) t
        GROUP BY 1, 2, 3`,
      [since, taskFloor],
    )).rows;
    const runsByStatus: Record<string, number> = {};
    const reasons = new Map<string, number>();
    let runs = 0;
    let sandboxRuns = 0;
    let sandboxFailed = 0;
    for (const r of runRows) {
      const n = int(r.n);
      runs += n;
      runsByStatus[String(r.status)] = (runsByStatus[String(r.status)] ?? 0) + n;
      // A reason is named only when it is one of Claw's own codes; anything else in the column is not repeated to anyone.
      const reason = typeof r.failure_reason === "string" ? (KNOWN_REASONS.has(r.failure_reason) ? r.failure_reason : "other") : null;
      if (r.status === "failed") reasons.set(reason ?? "unknown", (reasons.get(reason ?? "unknown") ?? 0) + n);
      if (r.sandbox === true) {
        sandboxRuns += n;
        if (reason?.startsWith("sandbox")) sandboxFailed += n;
      }
    }
    const runsFailed = runsByStatus.failed ?? 0;

    const notes = [
      `first_reply covers the latest ${SELF_STATUS_LATENCY_SAMPLE} messages at most, each older than ${REPLY_WINDOW_MIN} minutes; a message with no reply within ${REPLY_WINDOW_MIN} minutes is unanswered.`,
      "Counts are over every user of this deployment.",
    ];
    if (!BUILD) notes.push("This image does not say which build it is, so the version is not known here; api_started_at says when it started.");
    return {
      window_hours: h,
      since,
      version: { build: BUILD, api_started_at: PROCESS_STARTED_AT },
      messages: { received, at_least: received >= SELF_STATUS_ROW_CAP },
      first_reply: {
        judged, answered, handed_to_chat: handed, unanswered, unanswered_rate: rate(unanswered, judged),
        p50_s: seconds(reply.p50), p90_s: seconds(reply.p90), sample_cap: SELF_STATUS_LATENCY_SAMPLE,
      },
      router_turns: {
        total: turns, failed: turnsFailed, failure_rate: rate(turnsFailed, turns), by_status: turnsByStatus,
        at_least: turns >= SELF_STATUS_ROW_CAP,
      },
      items: { created: items, by_outcome: itemsByOutcome, at_least: items >= SELF_STATUS_ROW_CAP },
      runs: {
        total: runs, failed: runsFailed, failure_rate: rate(runsFailed, runs), by_status: runsByStatus,
        top_failure_reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count })),
        at_least: runs >= SELF_STATUS_ROW_CAP,
      },
      sandboxes: { runs_with_sandbox: sandboxRuns, failed: sandboxFailed, failure_rate: rate(sandboxFailed, sandboxRuns) },
      notes,
    };
  });
}
