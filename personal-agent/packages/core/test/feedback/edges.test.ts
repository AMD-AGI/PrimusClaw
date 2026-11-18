// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The edges of feedback's service, delivery and exchange that the ported tests do not reach. */
import assert from "node:assert/strict";
import test from "node:test";

import { ClawError, lastExchange, type HistoryRow, type JsonObject } from "@primusclaw/personal-agent";

import { USER_A, clickRoute, linkedWorld, makeWorld, nowSeconds, offerOf, resultRow, say, userRow } from "./world.js";

const TURN_TEXT = {
  withoutRule: (text: string) => text.replace(/\n\nRULE.*$/s, ""),
  answerOf: (_id: string, events: readonly { name: string; data: JsonObject }[]) =>
    events
      .map((e) => (e.name === "ResultMessage" && typeof e.data["final_text"] === "string" ? e.data["final_text"] : ""))
      .join(""),
};

test("the last exchange is the turn asked for, else the last; nothing when there is neither question nor answer", () => {
  const rows = [
    userRow("m1", "first\n\nRULE x", 1),
    resultRow("m1", "one", 2),
    userRow("m2", "second", 3),
    resultRow("m2", "two", 4),
  ] as unknown as HistoryRow[]; // (the world's rows are the replay's JSON, which a HistoryRow is read from)
  assert.deepEqual(lastExchange(rows, "m1", TURN_TEXT), { question: "first", answer: "one" });
  assert.deepEqual(lastExchange(rows, "", TURN_TEXT), { question: "second", answer: "two" });
  assert.deepEqual(lastExchange(rows, "gone", TURN_TEXT), { question: "second", answer: "two" });
  assert.equal(lastExchange([], "", TURN_TEXT), undefined);
  const noContent = [
    {
      event_id: "u",
      event_type: "UserMessage",
      data: { message_id: "m3", data: { content: "not a list" } },
      created_at: 5,
    },
  ];
  assert.equal(lastExchange(noContent, "", TURN_TEXT), undefined);
  const imageOnly = [
    { event_id: "u", event_type: "UserMessage", data: { data: { content: [{ type: "image" }, "x"] } }, created_at: 5 },
  ];
  assert.equal(lastExchange(imageOnly, "", TURN_TEXT), undefined);
});

test("whether the session runs is left unknown when Claw does not say, and the report goes", async () => {
  const world = linkedWorld();
  world.claw.sessions.turn = () => Promise.reject(new ClawError(503));
  await say(world, "/feedback x");
  assert.ok(world.issues.issues[0]?.body.includes("- Session state: unknown"));
  assert.ok(world.log.lines.some((l) => l.message === "feedback: whether the session runs was not read"));
});

test("a linked chat with no session yet, and a session without a linked key, say so in the scene", async () => {
  const noSession = makeWorld();
  noSession.store.links.redeemPending(USER_A.id, "Alice", noSession.store.links.stashPending("ak-alice"));
  await say(noSession, "/feedback x");
  assert.ok(noSession.issues.issues[0]?.body.includes("this chat has no PrimusClaw session yet"));
  const noKey = makeWorld();
  noKey.store.sessions.setSession(USER_A.id, { sessionId: "sess-9" });
  await say(noKey, "/feedback y");
  assert.ok(
    noKey.issues.issues[0]?.body.includes(
      "the chat is not linked to a PrimusClaw account, so its session was not read",
    ),
  );
});

test("an offer whose session can no longer be read stays open, and one with nothing to add says so", async () => {
  const world = linkedWorld();
  await say(world, "/feedback x");
  const offer = offerOf(world);
  assert.ok(offer);
  const yes = () =>
    world.flow.clicks.withCredential?.(
      clickRoute(world, { primusclaw: "feedback", offer: offer.offerId, include: true }),
      "ak-alice",
    );
  world.claw.replayError = 500;
  world.claw.owners.set("sess-1", "someone-else");
  await yes();
  assert.equal(world.settled.at(-1)?.options.fallback, "I could not add them just now. Press Yes again in a minute.");
  world.claw.replayError = undefined;
  world.claw.owners.clear();
  world.claw.rows = [resultRow("m1", "", nowSeconds(world))];
  await yes();
  assert.equal(world.settled.at(-1)?.card, "There was no question and answer to add to #1.");
  assert.equal(world.issues.comments.length, 0);
});

test("delivery: a report that is gone is an error, a filed one is said as it was filed, nothing configured files nothing", async () => {
  const world = linkedWorld();
  assert.deepEqual(await world.service.delivery.deliver(99), { kind: "error" });
  await say(world, "/feedback x");
  assert.deepEqual(await world.service.delivery.deliver(1), {
    kind: "filed",
    issue: { number: 1, url: "https://github.test/example-org/example-repo/issues/1" },
  });
  assert.equal(world.service.configured, true);
  const none = linkedWorld({ unconfigured: true });
  assert.equal(none.service.configured, false);
  await say(none, "/feedback y");
  const offerless = linkedWorld({ unconfigured: true });
  assert.equal(offerless.service.makeOffer(USER_A.id, { kind: "filed", sessionId: "s", lastTurnId: "" }), undefined);
});

test("a sink that says it has nowhere to file is the unconfigured answer, and an offer cannot be added without a sink", async () => {
  const world = linkedWorld();
  world.issues.issueFailure = { kind: "sink_not_configured" };
  await say(world, "/feedback x");
  assert.ok(
    world.surface.outbox.some(
      (r) =>
        r.op === "send" &&
        r.message.body.type === "text" &&
        r.message.body.text.startsWith("Feedback is not configured yet"),
    ),
  );
  const unsunk = linkedWorld({ unconfigured: true });
  const offerId = unsunk.store.feedback.addFeedbackOffer(USER_A.id, 7, "sess-1", "m1");
  assert.deepEqual(await unsunk.service.answerOffer(USER_A.id, "ak-alice", offerId, true), ["retry", 7]);
  assert.deepEqual(await unsunk.service.answerOffer(USER_A.id, "ak-alice", offerId, false), ["declined", 7]); // reopened
});
