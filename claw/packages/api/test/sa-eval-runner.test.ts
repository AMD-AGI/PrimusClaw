// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The super-agent evaluation's runner (`test/e2e/sa-eval.ts`) run as an operator runs it, against a fake Claw API on a local
 * port (no database, no model): what it sends, what it deletes, and when it refuses or stops.
 *
 *   R1 a run that made the assistant session: a turn is over once its exec_complete is stored (a stream never carries it, and
 *      its executionStats comes before the workspace sync); the item it started is closed and its worker's session deleted; each deletion counts only once a GET
 *      answers 404 (a DELETE that answered 200 and left the session is asked again); another session of the identity is
 *      never touched
 *   R2 an assistant session that is running, was active a moment ago, or was made a moment ago (by another run that has not
 *      sent anything yet), refuses the run before anything is sent
 *   R3 SIGINT stops the run: nothing more is sent, the item the interrupted turn started is closed and its worker's session
 *      deleted, the session the run made is deleted, and the run exits 1 saying it was stopped; in baseline mode, a stop
 *      during a case's oracle reads sends nothing, and one during a turn lets the turn end before its session is deleted and
 *      sends no decision after it; a
 *      stop before the assistant session was asked for asks for none
 *   R4 the identity's says of the last hour, stored before the run, hold the first case until there is room; a say the
 *      server refused for its hourly cap makes the attempt the run's failure. Says of an earlier run, whose assistant session
 *      is gone, are read from its say log, and the run leaves its own there
 *   R5 baseline: a plain session's turn is over once its exec_complete is stored, what it showed is graded (a tool name in an earlier
 *      message fails the case; a sub-agent's message is not the first reply; the final answer's time is when it was shown, not
 *      the turn's end), and the session is deleted and seen gone; R5b with two turns, what is graded of the last turn is its
 *      own (another turn's message delivered again is not its answer)
 *   R7 a stream that missed a stored event of the case (a leak in a say it never delivered, not even in a new stream's history,
 *      though the gap opened the stream again): an error, not a grade; an item whose work_create answer the stream missed is
 *      still closed with its worker's session; R7b an assistant session still running before a case: nothing is sent, an error;
 *      R7c a gap that a new stream's history fills is graded (the stream is opened again at once, and the attempt says when);
 *      a turn's progress, sandbox and plugin-loading events are no gap; R7d an attempt that ended in an error of the run is run
 *      again once (EVAL_INFRA_RETRY), and the second try is reported with the first one's error; R7e a first try recorded before
 *      its error (a judge that failed) leaves no recording: EVAL_OFFLINE grades the one attempt the live report has
 *   R9 a judge that gives no verdict (an error status, a busy or failing gateway twice, no PASS or FAIL twice) makes the attempt an
 *      error of the run, not a FAIL; a verdict-less answer is asked again saying what was missing; a verdict on the last line of a
 *      judge that reasons first counts; its FAIL fails, its PASS passes. R3e a stop while the stream holds its history back ends the wait at once
 *   R10 an oracle that could not be read makes the attempt the run's error before anything is sent; one that answers is graded
 *   R11 a read the grade needs that failed (a worker's events, the board through the item wait) makes the attempt the run's
 *      error, its item still closed; in the final cleanup, a board that answers again after a while is read again and the
 *      run's items are closed (R11b: one the attempt never saw, tied by its work_create answer on that same read)
 *   R12 a message whose answer was lost: the attempt is an error, and the item its turn started is left alone and said (nothing
 *      shows the server took that message: a person's message with the same text would look the same); a
 *      baseline session whose creation answer was lost is asked for again with the same idempotency key, and deleted;
 *      an item that cannot be read to delete its worker's session fails the cleanup; R12d a stop while the creation is asked
 *      for again: not asked again, and the session that may be left is said
 *   R8 a work_create that found someone else's open item with the same title (`deduplicated`): that item is not the run's, and
 *      is neither closed nor stripped of its worker's session
 *   R13 a turn whose router said nothing: the server's own reply, a moment after the turn's end, is waited for (EVAL_SAY_GRACE_S),
 *      graded and timed; without the wait the case had no answer
 *   R14 EVAL_FRESH_SESSION_EVERY: each case in a new assistant session, the one before closed and deleted (seen gone) first; an
 *      assistant session the identity already has is deleted (seen gone) before anything is sent, its says still counted for the
 *      pace, and the first case starts in a new one; one in use refuses the run, nothing deleted, also when it starts a turn between
 *      the run's first look and the DELETE (it is looked at once more right before)
 *   R15 EVAL_VARS_CMD is run before each case, so a value read right before it fills its text; one that fails is the run's error for
 *      that case, and nothing of it is sent
 *   R16 EVAL_GAP_S: the next case waits that long after the last one ended
 *   R17 EVAL_SEND_TOKEN_CMD: the messages go with the person's signed-in token, everything else with the key; a token that is not
 *      the key's identity refuses the run before anything is sent
 *   R18 a person who writes to the run's assistant session while the run is on: the item their turn started is not the run's and
 *      is neither closed nor stripped of its worker's session (it is said as left alone), while the run's own item is closed
 *   R20 "items named by title" knows the board's highest item number: a "#n" above it is not one of the person's items
 *   R19 a multi-turn case: each item in the results says whether the graded last turn started it (`last`), so an item an earlier
 *      turn started is not counted as the last turn's
 *   R21 the judge: its FAIL on a case every deterministic check passed is asked again (a third time on a split) and the majority
 *      decides, a case a check failed is judged once; it is told the values the run read as the truth; its reasons are kept without
 *      EVAL_KEEP_TEXT; EVAL_RECORD_DIR (no EVAL_KEEP_TEXT needed) is made 0700 and its file 0600 with the whole answers and every
 *      judge answer, and a directory open to others, or under one others may change, refuses the run before anything is sent
 *   R22 memory entries: the entries an attempt made (listed after it, not before) are deleted after it, by id, and the entries the
 *      identity had before are kept; one that could not be deleted fails the cleanup (cleanup_failed); a case's
 *      setup.forget_memories deletes the identity's entries it names before the attempt's first message, and one it could not
 *      delete makes the attempt the run's error with nothing sent
 *   R23 expect_memory / expect_no_memory are graded on the entries the attempt made, read after its turns and before they are
 *      deleted: an entry saved before the attempt does not satisfy expect_memory; a failing check fails the attempt by name
 *   R6 a turn whose end the stream never shows: graded when the stored events have its exec_complete (a delivery Brain gave up
 *      on ends with that alone), an error and not a grade when they do not either, or only after the wait from its own message
 *      (an earlier turn of a case is held to its own); a turn still running when the run ends is reported
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { JUDGE_RETRY_NOTE } from "./e2e/sa-eval-lib.js";
import { tmpDir } from "../../utils/test/tmp-dirs.js";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(API_DIR, "test", "e2e", "sa-eval.ts");
const EMAIL = "sa-eval-bot@example.test";

interface Item { item_id: string; seq: number; title: string; kind: string; board_state: string; can_accept: boolean; result_version: number; worker_session_id: string }
interface Row { event_id: string; event_type: string; data: Record<string, unknown>; created_at: string }

/** A Claw API with one identity, its assistant session, its board, and a scripted router. */
class FakeClaw {
  readonly calls: string[] = [];
  readonly callAt: number[] = [];
  /** When each turn's exec_complete was stored, by message id. */
  readonly settledAt = new Map<string, number>();
  readonly sent: Array<{ at: number; content: string }> = [];
  readonly sessions = new Map<string, { status: string; stale: number; createdAt?: number }>();
  /** The judge's answers, in order (an HTTP status, or the text of a 200). */
  judgeAnswers: Array<number | string> = [];
  /** What the judge was asked, in order. */
  judgePrompts: string[] = [];
  /** How long a stream holds back the end of its history. */
  historyDelayMs = 0;
  readonly items: Item[] = [];
  readonly rows = new Map<string, Row[]>();
  assistant = "asst-1";
  created = true;
  /** A new assistant session (`asst-2`, ...) is made when the last one was deleted, as the API does. */
  freshAssistant = false;
  private assistantAsked = 0;
  /** The identity's memory entries, by id. */
  readonly memories = new Map<number, { id: number; title: string; body: string }>();
  /** Memory entries whose DELETE answers 500 and leaves them. */
  readonly failMemoryDelete = new Set<number>();
  /** The authorization each message to a session came with. */
  readonly messageAuth: string[] = [];
  /** Who `GET /v1/me` says the caller is, by its authorization. */
  meFor: (authorization: string) => string = () => EMAIL;
  /** The next board read answers this much later (the run's first read is before anything is made). */
  boardDelayMs = 0;
  boardReads = 0;
  /** The board answers 503 until then; `boardScript` first gives the next reads' statuses. */
  boardFailUntil = 0;
  boardScript: number[] = [];
  /** Sessions whose stored events answer 500. */
  readonly failReplay = new Set<string>();
  /** Items whose own read answers 503. */
  readonly failItemDetail = new Set<string>();
  /** How many of the next message or session-create requests are done, but their answer lost (the connection dropped). */
  loseMessageAnswers = 0;
  loseCreateAnswers = 0;
  private readonly idempotent = new Map<string, unknown>();
  router: (content: string, messageId: string, sessionId: string) => void = () => {};
  /** Called on every GET of a session, with how many there were of it so far (this one included). */
  onSessionGet: (sessionId: string, n: number) => void = () => {};
  private readonly sessionGets = new Map<string, number>();
  /** Called when the run asks for its assistant session: what the run reads right after is set up relative to that moment. */
  onAssistant: () => void = () => {};
  /** The caller's hourly say cap POST /v1/assistant answers with (`say_max_per_hour`); undefined: not said, as an older server. */
  sayMaxPerHour: number | undefined = undefined;
  /** Stored events the stream does not deliver (a stream stalled without dropping): a new stream's history still has them. */
  hidden: (data: Record<string, unknown>) => boolean = () => false;
  /** Stored events no stream ever delivers, not even in a new stream's history. */
  withheld: (data: Record<string, unknown>) => boolean = () => false;
  /** How many times a session's stream was opened. */
  readonly streamsOpened = new Map<string, number>();
  private readonly streams = new Map<string, Set<ServerResponse>>();
  private server!: Server;
  private n = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    // A test that failed before stopping its fake does not keep the test process alive.
    this.server.unref();
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const set of this.streams.values()) for (const s of set) s.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** An event of a session (the assistant's unless named): stored for a replay and pushed to the session's open streams. */
  emit(data: Record<string, unknown>, at = Date.now(), sessionId = this.assistant): void {
    const row: Row = { event_id: `ev-${++this.n}`, event_type: String(data.type), data, created_at: new Date(at).toISOString() };
    this.rows.set(sessionId, [...(this.rows.get(sessionId) ?? []), row]);
    if (row.event_type === "exec_complete") this.settledAt.set(String(data.message_id), Date.now());
    // The API keeps exec_complete from a stream (`routes/events.ts`).
    if (row.event_type === "exec_complete" || this.hidden(data) || this.withheld(data)) return;
    for (const s of this.streams.get(sessionId) ?? []) s.write(frame(row));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const body = await new Promise<string>((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => r(b)); });
    if (!(method === "GET" && path === "/v1/work-items")) { this.calls.push(`${method} ${path}${url.search}`); this.callAt.push(Date.now()); }
    const send = (status: number, json: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/v1/me") {
      const email = this.meFor(String(req.headers.authorization ?? ""));
      return send(200, { userId: email === EMAIL ? "u-eval" : `u-${email}`, name: "sa-eval-bot", email });
    }
    if (method === "POST" && path === "/judge/v1/messages") {
      this.judgePrompts.push(String((JSON.parse(body || "{}") as any)?.messages?.[0]?.content ?? ""));
      const a = this.judgeAnswers.shift() ?? "PASS: ok";
      return typeof a === "number" ? send(a, { error: "down" }) : send(200, { content: [{ type: "text", text: a }] });
    }
    // Oracles: one that is down, one that answers.
    if (method === "GET" && path === "/v1/oracle-down") return send(503, { ok: false });
    if (method === "GET" && path === "/v1/oracle-ok") return send(200, { data: { n: 3 } });
    // An oracle read that takes a while (a fact's `/v1/...#pick`).
    if (method === "GET" && path === "/v1/slow-oracle") { setTimeout(() => send(200, { data: { n: 3 } }), 2_000); return; }
    if (method === "GET" && path === "/v1/notification-subscriptions") return send(200, { ok: true, data: [] });
    if (method === "GET" && path === "/v1/users/me/memories") return send(200, { ok: true, data: [...this.memories.values()].map((e) => ({ ...e, content: e.body })) });
    if ((m = /^\/v1\/users\/me\/memories\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const id = Number(m[1]);
      if (this.failMemoryDelete.has(id)) return send(500, { ok: false });
      return this.memories.delete(id) ? send(200, { ok: true }) : send(404, { ok: false, error: "not found" });
    }
    if (method === "GET" && path === "/v1/work-items") {
      this.boardReads++;
      const scripted = this.boardScript.shift();
      if (scripted !== undefined ? scripted !== 200 : Date.now() < this.boardFailUntil) return send(scripted ?? 503, { ok: false });
      if (this.boardDelayMs) { const wait = this.boardDelayMs; this.boardDelayMs = 0; setTimeout(() => send(200, { ok: true, data: this.items }), wait); return; }
      return send(200, { ok: true, data: this.items });
    }
    if (method === "POST" && path === "/v1/assistant") {
      this.onAssistant();
      if (this.freshAssistant && this.assistantAsked++ && !this.sessions.has(this.assistant)) {
        this.assistant = `asst-${Number(this.assistant.slice(5)) + 1}`;
        this.created = true;
      }
      if (!this.sessions.has(this.assistant)) this.sessions.set(this.assistant, { status: "idle", stale: 0 });
      return send(200, { ok: true, data: { session_id: this.assistant, created: this.created, ...(this.sayMaxPerHour === undefined ? {} : { say_max_per_hour: this.sayMaxPerHour }) } });
    }
    if ((m = /^\/v1\/work-items\/([^/]+)$/.exec(path)) && method === "GET") {
      if (this.failItemDetail.has(m[1]!)) return send(503, { ok: false });
      const i = this.items.find((x) => x.item_id === m![1]);
      return i ? send(200, { ok: true, data: i }) : send(404, { ok: false });
    }
    if ((m = /^\/v1\/work-items\/([^/]+)\/(accept|stop)$/.exec(path)) && method === "POST") {
      const i = this.items.find((x) => x.item_id === m![1]);
      if (!i) return send(404, { ok: false });
      i.board_state = "done";
      i.can_accept = false;
      return send(200, { ok: true, data: i });
    }
    if ((m = /^\/v1\/sessions\/([^/]+)$/.exec(path))) {
      if (method === "GET") {
        const n = (this.sessionGets.get(m[1]!) ?? 0) + 1;
        this.sessionGets.set(m[1]!, n);
        this.onSessionGet(m[1]!, n);
      }
      const s = this.sessions.get(m[1]!);
      if (method === "GET") {
        return s ? send(200, { ok: true, data: { session_id: m[1], agent_status: s.status, created_at: new Date(s.createdAt ?? Date.now() - 7_200_000).toISOString() } })
          : send(404, { ok: false });
      }
      if (method === "DELETE") {
        if (!s) return send(404, { ok: false });
        // A DELETE that answered 200 while the session stayed (the case a GET after it is there to catch).
        if (s.stale > 0) { s.stale--; return send(200, { ok: true }); }
        this.sessions.delete(m[1]!);
        return send(200, { ok: true });
      }
    }
    if ((m = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path)) && method === "POST") {
      const id = `msg-${this.sent.length + 1}`;
      const content = String(JSON.parse(body).content ?? "");
      this.sent.push({ at: Date.now(), content });
      this.messageAuth.push(String(req.headers.authorization ?? ""));
      // Stored, with its id, before the answer, as the API does (`sessions/dispatch.ts`): a lost answer still leaves it.
      this.userMessage(m[1]!, id, content);
      if (this.loseMessageAnswers > 0) { this.loseMessageAnswers--; req.socket.destroy(); }
      else send(200, { ok: true, message_id: id });
      const sessionId = m[1]!;
      setTimeout(() => this.router(content, id, sessionId), 20);
      return;
    }
    if (method === "POST" && path === "/v1/sessions") {
      // A plain session (baseline) that starts with its first message; a repeat with the same idempotency key gets the first
      // answer again.
      const key = String(req.headers["idempotency-key"] ?? "");
      const answer = key ? this.idempotent.get(key) : undefined;
      if (answer) {
        if (this.loseCreateAnswers > 0) { this.loseCreateAnswers--; req.socket.destroy(); return; }
        return send(200, answer);
      }
      const sessionId = `plain-${this.sessions.size + 1}`;
      this.sessions.set(sessionId, { status: "running", stale: 0 });
      const content = String(JSON.parse(body).message?.content ?? "");
      this.sent.push({ at: Date.now(), content });
      const made = { ok: true, data: { session_id: sessionId, message: { message_id: "msg-first" } } };
      if (key) this.idempotent.set(key, made);
      if (this.loseCreateAnswers > 0) { this.loseCreateAnswers--; req.socket.destroy(); } else send(200, made);
      setTimeout(() => this.router(content, "msg-first", sessionId), 300);
      return;
    }
    if ((m = /^\/v1\/chat\/sessions\/([^/]+)\/messages$/.exec(path)) && method === "GET") {
      if (!this.sessions.has(m[1]!)) return send(404, { ok: false });
      const sessionId = m[1]!;
      if (url.searchParams.get("mode") === "replay") {
        return this.failReplay.has(sessionId) ? send(500, { ok: false }) : send(200, { ok: true, data: this.rows.get(sessionId) ?? [] });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      this.streamsOpened.set(sessionId, (this.streamsOpened.get(sessionId) ?? 0) + 1);
      for (const row of this.rows.get(sessionId) ?? []) if (row.event_type !== "exec_complete" && !this.withheld(row.data)) res.write(frame(row));
      if (this.historyDelayMs) await new Promise((r) => setTimeout(r, this.historyDelayMs));
      res.write("event: historyComplete\ndata: {}\n\n");
      const open = this.streams.get(sessionId) ?? new Set<ServerResponse>();
      this.streams.set(sessionId, open.add(res));
      req.on("close", () => open.delete(res));
      return;
    }
    send(404, { ok: false, error: `no route ${method} ${path}` });
  }

  /**
   * The router's turn for one message: an optional work_create that starts `item`, a say, and its end as Brain sends it:
   * executionStats, then (after the workspace sync and the transcript, `settleMs` here) exec_complete.
   */
  /** A message of the session's person, stored as the API stores one (`UserMessage`, with its id and text). */
  userMessage(sessionId: string, messageId: string, text: string): void {
    this.emit({ type: "UserMessage", message_id: messageId, role: "user", data: { content: [{ type: "text", text }] } }, Date.now(), sessionId);
  }

  turn(messageId: string, opts: { item?: Item; say?: string; refusedSay?: boolean; end?: boolean; settleMs?: number }): void {
    if (opts.item) {
      this.items.push(opts.item);
      this.sessions.set(opts.item.worker_session_id, { status: "running", stale: 0 });
      this.emit({ type: "toolUsed", message_id: messageId, tool: "mcp__assistant__work_create", status: "start", actionId: `a-${messageId}` });
      this.emit({ type: "toolUsed", message_id: messageId, tool: "mcp__assistant__work_create", status: "success", actionId: `a-${messageId}`,
        result: JSON.stringify({ ok: true, item_id: opts.item.item_id, seq: opts.item.seq }) });
    }
    if (opts.refusedSay) {
      this.emit({ type: "toolUsed", message_id: messageId, tool: "mcp__assistant__say", status: "start", actionId: `r-${messageId}` });
      this.emit({ type: "toolUsed", message_id: messageId, tool: "mcp__assistant__say", status: "error", actionId: `r-${messageId}`,
        description: "say_rate_limited: at most 120 messages an hour" });
    }
    if (opts.say) {
      this.emit({ type: "AssistantSay", say_id: `say-${messageId}`, turn_message_id: messageId, text: opts.say,
        ...(opts.item ? { item: { item_id: opts.item.item_id, board_state: opts.item.board_state, can_accept: opts.item.can_accept } } : {}) });
    }
    if (opts.end !== false) {
      this.emit({ type: "executionStats", message_id: messageId, turns: 1 });
      setTimeout(() => this.emit({ type: "exec_complete", message_id: messageId, final_text: opts.say ?? "" }), opts.settleMs ?? 200);
    }
  }
}

const frame = (row: Row): string => `id: ${row.event_id}\nevent: ${row.event_type}\ndata: ${JSON.stringify(row.data)}\n\n`;

const item = (n: number, over: Partial<Item> = {}): Item => ({
  item_id: `item-${n}`, seq: n, title: `task ${n}`, kind: "task", board_state: "ready", can_accept: true, result_version: 1, worker_session_id: `worker-${n}`, ...over,
});

interface Run { code: number | null; out: string; child: ChildProcess }

/** The runner as an operator starts it, on the cases given, against `claw`. */
function runner(claw: string, cases: object[], env: Record<string, string> = {}, dir = tmpDir("sa-eval-runner-")): { done: Promise<Run>; child: ChildProcess; dir: string } {
  mkdirSync(join(dir, "cases"), { recursive: true });
  writeFileSync(join(dir, "cases", "c.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(dir, "key"), "test-key-not-a-secret\n");
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir,
      EVAL_CLAW: claw, EVAL_KEY_FILE: join(dir, "key"), EVAL_IDENTITY_ACK: `test:${EMAIL}`, EVAL_CASES_DIR: join(dir, "cases"), EVAL_K: "1",
      // One try per attempt unless a test asks for the retry (R7d): the other tests are each about one try's error.
      EVAL_OUT: join(dir, "out"), EVAL_SAY_LOG: join(dir, "says.jsonl"), EVAL_INFRA_RETRY: "0", ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (b) => { out += String(b); });
  child.stderr!.on("data", (b) => { out += String(b); });
  // A runner that never ends is killed (its own child process, by its handle), so a hang fails its test instead of the suite.
  const killer = setTimeout(() => child.kill("SIGKILL"), 100_000);
  const done = new Promise<Run>((resolve) => child.on("exit", (code) => { clearTimeout(killer); resolve({ code, out, child }); }));
  return { done, child, dir };
}

const until = async (ok: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

const itemCase = (over: object = {}) => ({
  id: "t-items-001", pipeline: "catalog", area: "items", lang: "en", modes: ["assistant"], route: "item", item_wait_s: 20,
  turns: [{ user: "start a task" }], tools_must: ["mcp__assistant__work_create"], ...over,
});

// The runs wait on the runner, not on the CPU: they go side by side, each with its own fake API and directory.
describe("the runner against a fake Claw API", { concurrency: 8 }, () => {
  it("R1 the run's own sessions are deleted and seen gone; nothing else is", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.sessions.set("someone-elses", { status: "idle", stale: 0 });
    // The turn finishes 2 s after its executionStats (Brain's workspace sync and transcript): nothing is graded or closed before.
    claw.router = (_content, id) => claw.turn(id, { item: item(1), say: "Task 1 is ready for your review.", settleMs: 2_000 });
    // The assistant session's first DELETE answers 200 and leaves it: only a GET that answers 404 counts.
    const r = runner(base, [itemCase()]);
    await until(() => claw.sessions.has(claw.assistant), 30_000);
    claw.sessions.get(claw.assistant)!.stale = 1;
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /pass t-items-001#1/, "the turn's end was seen: executionStats, not exec_complete");
      const deletes = claw.calls.filter((c) => c.startsWith("DELETE"));
      assert.deepEqual(deletes, ["DELETE /v1/sessions/worker-1", "DELETE /v1/sessions/asst-1", "DELETE /v1/sessions/asst-1"]);
      assert.ok(claw.calls.indexOf("GET /v1/sessions/worker-1") > claw.calls.indexOf("DELETE /v1/sessions/worker-1"), "a GET after the DELETE");
      assert.ok(!claw.sessions.has("worker-1") && !claw.sessions.has("asst-1"));
      assert.ok(claw.sessions.has("someone-elses"), "never deleted by identity");
      assert.deepEqual(claw.calls.filter((c) => c.includes("/accept")), ["POST /v1/work-items/item-1/accept"]);
      const acceptedAt = claw.callAt[claw.calls.indexOf("POST /v1/work-items/item-1/accept")]!;
      assert.ok(acceptedAt >= claw.settledAt.get("msg-1")!, "the item is closed only after the turn's exec_complete was stored");
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.deepEqual(report.cleanup_failed, []);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R2 an assistant session in use refuses the run before anything is sent", { timeout: 120_000 }, async () => {
    for (const [why, setup, env] of [
      ["running", (c: FakeClaw) => c.sessions.set(c.assistant, { status: "running", stale: 0 }), {}],
      ["active a moment ago", (c: FakeClaw) => { c.sessions.set(c.assistant, { status: "idle", stale: 0 }); c.emit({ type: "AssistantSay", say_id: "x", text: "hi" }); }, {}],
      // Another run made it a moment ago and has not sent anything yet.
      ["made a moment ago", (c: FakeClaw) => c.sessions.set(c.assistant, { status: "idle", stale: 0, createdAt: Date.now() - 5_000 }), {}],
    ] as const) {
      const claw = new FakeClaw();
      claw.created = false;
      const base = await claw.start();
      setup(claw);
      const r = runner(base, [itemCase()], env);
      const run = await r.done;
      await claw.stop();
      rmSync(r.dir, { recursive: true, force: true });
      assert.equal(run.code, 2, `${why}: ${run.out}`);
      assert.match(run.out, /refusing to run: .*(running|active \d+s ago)/, why);
      assert.deepEqual(claw.sent, [], `${why}: nothing sent`);
      assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE") || c.includes("/stop") || c.includes("/accept")), [], `${why}: nothing touched`);
    }
  });

  it("R3 SIGINT stops the run and still cleans up", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    // The first message's turn starts an item that is still working; the second message is due three seconds later.
    claw.router = (content, id) => { if (content === "one") claw.turn(id, { item: item(2, { board_state: "in_progress", can_accept: false }), say: "On it." }); };
    const r = runner(base, [itemCase({ turns: [{ user: "one" }, { user: "two", after_ms: 3000 }] })]);
    await until(() => claw.items.length === 1, 30_000);
    await new Promise((res) => setTimeout(res, 300));
    r.child.kill("SIGINT");
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /SIGINT: nothing more is sent/);
      assert.match(run.out, /stopped by SIGINT/);
      assert.deepEqual(claw.sent.map((s) => s.content), ["one"], "the second message is never sent");
      assert.deepEqual(claw.calls.filter((c) => c.includes("/stop") || c.includes("/accept")), ["POST /v1/work-items/item-2/stop"], "the interrupted turn's item is closed");
      assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE")), ["DELETE /v1/sessions/worker-2", "DELETE /v1/sessions/asst-1"]);
      assert.ok(!claw.sessions.has("worker-2") && !claw.sessions.has("asst-1"));
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R3b SIGINT in baseline mode while an oracle is read: the session is never created", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    const r = runner(base, [{ id: "t-base-002", pipeline: "catalog", area: "general", lang: "en", route: "answer", turns: [{ user: "how many?" }],
      facts: [{ claim: "the count", oracle: { kind: "api", query: "/v1/slow-oracle#data.n" } }] }], { EVAL_MODE: "baseline", EVAL_PLUGIN_ID: "9" });
    await until(() => claw.calls.includes("GET /v1/slow-oracle"), 30_000);
    r.child.kill("SIGINT");
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /stopped by SIGINT/);
      assert.deepEqual(claw.sent, [], "no session was created with the first turn");
      assert.ok(!claw.calls.includes("POST /v1/sessions"));
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R3c SIGINT in baseline mode during a turn: the turn ends before the session is deleted", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id, sessionId) => {
      claw.emit({ type: "AssistantMessage", message_id: id, data: { content: [{ type: "text", text: "Looking." }] } }, Date.now(), sessionId);
      // After the stop, the turn asks to run a held tool: nothing is sent after a stop, a decision included.
      setTimeout(() => claw.emit({ type: "permissionRequest", message_id: id, tool_use_id: "tu-1", tool: "mcp__safe__workload_stop" }, Date.now(), sessionId), 1_800);
      setTimeout(() => {
        claw.emit({ type: "executionStats", message_id: id, turns: 1 }, Date.now(), sessionId);
        claw.emit({ type: "exec_complete", message_id: id, final_text: "3 nodes." }, Date.now(), sessionId);
      }, 3_000);
    };
    const r = runner(base, [{ id: "t-base-003", pipeline: "catalog", area: "general", lang: "en", route: "answer", turns: [{ user: "how many?" }] }],
      { EVAL_MODE: "baseline", EVAL_PLUGIN_ID: "9" });
    await until(() => claw.calls.includes("POST /v1/sessions"), 30_000);
    await new Promise((res) => setTimeout(res, 1_000));
    r.child.kill("SIGINT");
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /stopped by SIGINT/);
      const deletedAt = claw.callAt[claw.calls.indexOf("DELETE /v1/sessions/plain-1")]!;
      assert.ok(deletedAt >= claw.settledAt.get("msg-first")!, "the turn under way ended before its session was deleted");
      assert.ok(!claw.sessions.has("plain-1"));
      assert.ok(!claw.calls.includes("POST /v1/sessions/plain-1/messages"), "no decision sent after the stop");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R3d SIGINT before the assistant session is asked for: none is asked for", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.boardDelayMs = 2_000;
    const r = runner(base, [itemCase()]);
    await until(() => claw.boardReads > 0, 30_000);
    await new Promise((res) => setTimeout(res, 300));
    r.child.kill("SIGINT");
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /stopped by SIGINT/);
      assert.ok(!claw.calls.includes("POST /v1/assistant"), "no assistant session selected or made after the stop");
      assert.deepEqual(claw.sent, []);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R4b an earlier run's says, from its log: its assistant session is gone", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    const dir = tmpDir("sa-eval-runner-");
    // The earlier run saw three says that leave the hour 4 s after the run asks for its session (and one older than the hour,
    // and a broken line): set then, so how long the runner takes to start does not matter.
    let old = 0;
    claw.onAssistant = () => {
      old = Date.now() - 3_600_000 + 4_000;
      writeFileSync(join(dir, "says.jsonl"), [0, 1, 2].map((k) => JSON.stringify({ id: `old-${k}`, at: old + k })).join("\n")
        + `\n${JSON.stringify({ id: "older", at: old - 60_000 })}\nnot a say\n`);
    };
    claw.router = (_content, id) => claw.turn(id, { say: "There are 3 nodes." });
    const r = runner(base, [{ id: "t-answer-002", pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user: "how many nodes?" }] }],
      { EVAL_SAY_PER_HOUR: "3", EVAL_SAY_RESERVE: "1" }, dir);
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /say cap: waiting \ds/);
      assert.ok(claw.sent[0]!.at >= old + 3_600_000, "held until the oldest of the earlier run's says left the hour");
      const kept = readFileSync(join(dir, "says.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
      assert.ok(kept.includes("say-msg-1"), "the run leaves its own say for the next run");
      assert.ok(!kept.includes("older"), "only the last hour's");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("R4c a pace raised past the server's cap for the identity is kept 20 under that cap", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    claw.sayMaxPerHour = 23;
    const base = await claw.start();
    const dir = tmpDir("sa-eval-runner-");
    // As R4b: three says of an earlier run that leave the hour 4 s after the run asks for its session. EVAL_SAY_PER_HOUR=550 would
    // send at once; the server's 23 makes the pace 3, and with the reserve of 1 the case waits for them.
    let old = 0;
    claw.onAssistant = () => {
      old = Date.now() - 3_600_000 + 4_000;
      writeFileSync(join(dir, "says.jsonl"), [0, 1, 2].map((k) => JSON.stringify({ id: `old-${k}`, at: old + k })).join("\n") + "\n");
    };
    claw.router = (_content, id) => claw.turn(id, { say: "There are 3 nodes." });
    const r = runner(base, [{ id: "t-answer-003", pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user: "how many nodes?" }] }],
      { EVAL_SAY_PER_HOUR: "550", EVAL_SAY_RESERVE: "1" }, dir);
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /say pace: 3 an hour \(EVAL_SAY_PER_HOUR=550; the server's cap for this identity: 23\)/);
      assert.match(run.out, /say cap: waiting \ds for room \(pace 3 an hour/);
      assert.ok(claw.sent[0]!.at >= old + 3_600_000, "held under the server's cap, not the configured pace");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("R4 the hourly say cap: earlier says hold the first case; a refused say is the run's failure", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    claw.created = false;
    const base = await claw.start();
    claw.sessions.set(claw.assistant, { status: "idle", stale: 0 });
    // Three counted says that leave the hour 4 s after the run asks for its session, one fallback the cap does not count: set
    // then, so how long the runner takes to start does not matter.
    let old = 0;
    claw.onAssistant = () => {
      old = Date.now() - 3_600_000 + 4_000;
      for (const k of [0, 1, 2]) claw.emit({ type: "AssistantSay", say_id: `old-${k}`, text: "earlier" }, old + k);
      claw.emit({ type: "AssistantSay", say_id: "fb", text: "fallback", fallback: true }, Date.now() - 5_000);
    };
    claw.router = (_content, id) => claw.turn(id, { refusedSay: true, say: "There are 3 nodes." });
    const started = Date.now();
    const r = runner(base, [{ id: "t-answer-001", pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user: "how many nodes?" }] }],
      { EVAL_SAY_PER_HOUR: "3", EVAL_SAY_RESERVE: "1", EVAL_QUIET_S: "1" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /say cap: waiting \ds/, run.out);
      assert.equal(claw.sent.length, 1);
      assert.ok(claw.sent[0]!.at >= old + 3_600_000, `sent ${claw.sent[0]!.at - started} ms after the start, before the oldest say left the hour`);
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ERROR t-answer-001#1 .*infra: 1 say\(s\) refused by the hourly cap/);
      assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE")), [], "the session it did not make is not deleted");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R5 baseline: the turn's end, what it showed, and its session", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id, sessionId) => {
      const text = (t: string) => ({ type: "AssistantMessage", message_id: id, data: { content: [{ type: "text", text: t }] } });
      // A sub-agent answers at once, and the main agent writes an empty text block; its first words come only 1.5 s later: that
      // is the user's first reply.
      claw.emit({ ...text("sub-agent notes"), subagent_id: "sub-1" }, Date.now(), sessionId);
      claw.emit(text(""), Date.now(), sessionId);
      // The final answer is shown at 1.5 s; the turn's executionStats comes 6 s after it, its exec_complete 1.5 s after that.
      setTimeout(() => {
        claw.emit(text("Calling mcp__safe__node_list for you."), Date.now(), sessionId);
        claw.emit(text("There are 3 nodes."), Date.now(), sessionId);
        setTimeout(() => {
          claw.emit({ type: "executionStats", message_id: id, turns: 1 }, Date.now(), sessionId);
          setTimeout(() => claw.emit({ type: "exec_complete", message_id: id, final_text: "There are 3 nodes." }, Date.now(), sessionId), 1_500);
        }, 6_000);
      }, 1_500);
    };
    const r = runner(base, [{ id: "t-base-001", pipeline: "catalog", area: "general", lang: "en", route: "answer", turns: [{ user: "how many nodes?" }],
      latency_budget_s: { first: 1, final: 5 } }], { EVAL_MODE: "baseline", EVAL_PLUGIN_ID: "9" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /FAIL t-base-001#1 .*no internal text: tool name/, run.out);
      assert.match(run.out, /FAIL t-base-001#1 .*first reply <= 1s/, "the sub-agent's message is not the user's first reply");
      assert.doesNotMatch(run.out, /final <= 5s/, "the final answer was shown at 1.5 s: on time, though the turn ended 6 s later");
      const deletedAt = claw.callAt[claw.calls.indexOf("DELETE /v1/sessions/plain-1")]!;
      assert.ok(deletedAt >= claw.settledAt.get("msg-first")!, "the session is deleted only after its turn's exec_complete was stored");
      assert.equal(run.code, 0, "a failed case is a measurement: the run itself completed and cleaned up");
      assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE")), ["DELETE /v1/sessions/plain-1"]);
      assert.ok(claw.calls.indexOf("GET /v1/sessions/plain-1") > claw.calls.indexOf("DELETE /v1/sessions/plain-1"), "a GET after the DELETE");
      assert.ok(!claw.sessions.has("plain-1"));
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R5b baseline, two turns: what is graded of the last turn is its own", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (content, id, sessionId) => {
      const at = Date.now();
      if (content === "first") claw.emit({ type: "AssistantMessage", message_id: id, data: { content: [{ type: "text", text: "There are 3 nodes." }] } }, at, sessionId);
      else {
        // The second turn shows nothing (a sub-agent's text is not shown); the stream delivers the first turn's answer again (a
        // reconnect) while it runs.
        claw.emit({ type: "AssistantMessage", message_id: "msg-first", data: { content: [{ type: "text", text: "There are 3 nodes." }] } }, at, sessionId);
        claw.emit({ type: "AssistantMessage", message_id: id, subagent_id: "sub-1", data: { content: [{ type: "text", text: "hidden notes" }] } }, at, sessionId);
      }
      claw.emit({ type: "executionStats", message_id: id }, at, sessionId);
      setTimeout(() => claw.emit({ type: "exec_complete", message_id: id, final_text: "" }, Date.now(), sessionId), 200);
    };
    const r = runner(base, [{ id: "t-base-004", pipeline: "catalog", area: "general", lang: "en", route: "answer",
      turns: [{ user: "first" }, { user: "second", after_ms: 1_000 }], latency_budget_s: { first: 5 } }], { EVAL_MODE: "baseline", EVAL_PLUGIN_ID: "9" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /FAIL t-base-004#1 .*answered/, "the last turn answered nothing: an earlier turn's answer, or a sub-agent's text, is not its");
      assert.match(run.out, /FAIL t-base-004#1 .*first reply <= 5s/, "nor is another turn's message its first reply");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R6 a turn with no end on the stream", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (content, id) => {
      // executionStats on the stream, but its exec_complete is never stored: not over.
      if (content === "stats only") claw.emit({ type: "executionStats", message_id: id });
      if (content === "slow first") {
        // Over 6 s after its message, past EVAL_TURN_WAIT_S=4, though before a wait counted from the case's last message ends.
        setTimeout(() => { claw.emit({ type: "executionStats", message_id: id }); claw.emit({ type: "exec_complete", message_id: id, final_text: "first" }); }, 6_000);
      }
      if (content === "quick second") claw.turn(id, { say: "second" });
      if (content === "late") {
        // Over 7 s after its message, past EVAL_TURN_WAIT_S=4: late is late, even if the end is stored by the time anyone looks.
        setTimeout(() => { claw.emit({ type: "executionStats", message_id: id }); claw.emit({ type: "exec_complete", message_id: id, final_text: "late" }); }, 7_000);
      }
      if (content === "poisoned") {
        // Brain gave up on the delivery: exec_complete alone, which the stream never carries.
        claw.emit({ type: "AssistantSay", say_id: `say-${id}`, turn_message_id: id, text: "Sorry, that did not go through." });
        claw.emit({ type: "exec_complete", message_id: id, final_text: "", failed: true, failure_reason: "delivery_exhausted" });
      }
      // "silent": nothing at all.
    };
    const turnCase = (id: string, user: string) => ({ id, pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user }] });
    const r = runner(base, [turnCase("t-silent-001", "silent"), turnCase("t-poison-001", "poisoned"), turnCase("t-late-001", "late"),
      { ...turnCase("t-twoturn-001", "slow first"), turns: [{ user: "slow first" }, { user: "quick second", after_ms: 5_000 }] },
      turnCase("t-stats-001", "stats only")], { EVAL_TURN_WAIT_S: "4" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /ERROR t-silent-001#1 .*no end of the turn of msg-1 within 4 s of its message: not graded/, run.out);
      assert.match(run.out, /pass t-poison-001#1/, "its end was in the stored events: graded on what the user saw");
      assert.match(run.out, /ERROR t-late-001#1 .*no end of the turn of msg-3 within 4 s of its message: not graded/, "a turn over after the wait is not graded");
      assert.match(run.out, /ERROR t-twoturn-001#1 .*no end of the turn of msg-4 within 4 s of its message: not graded/, "each turn has its own wait");
      assert.equal(run.code, 1, "an attempt that could not be graded fails the run");
      assert.match(run.out, /ERROR t-stats-001#1 .*no end of the turn of msg-6 within 4 s of its message: not graded/, "executionStats alone is not the end");
      assert.match(run.out, /cleanup: turns of the run still running at its end \(what they start is not closed\): msg-1,msg-6\n/, "the turns still running are named by the stored events");
      assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE")), ["DELETE /v1/sessions/asst-1"]);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R7 what the stream missed is not graded; the run's items are still closed", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    // The stream misses the work_create answer and a say with a tool name in it, even in a new stream's history; both are stored.
    claw.withheld = (d) => (d.type === "toolUsed" && d.tool === "mcp__assistant__work_create" && d.status === "success") || (d.type === "AssistantSay" && String(d.text).includes("mcp__"));
    claw.router = (content, id) => {
      claw.turn(id, { item: item(1, { board_state: "in_progress", can_accept: false }), say: "On it." });
      claw.emit({ type: "AssistantSay", say_id: `leak-${id}`, turn_message_id: id, text: "I called mcp__safe__node_list." });
    };
    const r = runner(base, [itemCase({ item_wait_s: 1 })]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /ERROR t-items-001#1 .*the stream missed 2 stored event\(s\) of the case/, run.out);
      // The gap opened the stream again first (its history did not have them either), and the attempt says when.
      assert.match(run.out, /the stream of asst-1 is opened again \(a stored event was not delivered\)/);
      assert.equal(claw.streamsOpened.get("asst-1"), 2);
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.match(report.results[0].attempts[0].reopened?.[0] ?? "", /^\d{4}-\d\d-\d\dT\S+Z forced$/);
      assert.deepEqual(claw.calls.filter((c) => c.includes("/stop") || c.includes("/accept")), ["POST /v1/work-items/item-1/stop"], "tied by its stored work_create answer and closed");
      assert.ok(claw.calls.includes("DELETE /v1/sessions/worker-1") && !claw.sessions.has("worker-1"));
      assert.doesNotMatch(run.out, /not tied to the run's calls/);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R7c a gap the stream's history fills is graded; what nothing graded reads is no gap", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    // The live stream stalls on the work_create answer and on a say with a tool name in it; a new stream's history has both.
    claw.hidden = (d) => (d.type === "toolUsed" && d.tool === "mcp__assistant__work_create" && d.status === "success") || (d.type === "AssistantSay" && String(d.text).includes("mcp__"));
    // A turn's progress, its sandbox and Brain's plugin loading never reach any stream (E249: 8 such events at a turn's start).
    claw.withheld = (d) => d.type === "statusUpdate" || d.type === "sandboxStatus" || (d.type === "toolUsed" && String(d.tool).startsWith("load_"));
    claw.router = (content, id) => {
      claw.emit({ type: "statusUpdate", message_id: id, agentStatus: "running" });
      claw.emit({ type: "sandboxStatus", message_id: id, status: "ready" });
      claw.emit({ type: "toolUsed", message_id: id, tool: "load_mcp", status: "success", actionId: `plugin_mcp_${id}`, brief: "Loaded plugin MCP (safe)" });
      claw.turn(id, { item: item(1, { board_state: "in_progress", can_accept: false }), say: "On it." });
      claw.emit({ type: "AssistantSay", say_id: `leak-${id}`, turn_message_id: id, text: "I called mcp__safe__node_list." });
    };
    const r = runner(base, [itemCase({ item_wait_s: 1 })]);
    const run = await r.done;
    await claw.stop();
    try {
      // Graded on what the reopened stream brought: the leak it would have missed fails the case; nothing is an error.
      assert.match(run.out, /FAIL t-items-001#1 .*no internal text/, run.out);
      assert.doesNotMatch(run.out, /ERROR|stream missed/);
      assert.match(run.out, /the stream of asst-1 is opened again \(a stored event was not delivered\)/);
      assert.equal(claw.streamsOpened.get("asst-1"), 2, "opened once more, for the gap");
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.equal(report.results[0].attempts[0].reopened?.length, 1);
      assert.deepEqual(claw.calls.filter((c) => c.includes("/stop") || c.includes("/accept")), ["POST /v1/work-items/item-1/stop"]);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R7d an attempt that ended in an error of the run is run again once", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    // The first try's say is stored but never delivered, not even by a new stream; the second try's is.
    claw.withheld = (d) => d.type === "AssistantSay" && d.turn_message_id === "msg-1";
    claw.router = (_content, id) => claw.turn(id, { say: "There are 3." });
    const answer = { id: "t-a-001", pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user: "how many?" }],
      facts: [{ claim: "the count", oracle: { kind: "static", value: "3" } }] };
    const r = runner(base, [answer], { EVAL_INFRA_RETRY: "1" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /ERROR t-a-001#1 the stream missed 1 stored event\(s\) of the case .*: running it again once/);
      assert.match(run.out, /pass t-a-001#1 .*\(second try\)/);
      assert.deepEqual(claw.sent.map((x) => x.content), ["how many?", "how many?"]);
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      const attempts = report.results[0].attempts;
      assert.equal(attempts.length, 1, "the second try is the attempt");
      assert.equal(attempts[0].pass, true);
      assert.equal(attempts[0].error, undefined);
      assert.match(attempts[0].retried, /the stream missed 1 stored event/);
      assert.match(attempts[0].reopened?.[0] ?? "", / forced$/, "the first try's reopening is kept");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R7e a retried attempt is recorded once: the first try's recording is dropped", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    // The first try is recorded, then its judge fails twice (busy gateway): an error of the run, after the recording. The second try
    // is judged.
    claw.judgeAnswers = [503, 503, "PASS: states the count"];
    claw.router = (_content, id) => claw.turn(id, { say: "There are 3." });
    const answer = { id: "t-a-002", pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user: "how many?" }],
      facts: [{ claim: "the count", oracle: { kind: "static", value: "3" } }] };
    const dir = tmpDir("sa-eval-runner-");
    writeFileSync(join(dir, "judge-key"), "judge-key-not-a-secret\n");
    const r = runner(base, [answer], { EVAL_INFRA_RETRY: "1", EVAL_JUDGE_URL: `${base}/judge`, EVAL_JUDGE_MODEL: "m", EVAL_JUDGE_KEY_FILE: join(dir, "judge-key"),
      EVAL_KEEP_TEXT: "1", EVAL_RECORD_DIR: join(dir, "records") }, dir);
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /ERROR t-a-002#1 infra: judge answered 503: running it again once/);
      assert.match(run.out, /pass t-a-002#1 .*\(second try\)/);
      const recs = readFileSync(join(dir, "records", "assistant-recordings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(recs.map((x) => `${x.case_id}#${x.attempt}`), ["t-a-002#1"], "one recording for one attempt");
      // Graded again offline, the case has the one attempt the live report has.
      const off = runner(base, [answer], { EVAL_OFFLINE: join(dir, "records", "assistant-recordings.jsonl"), EVAL_OUT: join(dir, "offline") }, dir);
      const offRun = await off.done;
      const offline = JSON.parse(readFileSync(join(dir, "offline", "assistant.json"), "utf8"));
      assert.equal(offline.results.find((x: any) => x.id === "t-a-002").attempts.length, 1, offRun.out);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("R7b an assistant session still running before a case: nothing is sent", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    // The first case's turn leaves the session running (a conversation that goes on).
    claw.router = (_content, id) => { claw.turn(id, { say: "Done." }); claw.sessions.get(claw.assistant)!.status = "running"; };
    const answer = (id: string) => ({ id, pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user: id }] });
    const r = runner(base, [answer("t-a-001"), answer("t-a-002")], { EVAL_TURN_WAIT_S: "4" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /pass t-a-001#1/, run.out);
      assert.match(run.out, /ERROR t-a-002#1 .*the assistant session was still running 4 s before t-a-002: nothing sent/);
      assert.deepEqual(claw.sent.map((x) => x.content), ["t-a-001"]);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R8 an item work_create only found again is not the run's", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id) => {
      // Someone else opened item 5 with the same title a moment ago; work_create answers with it, deduplicated.
      const theirs = item(5, { board_state: "in_progress", can_accept: false });
      claw.items.push(theirs);
      claw.sessions.set(theirs.worker_session_id, { status: "running", stale: 0 });
      claw.emit({ type: "toolUsed", message_id: id, tool: "mcp__assistant__work_create", status: "start", actionId: `a-${id}` });
      claw.emit({ type: "toolUsed", message_id: id, tool: "mcp__assistant__work_create", status: "success", actionId: `a-${id}`,
        result: JSON.stringify({ ok: true, item_id: theirs.item_id, seq: theirs.seq, deduplicated: true }) });
      claw.turn(id, { say: "That task is already under way." });
    };
    const r = runner(base, [itemCase({ item_wait_s: 1 })]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.deepEqual(claw.calls.filter((c) => c.includes("/stop") || c.includes("/accept")), [], "not closed");
      assert.ok(!claw.calls.includes("DELETE /v1/sessions/worker-5") && claw.sessions.has("worker-5"), "its worker's session kept");
      assert.match(run.out, /cleanup: open items not tied to the run's calls, left alone: 5/, "said, for a person to look at");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R9 a judge that gives no verdict is the run's error, not the assistant's FAIL", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    // An answer without a verdict, and a busy or failing gateway, are asked once more: t-j-001 gets 503 twice, t-j-002 no verdict
    // twice, t-j-005 a verdict on the second ask, t-j-006 one after a 503; t-j-007's judge reasons first and ends on its verdict;
    // t-j-008's 400 is not asked again.
    // t-j-003's FAIL (every deterministic check passed) is asked again, and the second FAIL decides.
    claw.judgeAnswers = [503, 503, "Hmm, hard to say.", "Still unsure.", "FAIL: wrong count", "FAIL: still the wrong count", "PASS: names the count", "Let me think.", "**PASS**: on a second ask",
      502, "PASS: after a 502", "The reply gives the count the user asked for.\n\nPASS: names the count", 400];
    claw.router = (_content, id) => claw.turn(id, { say: "There are 3 nodes." });
    const answer = (id: string) => ({ id, pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user: id }] });
    const dir = tmpDir("sa-eval-runner-");
    writeFileSync(join(dir, "judge-key"), "judge-key-not-a-secret\n");
    const r = runner(base, ["t-j-001", "t-j-002", "t-j-003", "t-j-004", "t-j-005", "t-j-006", "t-j-007", "t-j-008"].map(answer),
      { EVAL_JUDGE_URL: `${base}/judge`, EVAL_JUDGE_MODEL: "m", EVAL_JUDGE_KEY_FILE: join(dir, "judge-key") }, dir);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /ERROR t-j-001#1 .*infra: judge answered 503/, run.out);
      assert.match(run.out, /ERROR t-j-002#1 .*infra: judge gave no PASS or FAIL/);
      assert.match(run.out, /FAIL t-j-003#1/);
      assert.match(run.out, /pass t-j-004#1/);
      assert.match(run.out, /pass t-j-005#1/);
      assert.match(run.out, /pass t-j-006#1/);
      assert.match(run.out, /pass t-j-007#1/);
      assert.match(run.out, /ERROR t-j-008#1 .*infra: judge answered 400/);
      assert.equal(claw.judgeAnswers.length, 0, "every answer was asked for");
      assert.equal(claw.judgePrompts.filter((x) => x.endsWith(JUDGE_RETRY_NOTE)).length, 2, "a verdict-less answer's second ask says what was missing");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("R21 the judge: a lone FAIL is asked again and the majority decides; its reasons are kept; the recording is private", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    // t-m-001: FAIL, then PASS, PASS (E249: a judge that held a newer version than it knew to be made up); t-m-002: FAIL twice;
    // t-m-003: a deterministic check fails, so its judge's FAIL is not asked again.
    claw.judgeAnswers = ["FAIL: ROCm 10.1.0 does not exist", "PASS: states 10.1.0", "PASS: the version read for the run",
      "FAIL: no source named", "FAIL: still no source", "FAIL: the count is wrong"];
    claw.router = (content, id) => claw.turn(id, { say: content === "t-m-003" ? "There are 4." : "The latest ROCm is 10.1.0." });
    const version = (id: string) => ({ id, pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user: id }],
      facts: [{ claim: "the latest ROCm release", oracle: { kind: "static", value: id === "t-m-003" ? "3" : "10.1.0" } }] });
    const dir = tmpDir("sa-eval-runner-");
    writeFileSync(join(dir, "judge-key"), "judge-key-not-a-secret\n");
    const records = join(dir, "private", "records");
    const r = runner(base, ["t-m-001", "t-m-002", "t-m-003"].map(version),
      { EVAL_JUDGE_URL: `${base}/judge`, EVAL_JUDGE_MODEL: "m", EVAL_JUDGE_KEY_FILE: join(dir, "judge-key"), EVAL_RECORD_DIR: records }, dir);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /pass t-m-001#1/, run.out);
      assert.match(run.out, /FAIL t-m-002#1/);
      assert.match(run.out, /FAIL t-m-003#1/);
      const asked = (id: string) => claw.judgePrompts.filter((x) => x.includes(`User said:\n${id}\n`));
      assert.deepEqual(["t-m-001", "t-m-002", "t-m-003"].map((id) => asked(id).length), [3, 2, 1]);
      // The judge is told the value the run has, as the truth.
      assert.match(asked("t-m-001")[0]!, /source of truth[\s\S]*- the latest ROCm release: "10\.1\.0"/);
      const report = JSON.parse(readFileSync(join(dir, "out", "assistant.json"), "utf8"));
      const judged = (id: string) => report.results.find((x: any) => x.id === id).attempts[0];
      // The reasons are kept without EVAL_KEEP_TEXT (the answer is not).
      assert.equal(judged("t-m-001").final, null);
      assert.deepEqual(judged("t-m-001").judge, { pass: true, why: "PASS: states 10.1.0", votes: [
        { pass: false, why: "FAIL: ROCm 10.1.0 does not exist" }, { pass: true, why: "PASS: states 10.1.0" }, { pass: true, why: "PASS: the version read for the run" }] });
      assert.equal(judged("t-m-002").judge.why, "FAIL: no source named");
      assert.equal(judged("t-m-002").judge.votes.length, 2);
      assert.deepEqual(judged("t-m-003").judge, { pass: false, why: "FAIL: the count is wrong" });
      // The recording, in a directory made private, keeps the whole answers and every judge answer.
      assert.equal(statSync(records).mode & 0o777, 0o700);
      // One open file: its mode and its text are of the same file.
      const fd = openSync(join(records, "assistant-recordings.jsonl"), "r");
      let text: string;
      try {
        assert.equal(fstatSync(fd).mode & 0o777, 0o600);
        text = readFileSync(fd, "utf8");
      } finally { closeSync(fd); }
      const recs = text.trim().split("\n").map((l) => JSON.parse(l));
      const rec = recs.find((x) => x.case_id === "t-m-001");
      assert.equal(rec.observed.final, "The latest ROCm is 10.1.0.");
      assert.deepEqual(rec.judge, { pass: true, answers: ["FAIL: ROCm 10.1.0 does not exist", "PASS: states 10.1.0", "PASS: the version read for the run"] });
      assert.doesNotMatch(text, /test-key-not-a-secret|judge-key-not-a-secret/);
    } finally { rmSync(dir, { recursive: true, force: true }); }

    // A recording directory others can read: refused before anything is sent.
    const open = new FakeClaw();
    const base2 = await open.start();
    const dir2 = tmpDir("sa-eval-runner-");
    mkdirSync(join(dir2, "shared"), { mode: 0o755 });
    chmodSync(join(dir2, "shared"), 0o755);
    // A private directory under one others may write (not sticky): it could be moved away and replaced before the write.
    mkdirSync(join(dir2, "anyones"), { mode: 0o777 });
    chmodSync(join(dir2, "anyones"), 0o777);
    const r2 = runner(base2, [version("t-m-004")], { EVAL_RECORD_DIR: join(dir2, "shared") }, dir2);
    const run2 = await r2.done;
    const r3 = runner(base2, [version("t-m-005")], { EVAL_RECORD_DIR: join(dir2, "anyones", "mine") }, dir2);
    const run3 = await r3.done;
    await open.stop();
    try {
      assert.equal(run2.code, 2, run2.out);
      assert.match(run2.out, /refusing to run: EVAL_RECORD_DIR is open to group or others \(mode 755/);
      assert.equal(run3.code, 2, run3.out);
      assert.match(run3.out, /refusing to run: EVAL_RECORD_DIR lies under \S+anyones, which someone else could change \(owner \d+, mode 777\)/);
      assert.equal(open.sent.length, 0);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  });

  it("R19 the items of a multi-turn case: which the graded last turn started", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    let n = 0;
    // The first turn starts item 1, the second (the graded one) item 2.
    claw.router = (_content, id) => { n++; claw.turn(id, { item: item(n), say: `Started ${n}.` }); };
    const r = runner(base, [itemCase({ id: "t-last-001", turns: [{ user: "start a task" }, { user: "and another", after_ms: 1_000 }] })]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /t-last-001#1/, run.out);
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      const items = report.results[0].attempts[0].items as Array<{ seq: number; last?: boolean }>;
      assert.deepEqual(items.map((i) => [i.seq, i.last]).sort(), [[1, false], [2, true]], run.out);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R20 items named by title: a number above the board's highest item number is not one of the person's", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    let n = 0;
    claw.router = (_content, id) => { n++; claw.turn(id, { item: item(n), say: n === 1 ? "Started. The upstream one is #4321." : `Started #${n}.` }); };
    const r = runner(base, [itemCase({ id: "t-seq-001", style: { no_ids: true } }), itemCase({ id: "t-seq-002", style: { no_ids: true } })]);
    const run = await r.done;
    await claw.stop();
    try {
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      const titled = (id: string) => (report.results as any[]).find((x) => x.id === id).attempts[0].checks.find((c: any) => c.name === "items named by title")?.pass;
      assert.equal(titled("t-seq-001"), true, run.out);
      assert.equal(titled("t-seq-002"), false, "#2 is on the board: a bare item number");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R3e a stop while the stream holds its history back", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.historyDelayMs = 20_000;
    claw.router = (_content, id, sessionId) => {
      claw.emit({ type: "AssistantMessage", message_id: id, data: { content: [{ type: "text", text: "3 nodes." }] } }, Date.now(), sessionId);
      claw.emit({ type: "executionStats", message_id: id }, Date.now(), sessionId);
      claw.emit({ type: "exec_complete", message_id: id, final_text: "3 nodes." }, Date.now(), sessionId);
    };
    const r = runner(base, [{ id: "t-base-005", pipeline: "catalog", area: "general", lang: "en", route: "answer", turns: [{ user: "how many?" }] }],
      { EVAL_MODE: "baseline", EVAL_PLUGIN_ID: "9" });
    await until(() => claw.calls.includes("GET /v1/chat/sessions/plain-1/messages"), 30_000);
    const stoppedAt = Date.now();
    r.child.kill("SIGINT");
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /stopped by SIGINT/, run.out);
      assert.ok(Date.now() - stoppedAt < 10_000, `the run ended ${Date.now() - stoppedAt} ms after the stop: the stream's wait was cut short`);
      assert.ok(!claw.sessions.has("plain-1"), "and its session was deleted");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R10 an oracle that could not be read is the run's error, before anything is sent", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id) => claw.turn(id, { say: "There are 3 nodes." });
    const fact = (id: string, query: string) => ({ id, pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer",
      turns: [{ user: id }], facts: [{ claim: "the count", oracle: { kind: "api", query } }] });
    const r = runner(base, [fact("t-o-001", "/v1/oracle-down#data.n"), fact("t-o-002", "/v1/oracle-ok#data.n")]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /ERROR t-o-001#1 .*infra: the oracle of fact 1 could not be read \(the Claw API answered 503\): not graded/, run.out);
      assert.match(run.out, /pass t-o-002#1/, "an oracle that answered is graded: 3 is named");
      assert.deepEqual(claw.sent.map((x) => x.content), ["t-o-002"], "nothing sent for the case whose oracle could not be read");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R11 a read that failed is the run's error, and the cleanup reads again", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.failReplay.add("worker-1");
    claw.router = (content, id) => {
      if (content === "worker") claw.turn(id, { item: item(1), say: "Task 1 is ready for your review." });
      if (content === "board") {
        // The item is read once in progress; then the board cannot be read through the rest of the wait, while the item gets
        // its result, nor for a while after.
        claw.boardScript = [200];
        claw.boardFailUntil = Date.now() + 8_000;
        const it = item(2, { board_state: "in_progress", can_accept: false });
        claw.turn(id, { item: it, say: "On it." });
        setTimeout(() => {
          it.board_state = "ready";
          it.can_accept = true;
          claw.emit({ type: "AssistantSay", say_id: `ready-${id}`, turn_message_id: "", text: "Task 2 is ready.", item: { item_id: it.item_id, board_state: "ready", can_accept: true } });
        }, 500);
      }
      if (content === "no board") {
        // The board cannot be read from the turn on, for 8 s: the attempt never saw its item; the final cleanup finds it.
        claw.boardScript = [];
        claw.boardFailUntil = Date.now() + 8_000;
        claw.turn(id, { item: item(3, { board_state: "in_progress", can_accept: false }), say: "On it." });
      }
    };
    const r = runner(base, [itemCase({ id: "t-r-001", turns: [{ user: "worker" }] }), itemCase({ id: "t-r-002", turns: [{ user: "board" }], item_wait_s: 2 })]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /ERROR t-r-001#1 .*infra: could not read item 1's worker calls \(replay answered 500\): not graded/, run.out);
      assert.match(run.out, /ERROR t-r-002#1 .*infra: could not read the board \(board answered 503\): not graded/);
      assert.deepEqual(claw.calls.filter((c) => c.includes("/accept")).sort(), ["POST /v1/work-items/item-1/accept", "POST /v1/work-items/item-2/accept"], "both closed");
      assert.ok(!claw.sessions.has("worker-2"), "its worker's session deleted");
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.deepEqual(report.cleanup_failed, [], "the final cleanup completed");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R11b an item the attempt never saw, the board down: the final cleanup reads it again and closes it", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id) => {
      // The board cannot be read from the turn on, for 8 s.
      claw.boardFailUntil = Date.now() + 8_000;
      claw.turn(id, { item: item(3, { board_state: "in_progress", can_accept: false }), say: "On it." });
    };
    const r = runner(base, [itemCase({ id: "t-r-003", item_wait_s: 2 })]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /ERROR t-r-003#1 .*board answered 503/, run.out);
      assert.deepEqual(claw.calls.filter((c) => c.includes("/stop") || c.includes("/accept")), ["POST /v1/work-items/item-3/stop"], "tied by its work_create answer, closed");
      assert.ok(!claw.sessions.has("worker-3"), "its worker's session deleted");
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.deepEqual(report.cleanup_failed, [], "the final cleanup completed");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R12 a message whose answer was lost: its turn's item is left alone and said", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.loseMessageAnswers = 1;
    claw.router = (_content, id) => claw.turn(id, { item: item(1, { board_state: "in_progress", can_accept: false }), say: "On it." });
    const r = runner(base, [itemCase({ id: "t-l-001", turns: [{ user: "lost" }] })]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /ERROR t-l-001#1 /, run.out);
      assert.ok(!claw.calls.some((c) => /item-1\/(stop|accept)/.test(c)) && claw.sessions.has("worker-1"), "the lost message's item is not taken for the run's");
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.ok((report.cleanup_failed as string[]).some((x) => /left alone: 1 \(1 message\(s\) of the run whose answer was lost/.test(x)), JSON.stringify(report.cleanup_failed));
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R18 a person's message in the run's session: the item it started is left alone; the run's own is closed", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    let person = false;
    claw.router = (_content, id, sessionId) => {
      claw.turn(id, { item: item(1, { board_state: "in_progress", can_accept: false }), say: "On it." });
      if (person) return;
      person = true;
      // Meanwhile the identity's person writes to the same session, and their turn starts an item of its own.
      setTimeout(() => {
        claw.userMessage(sessionId, "person-1", "and check my disk quota");
        claw.turn("person-1", { item: item(2, { board_state: "in_progress", can_accept: false }), say: "Checking." });
      }, 50);
    };
    const r = runner(base, [itemCase({ id: "t-p-001" })]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.match(run.out, /t-p-001#1/, run.out);
      assert.ok(claw.calls.some((c) => /item-1\/(stop|accept)/.test(c)) && !claw.sessions.has("worker-1"), "the run's own item is closed");
      assert.ok(!claw.calls.some((c) => /item-2\/(stop|accept)/.test(c)), "the person's item is neither stopped nor accepted");
      assert.ok(claw.sessions.has("worker-2"), "the person's item keeps its worker's session");
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.ok((report.cleanup_failed as string[]).some((x) => /left alone: 2\b/.test(x)), JSON.stringify(report.cleanup_failed));
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R12b an item that cannot be read to delete its worker's session fails the cleanup", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.failItemDetail.add("item-2");
    claw.router = (_content, id) => claw.turn(id, { item: item(2), say: "Task 2 is ready for your review." });
    const r = runner(base, [itemCase({ id: "t-l-002", turns: [{ user: "unreadable" }] })]);
    const run = await r.done;
    await claw.stop();
    try {
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.ok(report.cleanup_failed.some((x: string) => /#2 not seen closed .*its worker's session kept/.test(x)), JSON.stringify(report.cleanup_failed));
      assert.equal(run.code, 1);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R12d a stop while a baseline session's creation is asked for again: not asked again, and said", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.loseCreateAnswers = 5;
    const r = runner(base, [{ id: "t-base-007", pipeline: "catalog", area: "general", lang: "en", route: "answer", turns: [{ user: "how many?" }] }],
      { EVAL_MODE: "baseline", EVAL_PLUGIN_ID: "9" });
    // The first request and its first repeat lose their answers; the stop comes while the runner waits to ask again.
    await until(() => claw.calls.filter((c) => c === "POST /v1/sessions").length >= 2, 30_000);
    await new Promise((res) => setTimeout(res, 500));
    r.child.kill("SIGINT");
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(claw.calls.filter((c) => c === "POST /v1/sessions").length, 2, "not asked again after the stop");
      assert.match(run.out, /cleanup: the session of t-base-007 was asked for and never confirmed/, run.out);
      assert.equal(run.code, 1);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R12c a baseline session whose creation answer was lost is asked for again with the same key, and deleted", { timeout: 120_000 }, async () => {
    const claw2 = new FakeClaw();
    const base2 = await claw2.start();
    claw2.loseCreateAnswers = 1;
    claw2.router = (_content, id, sessionId) => {
      claw2.emit({ type: "AssistantMessage", message_id: id, data: { content: [{ type: "text", text: "3 nodes." }] } }, Date.now(), sessionId);
      claw2.emit({ type: "executionStats", message_id: id }, Date.now(), sessionId);
      claw2.emit({ type: "exec_complete", message_id: id, final_text: "3 nodes." }, Date.now(), sessionId);
    };
    const r2 = runner(base2, [{ id: "t-base-006", pipeline: "catalog", area: "general", lang: "en", route: "answer", turns: [{ user: "how many?" }] }],
      { EVAL_MODE: "baseline", EVAL_PLUGIN_ID: "9" });
    const run2 = await r2.done;
    await claw2.stop();
    try {
      assert.equal(run2.code, 0, run2.out);
      assert.deepEqual(claw2.calls.filter((c) => c === "POST /v1/sessions").length, 2, "asked again");
      assert.equal(claw2.sent.length, 1, "with the same key: one session, one first message");
      assert.ok(!claw2.sessions.has("plain-1"), "the session it made is deleted");
    } finally { rmSync(r2.dir, { recursive: true, force: true }); }
  });

  const answerCase = (id: string, user = id) => ({ id, pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user }] });

  it("R13 the server's reply after a silent turn is waited for, graded and timed", { timeout: 120_000 }, async () => {
    const runs: Run[] = [];
    for (const grace of ["5", "0"]) {
      const claw = new FakeClaw();
      const base = await claw.start();
      // The router says nothing; its turn ends, and the server's own reply comes 4 s later.
      claw.router = (_content, id) => {
        claw.emit({ type: "executionStats", message_id: id, turns: 1 });
        setTimeout(() => claw.emit({ type: "exec_complete", message_id: id, final_text: "" }), 50);
        setTimeout(() => claw.emit({ type: "AssistantSay", say_id: `say-${id}`, turn_message_id: id, text: "There are 3 nodes.", fallback: true }), 4_000);
      };
      const r = runner(base, [answerCase("t-grace-001")], { EVAL_SAY_GRACE_S: grace });
      runs.push(await r.done);
      await claw.stop();
      rmSync(r.dir, { recursive: true, force: true });
    }
    const [waited, not] = runs as [Run, Run];
    assert.equal(waited.code, 0, waited.out);
    assert.match(waited.out, /pass t-grace-001#1 route=answer cards=none first=(\d+)ms/);
    assert.ok(Number(/first=(\d+)ms/.exec(waited.out)![1]) >= 3_900, "timed from when the reply came");
    assert.match(not.out, /FAIL t-grace-001#1 .*answered/, "without the wait the case had no answer");
  });

  it("R14 a new assistant session for each case, the one before deleted first", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.freshAssistant = true;
    claw.router = (_content, id, sid) => claw.turn(id, { say: `answered in ${sid}` });
    const r = runner(base, [answerCase("t-fresh-001"), answerCase("t-fresh-002")], { EVAL_FRESH_SESSION_EVERY: "1" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      const posts = claw.calls.filter((c) => /^POST \/v1\/sessions\/[^/]+\/messages$/.test(c));
      assert.deepEqual(posts, ["POST /v1/sessions/asst-1/messages", "POST /v1/sessions/asst-2/messages"]);
      const del1 = claw.calls.indexOf("DELETE /v1/sessions/asst-1");
      assert.ok(del1 > 0 && del1 < claw.calls.indexOf(posts[1]!), "the first session is deleted before the second case is sent");
      assert.ok(claw.calls.indexOf("GET /v1/sessions/asst-1", del1) > del1, "and seen gone");
      assert.ok(claw.calls.includes("DELETE /v1/sessions/asst-2"));
      assert.ok(!claw.sessions.has("asst-1") && !claw.sessions.has("asst-2"));
      assert.deepEqual(JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8")).cleanup_failed, []);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }

    // An identity that already has an assistant session, idle (E249: 58 cases in one conversation, a case answered from another's):
    // it is deleted and seen gone before anything is sent, and the first case starts in a new one. Its say of the hour still counts.
    const other = new FakeClaw();
    const base2 = await other.start();
    other.created = false;
    other.freshAssistant = true;
    other.sessions.set(other.assistant, { status: "idle", stale: 0 });
    other.emit({ type: "AssistantSay", say_id: "say-before-the-run", text: "an earlier answer" }, Date.now() - 1_800_000);
    other.router = (_content, id, sid) => other.turn(id, { say: `answered in ${sid}` });
    const r2 = runner(base2, [answerCase("t-fresh-003")], { EVAL_FRESH_SESSION_EVERY: "1" });
    const run2 = await r2.done;
    await other.stop();
    try {
      assert.equal(run2.code, 0, run2.out);
      assert.match(run2.out, /deleted the identity's assistant session asst-1 before the run/);
      const del = other.calls.indexOf("DELETE /v1/sessions/asst-1");
      const got = other.calls.indexOf("GET /v1/sessions/asst-1", del);
      assert.ok(del > 0 && got > del, "deleted, then seen gone");
      assert.deepEqual(other.calls.filter((c) => /^POST \/v1\/sessions\/[^/]+\/messages$/.test(c)), ["POST /v1/sessions/asst-2/messages"]);
      assert.ok(got < other.calls.indexOf("POST /v1/sessions/asst-2/messages"), "before anything is sent");
      assert.ok(!other.sessions.has("asst-1") && !other.sessions.has("asst-2"));
      assert.ok(readFileSync(join(r2.dir, "says.jsonl"), "utf8").includes("say-before-the-run"), "its say still counts for the pace");
    } finally { rmSync(r2.dir, { recursive: true, force: true }); }

    // One that starts a turn while the run looks at it (between its first look and the DELETE): the second look, right before the
    // DELETE, refuses the run; nothing is deleted or sent.
    const racing = new FakeClaw();
    const base4 = await racing.start();
    racing.created = false;
    racing.sessions.set(racing.assistant, { status: "idle", stale: 0 });
    racing.onSessionGet = (sid, n) => { if (sid === "asst-1" && n === 1) setImmediate(() => { racing.sessions.get("asst-1")!.status = "running"; }); };
    const r4 = runner(base4, [answerCase("t-fresh-005")], { EVAL_FRESH_SESSION_EVERY: "1" });
    const run4 = await r4.done;
    await racing.stop();
    try {
      assert.equal(run4.code, 2, run4.out);
      assert.match(run4.out, /refusing to run: .*running/);
      assert.equal(racing.sent.length, 0);
      assert.deepEqual(racing.calls.filter((c) => c.startsWith("DELETE")), []);
      assert.ok(racing.sessions.has("asst-1"));
    } finally { rmSync(r4.dir, { recursive: true, force: true }); }

    // One in use is not deleted: refused, nothing sent, nothing deleted.
    const busy = new FakeClaw();
    const base3 = await busy.start();
    busy.created = false;
    busy.sessions.set(busy.assistant, { status: "running", stale: 0 });
    const r3 = runner(base3, [answerCase("t-fresh-004")], { EVAL_FRESH_SESSION_EVERY: "1" });
    const run3 = await r3.done;
    await busy.stop();
    try {
      assert.equal(run3.code, 2, run3.out);
      assert.match(run3.out, /refusing to run: .*running/);
      assert.equal(busy.sent.length, 0);
      assert.deepEqual(busy.calls.filter((c) => c.startsWith("DELETE")), []);
    } finally { rmSync(r3.dir, { recursive: true, force: true }); }
  });

  it("R15 run variables read again before each case", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id) => claw.turn(id, { say: "ok" });
    const dir = tmpDir("sa-eval-runner-");
    const counter = join(dir, "n");
    // A program and its arguments, run without a shell: here a script file the shell runs.
    writeFileSync(join(dir, "vars.sh"), `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; printf '{"gh": {"n": %s}}' $n\n`);
    const r = runner(base, [answerCase("t-vars-001", "count {{gh.n}}"), answerCase("t-vars-002", "count {{gh.n}}")], { EVAL_VARS_CMD: `/bin/sh ${join(dir, "vars.sh")}` }, dir);
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(claw.sent.map((x) => x.content), ["count 1", "count 2"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }

    const failing = new FakeClaw();
    const base2 = await failing.start();
    failing.router = (_content, id) => failing.turn(id, { say: "ok" });
    // A command that fails: nothing of the case is sent. Without a shell, `false; echo {}` is a program named `false;`, which does not exist.
    const r2 = runner(base2, [answerCase("t-vars-003", "count {{gh.n}}"), answerCase("t-vars-004", "count {{gh.n}}")], { EVAL_VARS_CMD: "false ignored" });
    const run2 = await r2.done;
    await failing.stop();
    try {
      assert.equal(run2.code, 1, run2.out);
      assert.match(run2.out, /ERROR t-vars-003#1 infra: EVAL_VARS_CMD failed \(exit 1\)/);
      assert.equal(failing.sent.length, 0);
    } finally { rmSync(r2.dir, { recursive: true, force: true }); }

    const noShell = new FakeClaw();
    const base3 = await noShell.start();
    const r3 = runner(base3, [answerCase("t-vars-005", "count {{gh.n}}")], { EVAL_VARS_CMD: "false; printf {}" });
    const run3 = await r3.done;
    await noShell.stop();
    try {
      assert.match(run3.out, /ERROR t-vars-005#1 infra: EVAL_VARS_CMD failed \(ENOENT\)/, "no shell: `false;` is looked for as a program");
      assert.equal(noShell.sent.length, 0);
    } finally { rmSync(r3.dir, { recursive: true, force: true }); }
  });

  it("R16 the gap between cases", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id) => claw.turn(id, { say: "ok" });
    const r = runner(base, [answerCase("t-gap-001"), answerCase("t-gap-002")], { EVAL_GAP_S: "8" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.ok(claw.sent[1]!.at - claw.sent[0]!.at >= 8_000, `${claw.sent[1]!.at - claw.sent[0]!.at} ms between the cases`);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });

  it("R17 messages sent signed in, as the key's own identity only", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id) => claw.turn(id, { say: "ok" });
    const r = runner(base, [answerCase("t-token-001"), answerCase("t-token-002")], { EVAL_SEND_TOKEN_CMD: "printf tok-signed-in" });
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(claw.messageAuth, ["Bearer tok-signed-in", "Bearer tok-signed-in"]);
      assert.ok(!run.out.includes("tok-signed-in"), "the token is never printed");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }

    // Another account: its user id is not the key's.
    const other = new FakeClaw();
    const base2 = await other.start();
    other.meFor = (auth) => (auth === "Bearer tok-someone" ? "someone@example.test" : EMAIL);
    const r2 = runner(base2, [answerCase("t-token-003")], { EVAL_SEND_TOKEN_CMD: "printf tok-someone" });
    const run2 = await r2.done;
    await other.stop();
    try {
      assert.equal(run2.code, 2, run2.out);
      assert.match(run2.out, /the token of EVAL_SEND_TOKEN_CMD is not the key's identity/);
      assert.equal(other.sent.length, 0);
    } finally { rmSync(r2.dir, { recursive: true, force: true }); }
  });
  it("R22 the memory entries an attempt made are deleted after it; the identity's own are kept", { timeout: 120_000 }, async () => {
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.memories.set(1352, { id: 1352, title: "Main repo", body: "The user's main repo is AMD-AGI/PrimusClaw" });
    claw.memories.set(5, { id: 5, title: "Language", body: "Reply in Chinese" });
    // The turn saves an entry, as memory_save does.
    claw.router = (_content, id) => { claw.memories.set(2000, { id: 2000, title: "Reviews", body: "reviews with opus" }); claw.turn(id, { say: "Saved." }); };
    const r = runner(base, [answerCase("t-mem-001", "remember that I review with opus")]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE /v1/users")), ["DELETE /v1/users/me/memories/2000"], "only the entry the attempt made");
      assert.deepEqual([...claw.memories.keys()].sort((a, b) => a - b), [5, 1352], "the entries from before the attempt are kept");
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      assert.deepEqual(report.cleanup_failed, []);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }

    // An entry the run could not delete is the cleanup's failure, never silent.
    const stuck = new FakeClaw();
    const base2 = await stuck.start();
    stuck.memories.set(5, { id: 5, title: "Language", body: "Reply in Chinese" });
    stuck.failMemoryDelete.add(2001);
    stuck.router = (_content, id) => { stuck.memories.set(2001, { id: 2001, title: "Repo", body: "AMD-AGI/PrimusClaw" }); stuck.turn(id, { say: "Saved." }); };
    const r2 = runner(base2, [answerCase("t-mem-002", "remember my repo")]);
    const run2 = await r2.done;
    await stuck.stop();
    try {
      assert.equal(run2.code, 1, run2.out);
      assert.ok(stuck.memories.has(5) && stuck.memories.has(2001));
      const report = JSON.parse(readFileSync(join(r2.dir, "out", "assistant.json"), "utf8"));
      assert.ok(report.cleanup_failed.some((x: string) => /memory entries the run made not deleted: 2001/.test(x)), JSON.stringify(report.cleanup_failed));
      assert.ok(!report.cleanup_failed.some((x: string) => /\b5\b/.test(x)));
    } finally { rmSync(r2.dir, { recursive: true, force: true }); }
  });

  it("R22 setup.forget_memories deletes the entries it names before the attempt; one it cannot is the run's error", { timeout: 120_000 }, async () => {
    const memCase = { ...answerCase("cat-memory-wr-002", "remember that my main repo is AMD-AGI/PrimusClaw"), setup: { forget_memories: ["amd-agi/primusclaw"] } };
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.memories.set(1352, { id: 1352, title: "Main repo", body: "The user's main repo is AMD-AGI/PrimusClaw" });
    claw.memories.set(5, { id: 5, title: "Language", body: "Reply in Chinese" });
    claw.router = (_content, id) => { claw.memories.set(2002, { id: 2002, title: "Main repo", body: "AMD-AGI/PrimusClaw" }); claw.turn(id, { say: "Saved." }); };
    const r = runner(base, [memCase]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.doesNotMatch(run.out, /case not loaded/);
      const forgot = claw.calls.indexOf("DELETE /v1/users/me/memories/1352");
      const sent = claw.calls.findIndex((c) => /^POST \/v1\/sessions\/[^/]+\/messages$/.test(c));
      assert.ok(forgot >= 0 && sent > forgot, "the named entry is deleted before the message is sent");
      assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE /v1/users")), ["DELETE /v1/users/me/memories/1352", "DELETE /v1/users/me/memories/2002"]);
      assert.deepEqual([...claw.memories.keys()], [5], "an entry the case does not name is kept");
    } finally { rmSync(r.dir, { recursive: true, force: true }); }

    const stuck = new FakeClaw();
    const base2 = await stuck.start();
    stuck.memories.set(1352, { id: 1352, title: "Main repo", body: "AMD-AGI/PrimusClaw" });
    stuck.failMemoryDelete.add(1352);
    stuck.router = (_content, id) => stuck.turn(id, { say: "Saved." });
    const r2 = runner(base2, [memCase]);
    const run2 = await r2.done;
    await stuck.stop();
    try {
      assert.equal(run2.code, 1, run2.out);
      assert.match(run2.out, /ERROR cat-memory-wr-002#1 .*infra: setup: memory entries named by forget_memories not deleted: 1352/);
      assert.equal(stuck.sent.length, 0, "nothing sent");
    } finally { rmSync(r2.dir, { recursive: true, force: true }); }
  });

  it("R23 expect_memory is graded on the entries the attempt made, before they are deleted", { timeout: 120_000 }, async () => {
    const memCase = (id: string) => ({ ...answerCase(id, "remember that I review with opus"), expect_memory: ["opus"], expect_no_memory: ["sonnet"] });
    // Saved by the attempt: passes, then deleted.
    const claw = new FakeClaw();
    const base = await claw.start();
    claw.router = (_content, id) => { claw.memories.set(3000, { id: 3000, title: "Review model", body: "Reviews with Opus" }); claw.turn(id, { say: "Saved." }); };
    const r = runner(base, [memCase("t-expect-001")]);
    const run = await r.done;
    await claw.stop();
    try {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /pass t-expect-001#1/);
      assert.ok(!claw.memories.has(3000), "deleted after it was graded");
      const report = JSON.parse(readFileSync(join(r.dir, "out", "assistant.json"), "utf8"));
      const names = report.results[0].attempts[0].checks.map((x: { name: string }) => x.name);
      assert.ok(names.includes("memory saved: opus") && names.includes("no memory left: sonnet"), names.join("; "));
    } finally { rmSync(r.dir, { recursive: true, force: true }); }

    // An entry from before the attempt (a residue) does not count: nothing new was saved, the attempt fails on that check.
    const stale = new FakeClaw();
    const base2 = await stale.start();
    stale.memories.set(1352, { id: 1352, title: "Review model", body: "Reviews with opus" });
    stale.router = (_content, id) => stale.turn(id, { say: "There is already an entry for that." });
    const r2 = runner(base2, [memCase("t-expect-002")]);
    const run2 = await r2.done;
    await stale.stop();
    try {
      assert.equal(run2.code, 0, run2.out);
      assert.match(run2.out, /FAIL t-expect-002#1 .*memory saved: opus/);
      assert.ok(stale.memories.has(1352), "the entry from before is kept");
    } finally { rmSync(r2.dir, { recursive: true, force: true }); }
  });
});

