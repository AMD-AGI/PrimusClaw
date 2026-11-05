// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Runs the super-agent evaluation against a real deployment, as a user's channel would: each case's turns go to the
 * user's assistant (`POST /v1/assistant`, then `POST /v1/sessions/:id/messages`), and what the user would be shown is
 * read from the assistant session's live stream (`AssistantSay`), with the time each message arrived here. For every
 * case it records the route (answer, work item, review, confirmation), the tool calls (the Router's, and the workers'
 * of the items it started), the cards the user would be offered, the final answer and the latency of the first reply
 * and of the final answer, and grades them with the deterministic checks of `sa-eval-lib.ts` (the case format is
 * described there).
 *
 * Baseline mode sends the same turns to a new plain session with a plugin (a user of the plugin without the
 * assistant), so the two can be compared case by case on the checks that apply to both.
 *
 *   EVAL_CLAW=https://claw.example/api EVAL_KEY_FILE=/path/to/key npx tsx test/e2e/sa-eval.ts
 *   EVAL_MODE=baseline EVAL_PLUGIN_ID=<id> EVAL_CLAW=... EVAL_KEY_FILE=... npx tsx test/e2e/sa-eval.ts
 *
 *   EVAL_DRY_RUN=1 npx tsx test/e2e/sa-eval.ts                                  # load, check and plan: nothing is sent
 *   EVAL_OFFLINE=<dir>/assistant-recordings.jsonl npx tsx test/e2e/sa-eval.ts    # grade recorded attempts again, offline
 *
 * A live run requires EVAL_CLAW (the API root, to which `/v1/...` is appended), the key as EVAL_KEY or EVAL_KEY_FILE
 * (there is no default), and EVAL_IDENTITY_ACK=test:<the email of the key's identity>. Before anything is sent it reads
 * who the key is (`GET /v1/me`) and its notification subscriptions, and refuses to run for an identity that is not
 * acknowledged as a test one, one on EVAL_IDENTITY_DENY, or one with an enabled subscription (a chat channel would push
 * what the assistant says to a person; EVAL_ALLOW_SUBSCRIBED=1 overrides only that). Never run it with a person's key.
 * The key is read when it is used and never printed or written to the results.
 * Optional:
 *   EVAL_MODE         assistant (default) or baseline
 *   EVAL_PLUGIN_ID    the plugin a baseline session names (required for baseline)
 *   EVAL_CASES_DIR    the directory of `*.jsonl` case files, read recursively (default: `sa-eval-cases` next to this file,
 *                     a small synthetic set); cases from real users' messages belong in a directory outside the repository
 *   EVAL_PIPELINES    comma list of the subdirectories to run (e.g. catalog,real; default all)
 *   EVAL_CASES        comma list of case ids, areas or pipelines (default all)
 *   EVAL_VARIANTS     1: also run the cases that are variants of another (default: not)
 *   EVAL_K            attempts per case (default 3): the report has pass@1 (mean) and pass^k
 *   EVAL_ITEM_WAIT    seconds to wait for an item's result, unless the case sets item_wait_s (default 300)
 *   EVAL_KEEP_TEXT    1: keep the final answers in the results (they are the identity's own data, and can contain what an
 *                     oracle reads from it; default: only their length). Write such results only somewhere private.
 *   EVAL_OUT          a directory for the results: <mode>.json and <mode>.md
 *   EVAL_RECORD_DIR   a directory for <mode>-recordings.jsonl: every attempt as observed (what the identity was shown
 *                     included), for EVAL_OFFLINE; written only when set, and only together with EVAL_KEEP_TEXT=1
 *   EVAL_JUDGE_URL, EVAL_JUDGE_MODEL, EVAL_JUDGE_KEY_FILE
 *                     an Anthropic-compatible gateway, a model and its key: each case with a rubric or a judge-only fact
 *                     is also graded by that model, recorded beside the deterministic verdict and never instead of it.
 *
 * The assistant mode works in the key owner's one assistant conversation, so use a test identity where you can. It
 * runs the cases one at a time, waits for the assistant to be idle before each, and cleans up everything it started:
 * every work item numbered after the run began is accepted (a result that waits, at the version shown) or stopped.
 * Items the identity had before the run are never touched. Exit 0 when every attempt ran to a verdict; the score is
 * a measurement, not a gate.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apiClient, until } from "./assistant-p1-lib.js";
import { traceOf, type EventRow, type ToolCall } from "./agent-eval-lib.js";
import {
  apiQuery, caseHash, caseSays, cardsOf, cleanupOf, finalSay, grade, forRecording, identityRefusal, itemsStartedBy, loadCases, parseRecordings, pick, planOf,
  renderTable, routeOf, saysOf, verdictOf, scrub as scrubWith, select, sseFrames, totals, turnCalls, turnEnded, turnsOf,
  type Attempt, type CaseResult, type EvalCase, type ItemSeen, type LiveEvent, type Mode, type Observed, type Recording, type Turn,
} from "./sa-eval-lib.js";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required`); process.exit(2); }
  return v;
};
const int = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) { console.error(`${name} must be an integer in ${min}..${max}`); process.exit(2); }
  return n;
};
const list = (name: string): Set<string> => new Set((process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean));

const DRY_RUN = process.env.EVAL_DRY_RUN === "1";
const OFFLINE = process.env.EVAL_OFFLINE;
const LIVE = !DRY_RUN && !OFFLINE;
const CLAW = LIVE ? need("EVAL_CLAW").replace(/\/+$/, "") : "";
const MODE = (process.env.EVAL_MODE || "assistant") as Mode;
if (MODE !== "assistant" && MODE !== "baseline") { console.error("EVAL_MODE must be assistant or baseline"); process.exit(2); }
const PLUGIN_ID = process.env.EVAL_PLUGIN_ID ? Number(process.env.EVAL_PLUGIN_ID) : undefined;
if (LIVE && MODE === "baseline" && (PLUGIN_ID === undefined || !Number.isInteger(PLUGIN_ID))) { console.error("baseline needs EVAL_PLUGIN_ID"); process.exit(2); }
const CASES_DIR = process.env.EVAL_CASES_DIR || join(dirname(fileURLToPath(import.meta.url)), "sa-eval-cases");
const K = int("EVAL_K", 3, 1, 10);
const ITEM_WAIT_SEC = int("EVAL_ITEM_WAIT", 300, 10, 3600);
const KEEP_TEXT = process.env.EVAL_KEEP_TEXT === "1";
const OUT = process.env.EVAL_OUT;
const RECORD_DIR = process.env.EVAL_RECORD_DIR;
// A recording holds what the identity was shown (and so anything an oracle reads back from its data): it is written only
// when the operator also asks to keep the text, knowingly.
if (RECORD_DIR && !KEEP_TEXT) { console.error("EVAL_RECORD_DIR writes the answers the identity was shown: set EVAL_KEEP_TEXT=1 as well to say so"); process.exit(2); }

/** The key, from the environment or the file named there; never a default. Never printed, never written. */
function apiKey(): string {
  if (process.env.EVAL_KEY) return process.env.EVAL_KEY.trim();
  const file = process.env.EVAL_KEY_FILE;
  if (!file) { console.error("EVAL_KEY or EVAL_KEY_FILE is required"); process.exit(2); }
  return readFileSync(file, "utf8").trim();
}
const KEY = LIVE ? apiKey() : "";
const api = apiClient(CLAW, KEY);
const scrub = (s: string): string => scrubWith(s, [KEY]);
const iso = (): string => new Date().toISOString();
const log = (...a: unknown[]): void => console.log(iso(), ...a.map((x) => (typeof x === "string" ? scrub(x) : x)));
const recordings: Recording[] = [];
const sessionsLeft: string[] = [];   // baseline sessions the run made and could not delete: they fail the run
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- The live stream of a session ---------------------------------------------------------------------------------

/**
 * Every event of a session that arrives on its stream, with the time it arrived here. With `skipHistory` what the
 * session held before the stream opened is left out (the assistant's earlier conversation). The stream is reopened
 * when it drops; an event stored while it was down arrives with the new stream's history and is taken with the time it
 * was seen, so a gap only makes a latency look longer, never shorter.
 */
class LiveStream {
  readonly events: LiveEvent[] = [];
  private readonly seen = new Set<string>();
  private closed = false;
  private abort = new AbortController();
  private first = true;

  constructor(private readonly sessionId: string, private readonly skipHistory: boolean) {}

  async open(): Promise<void> {
    let ready!: () => void;
    const historyDone = new Promise<void>((r) => { ready = r; });
    void (async () => {
      while (!this.closed) {
        try { await this.read(ready); } catch { /* dropped: reopened below */ }
        if (!this.closed) await sleep(2_000);
      }
    })();
    await Promise.race([historyDone, sleep(60_000)]);
  }

  private async read(ready: () => void): Promise<void> {
    this.abort = new AbortController();
    const res = await fetch(`${CLAW}/v1/chat/sessions/${this.sessionId}/messages`, {
      headers: { authorization: `Bearer ${KEY}`, accept: "text/event-stream" }, signal: this.abort.signal,
    });
    if (res.status !== 200 || !res.body) throw new Error(`stream answered ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    let live = false;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const { frames, rest } = sseFrames(buffer);
      buffer = rest;
      for (const f of frames) {
        if (f.event === "historyComplete") { live = true; ready(); continue; }
        let data: Record<string, any>;
        try { data = JSON.parse(f.data); } catch { continue; }
        const id = f.id || `${data.type}:${data.say_id ?? data.actionId ?? ""}:${data.status ?? ""}:${data.message_id ?? ""}`;
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        if (!live && this.first && this.skipHistory) continue;
        this.events.push({ at: Date.now(), eventId: id, data });
      }
      if (live) this.first = false;
    }
  }

  close(): void { this.closed = true; this.abort.abort(); }
}

// --- Reads --------------------------------------------------------------------------------------------------------

async function board(): Promise<ItemSeen[]> {
  const r = await api("GET", "/v1/work-items");
  if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new Error(`board answered ${r.status}`);
  return (r.json.data as any[]).map((i) => ({
    item_id: String(i.item_id), seq: Number(i.seq), title: String(i.title ?? ""), kind: String(i.kind ?? "task"),
    board_state: String(i.board_state), can_accept: i.can_accept === true, result_version: Number(i.result_version ?? 0),
    outcome: i.outcome ?? null,
  }));
}

async function replay(sessionId: string): Promise<EventRow[]> {
  const r = await api("GET", `/v1/chat/sessions/${sessionId}/messages?mode=replay`);
  if (r.status !== 200 || !Array.isArray(r.json?.data)) throw new Error(`replay answered ${r.status}`);
  return r.json.data as EventRow[];
}

/** The tool calls of an item's worker, when the item names one the key can read; [] otherwise. */
async function workerCalls(itemId: string): Promise<ToolCall[]> {
  const r = await api("GET", `/v1/work-items/${itemId}`);
  const sid = r.json?.data?.worker_session_id;
  if (r.status !== 200 || typeof sid !== "string" || !sid) return [];
  return traceOf(await replay(sid).catch(() => [])).calls;
}

async function idle(sessionId: string, waitMs: number): Promise<boolean> {
  return (await until(async () => {
    const r = await api("GET", `/v1/sessions/${sessionId}`).catch(() => null);
    return r?.status === 200 && r.json?.data?.agent_status !== "running" ? true : undefined;
  }, Date.now() + waitMs, 2_000)) === true;
}

/** The values each fact expects, read now: an `api` oracle through the same API with the eval identity. */
async function factValues(c: EvalCase): Promise<Array<string[] | null>> {
  const out: Array<string[] | null> = [];
  for (const f of c.facts ?? []) {
    const o = f.oracle;
    const q = apiQuery(o);
    if (q) {
      const r = await api("GET", q.path).catch(() => null);
      out.push(r?.status === 200 ? pick(r.json, q.at) : []);   // an oracle that could not be read expects something unnamed: a failure
    } else out.push(o && o.kind !== "api" && o.value !== undefined ? [o.value] : null);
  }
  return out;
}

// --- The optional judge ---------------------------------------------------------------------------------------------

async function judge(c: EvalCase, turns: Turn[], final: string): Promise<{ pass: boolean; why: string } | null> {
  const url = process.env.EVAL_JUDGE_URL, model = process.env.EVAL_JUDGE_MODEL, keyFile = process.env.EVAL_JUDGE_KEY_FILE;
  const claims = (c.facts ?? []).filter((f) => !f.oracle).map((f) => f.claim);
  if (!url || !model || !keyFile || (!c.rubric && !claims.length)) return null;
  const key = readFileSync(keyFile, "utf8").trim();
  const prompt = `You grade one reply of an assistant to a user.\nUser said:\n${turns.map((t) => t.user).join("\n")}\n\n`
    + `Assistant's final reply:\n${final}\n\n${c.rubric ? `Rubric: ${c.rubric}\n` : ""}${claims.length ? `The reply must state: ${claims.join("; ")}\n` : ""}`
    + "\nAnswer with one line: PASS or FAIL, a colon, and one short reason.";
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
    });
    const text = ((await res.json()) as any)?.content?.find((b: any) => b.type === "text")?.text ?? "";
    return { pass: /^\s*PASS/i.test(text), why: scrubWith(String(text).trim().slice(0, 300), [KEY, key]) };
  } catch (err) {
    return { pass: false, why: `judge failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const attemptOf = async (c: EvalCase, turns: Turn[], o: Observed, tools: string[], items: Attempt["items"]): Promise<Attempt> => {
  const checks = grade(c, o);
  if (RECORD_DIR) recordings.push({ case_id: c.id, mode: MODE, attempt: recordings.filter((r) => r.case_id === c.id).length + 1, at: iso(), observed: forRecording(c, o) });
  const verdict = await judge(c, turns, o.final);
  return {
    ...verdictOf(c, checks, verdict), checks, route: o.route, cards: o.cards, tools, final: KEEP_TEXT ? scrub(o.final) : null, finalChars: o.final.length,
    // The judge's reason can quote the answer: kept only with the text.
    firstReplyMs: o.firstReplyMs, finalMs: o.finalMs, items, judge: verdict && (KEEP_TEXT ? verdict : { pass: verdict.pass, why: "" }),
  };
};

// --- One attempt on the assistant path ------------------------------------------------------------------------------

async function runAssistant(c: EvalCase, turns: Turn[], sessionId: string, stream: LiveStream): Promise<Attempt> {
  if (!(await idle(sessionId, 180_000))) log(`assistant still busy before ${c.id}; sending anyway (the message is queued)`);
  const floor = Math.max(0, ...(await board()).map((i) => i.seq));
  const values = await factValues(c);
  const start = Date.now();
  const messageIds: string[] = [];
  const sentAt: number[] = [];
  for (const t of turns) {
    const wait = start + (t.after_ms ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    const at = Date.now();
    const r = await api("POST", `/v1/sessions/${sessionId}/messages`, { content: t.user, messageType: "text" });
    const id = r.json?.message_id;
    if (r.status !== 200 || typeof id !== "string") throw new Error(`message answered ${r.status}`);
    messageIds.push(id);
    sentAt.push(at);
  }
  // The Router's turns for the case's messages end (each is short: it answers or hands the work on).
  await until(() => (messageIds.every((id) => turnEnded(stream.events, id)) ? true : undefined), Date.now() + 180_000, 500);
  const mine = (all: ItemSeen[]): ItemSeen[] => all.filter((i) => i.seq > floor);
  let items = mine(await board());
  if (items.length) {
    // The item's result (or question, or failure; or its end, for a case that stops it), then what was said about it.
    const settled = (is: ItemSeen[]): boolean => is.every((i) => (c.items_closed ? i.board_state === "done" : i.board_state !== "in_progress"));
    await until(async () => {
      items = mine(await board().catch(() => items));
      return settled(items) ? true : undefined;
    }, start + (c.item_wait_s ?? ITEM_WAIT_SEC) * 1000, 5_000);
    await until(() => (items.every((i) => i.board_state === "in_progress"
      || saysOf(stream.events).some((s) => s.itemId === i.item_id && s.itemState !== "in_progress")) ? true : undefined), Date.now() + 30_000, 1_000);
  }
  // What is graded is the last turn (earlier turns are its context and may start items of their own): its Router turn's
  // calls, the items that turn started and their workers' calls, what was said in it and about those items. Leaks are
  // looked for in everything the case showed; latencies run from the last turn's sending.
  const says = saysOf(stream.events);
  const lastId = messageIds.at(-1)!;
  const lastSent = sentAt.at(-1)!;
  const lastRouter = turnCalls(stream.events, [lastId]);
  const lastItems = itemsStartedBy(lastRouter, items);
  const lastIds = lastItems.map((i) => i.item_id);
  const lastCalls = [...lastRouter];
  for (const i of lastItems) lastCalls.push(...(await workerCalls(i.item_id).catch(() => [])));
  const lastSays = caseSays(says, [lastId], lastIds);
  const final = finalSay(says, [lastId], lastIds);
  const shown = caseSays(says, messageIds, items.map((i) => i.item_id));
  const firstOwn = lastSays.length ? Math.min(...lastSays.map((s) => s.at)) : null;
  const observed: Observed = {
    mode: MODE, route: routeOf(lastItems, lastRouter, lastSays), cards: cardsOf(lastSays), calls: lastCalls, shown: shown.map((s) => s.text),
    final: final?.text ?? "", firstReplyMs: firstOwn === null ? null : firstOwn - lastSent, finalMs: final ? final.at - lastSent : null,
    replyMs: messageIds.map((id, k) => { const s = says.find((x) => x.turn === id); return s ? s.at - sentAt[k]! : null; }),
    items, factValues: values,
  };
  const allCalls = [...turnCalls(stream.events, messageIds)];
  for (const i of items) if (!lastIds.includes(i.item_id)) allCalls.push(...(await workerCalls(i.item_id).catch(() => [])));
  allCalls.push(...lastCalls.filter((x) => !lastRouter.includes(x)));
  // Clean up: everything the attempt started is accepted (a result that waits, at its version) or stopped.
  const cleaned: Attempt["items"] = [];
  for (const i of mine(await board().catch(() => items))) {
    const seen = items.find((x) => x.item_id === i.item_id) ?? i;
    cleaned.push({ seq: i.seq, kind: i.kind, board_state: seen.board_state, cleanup: await close(i) });
  }
  return attemptOf(c, turns, observed, allCalls.map((x) => x.name), cleaned);
}

async function close(i: ItemSeen): Promise<string> {
  const op = cleanupOf(i);
  if (!op) return "already closed";
  if (op.op === "accept") {
    const r = await api("POST", `/v1/work-items/${i.item_id}/accept`, { version: op.version });
    if (r.status === 200) return `accepted v${op.version}`;
  }
  const s = await api("POST", `/v1/work-items/${i.item_id}/stop`, {});
  return s.status === 200 ? "stopped" : `stop answered ${s.status}`;
}

// --- One attempt on a plain session (baseline) ------------------------------------------------------------------------

async function runBaseline(c: EvalCase, turns: Turn[]): Promise<Attempt> {
  const values = await factValues(c);
  const start = Date.now();
  const created = await api("POST", "/v1/sessions", { name: `sa-eval-${c.id}`, message: { content: turns[0]!.user, pluginId: PLUGIN_ID } });
  const sessionId: string | undefined = created.json?.data?.session_id;
  if (!sessionId) throw new Error(`create answered ${created.status}`);
  const stream = new LiveStream(sessionId, false);
  try {
    await stream.open();
    const denied = new Set<string>();
    const ends = (): LiveEvent[] => stream.events.filter((e) => e.data?.type === "exec_complete");
    // The cases only read: every approval is denied, so a turn waiting on one does not hang the run.
    const waitEnds = async (n: number, deadline: number): Promise<void> => {
      await until(async () => {
        for (const e of stream.events) {
          const tid = e.data?.tool_use_id;
          if (e.data?.type !== "permissionRequest" || typeof tid !== "string" || denied.has(tid)) continue;
          denied.add(tid);
          await api("POST", `/v1/sessions/${sessionId}/messages`, { messageType: "decision", extData: { tool_use_id: tid, action: "deny" } });
        }
        return ends().length >= n ? true : undefined;
      }, deadline, 500);
    };
    await waitEnds(1, start + 600_000);
    const sentAt: number[] = [start];
    let lastMid: string | undefined;   // the last turn's message id (a single-turn case: every event is the last turn's)
    const firstText: Array<number | null> = [stream.events.find((e) => e.data?.type === "AssistantMessage")?.at ?? null];
    for (const [k, t] of turns.slice(1).entries()) {
      const wait = start + (t.after_ms ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);
      const at = Date.now();
      const r = await api("POST", `/v1/sessions/${sessionId}/messages`, { content: t.user, messageType: "text", pluginId: PLUGIN_ID });
      if (r.status !== 200) throw new Error(`message answered ${r.status}`);
      lastMid = typeof r.json?.message_id === "string" ? r.json.message_id : undefined;
      sentAt.push(at);
      await waitEnds(k + 2, at + 600_000);
      firstText.push(stream.events.find((e) => e.data?.type === "AssistantMessage" && e.at >= at)?.at ?? null);
    }
    await sleep(3_000);
    const rows = await replay(sessionId);
    const all = traceOf(rows);
    const lastCalls = lastMid ? traceOf(rows, lastMid).calls : all.calls;
    const last = ends().at(-1);
    const finalText = String(last?.data.final_text || all.final || "");
    const lastSent = sentAt.at(-1)!;
    const lastFirst = firstText.at(-1) ?? null;
    const observed: Observed = {
      mode: MODE, calls: lastCalls, shown: ends().map((e) => String(e.data.final_text ?? "")), final: finalText,
      firstReplyMs: lastFirst === null ? null : lastFirst - lastSent, finalMs: last ? last.at - lastSent : null,
      replyMs: firstText.map((a, k) => (a === null ? null : a - sentAt[k]!)), items: [], factValues: values,
    };
    const trace = all;
    return attemptOf(c, turns, observed, trace.calls.map((x) => x.name), []);
  } finally {
    stream.close();
    const gone = await until(async () => ((await api("DELETE", `/v1/sessions/${sessionId}`).catch(() => ({ status: 0 }))).status === 200 ? true : undefined), Date.now() + 60_000, 10_000);
    if (!gone) { log(`could not delete session ${sessionId} of ${c.id}`); sessionsLeft.push(sessionId); }
  }
}

// --- The run ------------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const loaded = loadCases(CASES_DIR);
  for (const b of loaded.bad) log(`case not loaded: ${b}`);
  const cases = select(loaded.cases, list("EVAL_CASES"), list("EVAL_PIPELINES"), process.env.EVAL_VARIANTS === "1");
  if (!cases.length) { console.error("no case selected"); process.exit(2); }
  if (DRY_RUN) {
    console.log(`dry run: mode=${MODE} k=${K} cases=${cases.length} from ${CASES_DIR}; nothing is sent`);
    for (const line of planOf(cases, MODE, process.env)) console.log(line);
    process.exit(loaded.bad.length ? 1 : 0);
  }
  if (OFFLINE) return offline(cases, OFFLINE);
  // Before anything is said to anybody's assistant: whose key this is, and whether a channel would carry the run to a person.
  const me = await api("GET", "/v1/me");
  if (me.status !== 200) { console.error(`GET /v1/me answered ${me.status}`); process.exit(2); }
  const subs = await api("GET", "/v1/notification-subscriptions");
  if (subs.status !== 200 || !Array.isArray(subs.json?.data)) { console.error(`GET /v1/notification-subscriptions answered ${subs.status}: refusing to run blind`); process.exit(2); }
  const refusal = identityRefusal(me.json ?? {}, subs.json.data, process.env);
  if (refusal) { console.error(`refusing to run: ${refusal}`); process.exit(2); }
  log(`mode=${MODE} plugin=${PLUGIN_ID ?? "-"} cases=${cases.length} k=${K}`);
  let sessionId = "";
  let stream: LiveStream | null = null;
  let createdAssistant = false;   // the run made the identity's assistant session: it is deleted at the end
  // The board's highest number is read before anything is made, so whatever fails after it, everything numbered above it
  // is the run's and is closed below.
  const floorAtStart = MODE === "assistant" ? Math.max(0, ...(await board()).map((i) => i.seq)) : 0;
  const results: CaseResult[] = [];
  let cleanupFailed: string[] = [];
  let leftOpen: number[] = [];
  try {
    if (MODE === "assistant") {
      const a = await api("POST", "/v1/assistant", {});
      sessionId = a.json?.data?.session_id;
      if (a.status !== 200 || !sessionId) throw new Error(`POST /v1/assistant answered ${a.status}`);
      createdAssistant = a.json?.data?.created === true;
      stream = new LiveStream(sessionId, true);
      await stream.open();
    }
    for (const c of cases) {
      const r: CaseResult = { id: c.id, area: c.area, pipeline: c.pipeline, mode: MODE, hash: c.source?.hash ?? caseHash(c), attempts: [] };
      results.push(r);
      const turns = turnsOf(c, process.env);
      if (c.modes && !c.modes.includes(MODE)) { r.skipped = `${c.modes.join(",")} only`; continue; }
      if (turns === null) { r.skipped = `needs ${c.needs}`; continue; }
      for (let k = 0; k < K; k++) {
        let a: Attempt;
        try {
          a = MODE === "assistant" ? await runAssistant(c, turns, sessionId, stream!) : await runBaseline(c, turns);
        } catch (err) {
          a = { pass: false, checks: [], tools: [], final: null, finalChars: 0, firstReplyMs: null, finalMs: null, items: [], error: scrub(err instanceof Error ? err.message : String(err)) };
        }
        r.attempts.push(a);
        const failed = a.checks.filter((x) => !x.pass).map((x) => x.name);
        log(`${a.error ? "ERROR" : a.pass ? "pass" : "FAIL"} ${c.id}#${k + 1} route=${a.route ?? "-"} cards=${a.cards ?? "-"} first=${a.firstReplyMs}ms final=${a.finalMs}ms ${a.error ?? failed.join("; ")}`);
      }
    }
  } catch (err) {
    log(`run stopped: ${err instanceof Error ? err.message : String(err)}`);
    cleanupFailed.push("the run stopped before its cases finished");
  } finally {
    stream?.close();
    // Whatever happened, nothing the run started stays open; what could not be closed fails the run.
    if (MODE === "assistant") {
      try {
        for (const i of (await board()).filter((x) => x.seq > floorAtStart && x.board_state !== "done")) log(`closing #${i.seq}: ${await close(i)}`);
        await sleep(5_000);
        leftOpen = (await board()).filter((x) => x.seq > floorAtStart && x.board_state !== "done").map((x) => x.seq);
      } catch (err) {
        cleanupFailed.push(`the board could not be read to close the run's items: ${err instanceof Error ? err.message : String(err)}`);
      }
      log(`items created by the run that are still open: ${leftOpen.length ? leftOpen.join(",") : "none"}`);
      if (leftOpen.length) cleanupFailed.push(`items still open: ${leftOpen.join(",")}`);
      if (createdAssistant) {
        const gone = await until(async () => ((await api("DELETE", `/v1/sessions/${sessionId}`).catch(() => ({ status: 0 }))).status === 200 ? true : undefined), Date.now() + 60_000, 10_000);
        log(gone ? "deleted the assistant session the run created" : `could not delete the assistant session ${sessionId} the run created`);
        if (!gone) cleanupFailed.push("the assistant session the run created was not deleted");
      }
    }
  }
  if (sessionsLeft.length) cleanupFailed.push(`baseline sessions not deleted: ${sessionsLeft.join(",")}`);
  cleanupFailed = cleanupFailed.map(scrub);
  if (RECORD_DIR) {
    mkdirSync(RECORD_DIR, { recursive: true });
    writeFileSync(join(RECORD_DIR, `${MODE}-recordings.jsonl`), scrub(recordings.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  }
  report(results, cases.length, leftOpen, cleanupFailed);
}

/** Grade recorded attempts again with the current cases and grader: no key, no request. */
function offline(cases: readonly EvalCase[], file: string): void {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const results = new Map<string, CaseResult>();
  for (const rec of parseRecordings(readFileSync(file, "utf8"))) {
    const c = byId.get(rec.case_id);
    if (!c) continue;
    const r = results.get(c.id) ?? { id: c.id, area: c.area, pipeline: c.pipeline, mode: rec.mode, hash: c.source?.hash ?? caseHash(c), attempts: [] };
    results.set(c.id, r);
    const o = rec.observed;
    const checks = grade(c, o);
    r.attempts.push({ ...verdictOf(c, checks, null), checks, route: o.route, cards: o.cards, tools: o.calls.map((x) => x.name), final: KEEP_TEXT ? o.final : null,
      finalChars: o.final.length, firstReplyMs: o.firstReplyMs, finalMs: o.finalMs, items: [] });
  }
  if (!results.size) { console.error(`no recording in ${file} matches a selected case`); process.exit(2); }
  report([...results.values()], results.size, [], []);
}

function report(results: CaseResult[], selected: number, leftOpen: number[], cleanupFailed: string[]): void {
  const sum = totals(results);
  const summary = { mode: MODE, offline: !!OFFLINE, plugin: PLUGIN_ID ?? null, k: K, finished_at: iso(), cases: selected, totals: sum, left_open: leftOpen, cleanup_failed: cleanupFailed };
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${MODE}.json`), scrub(JSON.stringify({ ...summary, results }, null, 1)));
    writeFileSync(join(OUT, `${MODE}.md`), scrub(`# sa-eval ${MODE} (k=${K})\n\n${renderTable(results)}\n`));
  }
  console.log(scrub(renderTable(results)));
  console.log(JSON.stringify(summary));
  for (const why of cleanupFailed) console.error(`cleanup: ${why}`);
  process.exit(results.every((r) => r.attempts.every((a) => !a.error)) && !cleanupFailed.length ? 0 : 1);
}

void main();
