// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClawAnswerInvalid, ClawError, parseStartedReviews, serviceRefusal } from "../../src/index.js";

const pr = { owner: "AMD-AGI", repo: "x", number: 1 };

describe("parseStartedReviews", () => {
  it("reads every field Claw says, and what it does not say as not said", () => {
    const [full, bare] = parseStartedReviews({
      items: [
        {
          pr,
          item_id: "i1",
          seq: 2,
          title: "Review",
          session_id: "s1",
          message_id: "claw-pending-1",
          model: "m",
          fell_back_from: "big",
          ignored: ["model", 3],
          review_only: true,
          merge_needs_confirmation: true,
          queued: { reason: "too_many_active_items" },
        },
        { pr, item_id: "i2", session_id: "s2", model: null, queued: true },
      ],
    });
    assert.deepEqual(full, {
      target: pr,
      itemId: "i1",
      seq: 2,
      title: "Review",
      sessionId: "s1",
      messageId: "claw-pending-1",
      model: "m",
      fellBackFrom: "big",
      ignored: ["model"],
      mergeNeedsConfirmation: true,
      queued: "too_many_active_items",
      mergeByRequester: false,
    });
    assert.ok(bare);
    assert.equal(bare.model, "");
    assert.equal(bare.mergeNeedsConfirmation, null);
    assert.equal(bare.queued, "queued");
    assert.equal(bare.messageId, "");
    const [said] = parseStartedReviews({
      items: [{ pr, item_id: "i3", session_id: "s", review_only: false, queued: {} }],
    });
    assert.ok(said);
    assert.equal(said.mergeNeedsConfirmation, false);
    assert.equal(said.queued, "");
    assert.equal(said.model, null);
  });
});

describe("parseStartedReviews for someone else", () => {
  it("parse started reviews reads merge by requester", () => {
    const [a, b, c] = parseStartedReviews(
      {
        items: [
          { pr, item_id: "i1", review_only: false, merge_by_requester: true },
          { pr, item_id: "i2", review_only: false },
          { pr, item_id: "i3", review_only: false, merge_by_requester: "yes" },
        ],
      },
      false,
    );
    assert.deepEqual([a?.mergeByRequester, b?.mergeByRequester, c?.mergeByRequester], [true, false, false]);
    assert.equal(a?.sessionId, "");
  });
});

describe("parseStartedReviews refusing", () => {
  it("an answer it does not understand is an error, never a review quietly not shown", () => {
    for (const data of [null, {}, { items: "x" }]) {
      assert.throws(() => parseStartedReviews(data), ClawAnswerInvalid);
    }
    for (const row of [
      { item_id: "i", session_id: "s" },
      { pr, session_id: "s" },
      { pr, item_id: "i" },
      { pr, item_id: "i", session_id: "" },
      { pr: { ...pr, number: "1" }, item_id: "i", session_id: "s" },
      "row",
    ]) {
      assert.throws(() => parseStartedReviews({ items: [row] }), ClawAnswerInvalid);
    }
    assert.throws(
      () => parseStartedReviews({ items: [{ pr, item_id: "i", session_id: 3 }] }, false),
      ClawAnswerInvalid,
    );
  });
});

describe("serviceRefusal", () => {
  it("says Claw's reason, the last one for a word it does not name, and what was not done", () => {
    const of = (code: string): ClawError => new ClawError(403, JSON.stringify({ ok: false, error: code }));
    assert.equal(
      serviceRefusal(of("service_client_not_allowed"), "Nothing was merged."),
      "PrimusClaw does not take answers from me yet: its operator has to allow this worker's client. Nothing was merged.",
    );
    assert.equal(
      serviceRefusal(of("interactive_sign_in_required"), "X."),
      "PrimusClaw did not take my credential for you as a sign-in; tell the operator. X.",
    );
    assert.equal(
      serviceRefusal(of("something_new"), "X.", "zh"),
      "PrimusClaw says this answer is not yours to give. X.",
    );
  });
});
