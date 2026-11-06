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
 *   R2 an assistant session that is running, or was active a moment ago, refuses the run before anything is sent
 *   R3 SIGINT stops the run: nothing more is sent, the item the interrupted turn started is closed and its worker's session
 *      deleted, the session the run made is deleted, and the run exits 1 saying it was stopped; in baseline mode, a stop
 *      during a case's oracle reads sends nothing, and one during a turn lets the turn end before its session is deleted; a
 *      stop before the assistant session was asked for asks for none
 *   R4 the identity's says of the last hour, stored before the run, hold the first case until there is room; a say the
 *      server refused for its hourly cap makes the attempt the run's failure. Says of an earlier run, whose assistant session
 *      is gone, are read from its say log, and the run leaves its own there
 *   R5 baseline: a plain session's turn is over once its exec_complete is stored, what it showed is graded (a tool name in an earlier
 *      message fails the case), and the session is deleted and seen gone
 *   R6 a turn whose end the stream never shows: graded when the stored events have its exec_complete (a delivery Brain gave up
 *      on ends with that alone), an error and not a grade when they do not either
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  readonly sessions = new Map<string, { status: string; stale: number }>();
  readonly items: Item[] = [];
  readonly rows = new Map<string, Row[]>();
  assistant = "asst-1";
  created = true;
  /** The next board read answers this much later (the run's first read is before anything is made). */
  boardDelayMs = 0;
  boardReads = 0;
  router: (content: string, messageId: string, sessionId: string) => void = () => {};
  private readonly streams = new Map<string, Set<ServerResponse>>();
  private server!: Server;
  private n = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const set of this.streams.values()) for (const s of set) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** An event of a session (the assistant's unless named): stored for a replay and pushed to the session's open streams. */
  emit(data: Record<string, unknown>, at = Date.now(), sessionId = this.assistant): void {
    const row: Row = { event_id: `ev-${++this.n}`, event_type: String(data.type), data, created_at: new Date(at).toISOString() };
    this.rows.set(sessionId, [...(this.rows.get(sessionId) ?? []), row]);
    if (row.event_type === "exec_complete") this.settledAt.set(String(data.message_id), Date.now());
    // The API keeps exec_complete from a stream (`routes/events.ts`).
    if (row.event_type === "exec_complete") return;
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
    if (method === "GET" && path === "/v1/me") return send(200, { name: "sa-eval-bot", email: EMAIL });
    // An oracle read that takes a while (a fact's `/v1/...#pick`).
    if (method === "GET" && path === "/v1/slow-oracle") { setTimeout(() => send(200, { data: { n: 3 } }), 2_000); return; }
    if (method === "GET" && path === "/v1/notification-subscriptions") return send(200, { ok: true, data: [] });
    if (method === "GET" && path === "/v1/work-items") {
      this.boardReads++;
      if (this.boardDelayMs) { const wait = this.boardDelayMs; this.boardDelayMs = 0; setTimeout(() => send(200, { ok: true, data: this.items }), wait); return; }
      return send(200, { ok: true, data: this.items });
    }
    if (method === "POST" && path === "/v1/assistant") {
      if (!this.sessions.has(this.assistant)) this.sessions.set(this.assistant, { status: "idle", stale: 0 });
      return send(200, { ok: true, data: { session_id: this.assistant, created: this.created } });
    }
    if ((m = /^\/v1\/work-items\/([^/]+)$/.exec(path)) && method === "GET") {
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
      const s = this.sessions.get(m[1]!);
      if (method === "GET") return s ? send(200, { ok: true, data: { session_id: m[1], agent_status: s.status } }) : send(404, { ok: false });
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
      send(200, { ok: true, message_id: id });
      const sessionId = m[1]!;
      setTimeout(() => this.router(content, id, sessionId), 20);
      return;
    }
    if (method === "POST" && path === "/v1/sessions") {
      // A plain session (baseline) that starts with its first message.
      const sessionId = `plain-${this.sessions.size + 1}`;
      this.sessions.set(sessionId, { status: "running", stale: 0 });
      const content = String(JSON.parse(body).message?.content ?? "");
      this.sent.push({ at: Date.now(), content });
      send(200, { ok: true, data: { session_id: sessionId } });
      setTimeout(() => this.router(content, "msg-first", sessionId), 300);
      return;
    }
    if ((m = /^\/v1\/chat\/sessions\/([^/]+)\/messages$/.exec(path)) && method === "GET") {
      if (!this.sessions.has(m[1]!)) return send(404, { ok: false });
      const sessionId = m[1]!;
      if (url.searchParams.get("mode") === "replay") return send(200, { ok: true, data: this.rows.get(sessionId) ?? [] });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const row of this.rows.get(sessionId) ?? []) if (row.event_type !== "exec_complete") res.write(frame(row));
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
function runner(claw: string, cases: object[], env: Record<string, string> = {}, dir = mkdtempSync(join(tmpdir(), "sa-eval-runner-"))): { done: Promise<Run>; child: ChildProcess; dir: string } {
  mkdirSync(join(dir, "cases"), { recursive: true });
  writeFileSync(join(dir, "cases", "c.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(dir, "key"), "test-key-not-a-secret\n");
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir,
      EVAL_CLAW: claw, EVAL_KEY_FILE: join(dir, "key"), EVAL_IDENTITY_ACK: `test:${EMAIL}`, EVAL_CASES_DIR: join(dir, "cases"), EVAL_K: "1",
      EVAL_OUT: join(dir, "out"), EVAL_SAY_LOG: join(dir, "says.jsonl"), ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (b) => { out += String(b); });
  child.stderr!.on("data", (b) => { out += String(b); });
  const done = new Promise<Run>((resolve) => child.on("exit", (code) => resolve({ code, out, child })));
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

test("R1 the run's own sessions are deleted and seen gone; nothing else is", { timeout: 120_000 }, async () => {
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

test("R2 an assistant session in use refuses the run before anything is sent", { timeout: 120_000 }, async () => {
  for (const [why, setup, env] of [
    ["running", (c: FakeClaw) => c.sessions.set(c.assistant, { status: "running", stale: 0 }), {}],
    ["active a moment ago", (c: FakeClaw) => { c.sessions.set(c.assistant, { status: "idle", stale: 0 }); c.emit({ type: "AssistantSay", say_id: "x", text: "hi" }); }, {}],
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

test("R3 SIGINT stops the run and still cleans up", { timeout: 120_000 }, async () => {
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

test("R3b SIGINT in baseline mode while an oracle is read: the session is never created", { timeout: 120_000 }, async () => {
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

test("R3c SIGINT in baseline mode during a turn: the turn ends before the session is deleted", { timeout: 120_000 }, async () => {
  const claw = new FakeClaw();
  const base = await claw.start();
  claw.router = (_content, id, sessionId) => {
    claw.emit({ type: "AssistantMessage", message_id: id, data: { content: [{ type: "text", text: "Looking." }] } }, Date.now(), sessionId);
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
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("R3d SIGINT before the assistant session is asked for: none is asked for", { timeout: 120_000 }, async () => {
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

test("R4b an earlier run's says, from its log: its assistant session is gone", { timeout: 120_000 }, async () => {
  const claw = new FakeClaw();
  const base = await claw.start();
  const dir = mkdtempSync(join(tmpdir(), "sa-eval-runner-"));
  // The earlier run saw three says that leave the hour 3 s from now (and one older than the hour, and a broken line).
  const old = Date.now() - 3_600_000 + 3_000;
  writeFileSync(join(dir, "says.jsonl"), [0, 1, 2].map((k) => JSON.stringify({ id: `old-${k}`, at: old + k })).join("\n")
    + `\n${JSON.stringify({ id: "older", at: old - 60_000 })}\nnot a say\n`);
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

test("R4 the hourly say cap: earlier says hold the first case; a refused say is the run's failure", { timeout: 120_000 }, async () => {
  const claw = new FakeClaw();
  claw.created = false;
  const base = await claw.start();
  claw.sessions.set(claw.assistant, { status: "idle", stale: 0 });
  // Three counted says that leave the hour 3 s from now, one fallback that the cap does not count.
  const old = Date.now() - 3_600_000 + 3_000;
  for (const k of [0, 1, 2]) claw.emit({ type: "AssistantSay", say_id: `old-${k}`, text: "earlier" }, old + k);
  claw.emit({ type: "AssistantSay", say_id: "fb", text: "fallback", fallback: true }, Date.now() - 5_000);
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

test("R5 baseline: the turn's end, what it showed, and its session", { timeout: 120_000 }, async () => {
  const claw = new FakeClaw();
  const base = await claw.start();
  claw.router = (_content, id, sessionId) => {
    const text = (t: string) => ({ type: "AssistantMessage", message_id: id, data: { content: [{ type: "text", text: t }] } });
    claw.emit(text("Calling mcp__safe__node_list for you."), Date.now(), sessionId);
    claw.emit(text("There are 3 nodes."), Date.now(), sessionId);
    claw.emit({ type: "executionStats", message_id: id, turns: 1 }, Date.now(), sessionId);
    setTimeout(() => claw.emit({ type: "exec_complete", message_id: id, final_text: "There are 3 nodes." }, Date.now(), sessionId), 1_500);
  };
  const r = runner(base, [{ id: "t-base-001", pipeline: "catalog", area: "general", lang: "en", route: "answer", turns: [{ user: "how many nodes?" }] }],
    { EVAL_MODE: "baseline", EVAL_PLUGIN_ID: "9" });
  const run = await r.done;
  await claw.stop();
  try {
    assert.match(run.out, /FAIL t-base-001#1 .*no internal text: tool name/, run.out);
    const deletedAt = claw.callAt[claw.calls.indexOf("DELETE /v1/sessions/plain-1")]!;
    assert.ok(deletedAt >= claw.settledAt.get("msg-first")!, "the session is deleted only after its turn's exec_complete was stored");
    assert.equal(run.code, 0, "a failed case is a measurement: the run itself completed and cleaned up");
    assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE")), ["DELETE /v1/sessions/plain-1"]);
    assert.ok(claw.calls.indexOf("GET /v1/sessions/plain-1") > claw.calls.indexOf("DELETE /v1/sessions/plain-1"), "a GET after the DELETE");
    assert.ok(!claw.sessions.has("plain-1"));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("R6 a turn with no end on the stream", { timeout: 120_000 }, async () => {
  const claw = new FakeClaw();
  const base = await claw.start();
  claw.router = (content, id) => {
    if (content === "poisoned") {
      // Brain gave up on the delivery: exec_complete alone, which the stream never carries.
      claw.emit({ type: "AssistantSay", say_id: `say-${id}`, turn_message_id: id, text: "Sorry, that did not go through." });
      claw.emit({ type: "exec_complete", message_id: id, final_text: "", failed: true, failure_reason: "delivery_exhausted" });
    }
    // "silent": nothing at all.
  };
  const turnCase = (id: string, user: string) => ({ id, pipeline: "catalog", area: "general", lang: "en", modes: ["assistant"], route: "answer", turns: [{ user }] });
  const r = runner(base, [turnCase("t-silent-001", "silent"), turnCase("t-poison-001", "poisoned")], { EVAL_TURN_WAIT_S: "2" });
  const run = await r.done;
  await claw.stop();
  try {
    assert.match(run.out, /ERROR t-silent-001#1 .*no end of the turn of msg-1 within 2 s: not graded/, run.out);
    assert.match(run.out, /pass t-poison-001#1/, "its end was in the stored events: graded on what the user saw");
    assert.equal(run.code, 1, "an attempt that could not be graded fails the run");
    assert.deepEqual(claw.calls.filter((c) => c.startsWith("DELETE")), ["DELETE /v1/sessions/asst-1"]);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
