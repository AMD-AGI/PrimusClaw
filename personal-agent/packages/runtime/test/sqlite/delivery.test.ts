// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Turns that answered in the chat, feedback, onboarding, review delegation and Claw event claims.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTING_SESSION_KEEP_SECONDS,
  EVENT_CLAIM_LEASE_SECONDS,
  FEEDBACK_ASK_TTL_SECONDS,
  FEEDBACK_KEEP_SECONDS,
  FEEDBACK_OFFER_KEEP_SECONDS,
  FEEDBACK_PROMPT_TTL_SECONDS,
  ONBOARDING_INTERVAL_SECONDS,
  PENDING_REQUEST_TTL_SECONDS,
  PROCESSED_TTL_SECONDS,
  type FeedbackReport,
} from "@primusclaw/personal-agent";

import { advanceSeconds, openFileTestStore, openTestStore } from "../../../../test-support/index.js";

const RUN = { runningMax: 600, slack: 30 };

test("a turn that delivered its answer covers its run's notification; a later message's run is not its", () => {
  const { store, clock } = openTestStore();
  const turns = store.turns;
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: store.now() }), null);
  turns.turnStarted("s1", { prompt: "fix it", messageId: "m1", turnId: "t1" });
  const started = store.now();
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: started + 5 }), "running");
  advanceSeconds(clock, 700);
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: started + 5 }), null); // stuck: does not mute for ever
  turns.turnDelivered("s1", { turnId: "other" }); // another turn's end writes nothing
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: started + 5 }), null);
  turns.turnDelivered("s1", { messageId: "m1", turnId: "t1" });
  const delivered = store.now();
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: delivered + 10 }), "delivered");
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: delivered + 31 }), null);
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: delivered + 999, messageId: "m1" }), "delivered");
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: delivered, messageId: "m2" }), null);
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: started - 1 }), null); // started after the run ended
  assert.equal(turns.turnPrompt("s1", started), "fix it");
  assert.equal(turns.turnPrompt("s1", started - 1), "");
  assert.equal(turns.turnPrompt("s9", started), "");
  turns.turnStarted("s1", { prompt: "next" }); // a later turn replaces the row; the answered message stays answered
  assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: delivered + 999, messageId: "m1" }), "delivered");
});

test("a turn that ended undelivered wants the notification; one of a dead process is lost", () => {
  const f = openFileTestStore();
  try {
    const turns = f.store.turns;
    turns.turnStarted("s1", { turnId: "t1" });
    turns.turnNotDelivered("s1", "t2");
    assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: f.store.now() }), "running");
    turns.turnNotDelivered("s1");
    assert.equal(turns.answeredInChat("s1", { ...RUN, finishedAt: f.store.now() }), null);
    turns.turnStarted("s2");
    assert.equal(f.reopen().turns.answeredInChat("s2", { ...RUN, finishedAt: f.store.now() }), "lost");
    turns.turnDelivered("s2");
    assert.equal(turns.answeredInChat("s2", { ...RUN, finishedAt: f.store.now() }), "delivered");
  } finally {
    f.close();
  }
});

const report = (text: string, sessionId = "s1") => ({ userId: "aad-a", scope: "", sessionId, text, scene: "chat" });

test("feedback reports are kept until filed, grouped on one issue within the dedupe window, retried when due", () => {
  const { store, clock } = openTestStore();
  const feedback = store.feedback;
  const first = feedback.addFeedbackReport({
    ...report("broken"),
    reporterName: "Alice",
    reporterEmail: "a@example.com",
  });
  const r1 = feedback.getFeedbackReport(first) as FeedbackReport;
  assert.deepEqual(r1, {
    id: first,
    userId: "aad-a",
    scope: "",
    sessionId: "s1",
    text: "broken",
    scene: "chat",
    createdAt: store.now(),
    state: "pending",
    issueNumber: null,
    issueUrl: "",
    asComment: false,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: "",
    reporterName: "Alice",
    reporterEmail: "a@example.com",
  });
  assert.equal(feedback.getFeedbackReport(999), null);
  assert.equal(feedback.feedbackTarget(r1), null);
  assert.equal(feedback.pendingFeedbackCount(), 1);
  feedback.markFeedbackFailed(first, "x".repeat(100), store.now() + 60);
  assert.deepEqual(feedback.dueFeedback(10), []);
  advanceSeconds(clock, 60);
  const due = feedback.dueFeedback(10);
  assert.deepEqual([due.length, due[0]?.attempts, due[0]?.lastError.length], [1, 1, 80]);
  feedback.markFeedbackFiled(first, { number: 42, url: "https://issue/42" }, false);
  assert.equal(feedback.pendingFeedbackCount(), 0);
  advanceSeconds(clock, 30);
  const second = feedback.getFeedbackReport(feedback.addFeedbackReport(report("again"))) as FeedbackReport;
  assert.deepEqual(feedback.feedbackTarget(second), { number: 42, url: "https://issue/42" });
  const elsewhere = feedback.getFeedbackReport(feedback.addFeedbackReport(report("other", "s2"))) as FeedbackReport;
  assert.equal(feedback.feedbackTarget(elsewhere), null);
  advanceSeconds(clock, FEEDBACK_KEEP_SECONDS + 1);
  store.idempotency.markProcessed("a-1"); // prunes delivered reports
  assert.equal(feedback.getFeedbackReport(first), null);
  assert.notEqual(feedback.getFeedbackReport(second.id), null); // undelivered ones are never dropped
});

test("a bare /feedback waits ten minutes for the next message, and is taken once", () => {
  const { store, clock } = openTestStore();
  const feedback = store.feedback;
  feedback.openFeedbackAsk("aad-a", "");
  assert.equal(feedback.hasFeedbackAsk("aad-a", ""), true);
  assert.equal(feedback.hasFeedbackAsk("aad-a", "g1"), false);
  assert.equal(feedback.takeFeedbackAsk("aad-a", ""), true);
  assert.equal(feedback.takeFeedbackAsk("aad-a", ""), false);
  feedback.openFeedbackAsk("aad-a", "");
  advanceSeconds(clock, FEEDBACK_ASK_TTL_SECONDS);
  assert.equal(feedback.hasFeedbackAsk("aad-a", ""), false);
  advanceSeconds(clock, 1);
  assert.equal(feedback.takeFeedbackAsk("aad-a", ""), false);
});

test("feedback offers move once, and prompts work for a week", () => {
  const { store, clock } = openTestStore();
  const feedback = store.feedback;
  const offer = feedback.addFeedbackOffer("aad-a", 42, "s1", "t1");
  assert.deepEqual(feedback.getFeedbackOffer(offer), {
    offerId: offer,
    userId: "aad-a",
    issueNumber: 42,
    sessionId: "s1",
    turnId: "t1",
    createdAt: store.now(),
    state: "open",
  });
  assert.equal(feedback.getFeedbackOffer("none"), null);
  assert.equal(feedback.moveFeedbackOffer(offer, "sending"), true);
  assert.equal(feedback.moveFeedbackOffer(offer, "sending"), false);
  assert.equal(feedback.moveFeedbackOffer(offer, "done", { onlyFrom: "sending" }), true);
  assert.equal(feedback.moveFeedbackOffer(offer, "declined", { onlyFrom: null }), true);
  const prompt = feedback.addFeedbackPrompt("aad-a", "g1");
  assert.deepEqual(feedback.getFeedbackPrompt(prompt), {
    promptId: prompt,
    userId: "aad-a",
    scope: "g1",
    createdAt: store.now(),
  });
  assert.equal(feedback.getFeedbackPrompt("none"), null);
  advanceSeconds(clock, FEEDBACK_PROMPT_TTL_SECONDS + 1);
  assert.equal(feedback.getFeedbackPrompt(prompt), null);
  advanceSeconds(clock, FEEDBACK_OFFER_KEEP_SECONDS);
  feedback.addFeedbackOffer("aad-a", 43, "s1", "t2");
  feedback.addFeedbackPrompt("aad-a", "");
  assert.equal(feedback.getFeedbackOffer(offer), null);
});

test("one onboarding card per person per group per day, one DM per day; an unsent one is given back", () => {
  const { store, clock } = openTestStore();
  const onboarding = store.onboarding;
  const member = { channelUserId: "29:a", name: "Alice" };
  const card = onboarding.claimOnboardingCard("aad-a", "g1", member);
  assert.ok(card !== null);
  assert.equal(onboarding.claimOnboardingCard("aad-a", "g1", member), null);
  assert.notEqual(onboarding.claimOnboardingCard("aad-a", "g2", member), null);
  assert.deepEqual(onboarding.getOnboardingCard(card), {
    promptId: card,
    userId: "aad-a",
    scope: "g1",
    channelUserId: "29:a",
    name: "Alice",
    createdAt: store.now(),
  });
  onboarding.releaseOnboardingCard(card);
  assert.equal(onboarding.getOnboardingCard(card), null);
  const again = onboarding.claimOnboardingCard("aad-a", "g1", member);
  assert.ok(again !== null);
  advanceSeconds(clock, ONBOARDING_INTERVAL_SECONDS + 1);
  assert.equal(onboarding.getOnboardingCard(again), null);
  assert.notEqual(onboarding.claimOnboardingCard("aad-a", "g1", member), null);
  assert.equal(onboarding.claimOnboardingDm("aad-a"), true);
  assert.equal(onboarding.claimOnboardingDm("aad-a"), false);
  onboarding.releaseOnboardingDm("aad-a");
  assert.equal(onboarding.claimOnboardingDm("aad-a"), true);
  advanceSeconds(clock, ONBOARDING_INTERVAL_SECONDS + 1);
  assert.equal(onboarding.claimOnboardingDm("aad-a"), true);
});

test("an unlinked member's request waits fifteen minutes, is replaced by a newer one, and is taken once", () => {
  const { store, clock } = openTestStore();
  const onboarding = store.onboarding;
  const request = { userId: "aad-a", scope: "g1", messageId: "m1", text: "help", reference: { conv: "g1" } };
  onboarding.savePendingRequest(request);
  onboarding.savePendingRequest({ ...request, messageId: "m2", quote: "q", sent: "help <https://x>" });
  assert.deepEqual(onboarding.takePendingRequest("aad-a"), {
    ...request,
    messageId: "m2",
    createdAt: store.now(),
    quote: "q",
    sent: "help <https://x>",
  });
  assert.equal(onboarding.takePendingRequest("aad-a"), null);
  onboarding.savePendingRequest(request);
  advanceSeconds(clock, PENDING_REQUEST_TTL_SECONDS + 1);
  assert.equal(onboarding.takePendingRequest("aad-a"), null);
});

test("a GitHub confirmation is recorded once, answered once, and only by its owner's list", () => {
  const { store, clock } = openTestStore();
  const confirmations = store.githubConfirmations;
  const base = {
    sessionId: "s1",
    actorId: "aad-a",
    requesterId: "aad-b",
    repo: "o/r",
    pr: 7,
    reference: { conv: "g" },
    expiresAt: store.now() + 600,
  };
  assert.equal(confirmations.addGithubConfirmation({ ...base, confirmationId: "c1" }), true);
  assert.equal(confirmations.addGithubConfirmation({ ...base, confirmationId: "c1" }), false);
  advanceSeconds(clock, 1);
  confirmations.addGithubConfirmation({ ...base, confirmationId: "c2", kind: "review", event: "APPROVE" });
  assert.deepEqual(confirmations.getGithubConfirmation("c1"), {
    ...base,
    confirmationId: "c1",
    state: "pending",
    createdAt: store.now() - 1,
    kind: "merge",
    event: "",
  });
  assert.equal(confirmations.getGithubConfirmation("none"), null);
  assert.deepEqual(
    confirmations.pendingGithubConfirmations("aad-a").map((c) => [c.confirmationId, c.kind, c.event]),
    [
      ["c1", "merge", ""],
      ["c2", "review", "APPROVE"],
    ],
  );
  assert.deepEqual(confirmations.pendingGithubConfirmations("aad-b"), []);
  assert.equal(confirmations.moveGithubConfirmation("c1", "sending"), true);
  assert.equal(confirmations.moveGithubConfirmation("c1", "sending"), false);
  assert.equal(confirmations.moveGithubConfirmation("c1", "done", { onlyFrom: "sending" }), true);
  confirmations.forgetGithubConfirmation("c1"); // answered: stays
  confirmations.forgetGithubConfirmation("c2"); // never shown: goes
  assert.equal(confirmations.getGithubConfirmation("c1")?.state, "done");
  assert.equal(confirmations.getGithubConfirmation("c2"), null);
});

test("acting sessions, review notices, followed reviews and rationed GitHub notices", () => {
  const { store, clock } = openTestStore();
  const review = store.reviewDelegation;
  assert.equal(review.isActingSession(""), false);
  review.noteActingSession("s1", "aad-b", "aad-a");
  assert.equal(review.isActingSession("s1"), true);
  advanceSeconds(clock, ACTING_SESSION_KEEP_SECONDS + 1);
  review.noteActingSession("s2", "aad-b", "aad-a");
  assert.deepEqual([review.isActingSession("s1"), review.isActingSession("s2")], [false, true]);
  const notice = {
    sessionId: "s2",
    actorId: "aad-a",
    requesterId: "aad-b",
    pull: "o/r#1",
    delivered: true,
    reason: "",
  };
  review.noteReviewNotice(notice);
  review.noteReviewNotice({ ...notice, delivered: false, reason: "not_linked" });
  assert.deepEqual(review.reviewNotices(), [notice, { ...notice, delivered: false, reason: "not_linked" }]);
  review.addAskerFollow({ itemId: "i1", batchId: "b1", review: { names: ["x"] }, reference: { c: 1 }, deadline: 99 });
  review.addAskerFollow({ itemId: "i1", batchId: "b9", review: {}, reference: {}, deadline: 1 });
  advanceSeconds(clock, 1);
  review.addAskerFollow({ itemId: "i2", batchId: "b2", review: {}, reference: {}, deadline: 5 });
  review.askerFollowSaid("i1", "running");
  review.askerFollowReviewerTold("i1");
  assert.deepEqual(review.askerFollows(), [
    {
      itemId: "i1",
      batchId: "b1",
      review: { names: ["x"] },
      reference: { c: 1 },
      said: "running",
      reviewerTold: true,
      deadline: 99,
    },
    { itemId: "i2", batchId: "b2", review: {}, reference: {}, said: "", reviewerTold: false, deadline: 5 },
  ]);
  review.dropAskerFollow("i1");
  assert.equal(review.askerFollows().length, 1);
  assert.equal(review.claimGithubNotice("aad-a", "bind", 3600), true);
  assert.equal(review.claimGithubNotice("aad-a", "bind", 3600), false);
  assert.equal(review.claimGithubNotice("aad-a", "other", 3600), true);
  review.releaseGithubNotice("aad-a", "bind");
  assert.equal(review.claimGithubNotice("aad-a", "bind", 3600), true);
  advanceSeconds(clock, 3600);
  assert.equal(review.claimGithubNotice("aad-a", "bind", 3600), true);
});

test("an activity is processed once, and a processed id is forgotten after a week", () => {
  const { store, clock } = openTestStore();
  const ids = store.idempotency;
  assert.equal(ids.claimProcessed("a1"), true);
  assert.equal(ids.claimProcessed("a1"), false);
  assert.equal(ids.seen("a1"), true);
  advanceSeconds(clock, PROCESSED_TTL_SECONDS + 1);
  ids.markProcessed("a2");
  assert.deepEqual([ids.seen("a1"), ids.seen("a2")], [false, true]);
});

test("a Claw event is claimed by one copy, waits while claimed, is done once finished, and expires after its ttl", () => {
  const f = openFileTestStore();
  try {
    const ids = f.store.idempotency;
    const claim = ids.claimEvent("e1");
    assert.equal(claim.state, "claimed");
    assert.deepEqual(f.reopen().idempotency.claimEvent("e1"), { state: "busy", holder: "" });
    ids.releaseEvent("e1", "not-the-holder");
    assert.equal(ids.claimEvent("e1").state, "busy");
    ids.releaseEvent("e1", claim.holder);
    const again = ids.claimEvent("e1");
    assert.equal(again.state, "claimed");
    advanceSeconds(f.clock, EVENT_CLAIM_LEASE_SECONDS + 1);
    const taken = ids.claimEvent("e1"); // the first claim died with its process
    assert.equal(taken.state, "claimed");
    ids.finishEvent("e1");
    assert.deepEqual(ids.claimEvent("e1"), { state: "done", holder: "" });
    ids.markProcessed("legacy");
    assert.deepEqual(ids.claimEvent("legacy"), { state: "done", holder: "" });
    advanceSeconds(f.clock, PROCESSED_TTL_SECONDS + EVENT_CLAIM_LEASE_SECONDS + 1);
    ids.claimEvent("e2");
    ids.finishEvent("e2"); // each finish prunes what has expired
    const keys = f.raw
      .prepare("SELECT event_key FROM event_claims ORDER BY event_key")
      .all()
      .map((r) => r["event_key"]);
    assert.deepEqual(keys, ["e2"]);
  } finally {
    f.close();
  }
});

test("claims are exclusive across stores on one file: each event is claimed by exactly one", () => {
  const f = openFileTestStore();
  try {
    const stores = [f.store, f.reopen(), f.reopen()];
    const keys = Array.from({ length: 100 }, (_, i) => `claw-event:say-${String(i)}`);
    const claimed = keys.flatMap((key, i) =>
      [0, 1, 2]
        .map((j) => stores[(i + j) % stores.length])
        .filter((s) => s?.idempotency.claimEvent(key).state === "claimed")
        .map(() => key),
    );
    assert.deepEqual(claimed, keys);
  } finally {
    f.close();
  }
});
