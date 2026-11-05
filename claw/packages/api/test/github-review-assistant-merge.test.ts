// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review the assistant's router started or restarted (`ReviewActor.mergeNeedsConfirmation`, from the session's
 * `config.merge_needs_confirmation`): the router's `merge=true` is its reading of a sentence, and natural language never
 * approves a merge. Through the service the MCP tools call, against PGlite and a fake GitHub that records every request.
 *
 *   G1  its merge is held for the acting user whatever the risk and their review mode: nothing is merged, a confirmation waits for them
 *   G2  an approval that GitHub's auto-merge would turn into a merge is held the same way; without auto-merge the approval posts
 *   G3  the acting user's allow (the card's button or the exact command reach this same `decide`) makes the merge
 *   G4  anyone else's allow is refused, and nothing is merged
 *   G5  a session the router did not start merges as before
 *   G6  with auto-merge on, resolving the last conversation can be the merge: such a session (and a review-only one) resolves nothing;
 *       without auto-merge, or for a session that merges by itself, the thread is resolved as before
 */
import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach, describe } from "node:test";
import { setReviewMode } from "../src/github-review/store.js";
import { HEAD } from "./support/fake-github.js";
import { PR, closeShared, reviewEnv, type ReviewEnv } from "./support/review-env.js";

let e: ReviewEnv;
beforeEach(async () => { e = await reviewEnv({}, { actor: { mergeNeedsConfirmation: true }, approved: true }); e.gh.graphql.mergeStateStatus = "CLEAN"; });
afterEach(async () => { await e.close(); });
after(closeShared);

const LOW = { level: "low", reason: "an ordinary change, nothing for a person to look at" };
const merge = () => e.service.mergePr(e.actor, { pr: PR, head_sha: HEAD, risk_judgement: LOW });
const approve = () => e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "APPROVE", body: "Looks fine.", risk_judgement: LOW });
const puts = () => e.gh.calls.filter((c) => c.method === "PUT");
const pending = () => e.sql("SELECT confirmation_id, actor_user_id, requester_user_id, kind, status FROM claw_github_confirmations ORDER BY created_at");

describe("G a review the assistant started", () => {
  test("G1 its merge is held for the acting user, at low risk and under fully_auto alike: nothing is merged, a confirmation waits for them", async () => {
    for (const mode of ["high_risk_confirm", "fully_auto"] as const) {
      e = await reviewEnv({}, { actor: { mergeNeedsConfirmation: true }, approved: true }); e.gh.graphql.mergeStateStatus = "CLEAN";
      await setReviewMode(e.db, "u-bob", mode);
      const o = await merge();
      assert.equal(o.body.status, "confirmation_required", `${mode}: ${o.text}`);
      assert.equal(o.body.kind, "merge");
      assert.match(String((o.body.reasons as string[]).join(" ")), /started through bob's assistant/, mode);
      assert.equal(puts().length, 0, `${mode}: nothing merged`);
      assert.deepEqual((await pending()).map((r) => [r.actor_user_id, r.kind, r.status]), [["u-bob", "merge", "pending"]], mode);
    }
  });

  test("G2 an approval that auto-merge would turn into a merge is held; without auto-merge the approval posts and merges nothing", async () => {
    e.gh.reviews = [];
    e.gh.graphql.autoMergeRequest = { enabledAt: "2026-11-04T00:00:00Z" };
    const held = await approve();
    assert.deepEqual([held.body.status, held.body.kind], ["confirmation_required", "review"], held.text);
    assert.equal(e.gh.writes.length, 0, "nothing posted");
    e = await reviewEnv({}, { actor: { mergeNeedsConfirmation: true } });
    e.gh.graphql.autoMergeRequest = null;
    assert.equal((await approve()).body.status, "submitted");
    assert.equal(puts().length, 0);
  });

  test("G3 the acting user's allow makes the merge", async () => {
    const held = await merge();
    assert.equal(held.body.status, "confirmation_required", held.text);
    const r = await e.service.decide("u-bob", String(held.body.confirmation_id), "allow", null);
    assert.equal(r.body.status, "merged", JSON.stringify(r.body));
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].body.sha, HEAD);
    assert.deepEqual((await pending()).map((x) => x.status), ["merged"]);
  });

  test("G4 anyone else's allow is refused, the requester's included, and nothing is merged", async () => {
    const held = await merge();
    const id = String(held.body.confirmation_id);
    for (const who of ["u-alice", "u-mallory"]) {
      const r = await e.service.decide(who, id, "allow", null);
      assert.deepEqual([r.http, r.body.error], [403, "only_the_acting_user_can_decide"], who);
    }
    assert.equal(puts().length, 0);
    assert.deepEqual((await pending()).map((x) => x.status), ["pending"]);
  });

  test("G5 a session the router did not start merges as before, unasked", async () => {
    e = await reviewEnv({}, { approved: true }); e.gh.graphql.mergeStateStatus = "CLEAN";
    const o = await merge();
    assert.equal(o.body.status, "merged", o.text);
    assert.deepEqual(await pending(), []);
  });

  test("G6 with auto-merge on, a thread is not resolved by a session that may not merge by itself; otherwise it is", async () => {
    const recorded = { sinceHeadSha: "2".repeat(40), findings: [{ path: "src/app.ts", line: 3, thread_id: "PRRT_1", note: "c is wrong", resolved: false }] };
    const cases: Array<[string, Record<string, unknown>, boolean, string]> = [
      ["router-started, auto-merge on", { mergeNeedsConfirmation: true }, true, "auto_merge_on"],
      ["review only, auto-merge on", { reviewOnly: true }, true, "auto_merge_on"],
      ["router-started, auto-merge off", { mergeNeedsConfirmation: true }, false, "resolved"],
      ["not router-started, auto-merge on", {}, true, "resolved"],
    ];
    for (const [name, actor, autoMerge, want] of cases) {
      e = await reviewEnv({}, { actor, deps: { continuationOf: async () => recorded, recordPosted: true, sessionStopped: async () => false } });
      e.gh.threads.push({ id: "PRRT_1", isResolved: false, path: "src/app.ts", line: 3, reviewId: 800, author: "bob", pr: 7, repo: "AMD-AGI/demo" });
      e.gh.graphql.autoMergeRequest = autoMerge ? { enabledAt: "2026-11-04T00:00:00Z" } : null;
      const o = await e.service.resolveThread(e.actor, { pr: PR, thread_id: "PRRT_1", head_sha: HEAD });
      assert.equal(o.isError ? o.body.reason : o.body.status, want, `${name}: ${o.text}`);
      assert.equal(e.gh.resolves.length, want === "resolved" ? 1 : 0, `${name}: resolves`);
      assert.equal(e.gh.threads[0]?.isResolved, want === "resolved", name);
      assert.equal(puts().length, 0, `${name}: nothing merged`);
    }
  });
});
