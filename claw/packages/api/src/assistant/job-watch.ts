// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Job watches: the assistant watches a job for the user and tells them when its state changes, and when it ends.
 *
 * Built the way GitHub events for items are (`github-events.ts`): a small deterministic loop, not a model. Every
 * `CLAW_ASSISTANT_JOB_POLL_SEC` each due watch is claimed by one replica (`FOR UPDATE SKIP LOCKED`), its job is read, and a change of
 * state is written once: the watch's state moves only from the value read (`last_state`), and the change gets the next number of the
 * watch (`transitions`), so a change two polls or two replicas saw is one row and one message. The message is said to the user in the
 * system's own words (`recordSystemNotice`, keyed by the change), in the language they asked in; the channel decides when it reaches
 * them (quiet hours hold it). A job that ends ends its watch.
 *
 * Two kinds of job:
 *  - `workload`: a SaFE workload of the user's own, read with their SaFE key (the one their messages last gave their assistant): one
 *    SaFE says is someone else's is not theirs to watch, whatever their key may read;
 *  - `run`: a run of the user's in this deployment (a task, such as the root of a run another service planned and submitted for
 *    them), read from Claw's own tables, and only when its session is the user's;
 *  - and any kind the deployment adds (`CLAW_ASSISTANT_JOB_HTTP_SOURCES`): a job of another service, read over HTTP with the user's
 *    own platform key, so they are told only what that service would show them; with an `owner` path, only a job of their own.
 *
 * Nothing is lost silently: a job that cannot be read for `READ_FAILURE_REPORT_SEC` is said once per streak, and one that is gone
 * ends its watch with a message that says so.
 */
import pino from "pino";
import { readTrustedSessionCredentials } from "../auth/sealed-session-credentials.js";
import {
  CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_JOB_EVENTS, CLAW_ASSISTANT_JOB_HTTP_SOURCES, CLAW_ASSISTANT_JOB_MAX_WATCHES,
  CLAW_ASSISTANT_JOB_POLL_SEC, SAFE_API_URL,
} from "../config.js";
import { db, inTransaction, type Querier } from "../infra/db.js";
import { markUntrustedRead, turnMessage } from "./inbound.js";
import { recordSystemNotice } from "./outbound.js";
import type { AssistantTokenClaims } from "./token.js";
import { assertLiveRun, ToolRefused } from "./tools.js";

const logger = pino({ name: "assistant-job-watch" });

/** The kinds every deployment has; `jobSources()` adds the deployment's own. */
export const JOB_SOURCES = ["workload", "run"] as const;
export type JobSource = string;
/** States a job does not leave: SaFE's ended phases, and a run's ended statuses. */
export const ENDED_STATES: Readonly<Record<(typeof JOB_SOURCES)[number], ReadonlySet<string>>> = {
  workload: new Set(["Succeeded", "Failed", "Stopped"]),
  run: new Set(["completed", "failed", "cancelled"]),
};

/** A kind of job read over HTTP with the user's platform key (`CLAW_ASSISTANT_JOB_HTTP_SOURCES`). */
export interface HttpJobSource {
  kind: string;
  /** What the router is told the kind is for: "a build of the user's (its id)". */
  description: string;
  /** The job's URL, `{id}` standing for the id, URL-encoded. */
  url: string;
  /** Dotted paths into the answer: the state (required), a line about it, and whose job it is. */
  state: string;
  detail: string | null;
  owner: string | null;
  ended: ReadonlySet<string>;
}

const KIND_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Whether a URL may carry a user's key: https, or plain http only inside the cluster (a `.svc` host); and the id (which the user
 * chooses) stands once, in the path or the query, after a fixed origin, so no id can send the key to a host of its choosing.
 */
function keySafeUrl(raw: string): boolean {
  const at = raw.indexOf("{id}");
  if (at < 0 || raw.indexOf("{id}", at + 1) >= 0) return false;
  const prefix = raw.slice(0, at);
  // In a fragment the id is never sent: every job would be read at the same address.
  if (prefix.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(raw.replace("{id}", "x"));
    if (!prefix.startsWith(`${new URL(`${prefix}x`).origin}/`) || !prefix.startsWith(`${u.origin}/`)) return false;
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && /\.svc(\.cluster\.local)?$/.test(u.hostname);
}

/**
 * The deployment's own kinds, from the JSON array the operator gives. Each entry is checked; one that does not parse is left out with
 * the reason, so a mistake in one never takes the others (or the API) down.
 */
export function parseJobHttpSources(raw: string): { sources: HttpJobSource[]; errors: string[] } {
  const sources: HttpJobSource[] = [];
  const errors: string[] = [];
  if (!raw.trim()) return { sources, errors };
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return { sources, errors: ["not JSON"] };
  }
  if (!Array.isArray(list)) return { sources, errors: ["not a JSON array"] };
  list.forEach((entry, i) => {
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind : "";
    const why = !KIND_RE.test(kind) ? "kind must be a short lowercase name"
      : (JOB_SOURCES as readonly string[]).includes(kind) || sources.some((s) => s.kind === kind) ? `kind ${kind} is taken`
      : typeof e.url !== "string" || !e.url.includes("{id}") ? "url must name the job with {id}"
      : !keySafeUrl(e.url) ? "url must be https, or http to an in-cluster .svc host, with {id} once after its host: it carries the user's key"
      : typeof e.state !== "string" || !PATH_RE.test(e.state) ? "state must be a dotted path"
      : (e.detail !== undefined && (typeof e.detail !== "string" || !PATH_RE.test(e.detail))) ? "detail must be a dotted path"
      : (e.owner !== undefined && (typeof e.owner !== "string" || !PATH_RE.test(e.owner))) ? "owner must be a dotted path"
      : !Array.isArray(e.ended) || !e.ended.length || !e.ended.every((x) => typeof x === "string" && x) ? "ended must list the end states"
      : "";
    if (why) {
      errors.push(`entry ${i}: ${why}`);
      return;
    }
    sources.push({
      kind, description: oneLine(e.description, 120) || `a ${kind} job (its id)`, url: e.url as string, state: e.state as string,
      detail: (e.detail as string | undefined) ?? null, owner: (e.owner as string | undefined) ?? null, ended: new Set(e.ended as string[]),
    });
  });
  return { sources, errors };
}

let httpSources: HttpJobSource[] | null = null;

/** The deployment's own kinds, parsed once (the errors are logged then). `setJobHttpSources` replaces them, for a test. */
export function jobHttpSources(): readonly HttpJobSource[] {
  if (httpSources === null) {
    const parsed = parseJobHttpSources(CLAW_ASSISTANT_JOB_HTTP_SOURCES);
    for (const error of parsed.errors) logger.error({ error }, "assistant.job_http_source_invalid");
    httpSources = parsed.sources;
  }
  return httpSources;
}

export function setJobHttpSources(sources: HttpJobSource[] | null): void {
  httpSources = sources;
}

/** Every kind a watch may be of here. */
export function jobSources(): string[] {
  return [...JOB_SOURCES, ...jobHttpSources().map((s) => s.kind)];
}

/** The states a job of this kind does not leave. */
export function endedStates(source: string): ReadonlySet<string> {
  return (ENDED_STATES as Record<string, ReadonlySet<string>>)[source] ?? jobHttpSources().find((s) => s.kind === source)?.ended ?? new Set();
}

function pick(body: unknown, path: string | null): unknown {
  if (!path) return undefined;
  let v: unknown = body;
  for (const part of path.split(".")) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}
export const READ_FAILURE_REPORT_SEC = 600;
const POLL_BATCH = 50;
const LABEL_MAX = 80;
const DETAIL_MAX = 200;
const SAFE_TIMEOUT_MS = 8000;

export function jobWatchesEnabled(): boolean {
  return CLAW_ASSISTANT_ENABLED && CLAW_ASSISTANT_JOB_EVENTS;
}

/** What one read of a job found. `gone`: the job does not exist (or is not the user's to see). */
export type JobRead =
  /** `owner`: whose the job is, when its source says (a SaFE workload's `userId`). */
  | { kind: "state"; state: string; detail: string | null; owner?: string | null }
  | { kind: "gone" }
  | { kind: "error"; code: string };

/** What leaves the process: SaFE, read with the user's key. A test stands in for it. */
export const jobWatchPorts: {
  readWorkload: (workloadId: string, apiKey: string) => Promise<JobRead>;
  /** One GET of a deployment-added kind's job, with the user's key: its status and JSON (null when the answer is not JSON). */
  httpGet: (url: string, apiKey: string) => Promise<{ status: number; body: unknown }>;
} = {
  httpGet: async (url, apiKey) => {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(SAFE_TIMEOUT_MS) });
    return { status: resp.status, body: resp.ok ? await resp.json().catch(() => null) : null };
  },
  readWorkload: async (workloadId, apiKey) => {
    if (!SAFE_API_URL) return { kind: "error", code: "safe_not_configured" };
    let resp: Response;
    try {
      resp = await fetch(`${SAFE_API_URL}/api/v1/workloads/${encodeURIComponent(workloadId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(SAFE_TIMEOUT_MS),
      });
    } catch {
      return { kind: "error", code: "safe_unreachable" };
    }
    if (resp.status === 404 || resp.status === 410) return { kind: "gone" };
    if (resp.status === 401 || resp.status === 403) return { kind: "error", code: `safe_refused_${resp.status}` };
    if (!resp.ok) return { kind: "error", code: `safe_http_${resp.status}` };
    const body = await resp.json().catch(() => null) as Record<string, unknown> | null;
    const phase = typeof body?.phase === "string" ? body.phase : "";
    if (!phase) return { kind: "error", code: "safe_unreadable" };
    return {
      kind: "state", state: phase, detail: typeof body?.message === "string" && body.message ? body.message : null,
      owner: typeof body?.userId === "string" ? body.userId : null,
    };
  },
};

const oneLine = (text: unknown, max: number): string => {
  const t = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

/** A run of this user's: its task's status, read here. Someone else's run is `gone`, as one that does not exist. */
async function readRun(q: Querier, userId: string, taskId: string): Promise<JobRead> {
  const row = (await q(
    `SELECT t.status, t.failure_reason FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id
      WHERE t.task_id = $1 AND s.user_id = $2`,
    [taskId, userId],
  )).rows[0] as { status: string; failure_reason: string | null } | undefined;
  if (!row) return { kind: "gone" };
  return { kind: "state", state: row.status, detail: row.failure_reason ?? null };
}

/** The SaFE key the user's messages last gave their assistant, read when it is needed: a later message renews it. */
async function userSafeKey(q: Querier, userId: string): Promise<string | null> {
  const row = (await q(
    "SELECT s.config FROM claw_assistants a JOIN claw_sessions s ON s.session_id = a.session_id WHERE a.user_id = $1", [userId],
  )).rows[0] as { config: unknown } | undefined;
  return readTrustedSessionCredentials(row?.config).platformKey || null;
}

/** A job of a deployment-added kind: one GET with the user's key, its state and line picked from the answer. */
async function readHttpJob(source: HttpJobSource, id: string, key: string): Promise<JobRead> {
  // Encoded, an id cannot leave its place in the path, except as a dot segment the URL would resolve upwards.
  if (id === "." || id === "..") return { kind: "gone" };
  let got: { status: number; body: unknown };
  try {
    got = await jobWatchPorts.httpGet(source.url.replace("{id}", encodeURIComponent(id)), key);
  } catch {
    return { kind: "error", code: `${source.kind}_unreachable` };
  }
  if (got.status === 404 || got.status === 410) return { kind: "gone" };
  if (got.status === 401 || got.status === 403) return { kind: "error", code: `${source.kind}_refused_${got.status}` };
  if (got.status < 200 || got.status >= 300) return { kind: "error", code: `${source.kind}_http_${got.status}` };
  const state = pick(got.body, source.state);
  if (typeof state !== "string" || !state) return { kind: "error", code: `${source.kind}_unreadable` };
  const detail = pick(got.body, source.detail);
  const owner = pick(got.body, source.owner);
  return {
    kind: "state", state, detail: typeof detail === "string" && detail ? detail : null,
    // With an owner path, an answer that names no owner is no proof the job is the user's.
    ...(source.owner ? { owner: typeof owner === "string" ? owner : "" } : {}),
  };
}

export async function readJob(q: Querier, w: { user_id: string; source: string; target: string }): Promise<JobRead> {
  if (w.source === "run") return readRun(q, w.user_id, w.target);
  const http = w.source === "workload" ? null : jobHttpSources().find((s) => s.kind === w.source);
  if (w.source !== "workload" && !http) return { kind: "error", code: "source_not_configured" };
  const key = await userSafeKey(q, w.user_id);
  if (!key) return { kind: "error", code: "no_safe_key" };
  if (http) {
    const read = await readHttpJob(http, w.target, key);
    if (read.kind === "state" && read.owner !== undefined && read.owner !== w.user_id) return { kind: "gone" };
    return read;
  }
  const read = await jobWatchPorts.readWorkload(w.target, key);
  // Only the user's own workload, whatever their key may read (an operator's reads everyone's): someone else's is not theirs to watch.
  if (read.kind === "state" && read.owner && read.owner !== w.user_id) return { kind: "gone" };
  return read;
}

const T = {
  zh: {
    changed: (l: string, from: string | null, to: string, d: string | null) => `盯的作业 ${l} 现在是 ${to}${from ? `（之前是 ${from}）` : ""}${d ? `：${d}` : ""}。`,
    ended: (l: string, to: string, d: string | null) => `盯的作业 ${l} 已结束：${to}${d ? `。${d}` : ""}。不再盯了。`,
    gone: (l: string) => `盯的作业 ${l} 找不到了（被删除，或你看不到它），不再盯了。`,
    unreadable: (l: string, code: string, min: number) => `盯的作业 ${l} 已经 ${min} 分钟读不到了（${code}），状态变化可能没告诉你。我会继续试。`,
  },
  en: {
    changed: (l: string, from: string | null, to: string, d: string | null) => `The job you asked me to watch, ${l}, is now ${to}${from ? ` (was ${from})` : ""}${d ? `: ${d}` : ""}.`,
    ended: (l: string, to: string, d: string | null) => `The job you asked me to watch, ${l}, has ended: ${to}${d ? `. ${d}` : ""}. I stopped watching it.`,
    gone: (l: string) => `The job you asked me to watch, ${l}, is gone (deleted, or not yours to see). I stopped watching it.`,
    unreadable: (l: string, code: string, min: number) => `I could not read the job ${l} for ${min} minutes (${code}), so a change may not have reached you. I keep trying.`,
  },
};

interface Watch {
  id: number; user_id: string; source: JobSource; target: string; label: string; lang: string; last_state: string | null; transitions: number;
}

async function assistantSession(q: Querier, userId: string): Promise<string | null> {
  return ((await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [userId])).rows[0]?.session_id as string | undefined) ?? null;
}

/** Tell the user, once per `key`, in the watch's language. Nothing when they have no assistant to say it through. */
async function tell(w: Watch, key: string, text: string): Promise<void> {
  const sessionId = await assistantSession((t, p) => db.query(t, p), w.user_id);
  if (!sessionId) return;
  await recordSystemNotice({ userId: w.user_id, sessionId, text, key });
}

const words = (w: Pick<Watch, "lang">) => (w.lang === "zh" ? T.zh : T.en);

/**
 * One poll of one watch: read the job; a new state is written once (the CAS on `last_state`) and said; an ended job ends the watch.
 * Returns what came of it, for the loop's log and the tests.
 */
export async function pollWatch(w: Watch): Promise<"changed" | "ended" | "same" | "gone" | "error"> {
  const read = await readJob((t, p) => db.query(t, p), w);
  if (read.kind === "error") {
    const row = (await db.query(
      `UPDATE claw_assistant_job_watches SET last_error = $2, failing_since = COALESCE(failing_since, NOW())
        WHERE id = $1 AND state = 'active'
        RETURNING failure_reported, failing_since <= NOW() - make_interval(secs => $3::int) AS overdue, failing_since`,
      [w.id, read.code, READ_FAILURE_REPORT_SEC],
    )).rows[0] as { failure_reported: boolean; overdue: boolean; failing_since: Date } | undefined;
    if (row?.overdue && !row.failure_reported) {
      await db.query("UPDATE claw_assistant_job_watches SET failure_reported = TRUE WHERE id = $1", [w.id]);
      await tell(w, `job-unreadable:${w.id}:${new Date(row.failing_since).toISOString()}`,
        words(w).unreadable(w.label, read.code, Math.round(READ_FAILURE_REPORT_SEC / 60)));
    }
    logger.warn({ watchId: w.id, code: read.code }, "assistant.job_read_failed");
    return "error";
  }
  if (read.kind === "gone") {
    const ended = await db.query(
      `UPDATE claw_assistant_job_watches SET state = 'ended', end_reason = 'not_found', ended_at = NOW()
        WHERE id = $1 AND state = 'active' RETURNING id`,
      [w.id],
    );
    if (ended.rowCount) await tell(w, `job-gone:${w.id}`, words(w).gone(w.label));
    return "gone";
  }
  const ended = endedStates(w.source).has(read.state);
  if (read.state === w.last_state) {
    await db.query(
      `UPDATE claw_assistant_job_watches SET last_error = NULL, failing_since = NULL, failure_reported = FALSE
        WHERE id = $1 AND (last_error IS NOT NULL OR failing_since IS NOT NULL)`,
      [w.id],
    );
    if (!ended) return "same";
  }
  const detail = read.detail ? oneLine(read.detail, DETAIL_MAX) : null;
  const changed = await inTransaction(async (q) => {
    // From the state this poll read and no other: a change another replica already wrote is not written again.
    const moved = (await q(
      `UPDATE claw_assistant_job_watches
          SET last_state = $3, transitions = transitions + 1, last_error = NULL, failing_since = NULL, failure_reported = FALSE,
              state = CASE WHEN $4 THEN 'ended' ELSE state END, end_reason = CASE WHEN $4 THEN 'finished' ELSE end_reason END,
              ended_at = CASE WHEN $4 THEN NOW() ELSE ended_at END
        WHERE id = $1 AND state = 'active' AND last_state IS NOT DISTINCT FROM $2
        RETURNING transitions`,
      [w.id, w.last_state, read.state, ended],
    )).rows[0] as { transitions: number } | undefined;
    if (!moved) return null;
    const eventId = `job:${w.id}:${moved.transitions}`;
    await q(
      `INSERT INTO claw_assistant_job_events (event_id, watch_id, user_id, from_state, to_state, detail)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, w.id, w.user_id, w.last_state, read.state, detail],
    );
    return eventId;
  });
  if (!changed) return "same";
  await tell(w, changed, ended ? words(w).ended(w.label, read.state, detail) : words(w).changed(w.label, w.last_state, read.state, detail));
  return ended ? "ended" : "changed";
}

/** One turn of the loop: claim the due watches (a replica holding one is skipped), and poll each. */
export async function pollDueWatches(intervalSec: number = CLAW_ASSISTANT_JOB_POLL_SEC): Promise<{ polled: number; changed: number }> {
  const due = (await db.query(
    `UPDATE claw_assistant_job_watches w SET polled_at = NOW()
      WHERE w.id IN (
        SELECT id FROM claw_assistant_job_watches
         WHERE state = 'active' AND (polled_at IS NULL OR polled_at <= NOW() - make_interval(secs => $1::int))
         ORDER BY polled_at NULLS FIRST, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING w.id, w.user_id, w.source, w.target, w.label, w.lang, w.last_state, w.transitions`,
    [intervalSec, POLL_BATCH],
  )).rows as Watch[];
  let changed = 0;
  for (const raw of due) {
    const w = { ...raw, id: Number(raw.id), transitions: Number(raw.transitions) };
    try {
      const out = await pollWatch(w);
      if (out === "changed" || out === "ended") changed += 1;
    } catch (err) {
      logger.warn({ err, watchId: w.id }, "assistant.job_poll_failed");
    }
  }
  return { polled: due.length, changed };
}

let timer: NodeJS.Timeout | null = null;

/** The loop, on every replica: claims make each poll one replica's. Ticks faster than the interval so a due watch waits little. */
export function startJobWatch(intervalSec: number = CLAW_ASSISTANT_JOB_POLL_SEC): void {
  if (timer || !jobWatchesEnabled()) return;
  const tickMs = Math.max(5, Math.floor(intervalSec / 3)) * 1000;
  const loop = async () => {
    try {
      await pollDueWatches(intervalSec);
    } catch (err) {
      logger.error({ err }, "assistant.job_watch_tick_failed");
    }
    timer = setTimeout(loop, tickMs);
    timer.unref?.();
  };
  timer = setTimeout(loop, tickMs);
  timer.unref?.();
  logger.info({ intervalSec, tickMs }, "assistant.job_watch_started");
}

export function jobWatchRunning(): boolean {
  return timer !== null;
}

export function stopJobWatch(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

// --- The router's tools ------------------------------------------------------------------------------------------------

function requireRouter(claims: AssistantTokenClaims): void {
  if (claims.role !== "router") throw new ToolRefused("not_allowed", `this tool is for the router, not the ${claims.role}`);
}

const watchView = (r: Record<string, any>) => ({
  watch_id: Number(r.id), kind: r.source, id: r.target, label: r.label, state: r.last_state ?? null, watching: r.state === "active",
  ...(r.end_reason ? { end_reason: r.end_reason } : {}), ...(r.last_error ? { last_error: r.last_error } : {}),
});

/**
 * `job_watch`: watch a job for the user. It is read once first, so a wrong id is refused now and a job that has already ended is
 * answered with its state instead of being watched. Reading only: it needs no confirmation, as answering a question would not.
 */
/**
 * A deployment-added kind's state is whatever its job API answered: text no one the user vetted wrote. The turn that reads it reads
 * it as a worker's words, and no longer acts for the user afterwards (`markUntrustedRead`). SaFE's phases and Claw's run statuses
 * are their own fixed words.
 */
const statesWordedByOthers = (source: string): boolean => !(JOB_SOURCES as readonly string[]).includes(source);

export async function jobWatch(
  claims: AssistantTokenClaims, args: { kind?: unknown; id?: unknown; label?: unknown },
): Promise<Record<string, unknown>> {
  requireRouter(claims);
  const source = String(args.kind ?? "") as JobSource;
  const kinds = jobSources();
  if (!kinds.includes(source)) throw new ToolRefused("invalid_arguments", `kind is one of ${kinds.join(", ")}`);
  const target = oneLine(args.id, 200);
  if (!target) throw new ToolRefused("invalid_arguments", "id names the workload or the run to watch");
  const q: Querier = (t, p) => db.query(t, p);
  const { userId } = await assertLiveRun(q, claims);
  // Only the user asks for a watch: a report's turn could otherwise have them told about jobs nobody asked about.
  const message = await turnMessage(q, claims.sid, claims.mid);
  if (!message) throw new ToolRefused("not_from_user", "only a message from the user can ask to watch a job: tell them what you would watch and let them ask");
  const lang = /\p{Script=Han}/u.test(message.content) ? "zh" : "en";
  const label = oneLine(args.label, LABEL_MAX) || target;
  const read = await readJob(q, { user_id: userId, source, target });
  if (read.kind === "gone") throw new ToolRefused("not_found", `no ${source} with that id is the user's to see: check the id`);
  if (read.kind === "error") throw new ToolRefused("unreadable", `the ${source} could not be read now (${read.code}): tell the user, and try again later`);
  if (statesWordedByOthers(source)) await markUntrustedRead(q, claims.sid, claims.mid);
  if (endedStates(source).has(read.state)) {
    // Only the state: the job's own message (or a run's failure reason) is text others wrote, and this turn may still act.
    return { ok: true, watching: false, state: read.state, note: "it has already ended: tell the user its state; nothing is watched" };
  }
  const row = await inTransaction(async (tx) => {
    if ((await assertLiveRun(tx, claims)).userId !== userId) throw new ToolRefused("turn_not_live", "the session changed hands");
    await tx("SELECT 1 FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [userId]);
    const existing = (await tx(
      "SELECT * FROM claw_assistant_job_watches WHERE user_id = $1 AND source = $2 AND target = $3 AND state = 'active'", [userId, source, target],
    )).rows[0] as Record<string, any> | undefined;
    if (existing) return { ...existing, created: false };
    const active = Number((await tx(
      "SELECT COUNT(*)::int AS n FROM claw_assistant_job_watches WHERE user_id = $1 AND state = 'active'", [userId],
    )).rows[0].n);
    if (active >= CLAW_ASSISTANT_JOB_MAX_WATCHES) {
      throw new ToolRefused("too_many_watches", `at most ${CLAW_ASSISTANT_JOB_MAX_WATCHES} jobs can be watched at once: job_unwatch one first`);
    }
    return { ...(await tx(
      `INSERT INTO claw_assistant_job_watches (user_id, source, target, label, lang, last_state, polled_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [userId, source, target, label, lang, read.state],
    )).rows[0] as Record<string, any>, created: true };
  });
  return {
    ok: true, ...watchView(row), created: row.created,
    note: `watching: the user is told when its state changes and when it ends, within about ${CLAW_ASSISTANT_JOB_POLL_SEC} seconds. Say so in one line.`,
  };
}

export async function jobWatchList(claims: AssistantTokenClaims): Promise<Record<string, unknown>> {
  requireRouter(claims);
  const { userId } = await assertLiveRun((t, p) => db.query(t, p), claims);
  const rows = (await db.query(
    `SELECT * FROM claw_assistant_job_watches WHERE user_id = $1 AND (state = 'active' OR ended_at > NOW() - INTERVAL '1 day') ORDER BY id`,
    [userId],
  )).rows as Array<Record<string, any>>;
  if (rows.some((r) => statesWordedByOthers(String(r.source)))) await markUntrustedRead((t, p) => db.query(t, p), claims.sid, claims.mid);
  return { ok: true, watches: rows.map(watchView) };
}

export async function jobUnwatch(claims: AssistantTokenClaims, args: { watch_id?: unknown }): Promise<Record<string, unknown>> {
  requireRouter(claims);
  const id = Number(String(args.watch_id ?? "").replace(/^#/, ""));
  if (!Number.isSafeInteger(id) || id <= 0) throw new ToolRefused("invalid_arguments", "watch_id is the number job_watch_list shows");
  const row = await inTransaction(async (tx) => {
    const { userId } = await assertLiveRun(tx, claims);
    return (await tx(
      `UPDATE claw_assistant_job_watches SET state = 'ended', end_reason = 'user', ended_at = NOW()
        WHERE id = $1 AND user_id = $2 AND state = 'active' RETURNING *`,
      [id, userId],
    )).rows[0] as Record<string, any> | undefined;
  });
  if (!row) throw new ToolRefused("not_found", "no job of the user's is watched under that number");
  return { ok: true, ...watchView(row), note: "no longer watched" };
}
