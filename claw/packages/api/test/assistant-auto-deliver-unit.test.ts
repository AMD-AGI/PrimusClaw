// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Auto-delivery of ready results, the parts that need no database (the rest: `assistant-auto-deliver.test.ts`).
 *
 *   U1  the pull requests a ready result names: by link or as owner/repo#123, case folded, nothing else
 *   U2  the wake message of a delivered result tells the router there is nothing to accept and how a change reaches the item; a
 *       result that waits for the Accept says nothing of the kind
 *   U3  the item list says a delivered item needs nothing, that a change goes to it with work_send, and what it still watches; an item
 *       accepted by the user or a posted review reads as before
 *   U4  an item stands delivered only while closed as accepted by that delivery, or open only to watch its pull request
 *   U5  a watching item holds no slot, by the same SQL that counts the slots
 */
import assert from "node:assert/strict";
import test from "node:test";

import { deliveredLine, formatWorkEvent, itemStatus } from "../src/assistant/prompts.js";
import { deliveredOf } from "../src/assistant/outbound.js";
import { pullRequestsInRefs, RUNNING } from "../src/assistant/work-items.js";

test("U1 the pull requests a ready result names", () => {
  const prs = pullRequestsInRefs({
    refs: [
      { type: "pull_request", url: "https://github.com/Acme/App/pull/7/files" },
      { type: "pr", url: "acme/other#12" },
      { type: "commit", sha: "abc" },
      { type: "issue", url: "https://github.com/acme/app/issues/3" },
      { type: "pr", url: "https://gitlab.com/acme/app/pull/9" },
      { type: "pr", url: 42 },
    ],
  });
  assert.deepEqual([...prs], ["acme/app#7", "acme/other#12"]);
  assert.deepEqual([...pullRequestsInRefs(undefined)], []);
  assert.deepEqual([...pullRequestsInRefs({ refs: "https://github.com/acme/app/pull/7" })], []);
});

test("U2 the wake message of a delivered result says there is nothing to accept and how a change reaches the item", () => {
  const base = { itemId: "kwi_1", seq: 3, kind: "ready" as const, version: 2, summary: "Opened the PR." };
  const closed = formatWorkEvent({ ...base, delivered: { watching: [] } });
  assert.equal(closed, `[work_event] #3 (item_id: kwi_1) ready v2: Opened the PR.\n${deliveredLine([])}`);
  assert.match(closed, /nothing for the user to accept and no Accept button\. The item is closed\./);
  assert.match(closed, /send such a reply to this item with work_send, which opens it again within 7 days\.$/);
  const watching = formatWorkEvent({ ...base, delivered: { watching: ["acme/app#7"] } });
  assert.match(watching, /The item stays open watching acme\/app#7: new comments, reviews and failed CI there reach its worker/);
  assert.match(watching, /that it keeps following acme\/app#7/);
  assert.ok(!watching.includes("opens it again"), "an open item needs no reopening");
  // Waiting for the Accept, as before: not a word of delivery.
  assert.equal(formatWorkEvent(base), "[work_event] #3 (item_id: kwi_1) ready v2: Opened the PR.");
  assert.equal(formatWorkEvent({ ...base, delivered: null }), "[work_event] #3 (item_id: kwi_1) ready v2: Opened the PR.");
});

test("U3 the item list: a delivered item needs nothing, a change goes to it, and what it still watches", () => {
  const done = { boardState: "done", lastReportKind: "ready", outcome: "accepted", pendingQuestion: null };
  assert.equal(
    itemStatus({ ...done, delivered: { version: 2, watching: [] } }),
    "closed, result v2 delivered with nothing to accept; needs nothing. A change the user asks for within 7 days of closing goes to this item with work_send, which opens it again",
  );
  assert.equal(itemStatus(done), "closed, accepted by the user; needs nothing");
  assert.equal(itemStatus({ ...done, review: { pr: "a/b#1", actingAsName: null, model: null, reviewOnly: true } }), "closed, the review was posted; needs nothing");
  assert.equal(
    itemStatus({ boardState: "in_progress", lastReportKind: "ready", outcome: null, pendingQuestion: null, delivered: { version: 1, watching: ["acme/app#7"] } }),
    "result v1 delivered with nothing to accept; still watching acme/app#7 for comments and failed CI until it is merged or closed; needs nothing. A change the user asks for goes to this item with work_send",
  );
  // Worked on again after its delivery (news on the pull request): in progress, as any.
  assert.equal(itemStatus({ boardState: "in_progress", lastReportKind: "progress", outcome: null, pendingQuestion: null, delivered: { version: 1, watching: [] } }), "in progress");
});

test("U4 an item stands delivered only while closed by its delivery or open only to watch", () => {
  const p = (params: Record<string, unknown>) => params;
  assert.deepEqual(deliveredOf({ board_state: "done", outcome: "accepted", params: p({ delivered: 2 }) }), { version: 2, watching: [] });
  assert.deepEqual(
    deliveredOf({ board_state: "in_progress", outcome: null, params: p({ delivered: 1, watching_pr: ["acme/app#7", 3] }) }),
    { version: 1, watching: ["acme/app#7"] },
  );
  assert.equal(deliveredOf({ board_state: "done", outcome: "stopped", params: p({ delivered: 1 }) }), null, "stopped after it");
  assert.equal(deliveredOf({ board_state: "in_progress", outcome: null, params: p({ delivered: 1 }) }), null, "worked on again");
  assert.equal(deliveredOf({ board_state: "done", outcome: "accepted", params: p({}) }), null, "accepted by the user");
  assert.equal(deliveredOf({ board_state: "done", outcome: "accepted", params: null }), null);
  assert.equal(deliveredOf({ board_state: "done", outcome: "accepted", params: p({ delivered: "x" }) }), null);
});

test("U5 a watching item holds no slot", () => {
  assert.match(RUNNING, /NOT \(params \? 'watching_pr'\)/);
  assert.match(RUNNING, /NOT \(params \? 'ci_waiting'\)/);
});
