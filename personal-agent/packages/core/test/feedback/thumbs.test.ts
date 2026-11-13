// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of tests/test_feedback_votes.py, tests/test_mobile_thumbs.py and the thumbs of tests/test_feedback_discoverable.py. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  chatCredentialOf,
  err,
  ok,
  THUMB_COMMENT_MAX,
  voteMessageId,
  type InboundVote,
  type RouteBase,
  type TokenExchange,
} from "@primusclaw/personal-agent";

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

test("in a chat that talks to the assistant a thumbs down reports the assistants session, not the plain chat session", async () => {
  const world = linkedWorld({ assistantOn: true });
  vote(world, "dislike", "it failed every time", "", "say-1");
  await world.thumbs.settled();
  assert.deepEqual(world.claw.votes, [["ak-alice", "sess-assistant", "teams:say-1", "down", "it failed every time"]]);
  const body = world.issues.issues[0]?.body ?? "";
  assert.ok(body.includes("sess-assistant"), body);
  assert.ok(!body.includes("sess-1"), "not the plain chat session's turns");
});

test("when the assistants session cannot be read the report goes without another sessions turns", async () => {
  const world = linkedWorld({ assistantOn: true });
  world.claw.assistant.session = () => Promise.reject(new Error("claw is down"));
  vote(world, "dislike", "bad", "", "say-1");
  await world.thumbs.settled();
  const body = world.issues.issues[0]?.body ?? "";
  assert.equal(world.issues.issues.length, 1, "still filed");
  assert.ok(!body.includes("sess-1"), body);
  assert.ok(world.log.lines.some((l) => l.message === "feedback: the assistant's session could not be read"));
});

test("the assistants own thumbs on mobile vote and the comment replaces the vote", async () => {
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
    // Expected values are python3's voted_message_id, run on the same replyToId.
    ["1:abc/def ghi", "teams:9b0e8ad4b4a3c635b1f017f995e960ef6e76a311"], // Claw would refuse "/" and " "
    ["x".repeat(120), "teams:13f05a0b594787f5ecd315edc96141bd3243203d"], // and more than 100 characters
    ["x".repeat(94), `teams:${"x".repeat(94)}`], // the prefixed key is exactly 100
    ["x".repeat(95), "teams:69b938805e4b98342b6d0564764fb96c234cda7c"], // one over
    ["é-1", "teams:ac09ccc36d141ca34c1420f0d859cf1fb19476e7"], // hashed as UTF-8
    ["ab\n", "teams:a63d8014dba891345b30174df2b2a57efbb65b4f"], // a trailing newline is not matched away
    ["", undefined],
    ["  ", undefined],
    ["\u3000", undefined], // Python's strip: any str.isspace character
    ["\x1c", undefined],
  ];
  for (const [replyTo, expected] of cases) {
    const got = voteMessageId(sha, replyTo, "teams");
    assert.equal(got, expected, replyTo);
    if (got !== undefined) assert.match(got, /^[A-Za-z0-9._:@-]{1,100}$/);
  }
});

test("a vote's key is under the channel's own id, hashed or not", () => {
  const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
  assert.equal(voteMessageId(sha, "1700000000.000100", "chatapp"), "chatapp:1700000000.000100");
  assert.equal(voteMessageId(sha, "é-1", "chatapp"), "chatapp:ac09ccc36d141ca34c1420f0d859cf1fb19476e7");
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
      assert.ok(
        issue.title.startsWith("[PrimusClaw Assistant feedback] (thumbs down) it ignored my question"),
        `${chat} ${via}`,
      );
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
    assert.ok(issue.title.startsWith("[PrimusClaw Assistant feedback] (thumbs down, no comment)"));
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
  assert.equal(
    world.issues.issues[0]?.title,
    "[PrimusClaw Assistant feedback] (thumbs down) the answer was wrong — Alice",
  );
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

test("a vote's message id is the python voted message id: prefixed, hashed when claw would refuse it, none when empty", async () => {
  // Python: voted_message_id({"replyToId": ...}) for each; a missing replyToId reaches core as "" (the adapter's pyStr).
  for (const [replyTo, stored] of [
    ["1730880000123", "teams:1730880000123"],
    ["1:abc/def ghi", "teams:9b0e8ad4b4a3c635b1f017f995e960ef6e76a311"],
    ["é-1", "teams:ac09ccc36d141ca34c1420f0d859cf1fb19476e7"],
    ["", undefined],
    ["   ", undefined],
    ["\u3000", undefined],
  ] as const) {
    const world = linkedWorld();
    vote(world, "like", "", "", replyTo);
    await world.thumbs.settled();
    assert.deepEqual(
      world.claw.votes.map((v) => v[2]),
      stored === undefined ? [] : [stored],
      replyTo,
    );
    if (stored === undefined) {
      assert.equal(
        world.log.lines.find((l) => l.message === "feedback vote")?.fields["outcome"],
        "no message to vote on",
      );
    }
  }
});

/** An exchange that binds `bound` (each to its token) and answers not_bound for anyone else. */
function exchangeOf(bound: Readonly<Record<string, string>>): TokenExchange {
  const tokens = new Map(Object.entries(bound));
  return {
    enabled: true,
    tokenFor: (userId) => {
      const token = tokens.get(userId);
      return Promise.resolve(token === undefined ? err({ kind: "not_bound" as const }) : ok(token));
    },
    bindingRequest: () => Promise.resolve(err({ kind: "exchange_unavailable" as const })),
    invalidate: () => undefined,
  };
}

test("a person bound but never linked votes on their plain session with the token their chats run on", async () => {
  // No key: their turns run on the exchanged token, in the chat's own session (not the assistant's).
  const world = makeWorld({ exchange: exchangeOf({ [USER_A.id]: "xt-alice" }) });
  world.store.sessions.setSession(USER_A.id, { sessionId: "sess-plain" });
  vote(world, "dislike", "", "", "1730880000777");
  await world.thumbs.settled();
  assert.deepEqual(world.claw.votes, [["xt-alice", "sess-plain", "teams:1730880000777", "down", undefined]]);
  const line = world.log.lines.find((l) => l.message === "feedback vote");
  assert.deepEqual(line?.fields, { reaction: "dislike", chat: "1:1", outcome: "recorded" });
  assert.equal(world.issues.issues.length, 1); // still filed as a report too
});

test("with chats on the exchange, a linked person who is not bound votes with their key", async () => {
  const world = linkedWorld({ exchange: exchangeOf({}) });
  vote(world, "like", "", "", "teams-9");
  await world.thumbs.settled();
  assert.deepEqual(world.claw.votes, [["ak-alice", "sess-1", "teams:teams-9", "up", undefined]]);
});

test("neither bound nor linked: no vote, logged as not linked", async () => {
  const world = makeWorld({ exchange: exchangeOf({}) });
  world.store.sessions.setSession(USER_A.id, { sessionId: "sess-plain" });
  vote(world, "dislike", "", "", "teams-9");
  await world.thumbs.settled();
  assert.deepEqual(world.claw.votes, []);
  const line = world.log.lines.find((l) => l.message === "feedback vote");
  assert.deepEqual(line?.fields, { reaction: "dislike", chat: "1:1", outcome: "not linked" });
});

test("chatCredentialOf: the exchanged token first, the key when not bound or the exchange is off, else nothing", async () => {
  const links = { getKey: (id: string) => (id === "has-key" ? "ak-1" : null) };
  const ex = exchangeOf({ "has-key": "xt-1", bound: "xt-2" });
  const off = { ...ex, enabled: false };
  const cases: readonly (readonly [TokenExchange | undefined, string, string | undefined])[] = [
    [ex, "has-key", "xt-1"],
    [ex, "bound", "xt-2"],
    [ex, "nobody", undefined],
    [undefined, "has-key", "ak-1"],
    [undefined, "bound", undefined],
    [off, "bound", undefined],
    [off, "has-key", "ak-1"],
  ];
  for (const [exchange, id, want] of cases) {
    const got = await chatCredentialOf(links, exchange)({ ...USER_A, id });
    assert.equal(got, want, `${id} exchange=${exchange === undefined ? "none" : String(exchange.enabled)}`);
  }
});
