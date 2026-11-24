// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A task the assistant hands to a seat on the person's machine (`seat_dispatch`): the card of one seat (Allow, Deny), the choice
 * card of several places (a button each, and Cancel; what Claw is told was picked is read from the card's record), what came of a
 * press, and what Claw says of such a task afterwards (its number, the seat's name, the hourly line, the parked reminder).
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { openTestStore } from "../../../../test-support/store.js";
import { ClawUnreachable } from "../../src/claw/errors.js";
import { CONFIRM_KINDS, confirmWriteOf, remoteNoticeOf } from "../../src/assistant/events.js";
import { confirmOutcome } from "../../src/assistant/confirm-outcome.js";
import { SayPlanner } from "../../src/assistant/say.js";
import { remoteAskView } from "../../src/remote-view/permission-view.js";
import { ALICE, ActionsWorld, BOB } from "./actions-world.js";

const OPTIONS = [
  { id: "seat-a1", label: "发布台", detail: "~/rel" },
  { id: "seat-b2", label: "mi300/claude", detail: "~/hl-ci" },
  { id: "sandbox", label: "沙箱" },
];

function choiceSay(options: unknown = OPTIONS, kind = "seat_dispatch"): Record<string, unknown> {
  return {
    type: "assistant.say",
    text: "Hyperloom 的两个工位都合适，交给哪里？",
    confirm_write: { confirmation_id: "cf-9", kind, allow_label: "发送", options },
  };
}

it("a seat dispatch is a held write this worker draws", () => {
  assert.ok((CONFIRM_KINDS as readonly string[]).includes("seat_dispatch"));
  const one = confirmWriteOf({
    type: "assistant.say",
    confirm_write: { confirmation_id: "cf-1", kind: "seat_dispatch", allow_label: "发送", later: { x: 1 } },
  });
  assert.deepEqual(one, { confirmationId: "cf-1", kind: "seat_dispatch", allowLabel: "发送" });
});

it("a seat dispatch's places are read whole, each one plain line, and anything else is no card", () => {
  const held = confirmWriteOf(
    choiceSay([...OPTIONS.slice(0, 2), { id: "sandbox", label: "沙箱", detail: 7, more: true }]),
  );
  assert.deepEqual(held?.options, [
    { id: "seat-a1", label: "发布台", detail: "~/rel" },
    { id: "seat-b2", label: "mi300/claude", detail: "~/hl-ci" },
    { id: "sandbox", label: "沙箱", detail: "" },
  ]);
  // A folder that is not one plain line is only left out: it is shown, never sent.
  assert.equal(confirmWriteOf(choiceSay([OPTIONS[0], { ...OPTIONS[1], detail: "a\nb" }]))?.options?.[1]?.detail, "");
  for (const bad of [
    [OPTIONS[0]], // too few
    [...OPTIONS, { id: "s4", label: "4" }, { id: "s5", label: "5" }, { id: "s6", label: "6" }], // too many
    [OPTIONS[0], { id: "seat-a1", label: "again" }], // two alike
    [OPTIONS[0], { id: "", label: "x" }],
    [OPTIONS[0], { id: "has space", label: "x" }],
    [OPTIONS[0], { id: "x".repeat(65), label: "x" }],
    [OPTIONS[0], { id: "s2", label: "two\nlines" }],
    [OPTIONS[0], { id: "s2", label: "x".repeat(41) }],
    [OPTIONS[0], "s2"],
    "seat-a1",
  ]) {
    assert.equal(confirmWriteOf(choiceSay(bad)), undefined, JSON.stringify(bad));
  }
  // Only a seat dispatch offers places: any other held write ignores them.
  assert.equal(confirmWriteOf(choiceSay(OPTIONS, "trigger_create"))?.options, undefined);
});

it("a choice card's words said apart leave it its buttons alone, never the word of its Allow", () => {
  const { store } = openTestStore();
  const say = new SayPlanner({
    store,
    exactCommand: () => false,
    style: () => ({ citations: true, suggestedReplies: true }),
  });
  const out = say.messages(ALICE, { ...choiceSay(), text: "x ".repeat(400) });
  const card = out.at(-1);
  assert.ok(card?.body.type === "view" && card.body.view.name === "confirmWrite");
  assert.equal(card.body.view.model.text, "");
});

it("a choice card is recorded with its places first and shows a button for each", () => {
  const { store } = openTestStore();
  const say = new SayPlanner({
    store,
    exactCommand: () => false,
    style: () => ({ citations: true, suggestedReplies: true }),
  });
  const [card] = say.messages(ALICE, choiceSay());
  assert.ok(card?.body.type === "view" && card.body.view.name === "confirmWrite");
  const model = card.body.view.model;
  assert.equal(model.kind, "seat_dispatch");
  assert.equal(model.text, "Hyperloom 的两个工位都合适，交给哪里？");
  assert.deepEqual(model.options, [
    { label: "发布台", detail: "~/rel" },
    { label: "mi300/claude", detail: "~/hl-ci" },
    { label: "沙箱", detail: "" },
  ]);
  const recorded = store.assistantButtons.getConfirmCard(model.cardId);
  assert.equal(recorded?.confirmationId, "cf-9");
  assert.deepEqual(
    recorded.options.map((o) => o.id),
    ["seat-a1", "seat-b2", "sandbox"],
  );
});

function choiceCard(w: ActionsWorld, user = ALICE): string {
  return w.store.assistantButtons.addConfirmCard(user, "cf-9", "seat_dispatch", "发送", [
    { id: "seat-a1", label: "发布台", detail: "~/rel" },
    { id: "seat-b2", label: "mi300/claude", detail: "~/hl-ci" },
  ]);
}

it("a press on a choice card sends the place its record holds, once, as the person", async () => {
  const w = new ActionsWorld();
  w.held = {
    status: "done",
    answered_now: true,
    result: { item_id: "wi-4", seq: 12, seat_id: "seat-b2", alias: null },
  };
  const card = choiceCard(w);
  await w.confirm(card, "allow", ALICE, { pick: "1" }, "zh");
  assert.deepEqual(w.decided, [["tok-aad-a", "cf-9", "allow"]]);
  assert.deepEqual(w.choices, ["seat-b2"], "the id comes from the record, never from the click");
  assert.equal(w.said(), "已交给 mi300/claude，事项 #12。");
  await w.confirm(card, "allow", ALICE, { pick: "0" }, "zh");
  assert.equal(w.decided.length, 1, "a second press sends nothing");
});

it("a press that names no place on the card sends nothing and Cancel sends no choice", async () => {
  const w = new ActionsWorld();
  const card = choiceCard(w);
  for (const pick of [undefined, "2", "-1", "seat-a1", "1.0", 99, null]) {
    await w.confirm(card, "allow", ALICE, pick === undefined ? {} : { pick });
    assert.equal(w.said(), "That choice is not on this card; nothing was sent.");
  }
  assert.deepEqual(w.decided, []);
  assert.equal(w.store.assistantButtons.getConfirmCard(card)?.state, "open");
  await w.confirm(card, "allow", BOB, { pick: "0" });
  assert.deepEqual(w.decided, [], "someone else's press sends nothing");
  w.held = { status: "denied", answered_now: true, result: null };
  await w.confirm(card, "deny");
  assert.deepEqual(w.decided, [["tok-aad-a", "cf-9", "deny"]]);
  assert.deepEqual(w.choices, [undefined]);
  assert.equal(w.said(), "OK, not sent.");
});

it("a card of one seat sends no choice whatever its button carries", async () => {
  const w = new ActionsWorld();
  w.held = { status: "done", answered_now: true, result: { seq: 3, alias: "发布台", dispatch: "sent" } };
  const card = w.confirmCard("cf-1", "seat_dispatch", "发送");
  await w.confirm(card, "allow", ALICE, { pick: "0" });
  assert.deepEqual(w.choices, [undefined]);
  assert.equal(w.said(), "Sent to 发布台 as #3.");
});

it("a choice card that comes back unanswered keeps its places", async () => {
  const w = new ActionsWorld();
  w.held = new ClawUnreachable("timeout", "a decision");
  const card = choiceCard(w);
  await w.confirm(card, "allow", ALICE, { pick: "0" });
  const back = w.card();
  assert.equal(back.view, "confirmWrite");
  assert.deepEqual(back.model["options"], [
    { label: "发布台", detail: "~/rel" },
    { label: "mi300/claude", detail: "~/hl-ci" },
  ]);
  assert.equal(w.store.assistantButtons.getConfirmCard(card)?.state, "open", "it can be pressed again");
});

it("what came of a seat dispatch is said in one line in the person's language", () => {
  const done = (result: Record<string, unknown>) => ({ status: "done", answered_now: true, result });
  assert.equal(
    confirmOutcome("seat_dispatch", done({ seq: 12, alias: "发布台", dispatch: "sent" }), "zh"),
    "已交给 发布台，事项 #12。",
  );
  assert.equal(
    confirmOutcome(
      "seat_dispatch",
      done({ seq: 12, alias: "发布台", dispatch: "queued", position: 2, ahead: [9, 10] }),
      "zh",
    ),
    "发布台 正忙：#12 排队，空下来再发（第 2 位，前面是 #9, #10）。",
  );
  assert.equal(
    confirmOutcome(
      "seat_dispatch",
      done({ seq: 12, alias: null, dispatch: "queued", queued_reason: "in_terminal", position: 1 }),
      "en",
      "mi300/claude",
    ),
    "mi300/claude is in use in your terminal: #12 waits in line (number 1) and goes out when it is free.",
  );
  assert.equal(confirmOutcome("seat_dispatch", done({}), "en"), "Sent to the seat.");
  assert.equal(
    confirmOutcome("seat_dispatch", done({ seq: 13, to: "sandbox" }), "zh", "沙箱"),
    "已交给 沙箱，事项 #13。",
    "the sandbox picked on a choice card is named as the card named it",
  );
  assert.equal(
    confirmOutcome(
      "seat_dispatch",
      done({ seq: 12, alias: "notes", dispatch: "queued", queued_reason: "machine_offline" }),
      "zh",
    ),
    "notes 所在机器不在线（最多等 24 小时）：#12 排队，空下来再发。",
  );
  assert.equal(confirmOutcome("seat_dispatch", { status: "done", answered_now: false }, "zh"), "这张卡已经处理过了。");
  assert.equal(confirmOutcome("seat_dispatch", { status: "expired" }, "zh"), "这张卡已过期，没有发出。");
  assert.equal(
    confirmOutcome("seat_dispatch", { status: "failed", result: { error: "seat_queue_full" } }, "zh"),
    "这个工位前面已经排了 3 件，没有发出。可以说等一等、改交沙箱或换个工位。",
  );
  assert.equal(
    confirmOutcome("seat_dispatch", { status: "failed", result: { error: "seat_unsupported" } }, "en"),
    "The agent at that seat cannot take tasks yet (its connector needs an update); nothing was sent.",
  );
  assert.equal(
    confirmOutcome("seat_dispatch", { status: "failed", result: { error: "odd" } }, "en"),
    "Not sent (odd).",
  );
});

it("a seat's notice carries its item number, the seat's name, the hourly line and the parked reminder", () => {
  const notice = (remote: Record<string, unknown>) =>
    remoteNoticeOf({
      type: "assistant.say",
      remote: { session_id: "rs-1", machine: "devbox", agent: "claude", ...remote },
    });
  assert.deepEqual(notice({ kind: "progress", item_seq: 12, seat: { seat_id: "s1", alias: "发布台" } }), {
    kind: "progress",
    sessionId: "rs-1",
    ask: undefined,
    machine: "devbox",
    agent: "claude",
    itemSeq: 12,
    seatAlias: "发布台",
  });
  const parked = notice({
    kind: "needs_you",
    ask: { action_id: "a1", parked: true },
    seat: { seat_id: "s1", alias: null },
  });
  assert.equal(parked?.parked, true);
  assert.equal(parked.seatAlias, undefined);
  // Whatever is not of the shape Claw sends is as if absent.
  const odd = notice({ kind: "done", item_seq: "12", seat: { alias: "two\nlines" }, ask: { parked: "yes" }, later: 1 });
  assert.deepEqual([odd?.itemSeq, odd?.seatAlias, odd?.parked], [undefined, undefined, undefined]);
  assert.equal(notice({ kind: "done", item_seq: 1.5 })?.itemSeq, undefined);
  assert.equal(notice({ kind: "later_kind" }), undefined);
});

it("a seat's request names the seat and its reminder says until when it still waits", () => {
  const base = {
    ask: { action_id: "a1", tool: "Bash" },
    options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }],
    sessionId: "rs-1",
    machine: "devbox",
    agent: "Claude Code",
    about: "#12",
    expiresAt: Date.UTC(2026, 10, 25, 8, 30) / 1000,
    zone: "Asia/Shanghai",
  };
  const plain = remoteAskView(base, "zh");
  assert.equal(plain.title, "需要你批准");
  assert.ok(plain.notes[0]?.startsWith("16:30（Asia/Shanghai）前有效"), plain.notes[0] ?? "");
  const seat = remoteAskView({ ...base, seat: "发布台", parked: true }, "zh");
  assert.equal(seat.title, "发布台 需要你批准");
  assert.equal(seat.notes[0], "还在等你批准，最晚到 16:30（Asia/Shanghai）。");
  const en = remoteAskView({ ...base, seat: "release-desk", parked: true }, "en");
  assert.equal(en.title, "release-desk needs your approval");
  assert.equal(en.notes[0], "Still waiting for your approval, until 16:30 (Asia/Shanghai) at the latest.");
});
