// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_transparency.py: the first messages an unconnected chat gets say answers are AI-generated. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutMessage } from "@primusclaw/personal-agent";

import { AI_NOTICE, dataStatement } from "../../src/locales/transparency.js";
import { ALICE } from "./fixtures.js";
import { groupAsked, link, message, PUBLIC, said, world } from "./world.js";

test("test_help_through_the_worker_in_a_1to1_chat_and_in_a_group", async () => {
  const w = world();
  groupAsked(w); // (the group was asked its language before: that card is group-language.test.ts's)
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/help", { id: "h1" }));
  await w.router.handle(message("你能做什么", { id: "h2" }));
  await w.router.handle(message("what can you do", { id: "h3", kind: "group", conversation: "g-1" }));
  const [en = "", zh = "", group = ""] = said(w).slice(-3);
  // (the world keeps a group's messages but its app is not granted them, as the default: help says @mentions only)
  // (the chat app is the surface's: Teams' name, as the Python worker said it)
  const statement = (lang: string) => dataStatement(lang, false, undefined, "Microsoft Teams");
  assert.ok(en.includes(statement("en")) && zh.includes(statement("zh")) && group.includes(statement("en")));
  assert.ok(group.startsWith("**What Clawy can do for you**") && group.includes("@mention Clawy"));
});

test("test_the_link_steps_an_unconnected_chat_gets_say_answers_are_ai_generated", async () => {
  const w = world();
  await w.router.handle(message("hi"));
  const [text = ""] = said(w);
  assert.ok(text.includes(`${PUBLIC}/primus-claw/teams-link`) && text.trimEnd().endsWith(AI_NOTICE.en));
});

function views(w: ReturnType<typeof world>): OutMessage[] {
  return w.surface.outbox.flatMap((r) => (r.op === "send" && r.message.body.type === "view" ? [r.message] : []));
}

test("test_the_identity_binding_card_says_answers_are_ai_generated", async () => {
  const w = world({ config: { exchangeForChat: true } });
  await w.router.handle(message("hi"));
  const [card] = views(w);
  assert.ok(
    card?.body.type === "view" && card.body.view.name === "binding" && card.body.view.model.notice === AI_NOTICE.en,
  );
});

test("test_the_connect_card_used_when_the_identity_service_does_not_answer_says_it_too", async () => {
  const w = world({ config: { exchangeForChat: true } });
  w.exchange.bindingDown = true;
  await w.router.handle(message("hi"));
  const [card] = views(w);
  assert.ok(
    card?.body.type === "view" && card.body.view.name === "link" && card.body.view.model.notice === AI_NOTICE.en,
  );
});

test("test_the_proactive_message_after_a_group_mention_says_it_too", async () => {
  const w = world({ reachable: [ALICE.id] });
  await w.router.handle(message("review this", { kind: "group", conversation: "g-1" }));
  const dm = w.surface.outbox.find((r) => r.op === "send" && r.conversation === `personal:${ALICE.id}`);
  assert.ok(dm?.op === "send" && dm.message.body.type === "text");
  assert.ok(dm.message.body.text.startsWith("You mentioned me") && dm.message.body.text.includes(AI_NOTICE.en));
});
