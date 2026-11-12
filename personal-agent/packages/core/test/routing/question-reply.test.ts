// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message typed while the agent waits on a question card answers it (`routing/question-reply.ts`). On 11-11 such a message
 * went to Claw as a new one, was queued behind the turn that asked, and ran only after the question timed out (9 min 37 s),
 * with a "Thinking…" stream of its own spinning the whole time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutMessage } from "../../src/ports/surface.js";
import { TYPED_ANSWER_MARGIN_SECONDS } from "../../src/routing/question-reply.js";
import { ALICE, BOB } from "./fixtures.js";
import { link, message, said, world, type World } from "./world.js";

const SESSION = "sess-ak";
const CARD = "card-q7";
const QUESTION = {
  id: "q1",
  question: "明天吃什么？",
  options: [
    { id: "hotpot", label: "火锅" },
    { id: "ramen", label: "拉面" },
  ],
  allow_multiple: false,
};

/** Alice's chat holds SESSION, Claw is running its turn, and that turn's question card waits in the chat. */
function waiting(options: { cardId?: string; expiresIn?: number; questions?: object[] } = {}): World {
  const w = world();
  link(w, ALICE.id, "ak");
  w.store.sessions.setSession(ALICE.id, { sessionId: SESSION });
  w.claw.busy.set(SESSION, true);
  assert.equal(
    w.store.approvals.saveApproval({
      userId: ALICE.id,
      sessionId: SESSION,
      toolUseId: "tu-q",
      tool: "ask_user_question",
      expiresAt: w.store.now() + (options.expiresIn ?? 600),
      envelope: {},
      questions: (options.questions ?? [QUESTION]) as never,
    }),
    true,
  );
  w.store.approvals.approvalSent(SESSION, "tu-q", options.cardId ?? CARD);
  return w;
}

function cardUpdate(w: World): OutMessage | undefined {
  const update = w.surface.outbox.find((r) => r.op === "update" && r.id === CARD);
  return update?.op === "update" ? update.message : undefined;
}

test("a message typed while a question card waits is its answer: sent at once, the card says so, and no turn starts", async () => {
  const w = waiting();
  const started = w.store.now();
  await w.router.handle(message("随便，便宜点就行"));
  await w.router.settled();
  // the answer went to Claw as the card's own free-text answer, at once (no ten-minute queue behind the question)
  assert.deepEqual(w.claw.answers, [["ak", SESSION, "tu-q", { q1: "随便，便宜点就行" }, []]]);
  assert.equal(w.store.now(), started);
  // the question is over: its record is closed, and nothing else waits in the chat
  assert.equal(w.store.approvals.getApproval(SESSION, "tu-q")?.state, "decided");
  assert.equal(w.store.approvals.pendingQuestion(SESSION, ALICE.id), null);
  // no new message for Claw, so no turn of its own and no second "Thinking…"
  assert.deepEqual(w.turns.calls, []);
  assert.equal(w.turns.runs.length, 0);
  assert.equal(w.router.hasPersonalTurn(ALICE.id), false);
  // the card is edited where it is: "已回答：<the answer>"
  const card = cardUpdate(w);
  assert.equal(card?.body.type, "view");
  assert.equal(card.body.view.name, "questionAnswered");
  assert.deepEqual(card.body.view.model, {
    answers: [["q1", "随便，便宜点就行"]],
    when: started,
    zone: "Asia/Shanghai", // (the default zone: Alice set none)
    replied: "zh",
  });
  assert.equal(card.body.fallbackText, "已回答：随便，便宜点就行");
  assert.deepEqual(said(w), ["<view:questionAnswered>"]); // (the edit is all the chat shows)
});

test("a reply that names an option, by its label or its number, answers with that option", async () => {
  for (const [typed, answer] of [
    ["火锅", "火锅"],
    ["2", "拉面"],
  ] as const) {
    const w = waiting();
    await w.router.handle(message(typed));
    assert.deepEqual(w.claw.answers, [["ak", SESSION, "tu-q", { q1: answer }, []]]);
  }
});

test("the answered card speaks the chat's language, not the reply's: 1 or a typed in a Chinese chat leaves it Chinese", async () => {
  const question = { ...QUESTION, options: [...QUESTION.options, { id: "a", label: "a" }] };
  for (const [typed, locale] of [
    ["1", "zh-CN"],
    ["a", "zh-CN"],
    ["1", ""], // no locale and no chosen language: the question's (Chinese), not the digit's
  ] as const) {
    const w = waiting({ questions: [question] });
    await w.router.handle(message(typed, { locale }));
    const card = cardUpdate(w);
    assert.ok(card?.body.type === "view" && card.body.view.name === "questionAnswered", `${typed} ${locale}`);
    assert.equal(card.body.view.model.replied, "zh", `${typed} ${locale}`);
    assert.match(card.body.fallbackText, /^已回答：/, `${typed} ${locale}`);
  }
  // and an English chat stays English whatever is typed
  const w = waiting();
  await w.router.handle(message("火锅", { locale: "en-US" }));
  const card = cardUpdate(w);
  assert.ok(card?.body.type === "view" && card.body.view.name === "questionAnswered");
  assert.equal(card.body.view.model.replied, "en");
});

test("a card whose id the chat never gave is answered all the same, and the answer is said below it", async () => {
  const w = waiting({ cardId: "" });
  await w.router.handle(message("火锅"));
  assert.equal(w.claw.answers.length, 1);
  assert.deepEqual(said(w), ["已回答：火锅"]);
});

test("with nothing waiting, or a question about to run out, the message goes on as a new one", async () => {
  const none = world();
  link(none, ALICE.id, "ak");
  none.store.sessions.setSession(ALICE.id, { sessionId: SESSION });
  await none.router.handle(message("hello"));
  await none.router.settled();
  assert.deepEqual(none.turns.calls, [["send", "ak", SESSION, "hello"]]);
  assert.deepEqual(none.claw.answers, []);

  const late = waiting({ expiresIn: TYPED_ANSWER_MARGIN_SECONDS - 1 });
  await late.router.handle(message("火锅"));
  await late.router.settled();
  assert.deepEqual(late.claw.answers, []);
  assert.deepEqual(late.turns.calls, [["send", "ak", SESSION, "火锅"]]);
});

test("a question whose turn Claw is no longer running is closed, and the message goes on as a new one", async () => {
  const w = waiting();
  w.claw.busy.set(SESSION, false);
  await w.router.handle(message("火锅"));
  await w.router.settled();
  assert.deepEqual(w.claw.answers, []);
  assert.equal(w.store.approvals.getApproval(SESSION, "tu-q")?.state, "expired");
  assert.deepEqual(w.turns.calls, [["send", "ak", SESSION, "火锅"]]);
});

test("an answer Claw refuses as gone closes the question, and the message goes on as a new one", async () => {
  const w = waiting();
  w.claw.answerFails = 404;
  await w.router.handle(message("火锅"));
  await w.router.settled();
  assert.equal(w.store.approvals.getApproval(SESSION, "tu-q")?.state, "expired");
  assert.deepEqual(w.turns.calls, [["send", "ak", SESSION, "火锅"]]);
  assert.equal(cardUpdate(w), undefined);
});

test("an answer that did not reach Claw leaves the card to be answered, and the message goes on as a new one", async () => {
  const w = waiting();
  w.claw.answerFails = 503;
  await w.router.handle(message("火锅"));
  await w.router.settled();
  assert.equal(w.store.approvals.getApproval(SESSION, "tu-q")?.state, "pending");
  assert.deepEqual(w.turns.calls, [["send", "ak", SESSION, "火锅"]]);
});

test("someone else's message never answers a person's question card", async () => {
  const w = waiting();
  link(w, BOB.id, "bk");
  w.store.sessions.setSession(BOB.id, { sessionId: SESSION }); // (even one whose chat holds the same session)
  await w.router.handle(message("火锅", { user: BOB }));
  await w.router.settled();
  assert.deepEqual(w.claw.answers, []);
  assert.equal(w.store.approvals.getApproval(SESSION, "tu-q")?.state, "pending");
});

test("with several questions the whole reply answers each of them", async () => {
  const w = waiting({ questions: [QUESTION, { id: "q2", question: "几点？", options: [] }] });
  await w.router.handle(message("火锅，七点"));
  assert.deepEqual(w.claw.answers, [["ak", SESSION, "tu-q", { q1: "火锅，七点", q2: "火锅，七点" }, []]]);
});

test("in a group chat, the asker's reply that @mentions the bot answers their question card there", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  w.store.sessions.setSession(ALICE.id, { sessionId: "sess-g", shared: true }, "g-1");
  w.claw.busy.set("sess-g", true);
  w.store.approvals.saveApproval({
    userId: ALICE.id,
    sessionId: "sess-g",
    toolUseId: "tu-g",
    tool: "ask_user_question",
    expiresAt: w.store.now() + 600,
    envelope: {},
    questions: [QUESTION] as never,
  });
  w.store.approvals.approvalSent("sess-g", "tu-g", "card-g");
  await w.router.handle(message("火锅", { kind: "group", conversation: "g-1" }));
  await w.router.settled();
  assert.deepEqual(w.claw.answers, [["ak", "sess-g", "tu-g", { q1: "火锅" }, []]]);
  assert.deepEqual(w.turns.calls, []);
  assert.ok(w.surface.outbox.some((r) => r.op === "update" && r.id === "card-g"));
});
