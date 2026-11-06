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
 *   EVAL_STATIC=1 npx tsx test/e2e/sa-eval.ts                                   # what cases ask for against what their arm can do
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
 *   EVAL_VARS_FILE    a JSON object of run variables for `{{name}}` placeholders (nested objects give `{{a.b}}`); EVAL_VAR_<NAME>
 *                     sets one too. A case whose placeholders have no value is skipped and says which.
 *   EVAL_GITHUB_TOKEN_FILE, EVAL_GITHUB_API
 *                     the eval identity's GitHub token and API root (default https://api.github.com) for `gh:` oracles
 *   EVAL_ORACLE_PLUGIN_ID, EVAL_ORACLE_MCP_HOSTS
 *                     the plugin whose MCP servers `mcp:` oracles read (default EVAL_PLUGIN_ID), and the hosts their URLs may
 *                     have (comma list, https only; default the host of EVAL_CLAW): the key is sent nowhere else. Only tools on
 *                     the router's list of reads are ever called, so an oracle cannot write
 *
 * EVAL_STATIC reports, without sending anything, every case that can never pass on its arm (a tools_must no tool of the arm
 * matches: the router's from `assistant/read-tools.ts`, the worker's every plugin server, given as EVAL_STATIC_SERVERS or the
 * router's servers plus github and schedules), every case that needs the assistant and still runs in baseline, and every
 * description written as a value; exit 1 when there is one. EVAL_OUT gets static.json.
 *
 * The assistant mode works in the key owner's one assistant conversation (it must be a test identity, see above). It
 * runs the cases one at a time, waits for the assistant to be idle before each, and cleans up what it started: every
 * work item its own turns' work_create / review_start answers name is accepted (a result that waits, at the version
 * shown) or stopped, and an assistant session it created is deleted. No other item is touched; a new open item it cannot
 * tie to its calls is reported. Exit 0 when every attempt ran to a verdict and the cleanup is complete; the score is a
 * measurement, not a gate.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apiClient, until } from "./assistant-p1-lib.js";
import { traceOf, type EventRow, type ToolCall } from "./agent-eval-lib.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BUILTIN_TOOLS, caseHash, caseSays, cardsOf, cleanupOf, filledCase, finalSay, grade, forRecording, identityRefusal, itemsStartedBy, judgePrompt,
  loadCases, oracleMcpTarget, missingVars, oracleMayRun, oracleQuery, parseRecordings, pick, planOf, renderTable, routeOf, saysOf, staticFindings,
  verdictOf, scrub as scrubWith, select, sseFrames, totals, turnCalls, turnEnded, heldCallRan, heldRequest, holdAnswers, toolPattern,
  type Arms, type Attempt, type CaseResult, type EvalCase, type ItemSeen, type LiveEvent, type Mode, type Observed, type OracleQuery, type Recording,
  type Turn, type Vars, type HoldSeen, type HoldSpec,
} from "./sa-eval-lib.js";
import * as readTools from "../../src/assistant/read-tools.js";

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
const STATIC = process.env.EVAL_STATIC === "1";
const OFFLINE = process.env.EVAL_OFFLINE;
const LIVE = !DRY_RUN && !STATIC && !OFFLINE;
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
/** Checks whose detail quotes what the identity was shown: kept only with EVAL_KEEP_TEXT. */
const TEXT_DETAIL = /^(no internal text|items named by title|no false denial)/;

/** The run's variables: the environment (`{NAME}`) and EVAL_VARS_FILE (`{{name}}`, nested objects as `{{a.b}}`). */
function runVars(): Vars {
  const out: Record<string, string | undefined> = { ...process.env };
  const file = process.env.EVAL_VARS_FILE;
  if (!file) return out;
  const flat = (o: unknown, at: string): void => {
    if (o !== null && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) flat(v, at ? `${at}.${k}` : k);
    else if (at && o !== null && o !== undefined) out[at] = String(o);
  };
  flat(JSON.parse(readFileSync(file, "utf8")), "");
  return out;
}
const VARS = runVars();
/** The router's reads as allow-list entries: the only MCP tools an `mcp:` oracle may call. */
const ROUTER_READS = Object.keys(readTools.ROUTER_READ_TOOLS).flatMap((s) => readTools.readToolPatterns(s));
const RUN_ITEMS = new Set<string>();   // ids of the items the run's own turns started: the only items it ever closes
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

/** The values each fact expects, read now with the eval identity: the Claw API, GitHub, or a read tool of the plugin. */
async function factValues(c: EvalCase): Promise<Array<string[] | null>> {
  const out: Array<string[] | null> = [];
  for (const f of c.facts ?? []) {
    const o = f.oracle;
    const q = oracleQuery(o);
    // An oracle that could not be read expects something unnamed: the fact fails, it is never skipped.
    if (q) out.push(await readOracle(q).catch(() => []));
    else out.push(o && o.kind !== "api" && o.value !== undefined ? [o.value] : null);
  }
  return out;
}

async function readOracle(q: OracleQuery): Promise<string[]> {
  if (q.via === "claw") {
    const r = await api("GET", q.path);
    return r.status === 200 ? pick(r.json, q.at) : [];
  }
  if (q.via === "github") {
    const tokenFile = process.env.EVAL_GITHUB_TOKEN_FILE;
    const token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : "";
    const root = (process.env.EVAL_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
    const res = await fetch(`${root}${q.path}`, {
      headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000),
    });
    return res.status === 200 ? pick(await res.json(), q.at) : [];
  }
  if (!oracleMayRun(q, ROUTER_READS)) throw new Error(`mcp:${q.server}/${q.tool} is not one of the router's reads`);
  const client = await mcpClient(q.server);
  const r = await client.callTool({ name: q.tool, arguments: q.args }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((x) => x.type === "text")?.text ?? "";
  if (r.isError) return [];
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* a plain-text answer: picked as it is */ }
  return pick(json, q.at);
}

const mcpClients = new Map<string, Promise<Client>>();
/** A client of one of the oracle plugin's MCP servers, as Brain connects to it, with the eval identity's key. */
function mcpClient(server: string): Promise<Client> {
  let c = mcpClients.get(server);
  if (!c) {
    c = (async () => {
      const id = process.env.EVAL_ORACLE_PLUGIN_ID || process.env.EVAL_PLUGIN_ID;
      if (!id) throw new Error("mcp: oracles need EVAL_ORACLE_PLUGIN_ID");
      const r = await api("GET", `/v1/plugins/${encodeURIComponent(id)}`);
      const specs = ((r.json?.data?.tools ?? []) as Array<{ type?: string; config?: { mcpServers?: Record<string, Record<string, unknown>> } }>)
        .filter((t) => String(t.type).toLowerCase() === "mcp").map((t) => t.config?.mcpServers?.[server]).filter(Boolean);
      const spec = specs[0];
      if (!spec || typeof spec.url !== "string") throw new Error(`plugin ${id} has no MCP server ${server}`);
      // The key goes only where the operator said MCP oracles may send it: a host of EVAL_ORACLE_MCP_HOSTS (default: the Claw
      // API's own host), and only where the spec asks for it by the placeholder Brain fills with the caller's key. A spec that
      // names another host, or a plugin that points a known server name somewhere else, gets nothing and its oracle fails.
      const target = oracleMcpTarget(spec, (process.env.EVAL_ORACLE_MCP_HOSTS || new URL(CLAW).host).split(","), KEY);
      if (typeof target === "string") throw new Error(`MCP server ${server} of plugin ${id}: ${target}`);
      const { url, headers } = target;
      const client = new Client({ name: "sa-eval-oracle", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
      return client;
    })();
    mcpClients.set(server, c);
  }
  return c;
}

// --- The optional judge ---------------------------------------------------------------------------------------------

async function judge(c: EvalCase, turns: Turn[], final: string): Promise<{ pass: boolean; why: string } | null> {
  const url = process.env.EVAL_JUDGE_URL, model = process.env.EVAL_JUDGE_MODEL, keyFile = process.env.EVAL_JUDGE_KEY_FILE;
  // Every case, not only those with content only a judge can grade: the no-false-denial rule is in every prompt.
  if (!url || !model || !keyFile) return null;
  const key = readFileSync(keyFile, "utf8").trim();
  const prompt = judgePrompt(c, turns, final);
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
  const kept = KEEP_TEXT ? checks : checks.map((x) => (TEXT_DETAIL.test(x.name) && x.detail ? { ...x, detail: "<hidden: EVAL_KEEP_TEXT>" } : x));
  return {
    ...verdictOf(c, checks, verdict), checks: kept, route: o.route, cards: o.cards, tools, final: KEEP_TEXT ? scrub(o.final) : null, finalChars: o.final.length,
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
  // The case's items are only those its own turns started (read from their work_create / review_start answers): an item
  // someone else put on the board meanwhile (a review asked of this identity) is neither graded nor closed here.
  const started = turnCalls(stream.events, messageIds);
  const mine = (all: ItemSeen[]): ItemSeen[] => itemsStartedBy(started, all.filter((i) => i.seq > floor));
  let items = mine(await board());
  for (const i of items) RUN_ITEMS.add(i.item_id);
  // A request the case's item holds for its person: answered the way that person's channel answers it.
  const hold = c.hold && items.length ? await answerHold(c.hold, items, start + (c.item_wait_s ?? ITEM_WAIT_SEC) * 1000) : undefined;
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
    items, factValues: values, ...(hold ? { hold } : {}),
  };
  const allCalls = [...turnCalls(stream.events, messageIds)];
  for (const i of items) if (!lastIds.includes(i.item_id)) allCalls.push(...(await workerCalls(i.item_id).catch(() => [])));
  allCalls.push(...lastCalls.filter((x) => !lastRouter.includes(x)));
  // Clean up: everything the attempt started is accepted (a result that waits, at its version) or stopped.
  const cleaned: Attempt["items"] = [];
  for (const i of mine(await board().catch(() => items))) {
    RUN_ITEMS.add(i.item_id);
    const seen = items.find((x) => x.item_id === i.item_id) ?? i;
    cleaned.push({ seq: i.seq, kind: i.kind, board_state: seen.board_state, cleanup: await close(i) });
  }
  return attemptOf(c, turns, observed, allCalls.map((x) => x.name), cleaned);
}

/**
 * Wait for one of the case's items to hold a request `spec` names for its person (`params.holds`), then answer it as the person's
 * channel does: a `decision` or an `answer` on the worker's session, after `wait_s`. What is seen is graded (`grade`, `hold`).
 * Gives up when every item has gone on without such a request, or at the deadline.
 */
async function answerHold(spec: HoldSpec, items: readonly ItemSeen[], deadline: number): Promise<HoldSeen> {
  const seen: HoldSeen = { tool: null, cardMs: null, answered: null, heldAfterWait: null, ran: null };
  const want = toolPattern(spec.tool);
  const look = async (itemId: string): Promise<any> => {
    const r = await api("GET", `/v1/work-items/${itemId}`).catch(() => null);
    return r?.status === 200 ? r.json?.data : null;
  };
  const found = await until(async () => {
    let open = false;
    for (const i of items) {
      const d = await look(i.item_id);
      const waiting: any[] = Array.isArray(d?.params?.holds) ? d.params.holds : [];
      const h = waiting.find((x) => typeof x?.tool_use_id === "string" && want.test(String(x.tool)));
      if (d && h) {
        const held = (d.events ?? []).find((e: any) => e.source === "hold" && e.kind === "waiting" && e.result?.tool_use_id === h.tool_use_id);
        return { itemId: i.item_id, sid: String(d.worker_session_id), toolUseId: h.tool_use_id as string, tool: String(h.tool), heldAt: held ? Date.parse(held.created_at) : Date.now() };
      }
      if (!d || d.board_state === "in_progress" || waiting.length) open = true;
    }
    return open ? undefined : null;
  }, deadline, 1_000);
  if (!found) return seen;
  seen.tool = found.tool;
  const rows = await replay(found.sid).catch(() => []);
  const request = heldRequest(rows, found.toolUseId);
  if (request && Number.isFinite(request.ts)) seen.cardMs = found.heldAt - request.ts;
  if (spec.wait_s) {
    await sleep(spec.wait_s * 1000);
    const d = await look(found.itemId);
    seen.heldAfterWait = d?.board_state === "needs_you"
      && (Array.isArray(d?.params?.holds) ? d.params.holds : []).some((x: any) => x?.tool_use_id === found.toolUseId);
  }
  const body = spec.decide === "answer"
    ? { messageType: "answer", extData: { tool_use_id: found.toolUseId, answers: holdAnswers(spec, request?.questions), skipped: [] } }
    : { messageType: "decision", extData: { tool_use_id: found.toolUseId, action: spec.decide } };
  seen.answered = (await api("POST", `/v1/sessions/${found.sid}/messages`, body).catch(() => ({ status: 0 }))).status;
  // How the call ended: its own result after the answer, read off the worker's session.
  seen.ran = await until(async () => {
    const ran = heldCallRan(await replay(found.sid).catch(() => []), found.toolUseId);
    return ran === null ? undefined : ran;
  }, Date.now() + 120_000, 2_000);
  return seen;
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
    for (const line of planOf(cases, MODE, VARS)) console.log(line);
    process.exit(loaded.bad.length ? 1 : 0);
  }
  if (STATIC) staticCheck(cases, loaded.bad);
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
      if (c.modes && !c.modes.includes(MODE)) { r.skipped = `${c.modes.join(",")} only`; continue; }
      // Placeholders filled everywhere they sit: turns, claims, values, oracle queries and the rubric.
      const filled = filledCase(c, VARS);
      if (filled === null) { r.skipped = `needs ${missingVars(c, VARS).join(", ")}`; continue; }
      const turns = filled.turns;
      for (let k = 0; k < K; k++) {
        let a: Attempt;
        try {
          a = MODE === "assistant" ? await runAssistant(filled, turns, sessionId, stream!) : await runBaseline(filled, turns);
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
        for (const i of (await board()).filter((x) => RUN_ITEMS.has(x.item_id) && x.board_state !== "done")) log(`closing #${i.seq}: ${await close(i)}`);
        await sleep(5_000);
        const after = (await board()).filter((x) => x.seq > floorAtStart && x.board_state !== "done");
        leftOpen = after.filter((x) => RUN_ITEMS.has(x.item_id)).map((x) => x.seq);
        // New open items the run cannot tie to its own calls are left alone, and said: on a test identity nobody else
        // makes items, so they are most likely the run's own whose answer could not be read, and a person must look.
        const foreign = after.filter((x) => !RUN_ITEMS.has(x.item_id)).map((x) => x.seq);
        if (foreign.length) cleanupFailed.push(`open items not tied to the run's calls, left alone: ${foreign.join(",")}`);
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

/**
 * The arms' tools from the code that gives them (`assistant/read-tools.ts`, and the GitHub and web lookups where a version of it
 * has them), and every case's findings against them. Nothing is sent.
 */
function staticCheck(cases: readonly EvalCase[], bad: readonly string[]): never {
  const m = readTools as Record<string, unknown>;
  const github = Array.isArray(m.ROUTER_GITHUB_READ_TOOLS) ? (m.ROUTER_GITHUB_READ_TOOLS as string[]).map((t) => `mcp__github__${t}`) : [];
  const web = Array.isArray(m.ROUTER_WEB_TOOLS) ? (m.ROUTER_WEB_TOOLS as string[]) : [];
  const servers = (process.env.EVAL_STATIC_SERVERS || [...Object.keys(readTools.ROUTER_READ_TOOLS), "github", "schedules"].join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const worker = [...servers.map((s) => `mcp__${s}__*`), BUILTIN_TOOLS];
  const arms: Arms = { router: ["mcp__assistant__*", ...ROUTER_READS, ...github, ...web], worker, baseline: worker };
  const found = staticFindings(cases, arms, VARS);
  const count = (xs: Array<{ kind: string }>) => xs.reduce<Record<string, number>>((n, x) => ({ ...n, [x.kind]: (n[x.kind] ?? 0) + 1 }), {});
  for (const p of found.problems) console.log(`PROBLEM ${p.id} ${p.kind}: ${p.detail}`);
  const summary = { cases: cases.length, not_loaded: bad.length, problems: count(found.problems), notes: count(found.notes), router_servers: Object.keys(readTools.ROUTER_READ_TOOLS),
    router_github: github.length > 0, router_web: web.length > 0, worker_servers: servers };
  console.log(JSON.stringify(summary));
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "static.json"), JSON.stringify({ ...summary, problems: found.problems, notes: found.notes }, null, 1));
  }
  process.exit(found.problems.length || bad.length ? 1 : 0);
}

/** Grade recorded attempts again with the current cases and grader: no key, no request. */
function offline(cases: readonly EvalCase[], file: string): void {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const results = new Map<string, CaseResult>();
  for (const rec of parseRecordings(readFileSync(file, "utf8"))) {
    const c = byId.get(rec.case_id) && filledCase(byId.get(rec.case_id)!, VARS);
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
