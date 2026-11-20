// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What waits for a reviewer to finish their steps (`review_onboarding`): one row per reviewer, asker and pull requests. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { REVIEW_ONBOARDING_KEEP_SECONDS } from "@primusclaw/personal-agent";

import { advanceSeconds, openTestStore } from "../../../../test-support/index.js";

const row = (id: string, requesterId = "aad-a", pulls = "o/r#1", toldRank = 1) => ({
  onboardingId: id,
  actorId: "aad-b",
  requesterId,
  pulls,
  request: { merge: true, note: id },
  toldRank,
});

test("asked again, the row keeps its id and takes the newer request and step; a done one is owed again", () => {
  const { store } = openTestStore();
  const repo = store.reviewDelegation;
  const first = repo.saveReviewOnboarding(row("o-1"));
  assert.equal(first.onboardingId, "o-1");
  assert.equal(repo.claimOnboardingStep("aad-b", 3), true);
  assert.equal(repo.finishReviewOnboarding("o-1"), true);
  assert.equal(repo.finishReviewOnboarding("o-1"), false, "the asker is told once");
  assert.deepEqual(repo.openReviewOnboardings("aad-b"), []);
  const again = repo.saveReviewOnboarding(row("o-2", "aad-a", "o/r#1", 2));
  assert.equal(again.onboardingId, "o-1");
  assert.equal(again.toldRank, 2);
  assert.equal(again.done, false);
  assert.deepEqual(again.request, { merge: true, note: "o-2" });
  assert.deepEqual(repo.onboardingReviewers(), ["aad-b"]);
});

test("a step is claimed once for every open row of the reviewer, and only upwards", () => {
  const { store } = openTestStore();
  const repo = store.reviewDelegation;
  repo.saveReviewOnboarding(row("o-1"));
  repo.saveReviewOnboarding(row("o-2", "aad-c", "o/r#2", 0));
  assert.equal(repo.claimOnboardingStep("aad-b", 1), true, "the row at 0 was not told yet");
  assert.equal(repo.claimOnboardingStep("aad-b", 1), false);
  assert.equal(repo.claimOnboardingStep("aad-b", 2), true);
  assert.equal(repo.claimOnboardingStep("aad-b", 2), false);
  assert.deepEqual(
    repo.openReviewOnboardings("aad-b").map((o) => [o.onboardingId, o.toldRank]),
    [
      ["o-1", 2],
      ["o-2", 2],
    ],
  );
  assert.equal(repo.claimOnboardingStep("aad-x", 5), false);
});

test("rows are kept a week, and a dropped one is gone", () => {
  const { store, clock } = openTestStore();
  const repo = store.reviewDelegation;
  repo.saveReviewOnboarding(row("o-1"));
  repo.saveReviewOnboarding(row("o-2", "aad-c", "o/r#2"));
  repo.dropReviewOnboarding("o-2");
  assert.equal(repo.getReviewOnboarding("o-2"), null);
  assert.equal(repo.getReviewOnboarding("o-1")?.request.note, "o-1");
  advanceSeconds(clock, REVIEW_ONBOARDING_KEEP_SECONDS + 1);
  assert.equal(repo.getReviewOnboarding("o-1"), null);
  assert.deepEqual(repo.openReviewOnboardings("aad-b"), []);
  assert.deepEqual(repo.onboardingReviewers(), []);
  assert.equal(repo.claimOnboardingStep("aad-b", 5), false);
  // (the next save drops it for good)
  repo.saveReviewOnboarding(row("o-3", "aad-c", "o/r#3"));
  assert.deepEqual(
    repo.openReviewOnboardings("aad-b").map((o) => o.onboardingId),
    ["o-3"],
  );
});
