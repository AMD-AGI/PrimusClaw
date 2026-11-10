// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The router's account check before a remote button, linking without the slash, and a session sentence in an attached chat
// going to the assistant (test_remote_menu.py, test_remote_follow.py, test_remote_nl_control.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { UserRef } from "@primusclaw/personal-agent";

import type { AssistantRouteRequest, UnderstandRequest } from "../../../src/routing/features.js";
import { ALICE as CLAW_ALICE, Script, USER_B } from "../../../../../test-support/remote-world.js";
import { clickOf, said } from "../world.js";
import { routed, TWO_AGENTS } from "./remote-routed.js";

type Json = Record<string, unknown>;

/** The action of a card whose title is `title`, anywhere in the card. */
function actionTitled(node: unknown, title: string): Json | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = actionTitled(item, title);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const json = node as Json;
  if (json["title"] === title && typeof json["verb"] === "string") return json;
  for (const value of Object.values(json)) {
    const found = actionTitled(value, title);
    if (found) return found;
  }
  return undefined;
}

test("test_a_user_who_is_not_connected_or_in_a_group_gets_no_remote_buttons", () =>
  routed(async (w) => {
    w.rw.server.addConnector(CLAW_ALICE, "dev-pod", TWO_AGENTS);
    await w.say("/agents");
    const tap = actionTitled(w.rw.cards().at(-1), "New session");
    assert.ok(tap, JSON.stringify(w.rw.cards().at(-1)));
    const zed: UserRef = { id: "aad-z", channelUserId: "29:z", name: "Zed", email: "" };
    const before = w.rw.server.commands.length;
    await w.r.router.handle(clickOf(String(tap["verb"]), (tap["data"] ?? {}) as Json, { user: zed }));
    await w.rw.idle();
    assert.ok(said(w.r).join(" ").includes("not connected to a PrimusClaw account"), said(w.r).join("\n"));
    assert.deepEqual(w.rw.server.commands.slice(before), []);
  }));

test("test_link_with_a_code_and_no_slash_links_the_chat", () =>
  routed(async (w) => {
    w.r.store.links.unlink(USER_B.id);
    let code = w.r.store.links.stashPending("ak-bob");
    // (lower-case letters alone read as a word, `link database`, by design; a code with a digit is a code)
    while (/^[A-Za-z]+$/u.test(code)) code = w.r.store.links.stashPending("ak-bob");
    await w.say(`link ${code.toLowerCase()}`, { user: USER_B });
    const last = said(w.r).at(-1) ?? "";
    assert.ok(last.startsWith("Connected"), last);
    assert.equal(w.r.store.links.getKey(USER_B.id), "ak-bob");
  }));

/** Alice's chat attached to the claude session of a machine with two, her assistant on; what reaches it is recorded. */
async function attachedWithAssistant(w: Parameters<Parameters<typeof routed>[0]>[0]): Promise<string> {
  const cid = w.rw.server.addConnector(CLAW_ALICE, "robin-dev-pod", TWO_AGENTS);
  const claude = w.rw.server.addSession(CLAW_ALICE, cid, "claude", { cwd: "/home/me/work" });
  const codex = w.rw.server.addSession(CLAW_ALICE, cid, "codex", { cwd: "/home/me/other" });
  for (const sid of [claude, codex]) await w.rw.server.started(sid);
  const script = new Script();
  script.onPrompt = async (srv, sid) => {
    await srv.say(sid, "Done.");
    await srv.end(sid);
  };
  w.rw.server.onCommand = script.hook;
  await w.say("切到 robin-dev-pod 的 claude");
  assert.equal(w.attachedSession(), claude);
  return claude;
}

const SENTENCES = ["切到昨天那个会话", "新开一个会话在 ~/repo 里看看", "switch to yesterday's session", "新开一个会话"];

test("test_attached_a_session_sentence_goes_to_the_assistant_and_nothing_to_the_agent", () => {
  const routedTexts: string[] = [];
  const route = (r: AssistantRouteRequest) => (routedTexts.push(r.prompt), Promise.resolve(true));
  return routed(
    async (w) => {
      const claude = await attachedWithAssistant(w);
      for (const text of SENTENCES) await w.say(text);
      // ("新开一个会话" alone is the assistant's /new when the chat is not attached; attached, it is a new agent session.)
      assert.deepEqual(routedTexts, SENTENCES);
      assert.deepEqual(w.rw.server.commandsOf("prompt"), [], "nothing was sent to the agent");
      assert.equal(w.attachedSession(), claude, "the chat stays where it is until the person presses the switch");
      await w.say("切到 main 分支"); // (anything else still goes to the agent)
      await w.say("新建一个会话管理器类");
      assert.deepEqual(
        w.rw.server.commandsOf("prompt").map((c) => c.body["text"]),
        ["切到 main 分支", "新建一个会话管理器类"],
      );
      assert.deepEqual(routedTexts, SENTENCES);
    },
    // (the assistant's own limit is off, as the Python test's `_assistant_over_limit`: four messages are not four tasks here)
    { assistant: { on: () => true, reachable: () => true, route }, limits: { maxConcurrentTasks: 100 } },
  );
});

test("test_attached_a_session_sentence_of_a_person_the_assistant_understands_goes_as_their_own_messages_do", () => {
  const routedTexts: string[] = [];
  const understood: string[] = [];
  const route = (r: AssistantRouteRequest) => (routedTexts.push(r.prompt), Promise.resolve(true));
  const understand = (r: UnderstandRequest) => (understood.push(r.prompt), Promise.resolve(true));
  return routed(
    async (w) => {
      await attachedWithAssistant(w);
      await w.say("切到昨天那个会话");
      assert.deepEqual(understood, ["切到昨天那个会话"]);
      assert.deepEqual(routedTexts, []);
      assert.deepEqual(w.rw.server.commandsOf("prompt"), []);
      await w.say("切到 main 分支"); // (anything else still goes to the agent)
      assert.deepEqual(understood, ["切到昨天那个会话"]);
      assert.deepEqual(
        w.rw.server.commandsOf("prompt").map((c) => c.body["text"]),
        ["切到 main 分支"],
      );
    },
    {
      assistant: { on: () => true, reachable: () => true, understands: () => true, route, understand },
      limits: { maxConcurrentTasks: 100 },
    },
  );
});
