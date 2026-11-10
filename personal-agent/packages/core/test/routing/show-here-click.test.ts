// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A press on Show here (Python agent.py `_show`): the session's last answer, read with the presser's own key, posted in the
// chat; the session becomes the chat's; the card is replaced on every outcome.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import { ALICE } from "./fixtures.js";
import { clickOf, link, said, world } from "./world.js";

function shown(sessionId = "s1") {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  const click = clickOf("show", { primusclaw: "show", session_id: sessionId });
  return { w, click };
}

test("test_show_here_posts_the_answer_before_it_replaces_the_card", async () => {
  const { w, click } = shown();
  w.turns.lastAnswers.set("s1", "THE ANSWER");
  await w.router.handle(click);
  const ops = w.surface.outbox.map((r) => r.op);
  assert.ok(said(w).join(" ").includes("THE ANSWER"));
  assert.equal(ops.at(-1), "update");
  assert.equal(ops.filter((op) => op === "update").length, 1);
  assert.equal(said(w).at(-1), "note::The answer is in the chat below. Your next message continues that session.");
  assert.equal(w.store.sessions.getSession(ALICE.id), "s1");
  assert.deepEqual(w.turns.lastAnswerReads, [["ak-alice", "s1"]]);
});

test("test_show_here_sends_the_answer_as_xml", async () => {
  const { w, click } = shown();
  w.turns.lastAnswers.set("s1", "**✅ Done**\n- ✅ **a** ok");
  await w.router.handle(click);
  const answer = w.surface.outbox.find((r) => r.op === "send" && r.message.body.type === "rich");
  const body = answer?.op === "send" ? answer.message.body : undefined;
  assert.ok(body?.type === "rich" && body.markdown.startsWith("Here is the answer.") && body.markdown.includes("✅"));
});

test("a session that is not the presser's is refused, forgotten, and nothing is switched", async () => {
  const { w, click } = shown();
  w.store.repoHistory.noteSession(ALICE.id, "s1");
  w.turns.lastAnswers.set("s1", new ClawError(404));
  await w.router.handle(click);
  assert.equal(said(w).at(-1), "I could not open that session. It may have been deleted, or it is not yours.");
  assert.equal(w.store.sessions.getSession(ALICE.id), null);
  assert.deepEqual(
    w.store.repoHistory.sessionHistory(ALICE.id).map((s) => s.sessionId),
    [],
  );
});

test("what pressing again can help comes back with its button", async () => {
  for (const [answer, text] of [
    [undefined, "That session has no finished answer yet. Press the button again when the run has finished."],
    [
      new ClawError(503),
      "PrimusClaw could not show that session (error 503). Please press the button again in a moment.",
    ],
    [
      new ClawUnreachable("connect", "claw"),
      "I could not reach PrimusClaw. Please press the button again in a moment.",
    ],
  ] as const) {
    const { w, click } = shown();
    w.turns.lastAnswers.set("s1", answer);
    await w.router.handle(click);
    assert.ok(said(w).includes(`note::${text} [Show here]`), said(w).join(" | "));
    assert.equal(w.store.sessions.getSession(ALICE.id), null);
  }
});

test("a press that names no session reads and switches nothing", async () => {
  const empty = shown("");
  await empty.w.router.handle(empty.click);
  assert.equal(said(empty.w).at(-1), "That button is no longer valid.");
  assert.deepEqual(empty.w.turns.lastAnswerReads, []);
});
