// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What became of a review's pull request, and the requester's own merge of it (`GithubReview.followPullRequest`), against a real
 * PostgreSQL engine (PGlite) and a fake GitHub that records every request. bob (`u-bob`) reviews; alice (`u-alice`) asked and wrote
 * the pull request.
 *
 *   F1  bob's approval of the head is on GitHub, CI is green, the merge state is CLEAN: alice's account merges, bob's held merge closes as
 *       merged by her, and bob's later answer to it makes nothing
 *   F2  no merge without this session's own approval of the current head, as GitHub has it now (missing, other commit, dismissed)
 *   F3  no merge when alice did not write the pull request, or may not push
 *   F4  no merge while CI is not green, a thread is open, or the merge state is not CLEAN; nothing is written and it is tried again later
 *   F5  bob deciding his held merge right now, or holding the lock on his writes to it, goes first
 *   F6  merged or closed on GitHub: said so, with whichever account reads it, and everything still held for bob's answer is closed
 *   F7  a review that may not merge by the requester (a review only, or bob's own) only reads, with bob's account
 *   F8  alice has no GitHub account bound: the pull request is read with bob's account, nothing is merged
 *   F9  writes switched off: every gate is read and nothing is merged
 *   F10 a merge queue: the pull request is queued as alice, never merged directly
 */
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { IdentityCredentialRefusedError } from "@claw/utils";
import type { FollowRequest } from "../src/github-review/service.js";
import { acquireWriteLock, openConfirmation, writeLockKey } from "../src/github-review/store.js";
import { HEAD } from "./support/fake-github.js";
import { REQUESTER_TOKEN, TOKEN, closeShared, directory, ownApproval, reviewEnv, type ReviewEnv } from "./support/review-env.js";

let e: ReviewEnv;
beforeEach(async () => {
  e = await reviewEnv();
  // alice's own account is `alice`, the pull request's author.
  e.identity.answer = directory({}, { providerLogin: "alice" });
});
afterEach(async () => { await e.close(); });
after(closeShared);

const REF = { owner: "AMD-AGI", repo: "demo", number: 7 };
const asked = (over: Partial<FollowRequest> = {}): FollowRequest => ({
  sessionId: "s-1", ref: REF, actingUserId: "u-bob", requesterUserId: "u-alice", requesterLabel: "Alice A", mergeByRequester: true, ...over,
});
const follow = (over: Partial<FollowRequest> = {}) => e.service.followPullRequest(asked(over));
const puts = () => e.gh.calls.filter((c) => c.method === "PUT");
const writes = () => e.gh.calls.filter((c) => c.method === "PUT" || (c.method === "POST" && c.path !== "/graphql"));

/** bob's approval of `head`, posted by this session: on GitHub, and on the session's audit row as the review tools record it. */
async function approvedByBob(o: { head?: string; onGithub?: Record<string, unknown> | null; id?: number } = {}): Promise<void> {
  const head = o.head ?? HEAD;
  const id = o.id ?? 880;
  if (o.onGithub !== null) e.gh.reviews.push({ ...ownApproval("s-1", head), id, ...o.onGithub });
  await e.sql(
    `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, repo, pr, head_sha, result, detail, posted)
     VALUES ('u-alice', 'u-bob', 's-1', 'gh_review_submit', 'AMD-AGI/demo', 7, $1, 'ok', 'submitted', $2::jsonb)`,
    [head, JSON.stringify({ event: "APPROVE", review_id: id, findings: [] })],
  );
}

/** A merge the session holds for bob's answer, as a held `gh_pr_merge` leaves it. */
async function heldForBob(head = HEAD): Promise<string> {
  const c = await openConfirmation(e.db, {
    sessionId: "s-1", requesterUserId: "u-alice", actorUserId: "u-bob", repo: "AMD-AGI/demo", pr: 7, headSha: head, title: "Fix the thing",
    author: "alice", kind: "merge", review: null, reasons: ["held"], checks: {}, ttlSeconds: 3600,
  });
  return c.id;
}

const statusOf = async (id: string) => (await e.sql("SELECT status, decided_by, result FROM claw_github_confirmations WHERE confirmation_id = $1", [id]))[0]!;

describe("F the requester's merge after the reviewer's approval", () => {
  test("F1 alice's account merges once bob's approval of the head is on GitHub and every gate is open; bob's held merge closes as hers", async () => {
    await approvedByBob();
    const held = await heldForBob();
    const o = await follow();
    assert.equal(o.body.status, "merged", o.text);
    assert.equal(o.body.approved_by, "bob");
    assert.equal(puts().length, 1);
    assert.equal(puts()[0]!.authorization, `Bearer ${REQUESTER_TOKEN}`, "the merge is made with alice's own token");
    assert.deepEqual(puts()[0]!.body, { sha: HEAD, merge_method: "squash" });
    assert.ok(!e.gh.calls.some((c) => c.authorization === `Bearer ${TOKEN}`), "bob's account is not used for any of it");
    assert.ok(e.resolved.every((r) => r.userId === "u-alice" && r.requesterUserId === "u-alice"), JSON.stringify(e.resolved));
    const c = await statusOf(held);
    assert.equal(c.status, "merged");
    assert.equal(c.decided_by, "u-alice");
    assert.equal(c.result.by, "requester");
    const audit = await e.sql("SELECT tool, result, detail, requester_user_id, actor_user_id, write FROM claw_github_audit WHERE tool = 'gh_pr_follow'");
    assert.deepEqual(audit, [{ tool: "gh_pr_follow", result: "ok", detail: "merged", requester_user_id: "u-alice", actor_user_id: "u-alice", write: true }]);
    // bob's card for it no longer makes anything.
    e.gh.calls.length = 0;
    const late = await e.service.decide("u-bob", held, "allow");
    assert.equal(late.body.status, "refused");
    assert.equal(late.body.reason, "not_pending");
    assert.equal(writes().length, 0);
  });

  test("F2 no merge without this session's approval of the current head, as GitHub has it now", async () => {
    // None recorded.
    let o = await follow();
    assert.equal(o.body.status, "waiting", o.text);
    assert.equal(o.body.reason, "approval_missing");
    // Recorded for another commit (a push came after it).
    await approvedByBob({ head: "2".repeat(40), id: 881 });
    o = await follow();
    assert.equal(o.body.reason, "approval_missing");
    // Recorded, but GitHub no longer has it as an approval (dismissed).
    await approvedByBob({ id: 882, onGithub: { state: "DISMISSED" } });
    o = await follow();
    assert.equal(o.body.reason, "approval_missing");
    // Recorded by the session, but not on GitHub at all.
    await approvedByBob({ id: 883, onGithub: null });
    o = await follow();
    assert.equal(o.body.reason, "approval_missing");
    // An approval on GitHub of the head, by the session's marker, that the session's audit never recorded is not one.
    e.gh.reviews.push({ ...ownApproval("s-1"), id: 990 });
    o = await follow();
    assert.equal(o.body.reason, "approval_missing");
    assert.equal(writes().length, 0);
  });

  test("F3 no merge when alice's account did not write the pull request, or may not push to the repository", async () => {
    await approvedByBob();
    e.gh.pr.user = { login: "mallory" };
    let o = await follow();
    assert.equal(o.body.reason, "requester_not_author", o.text);
    e.gh.pr.user = { login: "alice" };
    e.gh.repo.permissions = { push: false, pull: true, admin: false };
    o = await follow();
    assert.equal(o.body.reason, "no_merge_permission", o.text);
    assert.equal(writes().length, 0);
  });

  test("F4 nothing is merged while CI is not green, a thread is open or the merge state is not CLEAN; the held merge stays bob's", async () => {
    await approvedByBob();
    const held = await heldForBob();
    e.gh.checkRuns = [{ name: "test", status: "in_progress", conclusion: null }];
    let o = await follow();
    assert.equal(o.body.reason, "ci_not_green", o.text);
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
    e.gh.graphql.reviewThreads = { totalCount: 1, nodes: [{ isResolved: false }] };
    o = await follow();
    assert.equal(o.body.reason, "threads_unresolved", o.text);
    e.gh.graphql.reviewThreads = { totalCount: 0, nodes: [] };
    e.gh.graphql.mergeStateStatus = "BEHIND";
    o = await follow();
    assert.equal(o.body.reason, "merge_state_not_clean", o.text);
    assert.equal(writes().length, 0);
    assert.equal((await statusOf(held)).status, "pending");
    // And once it is, it merges.
    e.gh.graphql.mergeStateStatus = "CLEAN";
    o = await follow();
    assert.equal(o.body.status, "merged", o.text);
  });

  test("F5 bob deciding his held merge right now, or holding the lock on his writes, goes first; a failed merge gives the held merge back", async () => {
    await approvedByBob();
    const held = await heldForBob();
    await e.sql("UPDATE claw_github_confirmations SET status = 'merging' WHERE confirmation_id = $1", [held]);
    let o = await follow();
    assert.equal(o.body.reason, "reviewer_deciding", o.text);
    await e.sql("UPDATE claw_github_confirmations SET status = 'pending' WHERE confirmation_id = $1", [held]);
    const holder = await acquireWriteLock(e.db, writeLockKey("u-bob", REF), 120);
    assert.ok(holder);
    o = await follow();
    assert.equal(o.body.reason, "write_in_progress", o.text);
    assert.equal(writes().length, 0);
    await e.sql("DELETE FROM claw_github_write_locks");
    // GitHub refuses the merge: nothing is said merged, and bob's held merge waits for him again.
    e.gh.mergeStatus = 405;
    o = await follow();
    assert.equal(o.body.reason, "not_mergeable", o.text);
    assert.equal((await statusOf(held)).status, "pending");
  });

  test("F6 merged or closed on GitHub: said so, and what the session held for bob's answer is closed", async () => {
    const held = await heldForBob();
    e.gh.pr.merged = true;
    e.gh.pr.state = "closed";
    let o = await follow();
    assert.equal(o.body.status, "already_merged", o.text);
    const c = await statusOf(held);
    assert.equal(c.status, "stale");
    assert.equal(c.result.reason, "pr_merged");
    assert.equal(writes().length, 0);
    // Closed without a merge, read with bob's account (a review only).
    const again = await heldForBob("3".repeat(40));
    e.gh.pr.merged = false;
    o = await follow({ mergeByRequester: false });
    assert.equal(o.body.status, "closed", o.text);
    assert.equal((await statusOf(again)).result.reason, "pr_closed");
    assert.equal(e.gh.calls.at(-1)!.authorization, `Bearer ${TOKEN}`);
  });

  test("F7 a review that may not merge by the requester only reads, with bob's account, and bob's switch still counts", async () => {
    await approvedByBob();
    let o = await follow({ mergeByRequester: false });
    assert.equal(o.body.status, "open", o.text);
    assert.equal(writes().length, 0);
    assert.ok(e.gh.calls.every((c) => c.authorization === `Bearer ${TOKEN}`));
    // bob's own review: nobody else to merge for.
    o = await follow({ requesterUserId: "u-bob" });
    assert.equal(o.body.status, "open", o.text);
    // bob turned his switch off: alice's request reads nothing with his account.
    e.identity.answer = directory({ delegation: false }, { providerLogin: "alice" });
    o = await follow({ mergeByRequester: false });
    assert.equal(o.body.reason, "delegation_off", o.text);
    assert.equal(writes().length, 0);
  });

  test("F8 alice has no GitHub account bound: the pull request is read with bob's account and nothing is merged", async () => {
    await approvedByBob();
    e.identity.answer = async (req) => {
      if (req.userId === "u-alice") throw new IdentityCredentialRefusedError("not_bound", 404, "credential");
      return directory()(req);
    };
    let o = await follow();
    assert.equal(o.body.status, "open", o.text);
    assert.equal(writes().length, 0);
    e.gh.pr.merged = true;
    o = await follow();
    assert.equal(o.body.status, "already_merged", o.text);
  });

  test("F9 writes switched off: every gate is read and nothing is merged", async () => {
    e.configure({ CLAW_GITHUB_WRITES_ENABLED: "false" });
    await approvedByBob();
    const o = await follow();
    assert.equal(o.body.status, "would_merge", o.text);
    assert.equal(writes().length, 0);
  });

  test("F10 a merge queue: the pull request is queued as alice, never merged directly", async () => {
    await approvedByBob();
    e.gh.graphql.isMergeQueueEnabled = true;
    e.gh.enqueueEntry = { id: "MQE_1", position: 1, state: "QUEUED" };
    const held = await heldForBob();
    const o = await follow();
    assert.equal(o.body.status, "queued", o.text);
    assert.equal(puts().length, 0);
    assert.equal(e.gh.enqueues.length, 1);
    assert.equal(e.gh.enqueues[0]!.authorization, `Bearer ${REQUESTER_TOKEN}`);
    assert.equal((await statusOf(held)).status, "queued");
  });
});
