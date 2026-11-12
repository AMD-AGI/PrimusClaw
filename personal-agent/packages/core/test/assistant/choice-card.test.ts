// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A choice the assistant puts to the person (`choices` of an `assistant.say`): drawn as a card recorded first, and its Send sends
 * what was picked as the person's own next message, through the real router to the real assistant chat, exactly as a typed one.
 *
 *   CC1 the card: recorded with its options, holds short words, no suggested replies under it; a choice that does not fit is no card
 *   CC2 Send in a 1:1 chat: the pick reaches the assistant as the person's message; the card is replaced in place by what was sent,
 *       and the same line is said (a phone does not redraw an edit)
 *   CC3 a second press (a double tap, or after the edit did not show) sends nothing again and shows what was sent
 *   CC4 several picked on a multiple choice: one message, in the card's order, joined in the card's language
 *   CC5 nothing picked, or several on a single choice: nothing is sent, the card comes back open with a note
 *   CC6 a card that is not the presser's, unknown, or a pick the card never offered: nothing is sent
 *   CC7 in a group chat the press is the presser's own message there, to the bot
 *   CC8 a send that threw is never shown as picked: the card comes back open and a press sends it, once; a card a press is still
 *       sending is never sent again
 *   CC9 a message Claw does not take is told as for a typed one, and typing it again sends it
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AssistantWorld } from "../../../../test-support/assistant/assistant-world.js";
import { advanceSeconds } from "../../../../test-support/store.js";
import { AssistantChoiceClicks, pickedOn } from "../../src/assistant/choice-clicks.js";
import { choiceOf } from "../../src/assistant/events.js";
import { ClawError } from "../../src/claw/errors.js";
import { SayPlanner } from "../../src/assistant/say.js";
import { silentLogger } from "../../src/ports/logger.js";
import type { OutMessage } from "../../src/ports/surface.js";
import { ALICE, BOB } from "../routing/fixtures.js";
import { clickOf, link, message, said, world } from "../routing/world.js";

const VERB = "assistant_choice";

function viewOf(message: OutMessage | undefined) {
  const body = message?.body;
  assert.ok(body?.type === "view");
  return body.view;
}

async function choiceWorld() {
  const aw = await AssistantWorld.start();
  const late: { w?: ReturnType<typeof world> } = {};
  /** Sends that fail before the router takes the message (the worker's Claw call threw). */
  const failing = { next: 0 };
  const choices = new AssistantChoiceClicks({
    store: aw.store,
    deliver: (message) => {
      const w = late.w;
      assert.ok(w);
      if (failing.next > 0) {
        failing.next -= 1;
        return Promise.reject(new Error("Claw did not answer"));
      }
      return w.router.handle(message);
    },
    logger: silentLogger,
  });
  const w = world({
    testStore: { store: aw.store, clock: aw.clock, encryptionKeys: [] },
    assistantChat: aw.chat,
    ...(aw.subs ? { subscriptions: aw.subs } : {}),
    handlers: { clicks: [choices] },
  });
  late.w = w;
  const planner = new SayPlanner({
    store: aw.store,
    exactCommand: () => false,
    style: () => ({ citations: true, suggestedReplies: true }),
  });
  /** The card a say with `choices` draws for `userId`: its id, as the button carries it. */
  const card = (choices: unknown, text = "部署到哪个集群？", userId = ALICE.id): string => {
    const out = planner.messages(userId, { type: "assistant.say", text, choices });
    const view = viewOf(out.at(-1));
    assert.ok(view.name === "choiceCard");
    return view.model.cardId;
  };
  const heard = () => aw.claw.heard.map((h) => h.text);
  return { aw, w, planner, card, heard, failing };
}

test("CC1 a choice is a card recorded first, holding short words, with nothing to tap under it; one that does not fit is words", async () => {
  const { aw, planner } = await choiceWorld();
  const out = planner.messages(ALICE.id, {
    type: "assistant.say",
    text: "部署到哪个集群？",
    suggested_replies: ["都部署"],
    choices: { options: ["prod", " staging ", "prod"] },
  });
  assert.equal(out.length, 1, "the card holds the words: they are not said apart");
  const view = viewOf(out[0]);
  assert.ok(view.name === "choiceCard");
  assert.deepEqual(
    [view.model.text, view.model.options, view.model.multiple, view.model.lang],
    ["部署到哪个集群？", ["prod", "staging"], false, "zh"],
  );
  assert.equal(out[0]?.suggestions, undefined, "no suggested replies under a card");
  const recorded = aw.store.assistantButtons.getChoiceCard(view.model.cardId);
  assert.deepEqual(
    [recorded?.userId, recorded?.options, recorded?.multiple, recorded?.state, recorded?.chosen],
    [ALICE.id, ["prod", "staging"], false, "open", []],
  );

  const long = `${"很长的说明。".repeat(400)}选哪个？`;
  const apart = planner.messages(ALICE.id, {
    type: "assistant.say",
    text: long,
    choices: { options: ["a", "b"], multiple: true },
  });
  assert.deepEqual(
    apart.map((m) => m.body.type),
    ["rich", "view"],
    "long words are said, and the card follows with the options alone",
  );
  const card = viewOf(apart[1]);
  assert.ok(card.name === "choiceCard" && card.model.text === "" && card.model.multiple);

  for (const bad of [
    { options: ["only one"] },
    { options: ["a", 3] },
    { options: ["a", "line\nbreak"] },
    { options: ["a", "x".repeat(81)] },
    { options: Array.from({ length: 11 }, (_, i) => `o${String(i)}`) },
    { options: "a,b" },
    ["a", "b"],
    "a",
  ]) {
    const plain = planner.messages(ALICE.id, { type: "assistant.say", text: "选一个？", choices: bad });
    assert.deepEqual(
      plain.map((m) => m.body.type),
      ["rich"],
      `no card for ${JSON.stringify(bad)}`,
    );
    assert.ok(plain[0]?.suggestions?.length, "the words go as before, with the replies under them");
  }
  assert.equal(choiceOf({ type: "work_item.needs_you", choices: { options: ["a", "b"] } }), undefined, "a say's only");
  assert.deepEqual(choiceOf({ type: "assistant.say", choices: { options: ["a", "b"], multiple: "yes" } }), {
    options: ["a", "b"],
    multiple: false,
  });
});

test("CC2 Send in a 1:1 chat: the pick is the person's next message to the assistant, and the card shows what was sent", async () => {
  const { aw, w, card, heard } = await choiceWorld();
  const id = card({ options: ["prod", "staging"] });

  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "1" }));
  await w.router.settled();

  assert.deepEqual(heard(), ["staging"], "the assistant heard it as the person's message");
  assert.equal(aw.claw.heard[0]?.key, "ak-alice", "as the person");
  const updates = w.surface.outbox.filter((r) => r.op === "update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.id, "card-1", "the pressed card is replaced in place");
  const shown = viewOf(updates[0].message);
  assert.ok(shown.name === "choiceChosen");
  assert.deepEqual([shown.model.chosen, shown.model.text, shown.model.lang], [["staging"], "部署到哪个集群？", "zh"]);
  assert.ok(said(w).includes("你选了：staging"), "and said as a line, for a phone");
  const recorded = aw.store.assistantButtons.getChoiceCard(id);
  assert.deepEqual([recorded?.state, recorded?.chosen], ["done", ["staging"]]);
});

test("CC3 a second press sends nothing again and shows what was sent", async () => {
  const { w, card, heard } = await choiceWorld();
  const id = card({ options: ["prod", "staging"] });
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "0" }));
  const lines = said(w).length;

  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "1" }));
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "0" }));
  await w.router.settled();

  assert.deepEqual(heard(), ["prod"], "sent once");
  const updates = w.surface.outbox.filter((r) => r.op === "update");
  assert.equal(updates.length, 3);
  for (const u of updates) {
    const v = viewOf(u.message);
    assert.ok(v.name === "choiceChosen");
    assert.deepEqual(v.model.chosen, ["prod"], "what was sent, not what the later press picked");
  }
  assert.equal(said(w).length, lines + 2, "the later presses only replace the card: no second line");
});

test("CC3b two presses at once: exactly one is sent", async () => {
  const { w, card, heard } = await choiceWorld();
  const id = card({ options: ["prod", "staging"] });
  await Promise.all([
    w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "0" })),
    w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "1" })),
  ]);
  await w.router.settled();
  assert.equal(heard().length, 1);
});

test("CC4 several picked: one message, in the card's order, joined in the card's language", async () => {
  const { w, card, heard } = await choiceWorld();
  const en = card(
    { options: ["AMD-AGI/PrimusClaw", "AMD-AGI/Primus-SaFE", "AMD-AGI/Primus-Turbo"], multiple: true },
    "Which repositories?",
  );
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: en, choice: "2,0" }));
  const zh = card({ options: ["日报", "周报", "月报"], multiple: true }, "要哪些报告？");
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: zh, choice: "0,2,2" }));
  await w.router.settled();
  assert.deepEqual(heard(), ["AMD-AGI/PrimusClaw, AMD-AGI/Primus-Turbo", "日报、月报"]);
  assert.ok(said(w).includes("You picked: AMD-AGI/PrimusClaw, AMD-AGI/Primus-Turbo"));
});

test("CC5 nothing picked, or several on a single choice: nothing is sent and the card comes back open with a note", async () => {
  const { aw, w, card, heard } = await choiceWorld();
  const id = card({ options: ["prod", "staging"] });
  for (const data of [{}, { choice: "" }, { choice: "0,1" }]) {
    await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, ...data }));
  }
  assert.deepEqual(heard(), []);
  const updates = w.surface.outbox.filter((r) => r.op === "update");
  assert.equal(updates.length, 3);
  for (const u of updates) {
    const v = viewOf(u.message);
    assert.ok(v.name === "choiceCard");
    assert.deepEqual(
      [v.model.cardId, v.model.note, v.model.options],
      [id, "请先选一项，再点发送。", ["prod", "staging"]],
    );
  }
  assert.equal(aw.store.assistantButtons.getChoiceCard(id)?.state, "open");
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "0" }));
  assert.deepEqual(heard(), ["prod"], "the card still sends once something is picked");
});

test("CC6 someone else's card, an unknown card, or a pick it never offered: nothing is sent", async () => {
  const { aw, w, card, heard } = await choiceWorld();
  const bobs = card({ options: ["prod", "staging"] }, "部署到哪个集群？", BOB.id);
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: bobs, choice: "0" }));
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: "forged", choice: "0" }));
  const id = card({ options: ["prod", "staging"] });
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "2" }));
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "prod" }));
  await w.router.settled();
  assert.deepEqual(heard(), []);
  assert.equal(aw.store.assistantButtons.getChoiceCard(bobs)?.state, "open", "Bob's card is untouched");
  assert.ok(said(w).includes("这个选择已经失效，请直接在聊天里回复。"));
  assert.deepEqual(pickedOn({ options: ["a", "b", "c"] }, "2, 0,x,-1,9,1.5"), ["a", "c"]);
});

test("CC7 in a group chat the press is the presser's own message there, to the bot", async () => {
  const { w, card } = await choiceWorld();
  link(w, BOB.id, "ak-bob");
  const id = card({ options: ["prod", "staging"] });
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "1" }, { user: BOB, group: true }));
  await w.router.settled();
  const run = w.turns.runs.at(-1);
  assert.ok(run, "the group's turn was started by the press");
  assert.deepEqual([run.userId, run.text, run.group], [BOB.id, "staging", true]);
  assert.ok(said(w).includes("你选了：staging"));
});

test("CC8 a send that threw is given back: never shown as picked, and the next press reaches the assistant exactly once", async () => {
  const { aw, w, card, heard, failing } = await choiceWorld();
  const id = card({ options: ["prod", "staging"] });
  failing.next = 1;
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "1" }));
  assert.deepEqual(heard(), []);
  assert.equal(aw.store.assistantButtons.getChoiceCard(id)?.state, "open", "given back");
  const back = viewOf(w.surface.outbox.filter((r) => r.op === "update").at(-1)?.message);
  assert.ok(back.name === "choiceCard");
  assert.equal(back.model.note, "没有发出去，请再点一次发送。");
  assert.ok(!said(w).some((t) => t.startsWith("你选了")), "never said to be sent");

  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "1" }));
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "1" }));
  await w.router.settled();
  assert.deepEqual(heard(), ["staging"], "sent once");
  assert.equal(aw.store.assistantButtons.getChoiceCard(id)?.state, "done");
});

test("CC8 a card a press is still sending is never sent again, however long it waits: the person is told to reply in the chat", async () => {
  const { aw, w, card, heard } = await choiceWorld();
  const id = card({ options: ["prod", "staging"] });
  // (a press claimed it and its worker stopped before the router took the message)
  assert.ok(aw.store.assistantButtons.claimChoiceCard(id, ["staging"]));
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "0" }));
  advanceSeconds(aw.clock, 3600);
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "0" }));
  await w.router.settled();
  assert.deepEqual(heard(), [], "never a second send that could race the first");
  assert.equal(
    said(w).filter((t) => t === "note::正在发送：staging。如果一直没有回应，请直接在聊天里回复。").length,
    2,
  );
});

test("CC9 Claw refusing the message is told as for a typed one: the person learns it was not delivered and can type it", async () => {
  const { aw, w, card, heard } = await choiceWorld();
  const id = card({ options: ["prod", "staging"] });
  aw.claw.fail.set("send", new ClawError(503, "unavailable"));
  await w.router.handle(clickOf(VERB, { primusclaw: VERB, card: id, choice: "1" }));
  await w.router.settled();
  assert.deepEqual(heard(), []);
  const out = said(w);
  assert.ok(out.includes("你选了：staging"), "the card says what was picked, not that it arrived");
  assert.ok(
    out.some((t) => t.startsWith("I cannot reach your assistant just now") || t.startsWith("暂时连不上你的助理")),
    `the assistant path's own notice for a message Claw did not take: ${out.join(" | ")}`,
  );
  aw.claw.fail.delete("send");
  await w.router.handle(message("staging"));
  await w.router.settled();
  assert.deepEqual(heard(), ["staging"], "typed again, it goes");
});
