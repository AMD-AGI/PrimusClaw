// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decidedItem,
  isFinished,
  parseRequesterView,
  parseWorkItem,
  pullOf,
  requesterViewItem,
  waitsForReviewer,
  type WorkItem,
} from "../../src/index.js";

function item(fields: Partial<WorkItem> & { itemId: string }): WorkItem {
  return {
    seq: 0,
    title: "",
    boardState: "in_progress",
    resultVersion: 0,
    canAccept: false,
    lastReportKind: null,
    pendingQuestion: null,
    summary: "",
    outcome: null,
    kind: "task",
    params: {},
    pull: null,
    updatedAt: "",
    ...fields,
  };
}

describe("parseWorkItem", () => {
  const cases: Array<[string, unknown, WorkItem | null]> = [
    [
      "a row of the board",
      {
        item_id: "wi-1",
        seq: 3,
        title: "T",
        board_state: "needs_you",
        result_version: 2,
        can_accept: true,
        last_report_kind: "ready",
        pending_question: null,
        summary: "S",
        outcome: null,
      },
      item({
        itemId: "wi-1",
        seq: 3,
        title: "T",
        boardState: "needs_you",
        resultVersion: 2,
        canAccept: true,
        lastReportKind: "ready",
        summary: "S",
      }),
    ],
    ["an event's item, which carries less", { item_id: "wi-2" }, item({ itemId: "wi-2" })],
    [
      "fields of the wrong type",
      { item_id: "wi-3", seq: "3", result_version: "2", can_accept: "yes", title: 5 },
      item({ itemId: "wi-3" }),
    ],
    ["an empty id", { item_id: "" }, null],
    ["a number for an id", { item_id: 7 }, null],
    ["no id", {}, null],
    ["null", null, null],
    ["a string", "wi-1", null],
    ["a list", [], null],
  ];
  for (const [what, raw, expected] of cases) {
    it(`a work item is read as far as it is well formed and only a true can_accept counts: ${what}`, () => {
      assert.deepEqual(parseWorkItem(raw), expected);
    });
  }

  it("a result that needs no acceptance is not one to accept", () => {
    assert.equal(parseWorkItem({ item_id: "a", can_accept: true, needs_accept: false })?.canAccept, false);
    assert.equal(parseWorkItem({ item_id: "a", can_accept: true, needs_accept: true })?.canAccept, true);
  });

  it("reads a review's pull request from its params", () => {
    const review = parseWorkItem({
      item_id: "r",
      kind: "review",
      params: { pr: { owner: "o", repo: "r", number: 4 } },
      updated_at: "2026-11-09T00:00:00Z",
      outcome: "accepted",
    });
    assert.ok(review);
    assert.deepEqual(review.pull, { owner: "o", repo: "r", number: 4 });
    assert.equal(review.kind, "review");
    assert.equal(review.updatedAt, "2026-11-09T00:00:00Z");
    assert.equal(review.outcome, "accepted");
    for (const pr of [
      { owner: "", repo: "r", number: 1 },
      { owner: "o", repo: "r", number: "1" },
      { owner: "o", number: 1 },
      "x",
    ]) {
      assert.equal(pullOf({ pr }), null);
    }
    assert.equal(pullOf(undefined), null);
    assert.deepEqual(pullOf({ pr: { owner: "o", repo: "r", number: 2.5 } }), null);
  });
});

describe("the asker's view of a review", () => {
  it("is read wherever Claw puts it, and only its own fields", () => {
    const view = parseRequesterView(
      {
        params: {
          requester_view: {
            status: "waiting_for_reviewer",
            pr_url: "https://github.com/o/r/pull/1",
            verdict: "APPROVE",
            merged: "yes",
            waiting_for: "Confirm_Merge",
            findings: 2,
            note: "  the   first\nfinding ",
          },
        },
      },
      "i1",
    );
    assert.deepEqual(view, {
      itemId: "i1",
      status: "waiting_for_reviewer",
      prUrl: "https://github.com/o/r/pull/1",
      verdict: "approve",
      merged: false,
      waitingFor: "confirm_merge",
      findings: 2,
      note: "the first finding",
      prSummary: "",
    });
    assert.ok(view);
    assert.ok(waitsForReviewer(view) && !isFinished(view));
    assert.equal(parseRequesterView({ requester_view: { status: "done", pr: "u" } }, "i")?.prUrl, "u");
    assert.equal(parseRequesterView({ status: "done", merged: true }, "i")?.merged, true);
    assert.equal(parseRequesterView({ status: "done" }, "i"), null);
    assert.equal(parseRequesterView("x", "i"), null);
    assert.equal(
      parseRequesterView({ status: 3, verdict: 1, findings: -1, note: 5, pr_url: "x".repeat(400) }, "i")?.prUrl.length,
      300,
    );
    const odd = parseRequesterView({ status: 3, verdict: 1, findings: -1, note: 5, merged: true }, "i");
    assert.deepEqual([odd?.status, odd?.verdict, odd?.findings, odd?.note], ["", "", null, ""]);
  });

  it("makes an item of the view alone, and a decision's answer without board fields reads as one", () => {
    const view = parseRequesterView(
      { status: "done", pr_url: "https://github.com/o/r/pull/9", verdict: "approve", merged: true },
      "i9",
    );
    assert.ok(view && isFinished(view));
    const made = requesterViewItem(view, { seq: 4 });
    assert.equal(made.boardState, "done");
    assert.equal(made.outcome, "done");
    assert.equal(made.seq, 4);
    assert.equal(made.title, "https://github.com/o/r/pull/9");
    assert.deepEqual(made.params, {
      requester_view: { status: "done", pr_url: "https://github.com/o/r/pull/9", verdict: "approve", merged: true },
    });
    assert.equal(requesterViewItem(view, null).seq, 0);
    const open = parseRequesterView({ status: "queued", pr_url: "u" }, "q");
    assert.ok(open);
    assert.equal(requesterViewItem(open, {}).boardState, "in_progress");
    assert.equal(requesterViewItem(open, {}).outcome, null);
    assert.deepEqual(
      decidedItem("i9", { status: "done", pr_url: "u", merged: true }),
      requesterViewItem({ ...view, prUrl: "u", verdict: "" }, {}),
    );
    assert.equal(decidedItem("i9", { item_id: "i9", board_state: "done" })?.boardState, "done");
    assert.equal(decidedItem("i9", { title: "no view, no id" }), null);
  });
});
