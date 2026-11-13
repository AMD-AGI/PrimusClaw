// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_group_onboarding.py: a group member who has not connected, and their waiting request. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutMessage, UserRef } from "@primusclaw/personal-agent";

import { advanceSeconds } from "../../../../test-support/store.js";
import { clickOf, link, message, said, world, type World } from "./world.js";

const ZED: UserRef = { id: "aad-z", channelUserId: "29:zed-teams", name: "Zed", email: "" };
const YARA: UserRef = { id: "aad-y", channelUserId: "29:yara", name: "Yara", email: "" };
const ASK = "review https://github.com/o/r/pull/9";
const DAY = 24 * 3600;

async function mention(
  w: World,
  text = ASK,
  options: { user?: UserRef; id?: string; conv?: string } = {},
): Promise<void> {
  const m = message(text, {
    kind: "group",
    user: options.user ?? ZED,
    conversation: options.conv ?? "g-1",
    ...(options.id ? { id: options.id } : {}),
  });
  await w.router.handle(m);
}

function sentTo(w: World, conversation: string): OutMessage[] {
  return w.surface.outbox.flatMap((r) => (r.op === "send" && r.conversation === conversation ? [r.message] : []));
}

function cards(w: World, conversation = "g-1") {
  return sentTo(w, conversation).flatMap((m) =>
    m.body.type === "view" && m.body.view.name === "onboarding" ? [m.body.view.model] : [],
  );
}

function texts(w: World, conversation: string): string[] {
  return sentTo(w, conversation).flatMap((m) => (m.body.type === "text" ? [m.body.text] : []));
}

test("test_an_unlinked_mention_gets_a_card_for_them_and_a_one_to_one_message", async () => {
  const w = world({ reachable: [ZED.id] });
  await mention(w);
  const [card] = cards(w);
  assert.ok(card !== undefined && card.channelUserId === "29:zed-teams" && card.name === "Zed" && card.dmSent);
  assert.ok(!JSON.stringify(card).includes("pull/9")); // (nothing the asker wrote)
  const [dm = ""] = texts(w, "personal:aad-z");
  assert.ok(
    dm.startsWith(
      "You mentioned me in a group chat. To use PrimusClaw Assistant, connect your PrimusClaw account first.",
    ),
  );
  assert.ok(
    dm.includes("\nhttps://claw.example.com/primus-claw/teams-link\n") &&
      dm.includes("`/link CODE`") &&
      !dm.includes("pull/9"),
  );
  assert.deepEqual(w.turns.calls, []); // (no credential, no Claw call)
});

test("test_the_card_goes_out_in_the_group_even_when_the_conversation_cannot_be_created", async () => {
  const w = world();
  await mention(w);
  assert.deepEqual(texts(w, "personal:aad-z"), []);
  assert.equal(cards(w)[0]?.dmSent, false);
  await mention(w, "again", { conv: "g-2" }); // (the day's message was not used up: the next chat tries again)
  assert.equal(cards(w, "g-2")[0]?.dmSent, false);
});

test("test_a_command_is_not_kept_to_run_after_the_link", async () => {
  const w = world();
  await mention(w, "/new");
  assert.equal(w.store.onboarding.takePendingRequest(ZED.id), null);
});

test("test_only_the_person_the_card_is_for_can_press_it", async () => {
  const w = world({ reachable: [ZED.id, YARA.id] });
  await mention(w);
  const promptId = cards(w)[0]?.promptId ?? "";
  w.surface.outbox.length = 0;
  link(w, YARA.id, "ak-yara");
  await w.router.handle(
    clickOf("onboard", { primusclaw: "onboard", prompt: promptId, aad_id: ZED.id }, { user: YARA, group: true }),
  );
  const update = w.surface.outbox.find((r) => r.op === "update");
  assert.ok(
    update?.op === "update" && update.message.body.type === "view" && update.message.body.view.name === "onboarding",
  );
  assert.equal(update.message.body.view.model.note, "Only Zed can use this button.");
  assert.equal(update.message.body.view.model.channelUserId, "29:zed-teams"); // (still Zed's card)
  assert.deepEqual(said(w).slice(1), ["Only Zed can use this button."]);
  assert.notEqual(w.store.onboarding.takePendingRequest(ZED.id), null); // (Zed's request is untouched)
});

test("a press whose 1:1 chat cannot be opened puts the way to connect in the card", async () => {
  const w = world();
  await mention(w); // (the proactive message failed: the card is the only help)
  const promptId = cards(w)[0]?.promptId ?? "";
  w.surface.outbox.length = 0;
  await w.router.handle(clickOf("onboard", { prompt: promptId }, { user: ZED, group: true }));
  // the 1:1 chat still cannot be opened here: the card comes back with the way to connect in it
  const update = w.surface.outbox.find((r) => r.op === "update");
  assert.ok(
    update?.op === "update" && update.message.body.type === "view" && update.message.body.view.name === "onboarding",
  );
  assert.ok(update.message.body.view.model.note.startsWith("I could not message you directly."));
});

test("test_pressing_the_button_is_the_persons_own_request_and_is_not_held_to_the_daily_message", async () => {
  const w = world({ reachable: [ZED.id] });
  await mention(w);
  const promptId = cards(w)[0]?.promptId ?? "";
  await w.router.handle(clickOf("onboard", { prompt: promptId }, { user: ZED, group: true }));
  assert.equal(texts(w, "personal:aad-z").length, 2);
  const update = w.surface.outbox.find((r) => r.op === "update");
  assert.ok(update?.op === "update" && update.message.body.type === "text");
  assert.ok(update.message.body.text.includes("I sent you the steps in a 1:1 chat with PrimusClaw Assistant."));
});

test("test_a_press_after_a_day_is_not_active", async () => {
  const w = world({ reachable: [ZED.id] });
  await mention(w);
  const promptId = cards(w)[0]?.promptId ?? "";
  advanceSeconds(w.clock, DAY + 1);
  await w.router.handle(clickOf("onboard", { prompt: promptId }, { user: ZED, group: true }));
  assert.ok(said(w).includes("note::This button is no longer active. Mention me again to get a new one."));
});

test("test_a_second_mention_in_the_same_chat_within_a_day_posts_nothing", async () => {
  const w = world({ reachable: [ZED.id] });
  await mention(w, "first", { id: "g1" });
  const sent = w.surface.outbox.length;
  for (const n of [0, 1, 2]) await mention(w, `again ${String(n)}`, { id: `g${String(n + 2)}` });
  assert.equal(w.surface.outbox.length, sent);
  assert.equal(w.store.onboarding.takePendingRequest(ZED.id)?.text, "again 2"); // (the newest request waits)
});

test("test_after_a_day_the_card_and_the_message_come_again", async () => {
  const w = world({ reachable: [ZED.id] });
  await mention(w, ASK, { id: "g1" });
  advanceSeconds(w.clock, DAY + 1);
  await mention(w, ASK, { id: "g2" });
  assert.equal(cards(w).length, 2);
  assert.equal(texts(w, "personal:aad-z").length, 2);
});

test("test_a_second_chat_gets_its_own_card_but_not_a_second_message", async () => {
  const w = world({ reachable: [ZED.id] });
  await mention(w, ASK, { id: "g1", conv: "g-1" });
  await mention(w, ASK, { id: "g2", conv: "g-2" });
  assert.equal(cards(w, "g-1").length + cards(w, "g-2").length, 2);
  assert.equal(texts(w, "personal:aad-z").length, 1);
  assert.equal(cards(w, "g-2")[0]?.dmSent, true); // (they have the steps already)
});

test("test_another_person_in_the_same_chat_gets_their_own", async () => {
  const w = world({ reachable: [ZED.id, YARA.id] });
  await mention(w, ASK, { id: "g1" });
  await mention(w, ASK, { user: YARA, id: "g2" });
  assert.deepEqual(new Set(cards(w).map((c) => c.name)), new Set(["Zed", "Yara"]));
});

test("test_the_request_runs_in_the_group_when_they_connect_within_15_minutes", async () => {
  const w = world();
  w.turns.answers = ["THE ANSWER"];
  await mention(w);
  advanceSeconds(w.clock, 15 * 60 - 1);
  await w.router.handle(message(`/link ${w.store.links.stashPending("ak-zed")}`, { user: ZED }));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [["create", "ak-zed", ASK]]);
  assert.equal(w.store.sessions.getSession(ZED.id, "g-1"), "sess-ak-zed");
  const group = texts(w, "g-1");
  assert.equal(group[0], "Zed connected PrimusClaw Assistant, so I am running their earlier request now.");
  assert.ok(group.includes("THE ANSWER"));
  const [first = ""] = texts(w, "dm-aad-z");
  assert.ok(first.startsWith("Connected.") && first.includes("I am running your request from the group chat now"));
  assert.equal(w.store.onboarding.takePendingRequest(ZED.id), null); // (once)
});

test("test_a_request_older_than_15_minutes_is_not_run_and_the_link_is_just_confirmed", async () => {
  const w = world();
  await mention(w);
  advanceSeconds(w.clock, 15 * 60 + 1);
  await w.router.handle(message(`/link ${w.store.links.stashPending("ak-zed")}`, { user: ZED }));
  assert.deepEqual(w.turns.calls, []);
  const [text = ""] = texts(w, "dm-aad-z");
  assert.ok(
    text.startsWith("Connected.") && !text.includes("running") && text.includes("Send me a message to get started"),
  );
});

test("test_a_failed_link_does_not_run_the_request", async () => {
  const w = world();
  await mention(w);
  await w.router.handle(message("/link WRONG222", { user: ZED }));
  assert.deepEqual(w.turns.calls, []);
  assert.notEqual(w.store.onboarding.takePendingRequest(ZED.id), null);
});

test("test_pressing_the_button_after_connecting_elsewhere_runs_the_request", async () => {
  const w = world();
  await mention(w);
  const promptId = cards(w)[0]?.promptId ?? "";
  link(w, ZED.id, "ak-zed");
  await w.router.handle(clickOf("onboard", { prompt: promptId }, { user: ZED, group: true }));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [["create", "ak-zed", ASK]]);
  assert.ok(said(w).includes("note::You are connected. Running your request now."));
});

test("test_a_linked_member_is_unchanged", async () => {
  const w = world();
  link(w, ZED.id, "ak-zed");
  await mention(w);
  await w.router.settled();
  assert.deepEqual(cards(w), []);
  assert.deepEqual(w.turns.calls, [["create", "ak-zed", ASK]]);
});

test("test_a_private_message_in_a_group_is_not_answered_in_the_group_and_the_sender_is_pointed_to_the_1_1_chat", async () => {
  const w = world({ reachable: [ZED.id] });
  await w.router.handle({
    ...message("secret question", { kind: "group", user: ZED }),
    mentioned: false,
    targeted: true,
  });
  assert.deepEqual(sentTo(w, "g-1"), []);
  const [line = ""] = texts(w, "personal:aad-z");
  assert.ok(line.startsWith("You sent me a private message in a group chat.") && !line.includes("secret question"));
});

test("test_a_private_message_in_a_group_whose_1_1_chat_cannot_open_posts_nothing", async () => {
  const w = world();
  await w.router.handle({ ...message("secret", { kind: "group", user: ZED }), mentioned: false, targeted: true });
  assert.deepEqual(w.surface.outbox, []);
});
