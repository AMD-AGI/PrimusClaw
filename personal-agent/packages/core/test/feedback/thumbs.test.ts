// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of tests/test_feedback_votes.py, tests/test_mobile_thumbs.py and the thumbs of tests/test_feedback_discoverable.py. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { THUMB_COMMENT_MAX, voteMessageId, type InboundVote, type RouteBase } from "@primusclaw/personal-agent";

import { CONV, SECRET, USER_A, clickRoute, linkedWorld, makeWorld, offerOf, texts, type World } from "./world.js";

function route(world: World, scope = ""): RouteBase {
  const click = clickRoute(world, { primusclaw: "thumb" }, USER_A, scope);
  return { sender: click.sender, conversation: click.conversation, scope, lang: () => click.lang() };
}

function vote(world: World, reaction: "like" | "dislike", comment: string, scope = "", messageId = "teams-7"): void {
  const base = route(world, scope);
  const event: InboundVote = {
    type: "vote",
    id: "v1",
    sender: USER_A,
    conversation: base.conversation.ref,
    locale: "",
    clientPlatform: "Windows",
    messageId,
    reaction,
    comment,
  };
  world.thumbs.onVote(base, event);
}

async function tap(world: World, reaction: string, scope = ""): Promise<void> {
  await world.thumbs.clicks.beforeCredential?.(
    clickRoute(world, { primusclaw: "thumb", reaction }, USER_A, scope, "card-5"),
  );
}

async function sendComment(world: World, comment: unknown, skip = false, scope = ""): Promise<void> {
  const data = comment === undefined ? { primusclaw: "thumb_note", skip } : { primusclaw: "thumb_note", skip, comment };
  await world.thumbs.clicks.beforeCredential?.(clickRoute(world, data as never, USER_A, scope, "card-5"));
}

test("teams own thumb is a vote on that answer of the chats session", async () => {
  for (const [reaction, way] of [
    ["like", "up"],
    ["dislike", "down"],
  ] as const) {
    const world = linkedWorld();
    vote(world, reaction, "it ignored my question", "", "1730880000123");
    await world.thumbs.settled();
    assert.deepEqual(world.claw.votes, [["ak-alice", "sess-1", "teams:1730880000123", way, "it ignored my question"]]);
  }
});

test("a thumb without words is a vote without a reason", async () => {
  const world = linkedWorld();
  vote(world, "like", "");
  await world.thumbs.settled();
  assert.deepEqual(world.claw.votes, [["ak-alice", "sess-1", "teams:teams-7", "up", undefined]]);
});

test("a thumb in a group is a vote on the groups session with the comment masked", async () => {
  const world = linkedWorld();
  world.store.sessions.setSession(USER_A.id, { sessionId: "sess-g" }, CONV);
  vote(world, "dislike", `wrong, and my token is ${SECRET}`, CONV);
  await world.thumbs.settled();
  const [only] = world.claw.votes;
  assert.ok(only);
  assert.deepEqual(only.slice(0, 4), ["ak-alice", "sess-g", "teams:teams-7", "down"]);
  assert.ok(!only[4]?.includes(SECRET) && only[4]?.startsWith("wrong, and my token is"));
});

test("in a chat that talks to the assistant the vote is on the assistants session", async () => {
  const world = linkedWorld({ assistantOn: true });
  vote(world, "like", "", "", "say-1");
  await world.thumbs.settled();
  assert.ok(world.claw.calls.includes("assistant_session ak-alice"));
  assert.deepEqual(world.claw.votes, [["ak-alice", "sess-assistant", "teams:say-1", "up", undefined]]);
});

test("clawys own thumbs on mobile vote and the comment replaces the vote", async () => {
  const world = linkedWorld();
  await tap(world, "dislike");
  await sendComment(world, "it answered another question");
  await world.thumbs.settled();
  assert.deepEqual(world.claw.votes.slice(0, 2), [
    ["ak-alice", "sess-1", "teams:card-5", "down", undefined],
    ["ak-alice", "sess-1", "teams:card-5", "down", "it answered another question"],
  ]);
  await tap(world, "like");
  await world.thumbs.settled();
  assert.deepEqual(world.claw.votes.at(-1), ["ak-alice", "sess-1", "teams:card-5", "up", undefined]);
});

test("skip on the comment card does not vote again", async () => {
  const world = linkedWorld();
  await tap(world, "dislike");
  await sendComment(world, "typed", true);
  await world.thumbs.settled();
  assert.equal(world.claw.votes.length, 1);
});

test("a vote that cannot be recorded is logged and the report still goes", async () => {
  const cases: readonly (readonly [string, string])[] = [
    ["unlinked", "not linked"],
    ["no session", "no session"],
    ["no message", "no message to vote on"],
    ["refused", "refused (404)"],
  ];
  for (const [setup, outcome] of cases) {
    const world = setup === "unlinked" ? makeWorld() : linkedWorld();
    if (setup === "no session") world.store.sessions.clearSession(USER_A.id);
    if (setup === "refused") world.claw.voteRefusal = 404;
    vote(world, "dislike", "bad", "", setup === "no message" ? "" : "teams-7");
    await world.thumbs.settled();
    const line = world.log.lines.find((l) => l.message === "feedback vote");
    assert.deepEqual(line?.fields, { reaction: "dislike", chat: "1:1", outcome }, setup);
    assert.equal(world.issues.issues.length, 1, setup); // the report is filed whatever happened to the vote
    assert.ok(!texts(world).some((t) => t.toLowerCase().includes("vote")), setup);
  }
});

test("the message a thumb is stored under", () => {
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
  const cases: readonly (readonly [string, string | undefined])[] = [
    ["1730880000123", "teams:1730880000123"],
    ["f:6f1e-x_y.z@thread", "teams:f:6f1e-x_y.z@thread"],
    ["1:abc/def ghi", `teams:${sha("1:abc/def ghi").slice(0, 40)}`], // Claw would refuse "/" and " "
    ["x".repeat(120), `teams:${sha("x".repeat(120)).slice(0, 40)}`], // and more than 100 characters
    ["", undefined],
    ["  ", undefined],
  ];
  for (const [replyTo, expected] of cases) {
    const got = voteMessageId(sha, replyTo);
    assert.equal(got, expected, replyTo);
    if (got !== undefined) assert.match(got, /^[A-Za-z0-9._:@-]{1,100}$/);
  }
});

test("a thumbs down files the same issue by either thumbs", async () => {
  for (const chat of ["1:1", "group"]) {
    for (const via of ["teams", "card"]) {
      const world = linkedWorld();
      world.store.sessions.setSession(USER_A.id, { sessionId: "sess-g" }, CONV);
      const scope = chat === "group" ? CONV : "";
      if (via === "teams") vote(world, "dislike", "it ignored my question", scope);
      else await sendComment(world, "it ignored my question", false, scope);
      await world.thumbs.settled();
      const [issue] = world.issues.issues;
      assert.ok(issue, `${chat} ${via}`);
      assert.ok(issue.title.startsWith("[Clawy feedback] (thumbs down) it ignored my question"), `${chat} ${via}`);
      assert.ok(issue.body.includes(`Chat: ${chat}`) && issue.body.includes(chat === "1:1" ? "sess-1" : "sess-g"));
      const reply = world.surface.outbox.find(
        (r) => r.op === "send" && r.message.body.type === "text" && r.message.body.text.startsWith("Thanks. I filed"),
      );
      assert.equal(reply?.conversation, chat === "1:1" ? "conv-aad-a" : CONV); // answered where it was tapped
      assert.equal(offerOf(world) !== undefined, chat === "1:1"); // the opt-in offer: 1:1 only
    }
  }
});

test("a thumbs up on the card is a count like teams thumbs up", async () => {
  const world = linkedWorld();
  await tap(world, "like");
  await world.thumbs.settled();
  assert.equal(world.issues.calls, 0);
  assert.deepEqual(world.thumbs.counted, { like: 1, dislike: 0 });
  const line = world.log.lines.find((l) => l.message === "feedback thumb");
  assert.deepEqual(line?.fields, { reaction: "like", chat: "1:1", like: 1, dislike: 0 });
  assert.deepEqual(world.settled.at(-1), { card: "Thanks for the thumbs-up.", options: {} });
});

test("a thumbs down on the card counts and asks for the comment before filing anything", async () => {
  const world = linkedWorld();
  await tap(world, "dislike");
  await world.thumbs.settled();
  assert.equal(world.issues.calls, 0);
  assert.deepEqual(world.thumbs.counted, { like: 0, dislike: 1 });
  const last = world.settled.at(-1);
  assert.equal(last?.options.fallback, "What went wrong? Send /feedback and tell me.");
  assert.ok(last);
  const card = last.card;
  assert.ok(typeof card !== "string" && card.body.type === "view" && card.body.view.name === "thumbComment");
});

test("without a comment the report says so like teams form does", async () => {
  for (const [comment, skip] of [
    ["", false],
    [undefined, false],
    ["   \n ", false],
    ["typed but skipped", true],
    [undefined, true],
  ] as const) {
    const world = linkedWorld();
    await tap(world, "dislike");
    await sendComment(world, comment, skip);
    await world.thumbs.settled();
    const [issue] = world.issues.issues;
    assert.ok(issue);
    assert.ok(issue.title.startsWith("[Clawy feedback] (thumbs down, no comment)"));
    assert.ok(!issue.body.includes("typed but skipped"));
    assert.equal(world.settled.at(-1)?.card, "Thanks. I am filing your report.");
  }
});

test("a comment is clipped to what the card allows", async () => {
  const world = linkedWorld();
  await sendComment(world, "x".repeat(5000));
  await world.thumbs.settled();
  const body = world.issues.issues[0]?.body ?? "";
  assert.ok(body.includes("x".repeat(THUMB_COMMENT_MAX)) && !body.includes("x".repeat(THUMB_COMMENT_MAX + 1)));
});

test("a comment keeps its line breaks", async () => {
  const world = linkedWorld();
  await sendComment(world, "first line\nsecond line");
  await world.thumbs.settled();
  assert.ok(world.issues.issues[0]?.body.includes("first line\nsecond line"));
});

test("a comment in a group has the credentials masked like every group message", async () => {
  const world = linkedWorld();
  await sendComment(world, `my token is ${SECRET}`, false, CONV);
  await world.thumbs.settled();
  assert.equal(world.issues.issues.length, 1);
  assert.ok(!world.issues.everything().includes(SECRET));
});

test("a user who is not connected can give thumbs too", async () => {
  const world = makeWorld();
  await tap(world, "like");
  await tap(world, "dislike");
  await sendComment(world, "nothing works");
  await world.thumbs.settled();
  assert.deepEqual(world.thumbs.counted, { like: 1, dislike: 1 });
  assert.ok(world.issues.issues[0]?.body.includes("chat not linked"));
});

test("a tapped card is always replaced and a made up button files nothing", async () => {
  for (const scope of ["", CONV]) {
    const world = linkedWorld();
    await world.thumbs.clicks.inGroup?.(clickRoute(world, { primusclaw: "thumb", reaction: "meh" }, USER_A, scope));
    assert.deepEqual(world.settled.at(-1), { card: "That button is no longer active.", options: {} });
    assert.equal(world.issues.calls, 0);
    assert.deepEqual(world.thumbs.counted, { like: 0, dislike: 0 });
  }
});

test("a thumbs down files an issue and replies with its link", async () => {
  const world = linkedWorld();
  vote(world, "dislike", "the answer was wrong");
  await world.thumbs.settled();
  assert.equal(world.issues.issues[0]?.title, "[Clawy feedback] (thumbs down) the answer was wrong — Alice");
  assert.ok(texts(world).some((t) => t.includes("[#1](https://github.test/example-org/example-repo/issues/1)")));
});

test("a thumbs up only counts", async () => {
  const world = linkedWorld();
  vote(world, "like", "nice");
  await world.thumbs.settled();
  assert.equal(world.issues.calls, 0);
  assert.deepEqual(world.thumbs.counted, { like: 1, dislike: 0 });
});

test("a second thumbs down in the same session is a comment on the first issue", async () => {
  const world = linkedWorld();
  vote(world, "dislike", "first");
  await world.thumbs.settled();
  vote(world, "dislike", "second");
  await world.thumbs.settled();
  assert.equal(world.issues.issues.length, 1);
  assert.equal(world.issues.comments.length, 1);
  assert.ok(world.issues.comments[0]?.[1].startsWith("Reported by **Alice**"));
});

test("a thumbs down in a group never offers or includes the conversation", async () => {
  const world = linkedWorld();
  vote(world, "dislike", "bad", CONV);
  await world.thumbs.settled();
  assert.equal(offerOf(world), undefined);
  assert.equal(world.issues.comments.length, 0);
});

test("a failure while filing in the background is logged and the user is told", async () => {
  const world = linkedWorld();
  world.store.sessions.getSession = () => {
    throw new Error("the store is gone");
  };
  vote(world, "dislike", "bad");
  await world.thumbs.settled();
  assert.ok(
    world.log.lines.some((l) => l.message === "filing a thumbs-down report failed" && l.fields["why"] === "Error"),
  );
  assert.equal(texts(world).at(-1), "I could not record that report. Send /feedback and tell me what went wrong.");
});

test("the invoke returns at once while github is slow", async () => {
  const world = linkedWorld();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = world.issues.createIssue.bind(world.issues);
  world.issues.createIssue = async (...args) => {
    await held;
    return create(...args);
  };
  vote(world, "dislike", "slow");
  assert.equal(world.issues.issues.length, 0); // onVote returned before anything was filed
  release();
  await world.thumbs.settled();
  assert.equal(world.issues.issues.length, 1);
});
