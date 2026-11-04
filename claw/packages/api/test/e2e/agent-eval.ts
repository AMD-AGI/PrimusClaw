// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Runs the agent evaluation (`agent-eval-tasks.ts`) against a real deployment, through the API a user's client
 * uses: each task is a new session created with the task as its first message (`POST /v1/sessions`), followed
 * until its turn ends, graded from its stored events and the files it left, and deleted. Every approval the turn
 * asks for is denied: the tasks only read, and a request to write is itself a finding.
 *
 * It also reports how the turns went, per category and in total, from what Brain already records at the end of
 * each turn (`executionStats`: tool calls by tool, failed calls, elapsed time, tokens) and the sandbox's
 * readiness events. Nothing is added to the deployment to measure it.
 *
 *   EVAL_CLAW=https://claw.example/api EVAL_KEY_FILE=/path/to/key EVAL_PLUGIN_ID=<id> npx tsx test/e2e/agent-eval.ts
 *
 * Use a test identity's key: every session is created, charged and deleted as that user.
 * Required: EVAL_CLAW (the API root, to which `/v1/...` is appended) and the key as EVAL_KEY or EVAL_KEY_FILE.
 * The key is read when it is used and never printed or written to the results.
 * Optional:
 *   EVAL_PLUGIN_ID       the plugin each message names, as a user's client would; without it the MCP tasks are skipped
 *   EVAL_MODEL           the model each session asks for (default: the deployment's)
 *   EVAL_TASKS           comma list of task ids or categories (default all)
 *   EVAL_RUNS            runs of the selected tasks (default 1)
 *   EVAL_CONCURRENCY     sessions at once (default 2, at most 4)
 *   EVAL_TASK_TIMEOUT    seconds a task may take, unless it sets its own (default 600)
 *   EVAL_ARM             baseline (default) or guideline: the second sends the working guideline
 *                        (`src/sessions/agent-guideline.ts`) after the task, where a plugin's rules are put, so it
 *                        can be compared on a deployment that does not have CLAW_AGENT_GUIDELINE_ENABLED. On one
 *                        that has it, the baseline arm already runs under the guideline in its own place.
 *   EVAL_OUT             a directory for the full traces, one JSON file per run
 *
 * The last line is a JSON summary: the arm, the tasks, and per run the pass count and the per-category numbers.
 * Exit 0 when every selected task ran to a verdict; the score itself is a measurement, not a gate.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AGENT_GUIDELINE } from "../../src/sessions/agent-guideline.js";
import { apiClient, until } from "./assistant-p1-lib.js";
import { renderSummary, summarize, traceOf, type EventRow, type Outcome } from "./agent-eval-lib.js";
import { TASKS, type EvalContext, type EvalTask } from "./agent-eval-tasks.js";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required`); process.exit(2); }
  return v;
};
const intFromEnv = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) { console.error(`${name} must be an integer in ${min}..${max}`); process.exit(2); }
  return n;
};

const CLAW = need("EVAL_CLAW").replace(/\/+$/, "");
const PLUGIN_ID = process.env.EVAL_PLUGIN_ID ? Number(process.env.EVAL_PLUGIN_ID) : undefined;
const MODEL = process.env.EVAL_MODEL || undefined;
const RUNS = intFromEnv("EVAL_RUNS", 1, 1, 10);
const CONCURRENCY = intFromEnv("EVAL_CONCURRENCY", 2, 1, 4);
const TASK_TIMEOUT_SEC = intFromEnv("EVAL_TASK_TIMEOUT", 600, 60, 3600);
const ARM = process.env.EVAL_ARM || "baseline";
if (ARM !== "baseline" && ARM !== "guideline") { console.error("EVAL_ARM must be baseline or guideline"); process.exit(2); }
const OUT = process.env.EVAL_OUT;
const ONLY = new Set((process.env.EVAL_TASKS || "").split(",").map((s) => s.trim()).filter(Boolean));

/** The key: from the environment or the file it names. Never printed, never written to the results. */
function apiKey(): string {
  if (process.env.EVAL_KEY) return process.env.EVAL_KEY.trim();
  const file = process.env.EVAL_KEY_FILE;
  if (!file) { console.error("EVAL_KEY or EVAL_KEY_FILE is required"); process.exit(2); }
  return readFileSync(file, "utf8").trim();
}
const KEY = apiKey();
const api = apiClient(CLAW, KEY);
const scrub = (s: string): string => s.split(KEY).join("<redacted>");

const iso = (): string => new Date().toISOString();
const log = (...a: unknown[]): void => console.log(iso(), ...a);

/** The task as the session's first message, and in the guideline arm the guideline where a plugin's rules go. */
const promptOf = (task: EvalTask): string => (ARM === "guideline" ? `${task.prompt}\n\n${AGENT_GUIDELINE}` : task.prompt);

async function replay(sessionId: string): Promise<EventRow[]> {
  const r = await api("GET", `/v1/chat/sessions/${sessionId}/messages?mode=replay`);
  if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new Error(`replay answered ${r.status}`);
  return r.json.data as EventRow[];
}

/**
 * The session's events once they stop arriving. The turn's end can be stored before the last results of its tool
 * calls, so the trace is read from a replay that came back the same twice, five seconds apart (at most 30 seconds).
 */
async function settledReplay(sessionId: string): Promise<EventRow[]> {
  let rows = await replay(sessionId);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const again = await replay(sessionId);
    if (again.length === rows.length) return again;
    rows = again;
  }
  return rows;
}

/** A file the turn wrote, once the workspace has been saved; null when it never appears. */
async function fetchFile(sessionId: string, path: string, deadline: number): Promise<Buffer | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return until(async () => {
    const res = await fetch(`${CLAW}/v1/sessions/${sessionId}/files/${encoded}`, {
      headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (res?.status === 200) return Buffer.from(await res.arrayBuffer());
    return undefined;
  }, deadline, 5_000);
}

async function runTask(task: EvalTask, ctx: EvalContext): Promise<Outcome> {
  const base = { id: task.id, category: task.category };
  if (task.needsPlugin && PLUGIN_ID === undefined) return { ...base, pass: false, why: [], skipped: "no EVAL_PLUGIN_ID" };
  const message: Record<string, unknown> = { content: promptOf(task) };
  if (PLUGIN_ID !== undefined) message.pluginId = PLUGIN_ID;
  const created = await api("POST", "/v1/sessions", { name: `agent-eval-${task.id}`, message, ...(MODEL ? { model: MODEL } : {}) });
  const sessionId: string | undefined = created.json?.data?.session_id;
  if (!sessionId) return { ...base, pass: false, why: [], error: `create answered ${created.status}: ${scrub(JSON.stringify(created.json)).slice(0, 200)}` };
  const started = Date.now();
  const deadline = started + (task.timeoutSec ?? TASK_TIMEOUT_SEC) * 1000;
  const denied = new Set<string>();
  try {
    // Until the turn ends: each approval it asks for is denied, so a turn waiting on one does not hang the run.
    const ended = await until(async () => {
      const rows = await replay(sessionId).catch(() => [] as EventRow[]);
      for (const row of rows) {
        const id = row.data?.tool_use_id;
        if (row.data?.type !== "permissionRequest" || typeof id !== "string" || denied.has(id)) continue;
        denied.add(id);
        await api("POST", `/v1/sessions/${sessionId}/messages`, { messageType: "decision", extData: { tool_use_id: id, action: "deny" } });
      }
      return rows.some((r) => r.data?.type === "exec_complete") ? rows : undefined;
    }, deadline, 5_000);
    if (!ended) await api("POST", `/v1/sessions/${sessionId}/messages`, { messageType: "interrupt" });
    const rows = await settledReplay(sessionId);
    const files: Record<string, Buffer | null> = {};
    // The workspace is saved when the turn ends; a file may take a moment to be readable.
    for (const path of task.files ?? []) files[path] = await fetchFile(sessionId, path, Date.now() + 60_000);
    const seen = traceOf(rows);
    const verdict = task.grade({ ...seen, files }, ctx);
    const why = ended ? verdict.why : ["did not end in time", ...verdict.why];
    return { ...base, pass: !!ended && verdict.pass, why, trace: seen };
  } catch (err) {
    return { ...base, pass: false, why: [], error: scrub(err instanceof Error ? err.message : String(err)) };
  } finally {
    const gone = await until(async () => ((await api("DELETE", `/v1/sessions/${sessionId}`).catch(() => ({ status: 0 }))).status === 200 ? true : undefined), Date.now() + 60_000, 10_000);
    if (!gone) log(`could not delete session ${sessionId} of ${task.id}`);
  }
}

async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await work(items[i]!); }
  }));
  return out;
}

async function main(): Promise<void> {
  const tasks = ONLY.size ? TASKS.filter((t) => ONLY.has(t.id) || ONLY.has(t.category)) : TASKS;
  if (!tasks.length) { console.error("no task selected"); process.exit(2); }
  const me = await api("GET", "/v1/me");
  if (me.status !== 200) { console.error(`GET /v1/me answered ${me.status}`); process.exit(2); }
  const ctx: EvalContext = {
    userName: String(me.json?.name ?? ""),
    workspaces: (me.json?.workspaces ?? []).map((w: any) => ({ id: String(w.id), name: String(w.name) })),
  };
  const guideline = createHash("sha256").update(AGENT_GUIDELINE).digest("hex").slice(0, 12);
  log(`arm=${ARM} guideline=${guideline} plugin=${PLUGIN_ID ?? "-"} model=${MODEL ?? "default"} tasks=${tasks.length} runs=${RUNS} concurrency=${CONCURRENCY}`);

  const runs: Array<{ passed: number; ran: number; summary: ReturnType<typeof summarize> }> = [];
  let unfinished = 0;
  for (let run = 1; run <= RUNS; run++) {
    const startedAt = Date.now();
    const outcomes = await pool(tasks, CONCURRENCY, async (t) => {
      const o = await runTask(t, ctx);
      log(`${o.skipped ? "SKIP" : o.pass ? "pass" : "FAIL"} ${t.id} ${o.skipped ?? o.error ?? o.why.join(", ")}`);
      return o;
    });
    const summary = summarize(outcomes);
    const ran = outcomes.filter((o) => !o.skipped);
    unfinished += ran.filter((o) => o.error).length;
    runs.push({ passed: ran.filter((o) => o.pass).length, ran: ran.length, summary });
    log(`run ${run}/${RUNS}: ${runs.at(-1)!.passed}/${ran.length} passed in ${Math.round((Date.now() - startedAt) / 1000)}s\n${renderSummary(summary)}`);
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `${ARM}-run-${run}.json`), scrub(JSON.stringify({
        arm: ARM, guideline, plugin: PLUGIN_ID ?? null, model: MODEL ?? null, finished_at: iso(), summary, outcomes,
      }, null, 1)));
    }
  }
  console.log(JSON.stringify({
    arm: ARM, guideline, plugin: PLUGIN_ID ?? null, model: MODEL ?? null, tasks: tasks.map((t) => t.id), full_set: tasks.length === TASKS.length,
    runs: runs.map((r) => ({ passed: r.passed, ran: r.ran, by_category: r.summary })),
  }));
  process.exit(unfinished ? 1 : 0);
}

main().catch((err) => { console.error(scrub(err instanceof Error ? err.message : String(err))); process.exit(1); });
