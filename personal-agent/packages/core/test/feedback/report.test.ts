// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of the Python worker's tests/test_feedback.py: the issue, conversation content, masking, the question. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ANSWER_MARK,
  CONV,
  ERROR_TEXT_MARK,
  QUESTION_MARK,
  SECRET,
  USER_A,
  USER_B,
  advance,
  clickRoute,
  errorRow,
  link,
  linkedWorld,
  makeWorld,
  nowSeconds,
  offerOf,
  resultRow,
  say,
  storedReports,
  texts,
  userRow,
  type World,
} from "./world.js";

const PEM_BLOCK = "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADAN\n-----END " + "PRIVATE KEY-----";

async function answer(world: World, offerId: string, include: boolean, user = USER_A): Promise<void> {
  await world.flow.clicks.withCredential?.(
    clickRoute(world, { primusclaw: "feedback", offer: offerId, include }, user),
    world.store.links.getKey(user.id) ?? "",
  );
}

function everything(world: World): string {
  return storedReports(world) + world.issues.everything();
}

test("issue has the title label and a readable body with the scene", async () => {
  const world = linkedWorld();
  await say(world, "/feedback the card froze");
  const [issue] = world.issues.issues;
  assert.ok(issue);
  assert.equal(issue.title, "[PrimusClaw Assistant feedback] the card froze — Alice");
  assert.deepEqual(issue.labels, ["clawy-feedback"]);
  const body = issue.body;
  assert.ok(
    body.startsWith(
      "Reported by **Alice**\n\nReported from Teams through PrimusClaw Assistant.\n\n### What went wrong\n\n",
    ),
  );
  assert.ok(body.includes("```\nthe card froze\n```"));
  assert.ok(body.includes("- Reporter: `Alice` (SaFE user `u-1`)"));
  assert.ok(body.includes("- Chat: 1:1") && body.includes("- Plugin id: `2`"));
  assert.ok(body.includes("image tag `abc1234`") && body.includes("Claw api image tag: `unknown`"));
  assert.ok(
    body.includes("- `m1`: finished, 30.0 s, 1 tool error(s); tools: `bash`, `mcp__board__list`; errors: none"),
  );
  assert.ok(body.includes("[sess-1](https://claw.example.com/primus-claw/sess-1)"));
  assert.equal(
    texts(world).at(-2),
    "Thanks. I filed your report as issue [#1](https://github.test/example-org/example-repo/issues/1). " +
      "The PrimusClaw team will look at it.",
  );
});

test("no conversation content is recorded unless the user says yes", async () => {
  const world = linkedWorld();
  await say(world, "/feedback it broke");
  assert.ok(!everything(world).includes(QUESTION_MARK) && !everything(world).includes(ANSWER_MARK));
  const offer = offerOf(world);
  assert.ok(offer);
  assert.equal(offer.issueNumber, 1);
  await answer(world, offer.offerId, false);
  assert.deepEqual(world.issues.comments, []);
  assert.equal(world.settled.at(-1)?.card, "OK. Nothing else was added to #1.");
  await answer(world, offer.offerId, true); // the choice was made: a later tap cannot reverse it
  assert.deepEqual(world.issues.comments, []);
  assert.equal(world.settled.at(-1)?.card, "That choice is no longer active.");
});

test("yes adds the last question and answer with secrets hidden", async () => {
  const world = linkedWorld();
  const now = nowSeconds(world);
  world.claw.rows[0] = userRow("m1", `${QUESTION_MARK} my token is ${SECRET}`, now - 120);
  world.claw.rows[world.claw.rows.length - 1] = resultRow("m1", `${ANSWER_MARK} ${PEM_BLOCK}`, now - 90);
  await say(world, "/feedback it broke");
  const offer = offerOf(world);
  assert.ok(offer);
  await answer(world, offer.offerId, true);
  assert.equal(world.issues.comments.length, 1);
  const [number, comment] = world.issues.comments[0] ?? [0, ""];
  assert.equal(number, 1);
  assert.ok(comment.includes(QUESTION_MARK) && comment.includes(ANSWER_MARK));
  assert.ok(!comment.includes(SECRET) && !comment.includes("MIIEvQIBADAN") && comment.includes("[hidden]"));
  assert.equal(
    world.settled.at(-1)?.card,
    "Added your last question and my answer to #1. Passwords and keys were hidden.",
  );
  await answer(world, offer.offerId, true); // a second tap does not add it twice
  assert.equal(world.issues.comments.length, 1);
});

test("the offer cannot be answered by someone else or after it expires", async () => {
  const world = linkedWorld();
  link(world, USER_B, "ak-bob");
  await say(world, "/feedback it broke");
  const offer = offerOf(world);
  assert.ok(offer);
  await answer(world, offer.offerId, true, USER_B);
  assert.deepEqual(world.issues.comments, []);
  assert.equal(world.settled.at(-1)?.card, "That choice is no longer active.");
  advance(world, 1801);
  await answer(world, offer.offerId, true);
  assert.deepEqual(world.issues.comments, []);
  await answer(world, "forged-id", true);
  assert.deepEqual(world.issues.comments, []);
});

test("a failed add keeps the choice open so yes can be pressed again", async () => {
  const world = linkedWorld();
  await say(world, "/feedback it broke");
  const offer = offerOf(world);
  assert.ok(offer);
  world.issues.commentStatus = 502;
  await answer(world, offer.offerId, true);
  assert.deepEqual(world.issues.comments, []);
  const last = world.settled.at(-1);
  assert.equal(last?.options.fallback, "I could not add them just now. Press Yes again in a minute.");
  assert.ok(last);
  const card = last.card;
  assert.ok(typeof card !== "string" && card.body.type === "view");
  assert.deepEqual(card.body.view, {
    name: "feedbackOfferRetry",
    model: {
      offerId: offer.offerId,
      issueNumber: 1,
      note: "I could not add them just now. Press Yes again in a minute.",
    },
  });
  world.issues.commentStatus = undefined;
  await answer(world, offer.offerId, true);
  assert.equal(world.issues.comments.length, 1);
});

test("there is no offer in a group or without a session", async () => {
  const world = linkedWorld();
  world.store.sessions.setSession(USER_A.id, { sessionId: "sess-g" }, CONV);
  await say(world, "/feedback group problem", USER_A, CONV);
  assert.equal(world.issues.issues.length, 1);
  assert.ok(world.issues.issues[0]?.body.includes("Chat: group"));
  assert.equal(offerOf(world), undefined);
  const fresh = makeWorld();
  link(fresh, USER_B, "ak-bob");
  await say(fresh, "/feedback nothing yet", USER_B);
  assert.equal(fresh.issues.issues.length, 1);
  assert.equal(offerOf(fresh), undefined);
});

test("a credential in the feedback text is masked everywhere", async () => {
  const world = linkedWorld();
  await say(world, `/feedback my token ${SECRET} was rejected`);
  assert.ok(!everything(world).includes(SECRET));
  assert.ok(world.issues.issues[0]?.body.includes("[hidden]"));
  assert.ok(!world.issues.issues[0]?.title.includes(SECRET));
});

test("nothing the scene reads can carry a message body or an error text (end to end)", async () => {
  const world = linkedWorld();
  const now = nowSeconds(world);
  world.claw.rows.push(userRow("m2", "second", now - 50), errorRow("m2", now - 40));
  await say(world, "/feedback broke");
  const body = world.issues.issues[0]?.body ?? "";
  assert.ok(!body.includes(ERROR_TEXT_MARK) && !body.includes(QUESTION_MARK) && !body.includes(ANSWER_MARK));
  assert.ok(body.includes("error code=rate_limited"));
});

test("a bare feedback asks one question and the next message is the report", async () => {
  const world = linkedWorld();
  assert.equal(await say(world, "/feedback"), true);
  assert.equal(texts(world).at(-1), "What went wrong?");
  assert.equal(world.issues.issues.length, 0);
  assert.equal(await say(world, "the answer was cut off"), true);
  assert.equal(world.issues.issues[0]?.title, "[PrimusClaw Assistant feedback] the answer was cut off — Alice");
  assert.equal(await say(world, "just chatting"), false); // answered once: this goes on as a message
});

test("the question expires and another command cancels it", async () => {
  const world = linkedWorld();
  await say(world, "/feedback");
  advance(world, 601);
  assert.equal(await say(world, "late words"), false);
  assert.deepEqual(world.issues.issues, []);
  const other = linkedWorld();
  await say(other, "/feedback");
  assert.equal(await say(other, "/whoami"), false);
  assert.equal(await say(other, "words after another command"), false);
  assert.deepEqual(other.issues.issues, []);
});

test("an unlinked user can report and the scene says so", async () => {
  const world = makeWorld();
  await say(world, "/feedback I cannot link my account");
  const body = world.issues.issues[0]?.body ?? "";
  assert.ok(body.includes("SaFE user unknown (chat not linked)") && body.includes("no PrimusClaw session yet"));
  assert.ok(texts(world).at(-1)?.startsWith("Thanks. I filed your report"));
});

test("in a group an unlinked member can report and the reply is in the group", async () => {
  const world = makeWorld();
  await say(world, "/feedback it never answers me", USER_A, CONV);
  assert.ok(world.issues.issues[0]?.body.includes("Chat: group"));
  const last = world.surface.outbox.at(-1);
  assert.equal(last?.conversation, CONV);
  assert.ok(texts(world).at(-1)?.startsWith("Thanks. I filed"));
});

test("the group reply goes through the group conversation and the scene is the sender's own", async () => {
  const world = linkedWorld();
  world.store.sessions.setSession(USER_A.id, { sessionId: "sess-group" }, CONV);
  await say(world, `/feedback my key ${SECRET}`, USER_A, CONV);
  assert.ok(!everything(world).includes(SECRET));
  const body = world.issues.issues[0]?.body ?? "";
  assert.ok(body.includes("sess-group") && !body.includes("sess-1"));
});
