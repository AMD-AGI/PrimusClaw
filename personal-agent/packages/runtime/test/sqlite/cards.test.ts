// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Approvals, observed groups and the assistant's cards: a press is judged from the stored row, and of two presses on
// one card exactly one is carried out.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPROVAL_TTL_SECONDS,
  ASSISTANT_CARD_KEEP_SECONDS,
  ASSISTANT_MESSAGE_KEEP_SECONDS,
  CONFIRM_CARD_KEEP_SECONDS,
} from "@primusclaw/personal-agent";

import { advanceSeconds, openFileTestStore, openTestStore } from "../../../../test-support/index.js";

const approval = (
  toolUseId: string,
  expiresAt: number,
  envelope: { [k: string]: string } | null = { card: toolUseId },
) => ({
  userId: "aad-a",
  sessionId: "s1",
  toolUseId,
  tool: "Bash",
  expiresAt,
  envelope,
});

test("one approval is one card: recorded once, in flight until sent, taken back if never shown", () => {
  const { store } = openTestStore();
  const approvals = store.approvals;
  const at = store.now() + 600;
  assert.equal(approvals.saveApproval(approval("t1", at)), true);
  assert.equal(approvals.saveApproval(approval("t1", at)), false);
  assert.equal(approvals.approvalInFlight("s1", "t1"), true);
  assert.deepEqual(approvals.claimUnsentApprovals(), []); // being sent by this process
  approvals.approvalSent("s1", "t1");
  assert.equal(approvals.approvalInFlight("s1", "t1"), false);
  assert.deepEqual(approvals.getApproval("s1", "t1"), {
    sessionId: "s1",
    toolUseId: "t1",
    userId: "aad-a",
    tool: "Bash",
    expiresAt: at,
    state: "pending",
  });
  assert.equal(approvals.saveApproval(approval("t2", at)), true);
  approvals.forgetApproval("s1", "t2");
  assert.equal(approvals.getApproval("s1", "t2"), null);
  assert.equal(approvals.saveApproval(approval("t2", at)), true);
  assert.equal(approvals.getApproval("s9", "t9"), null);
});

test("a question card waits with its questions and its card's id until it is answered, runs out or is closed", () => {
  const { store, clock } = openTestStore();
  const approvals = store.approvals;
  const at = store.now() + 600;
  const questions = [{ id: "q1", question: "Which?", options: [{ id: "a", label: "A" }], allow_multiple: false }];
  const question = (toolUseId: string, withQuestions = true) => ({
    ...approval(toolUseId, at),
    tool: "ask_user_question",
    ...(withQuestions ? { questions } : {}),
  });
  approvals.saveApproval(question("q-old"));
  approvals.approvalSent("s1", "q-old", "card-old");
  advanceSeconds(clock, 1);
  approvals.saveApproval(question("q-new"));
  assert.equal(approvals.pendingQuestion("s1", "aad-a")?.toolUseId, "q-old"); // (the newer is not in the chat yet)
  approvals.approvalSent("s1", "q-new", "card-new");
  approvals.saveApproval(approval("t-bash", at)); // an approval is not a question
  approvals.approvalSent("s1", "t-bash", "card-bash");
  assert.deepEqual(approvals.pendingQuestion("s1", "aad-a"), {
    sessionId: "s1",
    toolUseId: "q-new",
    userId: "aad-a",
    expiresAt: at,
    questions,
    cardId: "card-new",
  });
  assert.equal(approvals.pendingQuestion("s1", "aad-b"), null); // someone else's
  assert.equal(approvals.pendingQuestion("s2", "aad-a"), null);
  assert.equal(approvals.closeApproval("s1", "q-new", "decided"), true);
  assert.equal(approvals.pendingQuestion("s1", "aad-a")?.toolUseId, "q-old");
  advanceSeconds(clock, 600);
  assert.equal(approvals.pendingQuestion("s1", "aad-a"), null); // ran out
  // one recorded without its questions (a work item's, pushed) is not answered from a typed message
  const fresh = openTestStore().store.approvals;
  fresh.saveApproval(question("q-bare", false));
  fresh.approvalSent("s1", "q-bare", "card");
  assert.equal(fresh.pendingQuestion("s1", "aad-a"), null);
});

test("a click closes an approval once; a closed one is not taken back", () => {
  const { store } = openTestStore();
  const approvals = store.approvals;
  approvals.saveApproval(approval("t1", store.now() + 600, null));
  assert.equal(approvals.closeApproval("s1", "t1", "approved"), true);
  assert.equal(approvals.closeApproval("s1", "t1", "denied"), false);
  approvals.forgetApproval("s1", "t1");
  assert.equal(approvals.getApproval("s1", "t1")?.state, "approved");
  assert.equal(approvals.closeApproval("s1", "t1", "expired", { onlyIfPending: false }), true);
  assert.equal(approvals.getApproval("s1", "t1")?.state, "expired");
});

test("cards a dead worker recorded and never sent are sent by the next; those out of time are closed", () => {
  const f = openFileTestStore();
  try {
    const now = f.store.now();
    f.store.approvals.saveApproval(approval("live", now + 600));
    f.store.approvals.saveApproval(approval("late", now + 5));
    f.store.approvals.saveApproval(approval("bad", now + 600));
    f.raw.prepare("UPDATE approvals SET card_json = 'not json' WHERE tool_use_id = 'bad'").run();
    advanceSeconds(f.clock, 10);
    const next = f.reopen();
    const claimed = next.approvals.claimUnsentApprovals();
    assert.deepEqual(claimed, [
      { sessionId: "s1", toolUseId: "live", userId: "aad-a", expiresAt: now + 600, envelope: { card: "live" } },
    ]);
    assert.deepEqual(next.approvals.claimUnsentApprovals(), []); // in flight now
    assert.equal(next.approvals.getApproval("s1", "late")?.state, "expired");
    assert.equal(next.approvals.getApproval("s1", "bad")?.state, "expired");
    next.approvals.approvalSendFailed("s1", "live");
    assert.equal(next.approvals.claimUnsentApprovals().length, 1);
    next.approvals.approvalSent("s1", "live");
    next.approvals.approvalSendFailed("s1", "live");
    assert.deepEqual(next.approvals.claimUnsentApprovals(), []);
  } finally {
    f.close();
  }
});

test("an approval row is kept a week after it expired", () => {
  const { store, clock } = openTestStore();
  store.approvals.saveApproval(approval("old", store.now() + 1));
  advanceSeconds(clock, APPROVAL_TTL_SECONDS + 2);
  store.approvals.saveApproval(approval("new", store.now() + 1));
  assert.equal(store.approvals.getApproval("s1", "old"), null);
  assert.notEqual(store.approvals.getApproval("s1", "new"), null);
});

test("observing a group: one observer, the last to turn it on; off keeps the row for /board", () => {
  const { store, clock } = openTestStore();
  const observe = store.observe;
  observe.observeGroup("g1", { userId: "aad-a", scope: "g1", reference: { r: 1 }, name: "x".repeat(250) });
  advanceSeconds(clock, 1);
  observe.observeGroup("g2", { userId: "aad-a", scope: "g2", reference: { r: 2 } });
  assert.deepEqual(observe.groupObserver("g1"), { userId: "aad-a", scope: "g1" });
  assert.equal(observe.observedBy("aad-a")[1]?.name.length, 200);
  observe.observeGroup("g1", { userId: "aad-b", scope: "g1", reference: { r: 3 } });
  assert.deepEqual(observe.groupObserver("g1"), { userId: "aad-b", scope: "g1" });
  assert.equal(observe.unobserveGroup("g1"), "aad-b");
  assert.equal(observe.unobserveGroup("g1"), null);
  assert.equal(observe.groupObserver("g1"), null);
  assert.deepEqual(observe.observedReference("g1"), { r: 3 });
  assert.equal(observe.observedReference("g9"), null);
  assert.deepEqual(observe.observedBy("aad-a"), [{ conversationId: "g2", scope: "g2", name: "", on: true }]);
  assert.deepEqual(observe.observedBy("aad-b"), [{ conversationId: "g1", scope: "g1", name: "", on: false }]);
});

test("a suggestion is carried out at most once, over every card of it", () => {
  const { store, clock } = openTestStore();
  const observe = store.observe;
  const card = { userId: "aad-a", conversationId: "g1", runId: "r1", seq: 1, tool: "t", args: "{}", message: "m" };
  const a = observe.addObserveCard(card);
  const b = observe.addObserveCard(card);
  assert.notEqual(a, b);
  assert.deepEqual(observe.getObserveCard(a), { cardId: a, ...card, state: "open" });
  assert.equal(observe.getObserveCard("none"), null);
  assert.equal(observe.moveObserveCard(a, "busy", "open"), true);
  assert.equal(observe.moveObserveCard(b, "busy", "open"), false); // the same suggestion is in hand
  assert.equal(observe.moveObserveCard(a, "busy", "open"), false);
  assert.equal(observe.observeSuggestionSettled("aad-a", "r1", 1), false);
  assert.equal(observe.moveObserveCard(a, "accepted"), true);
  assert.equal(observe.observeSuggestionSettled("aad-a", "r1", 1), true);
  assert.equal(observe.moveObserveCard(b, "dismissed", "open"), true);
  assert.equal(observe.moveObserveCard("none", "x"), false);
  advanceSeconds(clock, ASSISTANT_CARD_KEEP_SECONDS + 1);
  const c = observe.addObserveCard({ ...card, seq: 2 });
  assert.equal(observe.getObserveCard(a)?.state, "accepted"); // a settled card stays
  assert.notEqual(observe.getObserveCard(c), null);
  store.links.unlink("aad-a");
  assert.equal(observe.getObserveCard(c), null);
});

test("a work-item card: one press wins, an ended card answers from the store, a placed card can be edited", () => {
  const { store, clock } = openTestStore();
  const cards = store.assistantCards;
  const id = cards.addAssistantCard("aad-a", "item-1", 3, true);
  assert.deepEqual(cards.getAssistantCard(id), {
    cardId: id,
    userId: "aad-a",
    itemId: "item-1",
    version: 3,
    canAccept: true,
    state: "open",
    createdAt: store.now(),
    ended: "",
  });
  assert.equal(cards.getAssistantCard("none"), null);
  cards.placeAssistantCard(id, { activityId: "act-1", reference: { conv: "c" }, render: { title: "t" } });
  const other = cards.addAssistantCard("aad-a", "item-2", 1, false);
  cards.placeAssistantCard(other, { activityId: "act-2", reference: { conv: "d" }, render: {} });
  cards.addAssistantCard("aad-a", "item-3", 1, false); // never posted
  assert.deepEqual(
    cards.placedAssistantCards({ itemId: "item-1" }).map((c) => [c.cardId, c.activityId, c.reference, c.render]),
    [[id, "act-1", { conv: "c" }, { title: "t" }]],
  );
  assert.equal(cards.placedAssistantCards({}).length, 2);
  assert.equal(cards.placedAssistantCards({ since: store.now() + 1 }).length, 0);
  assert.equal(cards.moveAssistantCard(id, "busy", { onlyFrom: "open" }), true);
  assert.equal(cards.moveAssistantCard(id, "busy", { onlyFrom: "open" }), false);
  assert.equal(cards.endAssistantCard(id, "merged"), false); // being pressed: the press says the outcome
  assert.equal(cards.endAssistantCard(other, "closed"), true);
  assert.deepEqual([cards.getAssistantCard(other)?.state, cards.getAssistantCard(other)?.ended], ["ended", "closed"]);
  assert.equal(cards.moveAssistantCard(id, "done"), true);
  assert.equal(cards.placedAssistantCards({}).length, 0);
  advanceSeconds(clock, ASSISTANT_CARD_KEEP_SECONDS + 1);
  cards.addAssistantCard("aad-a", "item-4", 1, false);
  assert.equal(cards.getAssistantCard(id), null);
});

test("a placed card whose stored reference or render is not an object is left out", () => {
  const f = openFileTestStore();
  try {
    const cards = f.store.assistantCards;
    const id = cards.addAssistantCard("aad-a", "item-1", 1, false);
    cards.placeAssistantCard(id, { activityId: "act-1", reference: { c: 1 }, render: {} });
    f.raw.prepare("UPDATE assistant_cards SET render_json = '' WHERE card_id = ?").run(id);
    assert.equal(cards.placedAssistantCards({ itemId: "item-1" }).length, 1); // '' reads as {}
    f.raw.prepare("UPDATE assistant_cards SET reference_json = '[1]' WHERE card_id = ?").run(id);
    assert.equal(cards.placedAssistantCards({ itemId: "item-1" }).length, 0);
    f.raw.prepare("UPDATE assistant_cards SET reference_json = '{', render_json = '{}' WHERE card_id = ?").run(id);
    assert.equal(cards.placedAssistantCards({ itemId: "item-1" }).length, 0);
  } finally {
    f.close();
  }
});

test("automatic replies: on, read, off, forgotten after the card's keep time", () => {
  const { store, clock } = openTestStore();
  const cards = store.assistantCards;
  assert.equal(cards.autoReply("aad-a", "i1"), null);
  cards.setAutoReply("aad-a", "i1", "o/r#1");
  assert.equal(cards.autoReply("aad-a", "i1"), "o/r#1");
  cards.clearAutoReply("aad-a", "i1");
  assert.equal(cards.autoReply("aad-a", "i1"), null);
  cards.setAutoReply("aad-a", "i1", "o/r#1");
  advanceSeconds(clock, ASSISTANT_CARD_KEEP_SECONDS + 1);
  cards.setAutoReply("aad-a", "i2", "o/r#2");
  assert.equal(cards.autoReply("aad-a", "i1"), null);
});

test("action and confirm buttons live as long as their message or confirmation, and one press wins", () => {
  const { store, clock } = openTestStore();
  const buttons = store.assistantButtons;
  const action = buttons.addActionCard("aad-a", "m1", "remind", "tomorrow");
  const confirm = buttons.addConfirmCard("aad-a", "conf-1", "trigger_create", "Create");
  const bare = buttons.addConfirmCard("aad-a", "conf-2", "trigger_cancel");
  assert.deepEqual(buttons.getActionCard(action), {
    cardId: action,
    userId: "aad-a",
    channelMessageId: "m1",
    name: "remind",
    args: "tomorrow",
    state: "open",
    createdAt: store.now(),
  });
  assert.deepEqual(buttons.getConfirmCard(confirm), {
    cardId: confirm,
    userId: "aad-a",
    confirmationId: "conf-1",
    kind: "trigger_create",
    label: "Create",
    state: "open",
    createdAt: store.now(),
  });
  assert.equal(buttons.getConfirmCard(bare)?.label, "");
  assert.equal(buttons.moveActionCard(action, "busy", { onlyFrom: "open" }), true);
  assert.equal(buttons.moveActionCard(action, "busy", { onlyFrom: "open" }), false);
  assert.equal(buttons.moveConfirmCard(confirm, "busy", { onlyFrom: "open" }), true);
  assert.equal(buttons.moveConfirmCard(confirm, "done", { onlyFrom: null }), true);
  advanceSeconds(clock, ASSISTANT_MESSAGE_KEEP_SECONDS + 1);
  assert.equal(buttons.getActionCard(action), null);
  assert.notEqual(buttons.getConfirmCard(confirm), null);
  advanceSeconds(clock, CONFIRM_CARD_KEEP_SECONDS - ASSISTANT_MESSAGE_KEEP_SECONDS);
  assert.equal(buttons.getConfirmCard(confirm), null);
  buttons.addActionCard("aad-a", "m2", "x", "");
  buttons.addConfirmCard("aad-a", "conf-3", "devenv_send");
  store.links.unlink("aad-a");
  assert.equal(buttons.moveActionCard(action, "done"), false);
});

test("a choice card keeps its options for a day, is sent once with what was picked, and goes with the person's link", () => {
  const { store, clock } = openTestStore();
  const buttons = store.assistantButtons;
  const card = buttons.addChoiceCard("aad-a", {
    text: "哪个？",
    options: ["prod", "staging"],
    multiple: true,
    lang: "zh",
  });
  assert.deepEqual(buttons.getChoiceCard(card), {
    cardId: card,
    userId: "aad-a",
    text: "哪个？",
    options: ["prod", "staging"],
    multiple: true,
    chosen: [],
    lang: "zh",
    state: "open",
    createdAt: store.now(),
  });
  assert.equal(buttons.chooseChoiceCard(card, ["staging"]), true);
  assert.equal(buttons.chooseChoiceCard(card, ["prod"]), false, "of two presses exactly one is sent");
  assert.deepEqual([buttons.getChoiceCard(card)?.state, buttons.getChoiceCard(card)?.chosen], ["done", ["staging"]]);
  const single = buttons.addChoiceCard("aad-a", { text: "", options: ["a", "b"], multiple: false, lang: "" });
  assert.equal(buttons.getChoiceCard(single)?.multiple, false);
  assert.equal(buttons.chooseChoiceCard("forged", ["a"]), false);
  advanceSeconds(clock, ASSISTANT_MESSAGE_KEEP_SECONDS + 1);
  assert.equal(buttons.getChoiceCard(card), null);
  const kept = buttons.addChoiceCard("aad-a", { text: "", options: ["a", "b"], multiple: false, lang: "" });
  store.links.unlink("aad-a");
  assert.equal(buttons.getChoiceCard(kept), null, "unlinking clears the person's cards");
});

test("an assistant message is known for a day: whose it was, its actions and the people it named", () => {
  const { store, clock } = openTestStore();
  const messages = store.assistantMessages;
  assert.equal(messages.assistantMessage("m1"), null);
  assert.deepEqual(messages.assistantMessagePeople("m1"), new Set());
  messages.noteAssistantMessage("m1", "aad-a", ["remind", "review"], ["u-1", "u-2"]);
  messages.noteAssistantMessage("m2", "aad-a", []);
  assert.deepEqual(messages.assistantMessage("m1"), { userId: "aad-a", actions: new Set(["remind", "review"]) });
  assert.deepEqual(messages.assistantMessagePeople("m1"), new Set(["u-1", "u-2"]));
  assert.deepEqual(messages.assistantMessagePeople("m2"), new Set());
  advanceSeconds(clock, ASSISTANT_MESSAGE_KEEP_SECONDS + 1);
  assert.equal(messages.assistantMessage("m1"), null);
  assert.deepEqual(messages.assistantMessagePeople("m1"), new Set());
  messages.noteAssistantMessage("m3", "aad-b", ["x"]);
  assert.notEqual(messages.assistantMessage("m3"), null);
});
