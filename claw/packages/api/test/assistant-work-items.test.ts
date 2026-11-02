// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant and its board, over real HTTP against a real Postgres whose
 * schema `initDb` built with `CLAW_ASSISTANT_ENABLED` on. Skipped without
 * DATABASE_URL, and a skip is not a pass.
 *
 * The caller is whoever the `x-test-user` header names, standing in for the
 * verified identity the global auth hook would attach.
 *
 *   A  the assistant: one session per user, however many ask and however often
 *   B  what a worker's report does to an item, report by report
 *   C  fencing: a report from a stale generation, another worker or a closed item changes nothing
 *   D  acceptance is pinned to the version the user saw
 *   E  stop closes the item first, then interrupts, and a failed interrupt is retried
 *   F  the limit on unfinished items, and numbers that never repeat
 *   G  another user's items are not there
 *   H  the board: states, the seven-day window, the detail
 *   I  the schema: made by initDb, safe to run again, and checked at start-up
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { interruptSubject } from "@claw/protocol";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const MAX_ACTIVE = 5;
const ASSISTANT_TABLES = ["claw_assistants", "claw_work_items", "claw_work_item_events", "claw_assistant_says"];

describe("assistant work items", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let work: typeof import("../src/assistant/work-items.js");
  let published: string[];
  let restorePublish: () => void;
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);
  const rows = async (text: string, params: unknown[] = []) => (await q(text, params)).rows as Array<Record<string, any>>;

  before(async () => {
    h = await startAdmissionCluster({
      CLAW_ASSISTANT_ENABLED: "true",
      CLAW_ASSISTANT_MAX_ACTIVE_ITEMS: String(MAX_ACTIVE),
      CLAW_ASSISTANT_ROUTER_MODEL: "router-small",
    });
    work = await import("../src/assistant/work-items.js");
    const { registerAssistantRoutes } = await import("../src/routes/assistant.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") {
        (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
      }
    });
    await registerAssistantRoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await h?.stop();
  });
  beforeEach(async () => {
    for (const t of ["claw_work_item_events", "claw_work_items", "claw_assistants", "claw_assistant_says", "claw_pending_messages", "claw_sessions"]) {
      await q(`DELETE FROM ${t}`);
    }
    published = [];
    const ports = h.app.chatRun.chatRunPorts;
    const original = ports.publishInterrupt;
    ports.publishInterrupt = (subject: string) => { published.push(subject); };
    restorePublish = () => { ports.publishInterrupt = original; };
  });
  afterEach(() => restorePublish());

  type Res = { status: number; body: any };
  async function call(user: string | null, method: "GET" | "POST", url: string, payload?: unknown): Promise<Res> {
    const r = await app.inject({
      method, url, payload: payload as never,
      headers: user ? { "x-test-user": user } : {},
    });
    return { status: r.statusCode, body: r.json() };
  }
  const as = (user: string) => ({
    get: (url: string) => call(user, "GET", url),
    post: (url: string, body: unknown = {}) => call(user, "POST", url, body),
  });

  /** An assistant for the user and one open item whose worker is `w-<n>`. */
  async function item(user = "u1", n = 1): Promise<{ itemId: string; worker: string; seq: number }> {
    await as(user).post("/v1/assistant");
    const worker = `w-${user}-${n}-${Math.random().toString(36).slice(2, 8)}`;
    const made = await h.app.db.inTransaction((query) =>
      work.insertWorkItem({ query }, { userId: user, title: `task ${n}`, workerSessionId: worker }));
    assert.equal(made.ok, true);
    if (!made.ok) throw new Error("unreachable");
    return { itemId: made.itemId, worker, seq: made.seq };
  }
  const report = (it: { itemId: string; worker: string }, r: Parameters<typeof work.applyWorkerReport>[1]["report"], over: Partial<Parameters<typeof work.applyWorkerReport>[1]> = {}) =>
    work.applyWorkerReport(h.app.db.db, { itemId: it.itemId, generation: 0, workerSessionId: it.worker, source: "worker", report: r, ...over });
  const row = async (id: string) => (await rows("SELECT * FROM claw_work_items WHERE item_id = $1", [id]))[0];
  const events = (id: string) => rows("SELECT * FROM claw_work_item_events WHERE item_id = $1 ORDER BY id", [id]);

  // --- A ---------------------------------------------------------------------------------

  describe("A the assistant", () => {
    test("asking twice returns the same session, made once, as an ordinary session of the user", async () => {
      const first = await as("u1").post("/v1/assistant");
      const second = await as("u1").post("/v1/assistant");
      assert.equal(first.status, 200);
      assert.equal(first.body.data.created, true);
      assert.equal(second.body.data.created, false);
      assert.equal(second.body.data.session_id, first.body.data.session_id);
      const s = await rows("SELECT user_id, name, mode, model, agent_status FROM claw_sessions WHERE session_id = $1", [first.body.data.session_id]);
      assert.deepEqual(s, [{ user_id: "u1", name: "助理", mode: "claw", model: "router-small", agent_status: "idle" }]);
      assert.equal((await rows("SELECT 1 FROM claw_sessions")).length, 1);
    });

    test("twenty callers at once still make one session", async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => as("u1").post("/v1/assistant")));
      assert.deepEqual(new Set(results.map((r) => r.status)), new Set([200]));
      assert.equal(new Set(results.map((r) => r.body.data.session_id)).size, 1);
      assert.equal(results.filter((r) => r.body.data.created).length, 1);
      // A loser that made a session of its own before losing would leave it behind.
      assert.equal((await rows("SELECT 1 FROM claw_sessions")).length, 1);
      assert.equal((await rows("SELECT 1 FROM claw_assistants")).length, 1);
    });

    test("each user has their own", async () => {
      const a = await as("u1").post("/v1/assistant");
      const b = await as("u2").post("/v1/assistant");
      assert.notEqual(a.body.data.session_id, b.body.data.session_id);
    });

    test("a deleted session is replaced, not mourned", async () => {
      const first = await as("u1").post("/v1/assistant");
      await q("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = $1", [first.body.data.session_id]);
      const again = await as("u1").post("/v1/assistant");
      assert.equal(again.body.data.created, true);
      assert.notEqual(again.body.data.session_id, first.body.data.session_id);
      assert.deepEqual(
        (await rows("SELECT session_id FROM claw_assistants WHERE user_id = 'u1'")).map((r) => r.session_id),
        [again.body.data.session_id],
      );
      assert.equal((await as("u1").post("/v1/assistant")).body.data.session_id, again.body.data.session_id);
    });

    test("a deleted session replaced by ten callers at once is replaced once", async () => {
      const first = await as("u1").post("/v1/assistant");
      await q("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = $1", [first.body.data.session_id]);
      const results = await Promise.all(Array.from({ length: 10 }, () => as("u1").post("/v1/assistant")));
      assert.equal(new Set(results.map((r) => r.body.data.session_id)).size, 1);
      assert.equal(results.filter((r) => r.body.data.created).length, 1);
      assert.equal((await rows("SELECT 1 FROM claw_sessions WHERE deleted_at IS NULL")).length, 1);
    });

    test("a caller with no identity is refused", async () => {
      const none = await call(null, "POST", "/v1/assistant", {});
      assert.equal(none.status, 403);
      assert.equal(none.body.error, "assistant_requires_authenticated_user");
      assert.equal((await as("default").post("/v1/assistant")).status, 403);
      assert.equal((await rows("SELECT 1 FROM claw_sessions")).length, 0);
    });
  });

  // --- B ---------------------------------------------------------------------------------

  describe("B a report moves an item", () => {
    // [report, board_state, last_report_kind, pending_question, result_version, attention_seq, outcome, wake]
    const table = [
      [{ kind: "progress", summary: "step 1 of 3" }, "in_progress", "progress", null, 0, 0, null, false],
      [{ kind: "waiting", summary: "CI is running" }, "in_progress", "waiting", null, 0, 0, null, false],
      [{ kind: "waiting", summary: "need a branch", question: "Which branch?" }, "needs_you", "waiting", "Which branch?", 0, 1, null, true],
      [{ kind: "blocked", summary: "no access", question: "Can you grant it?" }, "needs_you", "blocked", "Can you grant it?", 0, 1, null, true],
      [{ kind: "blocked", summary: "no access" }, "needs_you", "blocked", null, 0, 1, null, true],
      [{ kind: "ready", summary: "PR opened", result: { refs: [{ type: "pr", url: "https://example.invalid/pr/1", sha: "abc" }] } }, "needs_you", "ready", null, 1, 1, null, true],
      [{ kind: "failed", summary: "tests are red" }, "needs_you", "failed", null, 0, 1, null, true],
      [{ kind: "dropped", summary: "no longer needed" }, "done", "dropped", null, 0, 0, "dropped", true],
      // Only waiting and blocked can ask; a question on any other kind is not kept.
      [{ kind: "progress", summary: "x", question: "ignored?" }, "in_progress", "progress", null, 0, 0, null, false],
      [{ kind: "failed", summary: "x", question: "ignored?" }, "needs_you", "failed", null, 0, 1, null, true],
    ] as const;

    for (const [r, board, last, question, version, attention, outcome, wake] of table) {
      test(`${r.kind}${"question" in r ? " with a question" : ""} -> ${board}${wake ? ", wakes the router" : ", does not wake the router"}`, async () => {
        const it = await item();
        const out = await report(it, r as never);
        assert.equal(out.applied, true);
        if (!out.applied) return;
        assert.equal(out.wake, wake);
        assert.equal(out.boardState, board);
        const got = await row(it.itemId);
        assert.deepEqual(
          [got.board_state, got.last_report_kind, got.pending_question, got.result_version, got.attention_seq, got.outcome],
          [board, last, question, version, attention, outcome],
        );
        assert.equal(got.closed_at !== null, board === "done");
        const evs = await events(it.itemId);
        assert.deepEqual(evs.map((e) => [e.kind, e.source]), [["created", "router"], [r.kind, "worker"]]);
        assert.equal(Number(evs[1].id), out.eventId);
      });
    }

    test("the item's one-line summary is the report's first 80 characters, on one line", async () => {
      const it = await item();
      await report(it, { kind: "progress", summary: `第一行\n第二行 ${"字".repeat(100)}` });
      const got = await row(it.itemId);
      assert.equal(Array.from(got.summary as string).length, 80);
      assert.ok(!(got.summary as string).includes("\n"));
      // The log keeps what was said in full.
      assert.ok(((await events(it.itemId))[1].summary as string).includes("\n"));
    });

    test("a ready report keeps its result in the log, not on the row", async () => {
      const it = await item();
      await report(it, { kind: "ready", summary: "done", result: { refs: [{ type: "pr", sha: "abc" }], notes: "n" } }, { runId: "run-1" });
      const ready = (await events(it.itemId))[1];
      assert.deepEqual(ready.result, { refs: [{ type: "pr", sha: "abc" }], notes: "n" });
      assert.equal(ready.run_id, "run-1");
      assert.equal(ready.generation, 0);
    });

    test("each ready is a new version, and each entry into needs_you a new attention", async () => {
      const it = await item();
      await report(it, { kind: "ready", summary: "v1" });
      await report(it, { kind: "progress", summary: "more" });
      await report(it, { kind: "ready", summary: "v2" });
      await report(it, { kind: "failed", summary: "oops" });
      const got = await row(it.itemId);
      assert.deepEqual([got.result_version, got.attention_seq], [2, 3]);
    });

    test("a question is cleared by the next report that is not a question", async () => {
      const it = await item();
      await report(it, { kind: "waiting", summary: "?", question: "Which?" });
      assert.equal((await row(it.itemId)).pending_question, "Which?");
      await report(it, { kind: "progress", summary: "answered, going on" });
      assert.equal((await row(it.itemId)).pending_question, null);
    });
  });

  // --- C ---------------------------------------------------------------------------------

  describe("C a report from someone who no longer counts changes nothing", () => {
    async function untouched(it: { itemId: string }, before: Record<string, any>, eventCount: number) {
      assert.deepEqual(await row(it.itemId), before);
      assert.equal((await events(it.itemId)).length, eventCount);
    }

    for (const [name, over] of [
      ["an older generation", { generation: 0 }],
      ["a newer generation", { generation: 2 }],
      // At the current generation, so that only the sender's identity is wrong.
      ["another worker's session", { generation: 1, workerSessionId: "w-someone-else" }],
    ] as const) {
      test(`${name}`, async () => {
        const it = await item();
        await q("UPDATE claw_work_items SET generation = 1 WHERE item_id = $1", [it.itemId]);
        const before = await row(it.itemId);
        const out = await report(it, { kind: "ready", summary: "late" }, over);
        assert.deepEqual(out, { applied: false });
        await untouched(it, before, 1);
      });
    }

    test("the current worker at the current generation does apply, so the cases above prove the rule and not a broken fixture", async () => {
      const it = await item();
      await q("UPDATE claw_work_items SET generation = 1 WHERE item_id = $1", [it.itemId]);
      const out = await report(it, { kind: "ready", summary: "on time" }, { generation: 1 });
      assert.equal(out.applied, true);
      assert.equal((await events(it.itemId)).at(-1)?.generation, 1);
    });

    test("a closed item", async () => {
      const it = await item();
      assert.equal((await report(it, { kind: "dropped", summary: "bye" })).applied, true);
      const before = await row(it.itemId);
      assert.deepEqual(await report(it, { kind: "ready", summary: "after the end" }), { applied: false });
      await untouched(it, before, 2);
    });

    test("a second turn-end for one run raises, and leaves the item as the first one made it", async () => {
      const it = await item();
      const end = { runId: "run-9", source: "turn_end" } as const;
      assert.equal((await report(it, { kind: "ready", summary: "first" }, end)).applied, true);
      const before = await row(it.itemId);
      await assert.rejects(report(it, { kind: "ready", summary: "again" }, end), (e: { code?: string }) => e.code === "23505");
      await untouched(it, before, 2);
    });
  });

  // --- D ---------------------------------------------------------------------------------

  describe("D acceptance is pinned to a version", () => {
    test("0 is refused, 1 is accepted, and a second acceptance is refused", async () => {
      const it = await item();
      await report(it, { kind: "ready", summary: "PR opened" });
      const stale = await as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 0 });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error, "version_mismatch");
      assert.equal(stale.body.data.result_version, 1);
      assert.equal(stale.body.data.board_state, "needs_you");
      assert.equal((await row(it.itemId)).board_state, "needs_you");

      const ok = await as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 1 });
      assert.equal(ok.status, 200);
      assert.deepEqual(
        [ok.body.data.board_state, ok.body.data.outcome, ok.body.data.accepted_version, ok.body.data.can_accept],
        ["done", "accepted", 1, false],
      );
      const got = await row(it.itemId);
      assert.deepEqual([got.board_state, got.outcome, got.accepted_version, got.closed_at !== null], ["done", "accepted", 1, true]);

      const again = await as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 1 });
      assert.equal(again.status, 409);
      assert.equal(again.body.error, "not_acceptable");
      const evs = await events(it.itemId);
      assert.deepEqual(evs.map((e) => e.kind), ["created", "ready", "accepted"]);
      assert.deepEqual([evs[2].source, evs[2].result], ["user", { version: 1 }]);
    });

    test("a newer result makes the old card useless, and the new version is accepted", async () => {
      const it = await item();
      await report(it, { kind: "ready", summary: "v1" });
      await report(it, { kind: "progress", summary: "changes" });
      await report(it, { kind: "ready", summary: "v2" });
      const old = await as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 1 });
      assert.deepEqual([old.status, old.body.error, old.body.data.result_version], [409, "version_mismatch", 2]);
      assert.equal((await as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 2 })).status, 200);
    });

    test("asking for more changes pulls the item back, and the click on the old result fails", async () => {
      const it = await item();
      await report(it, { kind: "ready", summary: "v1" });
      const back = await work.reopenWorkItem(h.app.db.db, { userId: "u1", itemId: it.itemId, text: "also fix the typo" });
      assert.deepEqual([back?.board_state, back?.last_report_kind, back?.result_version], ["in_progress", "progress", 1]);
      const res = await as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 1 });
      assert.deepEqual([res.status, res.body.error], [409, "not_acceptable"]);
      assert.equal((await row(it.itemId)).board_state, "in_progress");
    });

    for (const [kind, why] of [["failed", "a failure"], ["blocked", "a blocker"], ["progress", "progress"]] as const) {
      test(`${why} is not a result to accept`, async () => {
        const it = await item();
        await report(it, { kind, summary: "x" });
        const res = await as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 0 });
        assert.deepEqual([res.status, res.body.error], [409, "not_acceptable"]);
      });
    }

    test("two clicks at once: one acceptance", async () => {
      const it = await item();
      await report(it, { kind: "ready", summary: "v1" });
      const results = await Promise.all(Array.from({ length: 8 }, () => as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 1 })));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
      assert.equal((await events(it.itemId)).filter((e) => e.kind === "accepted").length, 1);
    });

    for (const bad of [undefined, -1, 1.5, "1", null, true]) {
      test(`version ${JSON.stringify(bad)} is a 400, not a guess`, async () => {
        const it = await item();
        await report(it, { kind: "ready", summary: "v1" });
        const res = await as("u1").post(`/v1/work-items/${it.itemId}/accept`, bad === undefined ? {} : { version: bad });
        assert.equal(res.status, 400);
        assert.equal((await row(it.itemId)).board_state, "needs_you");
      });
    }
  });

  // --- E ---------------------------------------------------------------------------------

  describe("E stop", () => {
    test("closes the item, bumps the generation, drops the unstarted first message, and interrupts the worker", async () => {
      const it = await item();
      await q("INSERT INTO claw_pending_messages (session_id, content, user_id) VALUES ($1, 'start', 'u1'), ('other-session', 'keep', 'u1')", [it.worker]);
      const res = await as("u1").post(`/v1/work-items/${it.itemId}/stop`);
      assert.equal(res.status, 200);
      assert.deepEqual([res.body.data.board_state, res.body.data.outcome], ["done", "stopped"]);
      const got = await row(it.itemId);
      assert.deepEqual([got.board_state, got.outcome, got.generation, got.closed_at !== null], ["done", "stopped", 1, true]);
      assert.deepEqual((await rows("SELECT session_id FROM claw_pending_messages")).map((r) => r.session_id), ["other-session"]);
      assert.deepEqual(published, [interruptSubject(it.worker)]);
      const last = (await events(it.itemId)).at(-1)!;
      assert.deepEqual([last.kind, last.source, last.generation], ["stopped", "user", 1]);
    });

    test("the worker that was stopped can no longer report", async () => {
      const it = await item();
      await as("u1").post(`/v1/work-items/${it.itemId}/stop`);
      assert.deepEqual(await report(it, { kind: "ready", summary: "too late" }), { applied: false });
      assert.deepEqual(await report(it, { kind: "ready", summary: "too late" }, { generation: 1 }), { applied: false });
    });

    test("a report racing a stop leaves a stopped item with no report after the stop", async () => {
      for (let i = 0; i < 10; i++) {
        const it = await item("u1", i);
        await Promise.all([
          as("u1").post(`/v1/work-items/${it.itemId}/stop`),
          report(it, { kind: "ready", summary: "racing" }),
        ]);
        const got = await row(it.itemId);
        assert.deepEqual([got.board_state, got.outcome], ["done", "stopped"]);
        const kinds = (await events(it.itemId)).map((e) => e.kind);
        assert.ok(kinds.indexOf("stopped") === kinds.length - 1, kinds.join(","));
      }
    });

    test("an item that is already accepted cannot be stopped", async () => {
      const it = await item();
      await report(it, { kind: "ready", summary: "v1" });
      await as("u1").post(`/v1/work-items/${it.itemId}/accept`, { version: 1 });
      const res = await as("u1").post(`/v1/work-items/${it.itemId}/stop`);
      assert.deepEqual([res.status, res.body.error, res.body.data.outcome], [409, "item_closed", "accepted"]);
      assert.deepEqual(published, []);
      assert.equal((await row(it.itemId)).outcome, "accepted");
    });

    test("a wire interrupt that cannot be published does not undo the stop: the durable half is what sticks", async () => {
      const it = await item();
      h.app.chatRun.chatRunPorts.publishInterrupt = () => { throw new Error("nats is down"); };
      const res = await as("u1").post(`/v1/work-items/${it.itemId}/stop`);
      assert.equal(res.status, 200);
      assert.equal((await row(it.itemId)).outcome, "stopped");
    });

    test("a stop whose durable half fails is a 503, the item stays stopped, and stopping again settles it", async () => {
      const it = await item();
      await q("ALTER TABLE claw_tasks RENAME TO claw_tasks_away");
      try {
        const res = await as("u1").post(`/v1/work-items/${it.itemId}/stop`);
        assert.deepEqual([res.status, res.body.error], [503, "interrupt_not_recorded"]);
      } finally {
        await q("ALTER TABLE claw_tasks_away RENAME TO claw_tasks");
      }
      assert.equal((await row(it.itemId)).outcome, "stopped");
      published = [];
      const retry = await as("u1").post(`/v1/work-items/${it.itemId}/stop`);
      assert.equal(retry.status, 200);
      assert.deepEqual(published, [interruptSubject(it.worker)]);
      assert.equal((await rows("SELECT 1 FROM claw_work_item_events WHERE item_id = $1 AND kind = 'stopped'", [it.itemId])).length, 1);
    });
  });

  // --- F ---------------------------------------------------------------------------------

  describe("F the limit on unfinished items", () => {
    const make = (user: string, n: number) =>
      h.app.db.inTransaction((query) => work.insertWorkItem({ query }, { userId: user, title: `t${n}`, workerSessionId: `w-${user}-${n}` }));

    test("the sixth unfinished item is refused with the reason, and nothing is written", async () => {
      await as("u1").post("/v1/assistant");
      for (let n = 1; n <= MAX_ACTIVE; n++) assert.equal((await make("u1", n)).ok, true);
      assert.deepEqual(await make("u1", 6), { ok: false, error: "too_many_active_items" });
      assert.equal((await rows("SELECT 1 FROM claw_work_items")).length, MAX_ACTIVE);
      assert.equal((await rows("SELECT 1 FROM claw_work_item_events")).length, MAX_ACTIVE);
    });

    test("an item that needs the user still counts, and a finished one does not", async () => {
      await as("u1").post("/v1/assistant");
      const made = [];
      for (let n = 1; n <= MAX_ACTIVE; n++) made.push(await make("u1", n));
      const first = made[0] as { ok: true; itemId: string };
      await work.applyWorkerReport(h.app.db.db, { itemId: first.itemId, generation: 0, workerSessionId: "w-u1-1", source: "worker", report: { kind: "ready", summary: "x" } });
      assert.equal((await make("u1", 6)).ok, false);
      await as("u1").post(`/v1/work-items/${first.itemId}/accept`, { version: 1 });
      assert.equal((await make("u1", 7)).ok, true);
    });

    test("the limit is per user", async () => {
      await as("u1").post("/v1/assistant");
      await as("u2").post("/v1/assistant");
      for (let n = 1; n <= MAX_ACTIVE; n++) await make("u1", n);
      assert.equal((await make("u2", 1)).ok, true);
    });

    test("numbers count up per user, and a closed item's number is not given again", async () => {
      await as("u1").post("/v1/assistant");
      await as("u2").post("/v1/assistant");
      const a = await make("u1", 1);
      const b = await make("u1", 2);
      const other = await make("u2", 1);
      assert.deepEqual([a, b, other].map((r) => r.ok && r.seq), [1, 2, 1]);
      await as("u1").post(`/v1/work-items/${(b as { itemId: string }).itemId}/stop`);
      const c = await make("u1", 3);
      assert.equal(c.ok && c.seq, 3);
    });

    test("ten creates at once: exactly the limit succeed, numbered 1 to the limit", async () => {
      await as("u1").post("/v1/assistant");
      const results = await Promise.all(Array.from({ length: 10 }, (_, n) => make("u1", n)));
      const ok = results.filter((r) => r.ok);
      assert.equal(ok.length, MAX_ACTIVE);
      assert.deepEqual(ok.map((r) => r.ok && r.seq).sort(), [1, 2, 3, 4, 5]);
      assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === "too_many_active_items"));
    });

    test("a user with no assistant has nothing to put an item on", async () => {
      assert.deepEqual(await make("nobody", 1), { ok: false, error: "no_assistant" });
    });

    test("a title is one line of at most 40 characters", async () => {
      await as("u1").post("/v1/assistant");
      const made = await h.app.db.inTransaction((query) =>
        work.insertWorkItem({ query }, { userId: "u1", title: `写\n报告 ${"长".repeat(60)}`, workerSessionId: "w-long" }));
      assert.equal(made.ok, true);
      if (!made.ok) return;
      const title = (await row(made.itemId)).title as string;
      assert.equal(Array.from(title).length, 40);
      assert.ok(!title.includes("\n"));
    });
  });

  // --- G ---------------------------------------------------------------------------------

  describe("G another user's items are not there", () => {
    test("reading, accepting and stopping an item of someone else all answer 404 and change nothing", async () => {
      const mine = await item("u1");
      await report(mine, { kind: "ready", summary: "v1" });
      const before = await row(mine.itemId);
      const evBefore = (await events(mine.itemId)).length;
      for (const [method, path, body] of [
        ["GET", `/v1/work-items/${mine.itemId}`, undefined],
        ["POST", `/v1/work-items/${mine.itemId}/accept`, { version: 1 }],
        ["POST", `/v1/work-items/${mine.itemId}/stop`, {}],
      ] as const) {
        const res = await call("u2", method, path, body);
        assert.deepEqual([res.status, res.body.error], [404, "not_found"], `${method} ${path}`);
      }
      assert.deepEqual(await row(mine.itemId), before);
      assert.equal((await events(mine.itemId)).length, evBefore);
      assert.deepEqual(published, []);
    });

    test("a body that names another user as the owner changes nothing: the owner is the caller", async () => {
      const mine = await item("u1");
      await report(mine, { kind: "ready", summary: "v1" });
      const created = await as("u2").post("/v1/assistant", { user_id: "u1", userId: "u1" });
      assert.deepEqual((await rows("SELECT user_id FROM claw_sessions WHERE session_id = $1", [created.body.data.session_id])).map((r) => r.user_id), ["u2"]);
      assert.deepEqual((await rows("SELECT user_id FROM claw_assistants ORDER BY user_id")).map((r) => r.user_id), ["u1", "u2"]);
      for (const [path, body] of [
        [`/v1/work-items/${mine.itemId}/accept`, { version: 1, user_id: "u1" }],
        [`/v1/work-items/${mine.itemId}/stop`, { user_id: "u1" }],
      ] as const) {
        assert.equal((await as("u2").post(path, body)).status, 404, path);
      }
      assert.equal((await row(mine.itemId)).board_state, "needs_you");
    });

    test("the board of one user holds none of another's", async () => {
      await item("u1", 1);
      await item("u2", 1);
      const a = await as("u1").get("/v1/work-items");
      const b = await as("u2").get("/v1/work-items");
      assert.equal(a.body.data.length, 1);
      assert.equal(b.body.data.length, 1);
      assert.notEqual(a.body.data[0].item_id, b.body.data[0].item_id);
    });

    test("an item that never existed answers the same as one that is someone else's", async () => {
      await as("u1").post("/v1/assistant");
      const res = await as("u1").get("/v1/work-items/kwi_NOSUCHITEM");
      assert.deepEqual([res.status, res.body.error], [404, "not_found"]);
    });

    test("without an identity, every route refuses", async () => {
      for (const [method, path] of [["GET", "/v1/work-items"], ["GET", "/v1/work-items/x"], ["POST", "/v1/work-items/x/accept"], ["POST", "/v1/work-items/x/stop"]] as const) {
        assert.equal((await call(null, method, path, method === "POST" ? { version: 0 } : undefined)).status, 403, `${method} ${path}`);
      }
    });
  });

  // --- H ---------------------------------------------------------------------------------

  describe("H the board", () => {
    test("filters by state, newest first, and each row says whether it can be accepted", async () => {
      const a = await item("u1", 1);
      const b = await item("u1", 2);
      const c = await item("u1", 3);
      await report(b, { kind: "ready", summary: "b is ready" });
      await report(c, { kind: "waiting", summary: "c asks", question: "Which one?" });
      const all = await as("u1").get("/v1/work-items");
      assert.deepEqual(all.body.data.map((r: any) => r.seq), [3, 2, 1]);
      const needs = await as("u1").get("/v1/work-items?state=needs_you");
      assert.deepEqual(needs.body.data.map((r: any) => [r.seq, r.last_report_kind, r.pending_question, r.can_accept, r.result_version]),
        [[3, "waiting", "Which one?", false, 0], [2, "ready", null, true, 1]]);
      assert.deepEqual((await as("u1").get("/v1/work-items?state=in_progress")).body.data.map((r: any) => r.item_id), [a.itemId]);
      assert.deepEqual(Object.keys(needs.body.data[0]).sort(), [
        "accepted_version", "board_state", "can_accept", "item_id", "last_report_kind", "outcome",
        "pending_question", "result_version", "seq", "summary", "title", "updated_at",
      ]);
    });

    test("an unknown state is a 400", async () => {
      const res = await as("u1").get("/v1/work-items?state=finished");
      assert.equal(res.status, 400);
    });

    test("done shows the last seven days only", async () => {
      const fresh = await item("u1", 1);
      const old = await item("u1", 2);
      for (const it of [fresh, old]) await report(it, { kind: "dropped", summary: "bye" });
      await q("UPDATE claw_work_items SET closed_at = NOW() - INTERVAL '8 days' WHERE item_id = $1", [old.itemId]);
      const done = await as("u1").get("/v1/work-items?state=done");
      assert.deepEqual(done.body.data.map((r: any) => r.item_id), [fresh.itemId]);
      assert.deepEqual((await as("u1").get("/v1/work-items")).body.data.map((r: any) => r.item_id), [fresh.itemId]);
      // Older than the window is hidden from the board, not deleted.
      assert.equal((await row(old.itemId)).board_state, "done");
    });

    test("an item's detail carries its worker session and its latest twenty events, newest first", async () => {
      const it = await item();
      for (let i = 0; i < 25; i++) await report(it, { kind: "progress", summary: `step ${i}` });
      const res = await as("u1").get(`/v1/work-items/${it.itemId}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.worker_session_id, it.worker);
      assert.equal(res.body.data.events.length, 20);
      assert.equal(res.body.data.events[0].summary, "step 24");
      assert.equal(res.body.data.events[19].summary, "step 5");
      assert.deepEqual(Object.keys(res.body.data.events[0]).sort(), ["created_at", "generation", "id", "kind", "question", "result", "run_id", "source", "summary"]);
      assert.equal(res.body.data.seq, 1);
      assert.equal(res.body.data.title, "task 1");
    });
  });

  // --- I ---------------------------------------------------------------------------------

  describe("I the schema", () => {
    const tables = async () => (await rows(
      "SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1) ORDER BY table_name", [ASSISTANT_TABLES],
    )).map((r) => r.table_name);

    test("initDb creates the four tables, and running it again is harmless", async () => {
      assert.deepEqual(await tables(), [...ASSISTANT_TABLES].sort());
      await h.app.db.initDb();
      assert.deepEqual(await tables(), [...ASSISTANT_TABLES].sort());
    });

    test("start-up refuses a database that lost a column the state machine names", async () => {
      await q("ALTER TABLE claw_work_items RENAME COLUMN attention_seq TO attention_seq_away");
      try {
        await assert.rejects(h.app.db.initDb(), /claw_work_items is missing column\(s\): attention_seq/);
      } finally {
        await q("ALTER TABLE claw_work_items RENAME COLUMN attention_seq_away TO attention_seq");
      }
    });

    test("a duplicate start or turn end for one run is refused by the table, not by luck", async () => {
      const it = await item();
      const add = (kind: string, source: string, run: string) => q(
        "INSERT INTO claw_work_item_events (item_id, kind, source, generation, run_id) VALUES ($1, $2, $3, 0, $4)", [it.itemId, kind, source, run]);
      await add("run_started", "worker", "r1");
      await assert.rejects(add("run_started", "worker", "r1"), (e: { code?: string }) => e.code === "23505");
      await add("run_started", "worker", "r2");
      await add("ready", "turn_end", "r1");
      await assert.rejects(add("failed", "turn_end", "r1"), (e: { code?: string }) => e.code === "23505");
      // Worker reports are not limited to one per run: a worker may say several things in a turn.
      await add("progress", "worker", "r1");
      await add("progress", "worker", "r1");
    });

    test("one system fallback per time an item needed the user, but any number of ordinary says", async () => {
      const say = (fallback: boolean, attention: number | null, item = "i1") => q(
        "INSERT INTO claw_assistant_says (say_id, user_id, item_id, item_attention_seq, text, fallback) VALUES (gen_random_uuid(), 'u1', $1, $2, 't', $3)",
        [item, attention, fallback]);
      await say(false, 1);
      await say(false, 1);
      await say(true, 1);
      await assert.rejects(say(true, 1), (e: { code?: string }) => e.code === "23505");
      await say(true, 2);
      await say(true, 1, "i2");
    });

    test("one worker session belongs to one item, and one user has one number once", async () => {
      const it = await item();
      await assert.rejects(
        q("INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id) VALUES ('x1', 'u1', 99, 't', 'in_progress', $1)", [it.worker]),
        (e: { code?: string }) => e.code === "23505",
      );
      await assert.rejects(
        q("INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id) VALUES ('x2', 'u1', $1, 't', 'in_progress', 'w-other')", [it.seq]),
        (e: { code?: string }) => e.code === "23505",
      );
    });
  });
});
