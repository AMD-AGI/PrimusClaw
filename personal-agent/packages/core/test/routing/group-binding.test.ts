// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Ported from teams/tests/test_group_binds_agent_session.py: the router's part of a group bound to an agent session (the
 * binding itself, its status card and its permissions are the remote-agent feature's, W6).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RemoteAgentCommand, RemotePrompt } from "../../src/routing/features.js";
import { ALICE, BOB } from "./fixtures.js";
import { groupAsked, link, message, said, world } from "./world.js";

function bound(window: "card" | "chat" = "chat") {
  const keys = new Set<string>();
  const prompts: RemotePrompt[] = [];
  const agents: RemoteAgentCommand[] = [];
  const stops: string[] = [];
  const w = world({
    remote: {
      enabled: true,
      attached: (key) => keys.has(key),
      prompt: (p) => (prompts.push(p), Promise.resolve()),
      agent: (c) => {
        agents.push(c);
        if (c.args.startsWith("attach")) keys.add(c.chat.id);
        if (c.args === "detach") keys.delete(c.chat.id);
        return Promise.resolve();
      },
      stop: (chat) => (stops.push(chat.id), Promise.resolve(true)),
      windowMode: () => window,
    },
  });
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  groupAsked(w); // (the group was asked its language before: that card is group-language.test.ts's)
  const say = (text: string, user = ALICE) =>
    w.router.handle(message(text, { kind: "group", conversation: "g-1", user }));
  return { w, keys, prompts, agents, stops, say };
}

test("test_switch_in_a_group_binds_it_with_a_status_card_and_the_next_mention_goes_to_the_session", async () => {
  const b = bound();
  await b.say("切到 robin-dev-pod 的 claude");
  await b.say("帮我看看这个报错");
  await b.w.router.settled();
  assert.deepEqual(
    b.agents.map((a) => [a.chat.id, a.args]),
    [["aad-a|g-1", "attach robin-dev-pod/claude"]],
  );
  assert.ok(!b.keys.has(ALICE.id)); // (the person's 1:1 chat is not attached)
  assert.deepEqual(
    b.prompts.map((p) => p.prompt),
    ["帮我看看这个报错"],
  );
  assert.deepEqual(b.w.turns.calls, []); // (nothing went to the group's cloud session)
});

test("test_another_members_mention_never_reaches_the_binding", async () => {
  const b = bound();
  await b.say("切到 robin-dev-pod 的 claude");
  await b.say("帮我看看这个报错", BOB);
  await b.w.router.settled();
  assert.deepEqual(b.prompts, []);
  assert.deepEqual(b.w.turns.calls, [["create", "ak-bob", "帮我看看这个报错"]]);
});

test("test_back_to_the_assistant_in_the_group_unbinds_it", async () => {
  const b = bound();
  await b.say("切到 robin-dev-pod 的 claude");
  await b.say("回到助理");
  await b.say("现在谁来回答");
  await b.w.router.settled();
  assert.ok(!b.keys.has("aad-a|g-1"));
  assert.deepEqual(b.prompts, []);
  assert.deepEqual(b.w.turns.calls, [["create", "ak-alice", "现在谁来回答"]]);
});

test("test_stop_it_in_a_bound_group_cancels_the_sessions_turn", async () => {
  const b = bound();
  await b.say("切到 robin-dev-pod 的 claude");
  await b.say("停掉它");
  assert.deepEqual(b.stops, ["aad-a|g-1"]);
});

test("test_the_other_agent_commands_stay_a_1on1_chats_in_a_group", async () => {
  const b = bound();
  for (const text of ["/agent sessions", "/agent new codex /x", "/agent off"]) await b.say(text);
  assert.deepEqual(b.agents, []);
  assert.equal(said(b.w).length, 3);
  assert.ok(said(b.w).every((t) => t.includes("1:1")));
});

test("test_a_bound_groups_mention_goes_to_the_session_when_the_card_is_the_window", async () => {
  // (the 1:1 card window keeps the chat box for the bot; a group reaches the bot only by @-mention, so it would never reach the session)
  const b = bound("card");
  await b.say("切到 robin-dev-pod 的 claude");
  await b.say("帮我看看这个报错");
  await b.w.router.settled();
  assert.deepEqual(
    b.prompts.map((p) => [p.chat.id, p.prompt]),
    [["aad-a|g-1", "帮我看看这个报错"]],
  );
  assert.deepEqual(b.w.turns.calls, []);
  await b.say("回到助理");
  await b.say("现在谁来回答");
  await b.w.router.settled();
  assert.equal(b.prompts.length, 1);
  assert.deepEqual(b.w.turns.calls, [["create", "ak-alice", "现在谁来回答"]]);
});
