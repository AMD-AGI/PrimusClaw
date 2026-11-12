// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_commands_while_attached.py: the menu's words are the bot's in every state of the chat. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RemoteAgentCommand, RemotePrompt } from "../../src/routing/features.js";
import { ALICE } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

function attachedWorld(attached = true) {
  const prompts: RemotePrompt[] = [];
  const agents: RemoteAgentCommand[] = [];
  const listed: string[] = [];
  const w = world({
    remote: {
      enabled: true,
      attached: () => attached,
      prompt: (p) => (prompts.push(p), Promise.resolve()),
      agent: (c) => (agents.push(c), Promise.resolve()),
      agents: () => (listed.push("agents"), Promise.resolve()),
      stop: () => Promise.resolve(attached),
      attachment: () => ({ label: "Codex", host: "dev-pod", cwd: "", cardWindowLine: "" }),
    },
  });
  link(w, ALICE.id, "ak");
  return { w, prompts, agents, listed };
}

test("test_help_without_a_slash_is_the_help_and_not_the_agents_message", async () => {
  const { w, prompts } = attachedWorld();
  await w.router.handle(message("help"));
  assert.deepEqual(prompts, []);
  assert.ok(said(w)[0]?.startsWith("**What Clawy can do for you**"));
});

test("test_help_says_which_agent_the_chat_is_attached_to_and_how_to_leave", async () => {
  const { w } = attachedWorld();
  await w.router.handle(message("/help"));
  assert.ok(said(w)[0]?.includes("This chat is attached to Codex on dev-pod: what you say goes to it."));
  assert.ok(said(w)[0]?.includes('Say "back to Clawy" to come back to me.'));
});

test("test_help_of_a_chat_that_is_not_attached_has_no_note_about_an_agent", async () => {
  const { w } = attachedWorld(false);
  await w.router.handle(message("/help"));
  assert.ok(!said(w)[0]?.includes("This chat is attached to"));
});

test("test_every_menu_word_without_a_slash_is_answered_by_clawy_and_never_reaches_the_agent", async () => {
  const { w, prompts, agents, listed } = attachedWorld();
  for (const word of [
    "help",
    "new",
    "stop",
    "agents",
    "agent sessions",
    "agent detach",
    "whoami",
    "sessions",
    "detach",
  ]) {
    await w.router.handle(message(word));
  }
  assert.deepEqual(prompts, []);
  assert.deepEqual(
    agents.map((a) => a.args),
    ["sessions", "detach", "sessions", "detach"],
  );
  assert.deepEqual(listed, ["agents"]);
});

test("test_unlink_without_a_slash_only_asks_and_deletes_nothing", async () => {
  const { w, prompts } = attachedWorld();
  await w.router.handle(message("unlink"));
  assert.ok(said(w)[0]?.startsWith("`unlink` would disconnect this chat"));
  assert.notEqual(w.store.links.getKey(ALICE.id), null);
  assert.deepEqual(prompts, []);
});

test("test_a_word_after_link_goes_on_to_the_agent_and_to_claw_and_is_not_a_failed_link_attempt", async () => {
  const { w, prompts } = attachedWorld();
  await w.router.handle(message("link database"));
  assert.deepEqual(
    prompts.map((p) => p.prompt),
    ["link database"],
  );
  assert.deepEqual(said(w), []);
});

test("test_a_sentence_that_starts_with_a_menu_word_still_goes_to_the_agent", async () => {
  const { w, prompts } = attachedWorld();
  await w.router.handle(message("help me fix the build"));
  assert.deepEqual(
    prompts.map((p) => p.prompt),
    ["help me fix the build"],
  );
});

test("test_the_slash_forms_of_clawys_commands_are_still_clawys_while_attached", async () => {
  const { w, prompts } = attachedWorld();
  await w.router.handle(message("/whoami"));
  await w.router.handle(message("/timezone"));
  assert.deepEqual(prompts, []);
  assert.equal(said(w).length, 2);
});

test("test_sessions_and_detach_in_a_chat_that_is_not_attached_are_answered_and_not_sent_to_claw", async () => {
  const { w, agents } = attachedWorld(false);
  await w.router.handle(message("sessions"));
  await w.router.handle(message("detach"));
  assert.deepEqual(
    agents.map((a) => a.args),
    ["sessions", "detach"],
  );
  assert.deepEqual(w.turns.calls, []);
});

test("test_a_group_chat_reads_help_and_new_without_a_slash_too", async () => {
  const { w } = attachedWorld(false);
  await w.router.handle(message("help", { kind: "group", conversation: "g-1" }));
  w.store.sessions.setSession(ALICE.id, { sessionId: "s-g" }, "g-1");
  await w.router.handle(message("new", { kind: "group", conversation: "g-1" }));
  assert.ok(said(w)[0]?.startsWith("**What Clawy can do for you**"));
  assert.equal(said(w)[1], "Started a new session. What would you like to do?");
  assert.equal(w.store.sessions.getSession(ALICE.id, "g-1"), null);
});

test("test_in_a_group_chat_the_personal_menu_words_are_not_commands", async () => {
  const { w, agents, listed } = attachedWorld(false);
  await w.router.handle(message("agents", { kind: "group", conversation: "g-1" }));
  await w.router.settled();
  assert.deepEqual(listed, []);
  assert.deepEqual(agents, []);
  assert.deepEqual(w.turns.calls, [["create", "ak", "agents"]]);
});

test("test_in_a_group_chat_the_slash_forms_of_the_personal_commands_are_refused", async () => {
  const { w } = attachedWorld(false);
  await w.router.handle(message("/sessions", { kind: "group", conversation: "g-1" }));
  assert.equal(said(w)[0], "`/sessions` works only in a 1:1 chat. Please do this in a 1:1 chat with me.");
});

test("a pick on the assistant's choice card in an attached chat goes to the agent as words: no menu word or phrase runs", async () => {
  // (a pick is the person's next message, as a typed one that is no command: in a chat attached to an agent, the agent's)
  const { w, prompts, agents, listed } = attachedWorld();
  const words = ["New", "Stop", "Help", "Sessions", "detach", "停止", "重新开始", "回到助理"];
  for (const word of words) await w.router.handle({ ...message(word), choice: true });
  assert.deepEqual(
    prompts.map((p) => p.prompt),
    words,
  );
  assert.deepEqual([agents, listed], [[], []]);
});
