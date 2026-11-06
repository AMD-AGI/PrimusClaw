// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the router says never shows the user the assistant's wiring (`say`'s check, `internalTextIn`), and the router is told to name
 * an item by its number and title. Over a real Postgres; skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   G1 a tool name, the [work_event] marker, an item_id and a run id are refused, wherever they are in the text
 *   G2 an id of the UUID form is refused unless the user wrote it in the message the turn answers
 *   G3 through the tool: refused with internal_text and a message that says how to write it, nothing stored; plain words go through
 *   G4 the router's prompt names items "#12 title" and says say refuses internal text
 *   G5 a turn that ends in plain text with internal text in it delivers the system's notice, never the text; clean text is delivered
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const RUN_ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c5d7e9f0a3b";

describe("assistant say guard", { skip }, () => {
  let w: World;
  let tools: typeof import("../src/assistant/tools.js");
  let alice: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld();
    tools = await import("../src/assistant/tools.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions CASCADE");
    alice = await w.user("alice");
  });

  test("G1 a tool name, the marker, an item_id and a run id are refused", () => {
    const cases: Array<[string, string]> = [
      ["我用 mcp__autopilot__get_nodes 查了：12 台", "a tool name (mcp__…)"],
      ["[work_event] #3 ready", "the [work_event] marker"],
      ["已转给 kwi_01M6NWA18KK97H2J1QVWHWVHWJ", "an item_id"],
      ["pass item_id when you reply", "an item_id"],
      ["run ktsk_test_12_ab is done", "a run id"],
      ["已转给 KWI_01M6NWA18KK97H2J1QVWHWVHWJ", "an item_id"],
      ["pass ITEM_ID when you reply", "an item_id"],
      ["run KTSK_TEST_12_AB is done", "a run id"],
    ];
    for (const [text, what] of cases) assert.equal(tools.internalTextIn(text, ""), what, text);
    for (const text of ["#12 修复登录超时 已完成，PR 在 https://github.com/o/r/pull/12", "autopilot 现在有 12 台节点：11 台就绪，1 台已隔离。", "Item #3 is ready."]) {
      assert.equal(tools.internalTextIn(text, ""), null, text);
    }
  });

  test("G2 a UUID is refused unless the user wrote it", async () => {
    assert.equal(tools.internalTextIn(`session ${RUN_ID}`, "how is it going?"), "an internal id");
    assert.equal(tools.internalTextIn(`run ${RUN_ID} 已完成`, `看一下 run ${RUN_ID.toUpperCase()} 的状态`), null, "the user's own id, in any case");
    assert.equal(tools.internalTextIn(`run ${RUN_ID} and ${RUN_ID.replace("3f", "4f")}`, `run ${RUN_ID}`), "an internal id", "one of the user's does not let another through");
    // A worker's report is not the user's words: an id in it does not let the same id through.
    const { userWordsOf } = await import("../src/assistant/internal-text.js");
    assert.equal(tools.internalTextIn(`run ${RUN_ID}`, userWordsOf([`[work_event] #1 (item_id: kwi_x) ready: run ${RUN_ID}`])), "an internal id");
    assert.equal(tools.internalTextIn(`run ${RUN_ID}`, userWordsOf([`看一下 run ${RUN_ID}`])), null);
  });

  test("G3 through the tool: refused and not stored; plain words go through", async () => {
    const turn = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [turn.task_id, `看一下 run ${RUN_ID}`]);
    await assert.rejects(tools.say(turn as never, { text: "已建 kwi_01M6NWA18KK97H2J1QVWHWVHWJ" }, w.sayDeps), (err: any) => {
      assert.equal(err.code, "internal_text");
      assert.match(err.message, /an item_id, which is internal\. Name a work item as its number and title \(#12 修复登录超时\)/);
      return true;
    });
    await assert.rejects(tools.say(turn as never, { text: "mcp__assistant__say" }, w.sayDeps), /internal/);
    assert.equal((await w.q("SELECT count(*)::int AS n FROM claw_assistant_says"))[0].n, 0, "nothing was said");
    const ok = await tools.say(turn as never, { text: `run ${RUN_ID} 已完成，#1 修复构建 也好了。` }, w.sayDeps);
    assert.equal(ok.ok, true);
    assert.equal((await w.q("SELECT count(*)::int AS n FROM claw_assistant_says"))[0].n, 1);
  });

  test("G4 the router is told how to name items and that say refuses internal text", async () => {
    const { ROUTER_PROMPT, ROUTER_PROMPT_VERSION } = await import("../src/assistant/prompts.js");
    assert.equal(ROUTER_PROMPT_VERSION, "router-v7");
    assert.match(ROUTER_PROMPT, /Name a work item to the user by its number and title, as in #12 修复登录超时, never by its item_id\./);
    assert.match(ROUTER_PROMPT, /say refuses a message that does, and you write it again in plain words/);
  });

  test("G5 a turn that ends in plain text with internal text delivers the system's notice, not the text", async () => {
    const ended = async (prompt: string, finalText: string) => {
      const turn = await w.routerTurn(alice);
      await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() WHERE task_id = $1", [turn.task_id, prompt]);
      await w.closeRun(turn.task_id, "completed", undefined, 0);
      return w.mod.routerTurnEnd.deliverUnsaidAnswer(
        { sessionId: alice.routerSid, runIds: [turn.task_id], messageId: turn.mid, failed: false, interrupted: false, finalText } as never, w.sayDeps,
      );
    };
    assert.equal(await ended("帮我看看节点", "我调用了 mcp__autopilot__get_nodes，已建 kwi_01M6NWA18KK97H2J1QVWHWVHWJ"), "said");
    const says = async () => w.q("SELECT text, fallback FROM claw_assistant_says ORDER BY created_at");
    const first = await says();
    assert.equal(first.length, 1);
    assert.ok(!/mcp__|kwi_/.test(first[0].text), first[0].text);
    assert.equal(first[0].fallback, true, "the system's own notice");
    assert.match(first[0].text, /没有处理成功/);
    // Clean words are delivered as they were written.
    await w.q("DELETE FROM claw_assistant_says");
    assert.equal(await ended("how many nodes?", "Autopilot has 12 nodes."), "said");
    assert.deepEqual((await says()).map((r) => [r.text, r.fallback]), [["Autopilot has 12 nodes.", false]]);
  });
});
