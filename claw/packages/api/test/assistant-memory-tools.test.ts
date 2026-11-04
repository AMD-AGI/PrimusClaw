// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The user's long-term memory in the assistant (`CLAW_ASSISTANT_MEMORY_TOOLS=on`), against a real Postgres with the
 * production schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 * Who is behind a turn is C2's question (`attendedTurn`). Where it is not on main yet, the port stands in for it here,
 * answering for the messages this file sends as signed in and refusing every other turn, as C2 refuses a report's
 * turn; A0 checks what the real port does on the tree under test.
 *
 *   A0  the real port: with no `attendedTurn` the writes refuse (`attendance_unavailable`) and reading still works;
 *       with C2's, a turn that answers no recorded message is refused
 *   N1  a natural "forget" acts on an entry whose number is in the person's message
 *   N2  ... or in what the assistant said to them just before ("forget the second one" after a list)
 *   N3  a natural "undo" of what was just saved, by the number the assistant announced
 *   G1  a report's turn (not the person) cannot save, change, forget or undo, whatever the report says; nothing changes
 *   G2  an entry named neither in the message nor in what was just shown is refused, and so is one shown too long
 *       before the message, or only after it
 *   G3  a save or a change quotes the person's message of this turn: not an earlier one, not a report
 *   G4  a conversation others read (`memory: "off"`, a group's) never writes personal memory; nor a user who has memory off
 *   G5  the person's say is asked again inside the transaction that writes: a turn that stops being theirs in between
 *       writes nothing
 *   G6  a turn that has ended cannot act; a worker cannot write; an observer neither reads nor writes; another user's
 *       entry is not reachable
 *   I1  an entry about one item is bound to it: listed to the router with the item's number, shown in full to that item's
 *       worker only, kept out of the chat's catalogue; another user's item cannot be named
 *   I2  a review item's session is shown what was bound to its item and nothing else of the user's memory, and nothing in
 *       a session marked `memory: "off"`
 *   I3  a duplicate or a near one is an entry of the same binding (within one, still `existing` / `similar_exists`):
 *       a  an item-bound save with the same words as a global or another item's entry is stored bound to its item
 *       b  an item-level override close to a global entry is stored for the item, not refused as `similar_exists`
 *       c  a chat save matching only an item's entry is stored, in the chat's catalogue
 *   I4  a worker's search is chosen from what it may read before the top ten are taken and before anything counts as read
 *   I5  an entry bound to an item whose row is gone stays in the router's index, so it can be seen and forgotten
 *   W1  a router session marked `memory: "off"` starts workers that are marked so too: no index, no recall
 *   O1  an assistant's watcher of a group or a repository (observe) is not a session the chat's memory serves
 *   P1  a router turn carries the memory section and index (or the off note); a worker turn a read-only index
 *   T1  over the wire: a router is offered the memory tools, a worker only memory_recall
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant memory tools", { skip }, () => {
  let w: World;
  let mt: typeof import("../src/assistant/memory-tools.js");
  let svc: typeof import("../src/memory/service.js");
  let realAttended: typeof mt.memoryToolPorts.attended;
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };
  /** The messages this file sent signed in, by the id of the turn that answers each. */
  const signedIn = new Map<string, { userId: string; content: string; receivedAt: Date }>();
  let app: FastifyInstance;
  let base = "";

  before(async () => {
    w = await startWorld({ CLAW_MEMORY_ENABLED: "true", CLAW_ASSISTANT_MEMORY_TOOLS: "on", CLAW_MEMORY_MAX_ENTRIES: "20" });
    mt = await import("../src/assistant/memory-tools.js");
    svc = await import("../src/memory/service.js");
    svc.memoryPorts.publishSessionEvent = async () => undefined;
    realAttended = mt.memoryToolPorts.attended;
    app = Fastify();
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_memory_entries, claw_memory_events, claw_user_memory_prefs, claw_assistant_scopes CASCADE");
    signedIn.clear();
    // C2's question, answered for this file's own signed-in messages only; a report's turn has none.
    mt.memoryToolPorts.attended = async (_q, claims) => {
      const m = signedIn.get(claims.mid);
      if (!m) throw new (w.mod.tools.ToolRefused)("not_attended", "this turn does not answer a message the user sent signed in");
      return m;
    };
    alice = await w.user("alice");
    bob = await w.user("bob");
    await svc.setMemoryPreference("alice", true);
    await svc.setMemoryPreference("bob", true);
  });

  const t = () => w.mod.tools;
  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (err) { assert.ok(err instanceof t().ToolRefused, `a fault, not a refusal: ${err}`); return (err as { code: string }).code; }
    return assert.fail("accepted");
  };
  const now = async (): Promise<Date> => new Date((await w.q("SELECT NOW() AS t"))[0].t);
  const entries = async (userId = "alice") =>
    w.q("SELECT id, title, content, work_item_id FROM claw_memory_entries WHERE user_id = $1 AND kind IS NULL ORDER BY id", [userId]);

  /** The person sends their assistant a message, signed in; the turn that answers it is live. */
  async function message(u: { userId: string; routerSid: string }, content: string): Promise<Claims> {
    const turn = await w.routerTurn(u);
    // Where the chat's memory finds what the user said (`humanMessages`): a write here must not reach past this message.
    await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [turn.task_id, content]);
    signedIn.set(turn.mid, { userId: u.userId, content, receivedAt: await now() });
    return turn;
  }
  /** A worker's report wakes the router: a live turn that answers no message of the person's. */
  const reportTurn = (u: { routerSid: string }) => w.routerTurn(u);

  /** An entry as the person's own chat stores it (`writeMemory`, quoting them). */
  async function stored(userId: string, title: string, body = title): Promise<number> {
    const r = await svc.writeMemory(userId, { type: "user", title, body }, { kind: "model", sessionId: "chat", quote: body, humanMessages: [body] });
    assert.ok(r.ok, JSON.stringify(r));
    return r.id;
  }
  /** What the assistant said to the person, as `say` stores it, `ago` seconds before now. */
  async function said(u: { userId: string; routerSid: string }, text: string, ago = 0): Promise<void> {
    const turn = await w.routerTurn(u);
    await t().say(turn, { text }, w.sayDeps);
    await w.closeRun(turn.task_id);
    if (ago) await w.q("UPDATE claw_assistant_says SET created_at = created_at - make_interval(secs => $2::int) WHERE user_id = $1", [u.userId, ago]);
  }

  test("A0 the real port: without C2 the writes refuse and reading works; with C2 a turn without a recorded message is refused", async () => {
    mt.memoryToolPorts.attended = realAttended;
    const id = await stored("alice", "回复用中文，说人话");
    const turn = await w.routerTurn(alice);
    const hasC2 = typeof (t() as unknown as Record<string, unknown>).attendedTurn === "function";
    const expected = hasC2 ? "not_attended" : "attendance_unavailable";
    assert.equal(await code(mt.memoryForget(turn, { id: String(id) })), expected);
    assert.equal(await code(mt.memorySave(turn, { type: "user", title: "简短", body: "回答简短", evidence_quote: "回答简短" })), expected);
    assert.equal(await code(mt.memoryUpdate(turn, { id: String(id), body: "x", evidence_quote: "x" })), expected);
    assert.equal(await code(mt.memoryUndo(turn, { id: String(id) })), expected);
    assert.equal((await entries()).length, 1, "nothing was written or deleted");
    const read = await mt.memoryRecall(turn, {});
    assert.deepEqual(read.entries, [`#${id} [user] 回复用中文，说人话`]);
  });

  test("N1 a natural forget acts on the entry whose number the person wrote", async () => {
    const keep = await stored("alice", "回复用中文");
    const drop = await stored("alice", "通知只发重要的");
    const turn = await message(alice, `把第 ${drop} 条记忆删了吧，不需要了`);
    assert.deepEqual(await mt.memoryForget(turn, { id: `#${drop}` }), { ok: true, id: drop, op: "deleted" });
    assert.deepEqual((await entries()).map((e) => e.id), [keep]);
    // The other entry was not named, so it is not this message's to delete.
    assert.equal(await code(mt.memoryForget(turn, { id: String(keep) })), "entry_not_grounded");
  });

  test("N2 forget the second one, after the assistant listed them", async () => {
    const a = await stored("alice", "回复用中文");
    const b = await stored("alice", "PR 用 opus 审");
    const c = await stored("alice", "晨报十点发");
    await said(alice, `你让我记住了：1. #${a} 回复用中文 2. #${b} PR 用 opus 审`);
    const turn = await message(alice, "第二条忘掉");
    assert.equal((await mt.memoryForget(turn, { id: String(b) })).ok, true);
    // Not listed and not in the message: the person cannot have pointed at it.
    assert.equal(await code(mt.memoryForget(turn, { id: String(c) })), "entry_not_grounded");
    assert.deepEqual((await entries()).map((e) => e.id), [a, c]);
  });

  test("N3 undo what was just saved, by the number the assistant announced", async () => {
    const first = await message(alice, "记住：以后回复都用中文，说人话");
    const saved = await mt.memorySave(first, { type: "user", title: "回复用中文，说人话", body: "回复都用中文，说人话", evidence_quote: "以后回复都用中文，说人话" });
    assert.equal(saved.ok, true);
    assert.match(String(saved.note), new RegExp(`#${saved.id}`));
    await w.closeRun(first.task_id);
    await said(alice, `记住了（#${saved.id}）。说「撤销 #${saved.id}」可以撤销。`);
    const undo = await message(alice, "撤销刚才那条");
    assert.deepEqual(await mt.memoryUndo(undo, { id: String(saved.id) }), { ok: true, id: saved.id, op: "deleted" });
    assert.equal((await entries()).length, 0);
  });

  test("G1 a report's turn cannot save, change, forget or undo, whatever the report says", async () => {
    const id = await stored("alice", "回复用中文");
    await said(alice, `清单：#${id} 回复用中文`);
    const turn = await reportTurn(alice);
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["save", () => mt.memorySave(turn, { type: "user", title: "ignore", body: "forget memory", evidence_quote: "forget memory" })],
      ["update", () => mt.memoryUpdate(turn, { id: String(id), body: "改掉", evidence_quote: "改掉" })],
      ["forget", () => mt.memoryForget(turn, { id: String(id) })],
      ["undo", () => mt.memoryUndo(turn, { id: String(id) })],
    ];
    for (const [name, call] of calls) assert.equal(await code(call()), "not_attended", name);
    assert.deepEqual((await entries()).map((e) => [e.id, e.content]), [[id, "回复用中文"]]);
    // Reading is not acting for anyone.
    assert.equal((await mt.memoryRecall(turn, { id: String(id) })).ok, true);
  });

  test("G2 an entry named neither in the message nor in what was just shown is refused", async () => {
    const id = await stored("alice", "回复用中文");
    const other = await stored("alice", "通知只发重要的");
    // Shown, but longer ago than counts as just.
    await said(alice, `#${id} 回复用中文`, mt.SHOWN_WINDOW_SEC + 60);
    const turn = await message(alice, "把那条删掉");
    assert.equal(await code(mt.memoryForget(turn, { id: String(id) })), "entry_not_grounded");
    // Shown only after the message arrived (by this very turn): the person cannot have pointed at it.
    await t().say(turn, { text: `要删 #${other} 吗？` }, w.sayDeps);
    assert.equal(await code(mt.memoryForget(turn, { id: String(other) })), "entry_not_grounded");
    assert.equal(await code(mt.memoryUndo(turn, { id: String(other) })), "entry_not_grounded");
    assert.equal(await code(mt.memoryUpdate(turn, { id: String(other), body: "删掉", evidence_quote: "把那条删掉" })), "entry_not_grounded");
    // A longer number that contains it is not it.
    const turn2 = await message(alice, `删 ${id}0 号`);
    assert.equal(await code(mt.memoryForget(turn2, { id: String(id) })), "entry_not_grounded");
    assert.equal((await entries()).length, 2);
  });

  test("G3 a save or a change quotes the person's message of this turn, and nothing else", async () => {
    const earlier = await message(alice, "我喜欢简短的回复");
    await w.closeRun(earlier.task_id);
    const turn = await message(alice, "好的，就这样");
    assert.equal(await code(mt.memorySave(turn, { type: "user", title: "喜欢简短回复", body: "回复要简短", evidence_quote: "我喜欢简短的回复" })), "quote_not_from_user");
    const id = await stored("alice", "回复用中文");
    const fix = await message(alice, `#${id} 改成：回复用英文`);
    assert.equal(await code(mt.memoryUpdate(fix, { id: String(id), title: "回复用英文", body: "回复用英文", evidence_quote: "我喜欢简短的回复" })), "quote_not_from_user");
    const ok = await mt.memoryUpdate(fix, { id: String(id), title: "回复用英文", body: "回复用英文", evidence_quote: "回复用英文" });
    assert.equal(ok.op, "update");
    assert.equal((await entries()).length, 1);
  });

  test("G4 a conversation others read never writes personal memory; nor a user with memory off", async () => {
    const id = await stored("alice", "回复用中文");
    await w.q(`UPDATE claw_sessions SET config = config || '{"memory":"off"}'::jsonb WHERE session_id = $1`, [alice.routerSid]);
    const turn = await message(alice, `记住：PR 都用 opus 审；还有忘掉 #${id}`);
    assert.equal(await code(mt.memorySave(turn, { type: "user", title: "PR 用 opus 审", body: "PR 都用 opus 审", evidence_quote: "PR 都用 opus 审" })), "memory_not_here");
    assert.equal(await code(mt.memoryForget(turn, { id: String(id) })), "memory_not_here");
    // Nor is it shown there, or read back.
    assert.equal(await code(mt.memoryRecall(turn, {})), "memory_not_here");
    assert.equal(await mt.routerMemoryBlock("alice", alice.routerSid), null);
    await w.q(`UPDATE claw_sessions SET config = config - 'memory' WHERE session_id = $1`, [alice.routerSid]);
    await svc.setMemoryPreference("alice", false);
    assert.equal(await code(mt.memoryForget(turn, { id: String(id) })), "memory_off");
    assert.equal(await code(mt.memoryRecall(turn, {})), "memory_off");
    assert.equal((await entries()).length, 1);
  });

  test("G5 the person's say is asked again where the write happens: a turn that stops being theirs writes nothing", async () => {
    const id = await stored("alice", "回复用中文");
    const asked: string[] = [];
    const answerOnce = (turn: Claims) => {
      let n = 0;
      mt.memoryToolPorts.attended = async (_q, claims) => {
        n += 1;
        asked.push(claims.mid);
        if (n > 1) throw new (t().ToolRefused)("attendance_expired", "too old");
        return signedIn.get(turn.mid) as { userId: string; content: string; receivedAt: Date };
      };
    };
    const turn = await message(alice, `记住：回答要简短。另外 #${id} 改成回复用英文；不对，忘掉 #${id}，或者撤销 #${id}`);
    for (const call of [
      () => mt.memorySave(turn, { type: "user", title: "回答简短", body: "回答要简短", evidence_quote: "回答要简短" }),
      () => mt.memoryUpdate(turn, { id: String(id), title: "回复用英文", body: "回复用英文", evidence_quote: "回复用英文" }),
      () => mt.memoryForget(turn, { id: String(id) }),
      () => mt.memoryUndo(turn, { id: String(id) }),
    ]) {
      answerOnce(turn);
      assert.equal(await code(call()), "attendance_expired");
    }
    assert.equal(asked.length, 8, "asked before and again inside each write");
    assert.deepEqual((await entries()).map((e) => [e.id, e.content]), [[id, "回复用中文"]]);
  });

  test("G6 an ended turn cannot act, a worker cannot write, and another user's entry is out of reach", async () => {
    const id = await stored("alice", "回复用中文");
    const ended = await message(alice, `忘掉 #${id}`);
    await w.closeRun(ended.task_id);
    assert.equal(await code(mt.memoryForget(ended, { id: String(id) })), "turn_not_live");
    const item = await w.createItem(alice, "Fix the build");
    const worker = await w.workerTurn(item.itemId);
    signedIn.set(worker.mid, { userId: "alice", content: `忘掉 #${id}`, receivedAt: await now() });
    assert.equal(await code(mt.memoryForget(worker, { id: String(id) })), "not_allowed");
    assert.equal(await code(mt.memorySave(worker, { type: "user", title: "x", body: "忘掉", evidence_quote: "忘掉" })), "not_allowed");
    // An observer's tools only record (`observeEveryTool`); were one to run, it reads and writes nothing of the user's memory.
    const observer = { ...(await w.routerTurn(alice)), role: "observer" } as unknown as Claims;
    assert.equal(await code(mt.memoryRecall(observer, {})), "not_allowed");
    assert.equal(await code(mt.memoryForget(observer, { id: String(id) })), "not_allowed");
    const bobs = await message(bob, `忘掉 #${id}`);
    assert.equal(await code(mt.memoryForget(bobs, { id: String(id) })), "not_found");
    assert.equal((await entries()).length, 1);
  });

  test("I1 an entry about one item is bound to it, shown to that item's worker, and kept out of the chat's catalogue", async () => {
    const general = await stored("alice", "回复用中文");
    const item = await w.createItem(alice, "Review 254");
    const other = await w.createItem(alice, "Fix the build");
    const bobItem = await w.createItem(bob, "Bob's");
    const turn = await message(alice, `#${item.seq} 这个事项的 PR 用 opus 审，记住`);
    assert.equal(await code(mt.memorySave(turn, {
      type: "feedback", title: "这个事项用 opus 审", body: "这个事项的 PR 用 opus 审", evidence_quote: "这个事项的 PR 用 opus 审", item_id: bobItem.itemId,
    })), "item_not_found");
    const saved = await mt.memorySave(turn, {
      type: "feedback", title: "这个事项用 opus 审", body: "这个事项的 PR 用 opus 审", evidence_quote: "这个事项的 PR 用 opus 审", item_id: `#${item.seq}`,
    });
    const bound = Number(saved.id);
    assert.deepEqual((await entries()).map((e) => e.work_item_id), [null, item.itemId]);

    const router = await mt.routerMemoryBlock("alice", alice.routerSid);
    assert.ok(router?.includes(`#${bound} 这个事项用 opus 审 (item #${item.seq})`), router ?? "");
    assert.ok(router?.includes(`#${general} 回复用中文`));
    const worker = await mt.workerMemoryBlock("alice", item.itemId, item.workerSid);
    assert.ok(worker?.includes(`#${bound} 这个事项用 opus 审: 这个事项的 PR 用 opus 审`), worker ?? "");
    assert.ok(worker?.includes(`#${general} 回复用中文`), "and the index");
    const otherWorker = await mt.workerMemoryBlock("alice", other.itemId, other.workerSid);
    assert.ok(otherWorker && !otherWorker.includes(`#${bound}`), "another item's worker is not shown it");
    const chat = await svc.buildMemoryCatalogue("alice");
    assert.ok(chat && !chat.text.includes(`#${bound}`) && chat.text.includes(`#${general}`), chat?.text);

    // Recall reaches no further than what a worker is shown: not another item's entry, by number, search or list.
    const otherTurn = await w.workerTurn(other.itemId);
    assert.equal((await mt.memoryRecall(otherTurn, { id: String(bound) })).ok, false);
    assert.deepEqual(((await mt.memoryRecall(otherTurn, { query: "opus" })).entries as unknown[]).length, 0);
    assert.deepEqual((await mt.memoryRecall(otherTurn, {})).entries, [`#${general} [user] 回复用中文`]);
    await w.closeRun(otherTurn.task_id);
    const ownTurn = await w.workerTurn(item.itemId);
    assert.equal(((await mt.memoryRecall(ownTurn, { id: String(bound) })).entry as { title: string }).title, "这个事项用 opus 审");
    assert.equal(((await mt.memoryRecall(ownTurn, { query: "opus" })).entries as unknown[]).length, 1);
  });

  test("I2 a review item's session is shown what was bound to its item and nothing else", async () => {
    await stored("alice", "回复用中文");
    const reviewSid = randomUUID();
    await w.q(
      `INSERT INTO claw_sessions (session_id, user_id, name, mode, agent_status, config) VALUES ($1, 'alice', 'review', 'claw', 'idle', '{}'::jsonb)`,
      [reviewSid],
    );
    await w.q(
      `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id, kind, params)
       VALUES ('kwi_review_1', 'alice', 50, 'Review AMD-AGI/PrimusClaw#254', 'in_progress', $1, 'review', '{"pr":{"owner":"AMD-AGI","repo":"PrimusClaw","number":254}}'::jsonb)`,
      [reviewSid],
    );
    assert.equal(await mt.reviewMemoryBlock(reviewSid), null, "nothing bound: nothing shown");
    const turn = await message(alice, "#50 重点看安全，记住");
    const saved = await mt.memorySave(turn, { type: "feedback", title: "这次重点看安全", body: "重点看安全", evidence_quote: "重点看安全", item_id: "#50" });
    const block = await mt.reviewMemoryBlock(reviewSid);
    assert.ok(block?.includes(`#${saved.id} 这次重点看安全: 重点看安全`), block ?? "");
    assert.ok(!block?.includes("回复用中文"), "no index");
    await w.q(`UPDATE claw_sessions SET config = config || '{"memory":"off"}'::jsonb WHERE session_id = $1`, [reviewSid]);
    assert.equal(await mt.reviewMemoryBlock(reviewSid), null, "a session marked memory off: nothing");
    await w.q(`UPDATE claw_sessions SET config = config - 'memory' WHERE session_id = $1`, [reviewSid]);
    assert.ok(await mt.reviewMemoryBlock(reviewSid), "unmarked again: shown again");
    await svc.setMemoryPreference("alice", false);
    assert.equal(await mt.reviewMemoryBlock(reviewSid), null, "memory off: nothing");
  });

  /** An item-bound save from the person's message, as the router makes one. */
  async function saveFor(seq: number, title: string, body: string) {
    const turn = await message(alice, `#${seq} ${body}，记住`);
    try {
      return await mt.memorySave(turn, { type: "feedback", title, body, evidence_quote: body, item_id: `#${seq}` });
    } finally {
      await w.closeRun(turn.task_id);
    }
  }

  test("I3a an item-bound save with the same words as a global or another item's entry is stored bound to its item", async () => {
    const general = await stored("alice", "PR 用 opus 审");
    const item = await w.createItem(alice, "Review 254");
    const other = await w.createItem(alice, "Review 255");
    const same = await saveFor(item.seq, "PR 用 opus 审", "PR 用 opus 审");
    assert.equal(same.op, "add", JSON.stringify(same));
    const worker = await mt.workerMemoryBlock("alice", item.itemId, item.workerSid);
    assert.ok(worker?.includes(`#${same.id} PR 用 opus 审: PR 用 opus 审`), worker ?? "");
    const otherSame = await saveFor(other.seq, "PR 用 opus 审", "PR 用 opus 审");
    assert.equal(otherSame.op, "add", JSON.stringify(otherSame));
    assert.deepEqual((await entries()).map((e) => [e.id, e.work_item_id]), [[general, null], [same.id, item.itemId], [otherSame.id, other.itemId]]);
    // Within one binding a duplicate is still a duplicate.
    assert.deepEqual(await saveFor(item.seq, "PR 用 opus 审", "PR 用 opus 审").then((r) => [r.op, r.id]), ["existing", same.id]);
  });

  test("I3b an item-level override close to a global entry is stored for the item, not refused as similar_exists", async () => {
    const general = await stored("alice", "PR 用 opus 审");
    const item = await w.createItem(alice, "Review 256");
    const override = await saveFor(item.seq, "PR 用 opus 审，重点看安全", "PR 用 opus 审，重点看安全");
    assert.equal(override.op, "add", JSON.stringify(override));
    assert.deepEqual((await entries()).map((e) => [e.id, e.work_item_id]), [[general, null], [override.id, item.itemId]]);
    // Within one binding a near one is still refused.
    assert.equal(await code(saveFor(item.seq, "PR 用 opus 审，重点看安全性", "PR 用 opus 审，重点看安全性")), "similar_exists");
  });

  test("I3c a chat save matching only an item's entry is stored, and is in the chat's catalogue", async () => {
    const item = await w.createItem(alice, "Review 257");
    const bound = await saveFor(item.seq, "晨报十点发", "晨报十点发");
    assert.equal(bound.op, "add");
    const chat = await svc.writeMemory("alice", { type: "user", title: "晨报十点发", body: "晨报十点发" }, { kind: "model", sessionId: "chat", quote: "晨报十点发", humanMessages: ["晨报十点发"] });
    assert.ok(chat.ok && chat.op === "add" && chat.id !== bound.id, JSON.stringify(chat));
    const catalogue = await svc.buildMemoryCatalogue("alice");
    assert.ok(catalogue?.text.includes(`#${chat.id} 晨报十点发`), catalogue?.text);
    // And a second chat save of the same words is the chat's duplicate.
    const again = await svc.writeMemory("alice", { type: "user", title: "晨报十点发", body: "晨报十点发" }, { kind: "model", sessionId: "chat", quote: "晨报十点发", humanMessages: ["晨报十点发"] });
    assert.ok(again.ok && again.op === "existing" && again.id === chat.id, JSON.stringify(again));
  });

  test("I4 a worker's search is chosen from what it may read, before the top ten and before anything counts as read", async () => {
    const item = await w.createItem(alice, "Fix the build");
    const other = await w.createItem(alice, "Other");
    // Twelve entries of another item that match the search as well as the general one does, stored first so they lead.
    for (const word of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]) {
      const body = `构建用 ${word}`;
      const r = await svc.writeMemory("alice", { type: "project", title: `构建 ${word}`, body },
        { kind: "model", sessionId: "chat", quote: body, humanMessages: [body] }, { workItemId: other.itemId });
      assert.ok(r.ok, JSON.stringify(r));
    }
    const general = await stored("alice", "构建失败先看日志");
    const turn = await w.workerTurn(item.itemId);
    const found = (await mt.memoryRecall(turn, { query: "构建" })).entries as Array<{ id: number }>;
    assert.deepEqual(found.map((e) => e.id), [general]);
    assert.equal((await mt.memoryRecall(turn, { id: String((await entries())[0].id) })).ok, false);
    const counted = await w.q("SELECT id FROM claw_memory_entries WHERE user_id = 'alice' AND access_count > 0 ORDER BY id");
    assert.deepEqual(counted.map((r: { id: number }) => Number(r.id)), [general], "another item's entries are not counted as read");
  });

  test("I5 an entry bound to an item whose row is gone stays in the router's index", async () => {
    const item = await w.createItem(alice, "Gone soon");
    const turn = await message(alice, `#${item.seq} 用 opus 审，记住`);
    const saved = await mt.memorySave(turn, { type: "feedback", title: "用 opus 审", body: "用 opus 审", evidence_quote: "用 opus 审", item_id: `#${item.seq}` });
    await w.q("DELETE FROM claw_work_item_events WHERE item_id = $1", [item.itemId]);
    await w.q("DELETE FROM claw_work_items WHERE item_id = $1", [item.itemId]);
    const router = await mt.routerMemoryBlock("alice", alice.routerSid);
    assert.ok(router?.includes(`#${saved.id} 用 opus 审 (an item no longer on the board)`), router ?? "");
    const forget = await message(alice, `忘掉 #${saved.id}`);
    assert.deepEqual(await mt.memoryForget(forget, { id: String(saved.id) }), { ok: true, id: saved.id, op: "deleted" });
  });

  test("W1 a router session marked memory off starts workers marked so too: no index, no recall", async () => {
    await stored("alice", "回复用中文");
    await w.q(`UPDATE claw_sessions SET config = config || '{"memory":"off"}'::jsonb WHERE session_id = $1`, [alice.routerSid]);
    const item = await w.createItem(alice, "Fix the build");
    const marked = (await w.q("SELECT config->'memory' AS memory FROM claw_sessions WHERE session_id = $1", [item.workerSid]))[0];
    assert.equal(marked.memory, "off");
    assert.equal(await mt.workerMemoryBlock("alice", item.itemId, item.workerSid), null);
    const turn = await w.workerTurn(item.itemId);
    assert.equal(await code(mt.memoryRecall(turn, {})), "memory_not_here");
    await w.closeRun(turn.task_id);
    // A router session that is the user's own starts workers that are shown the index.
    await w.q(`UPDATE claw_sessions SET config = config - 'memory' WHERE session_id = $1`, [alice.routerSid]);
    const own = await w.createItem(alice, "Another");
    assert.ok((await mt.workerMemoryBlock("alice", own.itemId, own.workerSid))?.includes("回复用中文"));
  });

  test("O1 an assistant's watcher of a group or a repository is not a session the chat's memory serves", async () => {
    await stored("alice", "回复用中文");
    const own = randomUUID();
    const watcher = randomUUID();
    for (const sid of [own, watcher]) {
      await w.q(`INSERT INTO claw_sessions (session_id, user_id, name, mode, agent_status, config) VALUES ($1, 'alice', 'x', 'claw', 'idle', '{}'::jsonb)`, [sid]);
    }
    await w.q("INSERT INTO claw_assistant_scopes (user_id, scope, session_id) VALUES ('alice', 'group:feishu:oc_1', $1)", [watcher]);
    assert.deepEqual(await svc.memoryAccess(own, "alice"), { optedIn: true, serves: true }, "the user's own chat is served");
    assert.deepEqual(await svc.memoryAccess(watcher, "alice"), { optedIn: true, serves: false });
  });

  test("P1 a router turn carries the memory section and index, a worker turn a read-only index", async () => {
    const id = await stored("alice", "回复用中文");
    const turn = await message(alice, "你好");
    const task: Record<string, unknown> = { task_id: turn.task_id, message_id: turn.mid, prompt: "你好" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    const append = String(task.system_append);
    assert.ok(append.includes("memory_forget(id)") && append.includes(`#${id} 回复用中文`), append);
    await svc.setMemoryPreference("alice", false);
    const off: Record<string, unknown> = { task_id: turn.task_id, message_id: turn.mid, prompt: "你好" };
    await w.mod.role.applySessionRoleToTask(off, alice.routerSid);
    assert.ok(String(off.system_append).includes("Long-term memory is turned off"), String(off.system_append));
    assert.ok(!String(off.system_append).includes(`#${id}`));
    await svc.setMemoryPreference("alice", true);

    const item = await w.createItem(alice, "Fix the build");
    const run = await w.openRun(item.workerSid);
    const wtask: Record<string, unknown> = { task_id: run.taskId, message_id: run.messageId, prompt: "go" };
    await w.mod.role.applySessionRoleToTask(wtask, item.workerSid);
    const wappend = String(wtask.system_append);
    assert.ok(wappend.includes("read only") && wappend.includes(`#${id} 回复用中文`), wappend);
    assert.ok(!wappend.includes("memory_forget"), "a worker is not told of the write tools");
  });

  test("T1 over the wire: a router is offered the memory tools, a worker only memory_recall", async () => {
    const connect = async (claims: Claims): Promise<Client> => {
      const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
      const token = w.mod.token.mintAssistantToken(claims as never, TOKEN_KEY);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/assistant-mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    };
    const memoryTools = (names: string[]) => names.filter((n) => n.startsWith("memory_")).sort();
    const id = await stored("alice", "回复用中文");
    const router = await connect(await w.routerTurn(alice));
    try {
      assert.deepEqual(memoryTools((await router.listTools()).tools.map((x) => x.name)), ["memory_forget", "memory_recall", "memory_save", "memory_undo", "memory_update"]);
      const refusal = await router.callTool({ name: "memory_forget", arguments: { id: String(id) } });
      assert.equal(refusal.isError, true);
      assert.equal(JSON.parse((refusal.content as Array<{ text: string }>)[0].text).error, "not_attended");
    } finally {
      await router.close();
    }
    const item = await w.createItem(alice, "Fix the build");
    const worker = await connect(await w.workerTurn(item.itemId));
    try {
      assert.deepEqual(memoryTools((await worker.listTools()).tools.map((x) => x.name)), ["memory_recall"]);
      const read = await worker.callTool({ name: "memory_recall", arguments: { id: String(id) } });
      assert.equal(JSON.parse((read.content as Array<{ text: string }>)[0].text).entry.title, "回复用中文");
    } finally {
      await worker.close();
    }
    assert.equal((await entries()).length, 1);
  });
});
