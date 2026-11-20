// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What became of a review's pull request, and whose account merges it (`GithubReview.followPullRequest`, `decide`), against a real
 * PostgreSQL engine (PGlite) and a fake GitHub that records every request. bob (`u-bob`) reviews; alice (`u-alice`) asked and wrote
 * the pull request. The merge is bob's; alice's own account merges only when bob's cannot, and only on her yes (2026-11-20).
 *
 *   F1  bob's merge was not refused for a permission (or is held for him): the follow reads with bob's account only, asks alice nothing,
 *       leaves bob's held merge his, and never fetches alice's credential
 *   F2  bob's merge of the head was refused for a permission (no_merge_permission, merge_not_permitted): alice is asked once (a
 *       requester_merge confirmation that is hers), nothing is written; her yes reads every gate again and merges with her account, and
 *       closes a held merge of bob's for that head as merged by her; bob cannot answer her question
 *   F3  no question without this session's own approval of the current head as GitHub has it now, when alice did not write the pull
 *       request or may not push, when bob's refusal was of another head, or while CI is not green, a thread is open or the merge state is
 *       not CLEAN; a refusal of bob's for another reason (not_mergeable) asks nothing either
 *   F4  her no: nothing merged, and she is not asked again for that head
 *   F5  her yes after a gate shut merges nothing (CI red, a new commit, a dismissed approval); bob deciding his held merge, or holding the
 *       lock on his writes, goes first and her yes waits to be pressed again; a merge GitHub refuses gives bob's held merge back
 *   F5b GitHub's 405 "Base branch was modified" on alice's merge is retried twice, 1 s and 2 s apart, then reported as not_mergeable
 *   F6  merged or closed on GitHub: said so, with whichever account reads it, and everything still held for an answer is closed
 *   F7  a review that may not merge by the requester (a review only, or bob's own) only reads, with bob's account
 *   F8  alice has no GitHub account bound: the pull request is read with bob's account, nothing is asked or merged
 *   F9  writes switched off: she is asked, and her yes merges nothing
 *   F10 a merge queue: her yes queues it as alice, never merges it directly
 *   F11 already in the merge queue: nothing is asked or written, bob's held merge is closed (not left counting against his limit), and bob
 *       deciding it right now still goes first
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
  // The review session is bob's, acting as bob, as a review asked of him is.
  await e.sql("INSERT INTO claw_sessions (session_id, user_id, config) VALUES ('s-1', 'u-bob', '{\"acting_as\":\"u-bob\"}'::jsonb)");
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

/** bob's `gh_pr_merge` of `head`, as the review tools record it: refused with `detail` (his account may not merge, by default). */
async function bobMergeRefused(detail = "merge_not_permitted", head = HEAD): Promise<void> {
  await e.sql(
    `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, repo, pr, head_sha, result, detail)
     VALUES ('u-alice', 'u-bob', 's-1', 'gh_pr_merge', 'AMD-AGI/demo', 7, $1, 'refused', $2)`,
    [head, detail],
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
const asks = async () => e.sql("SELECT confirmation_id, actor_user_id, requester_user_id, status, head_sha FROM claw_github_confirmations WHERE kind = 'requester_merge' ORDER BY created_at");

/** bob approved the head and could not merge it; the follow asks alice. Her question's id. */
async function askAlice(): Promise<string> {
  await approvedByBob();
  await bobMergeRefused();
  const o = await follow();
  assert.deepEqual([o.body.status, o.body.reason], ["waiting", "requester_asked"], o.text);
  return String(o.body.confirmation_id);
}

describe("F whose account merges after the reviewer's approval", () => {
  test("F1 bob's merge was not refused for a permission, or is held for him: read with bob's account only, nothing asked of alice", async () => {
    await approvedByBob();
    const held = await heldForBob();
    let o = await follow();
    assert.equal(o.body.status, "open", o.text);
    // bob's merge refused for another reason (a conflict, a check): still bob's.
    await bobMergeRefused("merge_state_not_clean");
    o = await follow();
    assert.equal(o.body.status, "open", o.text);
    await bobMergeRefused("not_mergeable");
    o = await follow();
    assert.equal(o.body.status, "open", o.text);
    assert.ok(e.gh.calls.every((c) => c.authorization === `Bearer ${TOKEN}`), "only bob's account reads");
    assert.ok(e.resolved.every((r) => r.userId === "u-bob"), JSON.stringify(e.resolved));
    assert.equal(writes().length, 0);
    assert.deepEqual(await asks(), []);
    assert.equal((await statusOf(held)).status, "pending", "bob's held merge is his to answer");
    const audit = await e.sql("SELECT actor_user_id, detail FROM claw_github_audit WHERE tool = 'gh_pr_follow'");
    assert.ok(audit.every((a) => a.actor_user_id === "u-bob" && a.detail === "open"), JSON.stringify(audit));
  });

  test("F2 bob cannot merge: alice is asked once, and her yes reads every gate again and merges with her account", async () => {
    await approvedByBob();
    const held = await heldForBob();
    await bobMergeRefused();
    let o = await follow();
    assert.deepEqual([o.body.status, o.body.reason, o.body.approved_by, o.body.reviewer_refusal], ["waiting", "requester_asked", "bob", "merge_not_permitted"], o.text);
    const id = String(o.body.confirmation_id);
    assert.equal(writes().length, 0, "asking writes nothing");
    assert.deepEqual((await asks()).map((a) => [a.confirmation_id, a.actor_user_id, a.requester_user_id, a.status, a.head_sha]),
      [[id, "u-alice", "u-alice", "pending", HEAD]], "the question is alice's");
    // Asked again: the same question, not a second one.
    o = await follow();
    assert.equal(o.body.confirmation_id, id);
    assert.equal((await asks()).length, 1);
    // no_merge_permission is the same as merge_not_permitted.
    await bobMergeRefused("no_merge_permission");
    o = await follow();
    assert.equal(o.body.confirmation_id, id);
    // Only alice answers it.
    const notBob = await e.service.decide("u-bob", id, "allow");
    assert.equal(notBob.http, 403);
    e.gh.calls.length = 0;
    const yes = await e.service.decide("u-alice", id, "allow");
    assert.equal(yes.body.status, "merged", JSON.stringify(yes.body));
    assert.equal(puts().length, 1);
    assert.equal(puts()[0]!.authorization, `Bearer ${REQUESTER_TOKEN}`, "merged with alice's own token");
    assert.deepEqual(puts()[0]!.body, { sha: HEAD, merge_method: "squash" });
    assert.ok(!e.gh.calls.some((c) => c.authorization === `Bearer ${TOKEN}`), "bob's account is not used for her merge");
    assert.ok(e.gh.calls.some((c) => /\/check-runs$/.test(c.path)), "CI read again at her yes");
    assert.ok(e.gh.calls.some((c) => /\/reviews\/880$/.test(c.path)), "bob's approval read again at her yes");
    assert.equal((await statusOf(id)).status, "merged");
    const c = await statusOf(held);
    assert.deepEqual([c.status, c.decided_by, c.result.by], ["merged", "u-alice", "requester"], "bob's held merge closes as hers");
    const audit = await e.sql("SELECT tool, result, detail, requester_user_id, actor_user_id, write FROM claw_github_audit WHERE tool = 'gh_pr_merge_as_requester'");
    assert.deepEqual(audit, [{ tool: "gh_pr_merge_as_requester", result: "ok", detail: "merged", requester_user_id: "u-alice", actor_user_id: "u-alice", write: true }]);
    // bob's card for his held merge no longer makes anything, and her second press neither.
    e.gh.calls.length = 0;
    assert.deepEqual([(await e.service.decide("u-bob", held, "allow")).body.reason], ["not_pending"]);
    assert.deepEqual([(await e.service.decide("u-alice", id, "allow")).body.reason], ["not_pending"]);
    assert.equal(writes().length, 0);
  });

  test("F3 no question without this session's approval of the head, alice's authorship and push, bob's refusal of this head, and open gates", async () => {
    await bobMergeRefused();
    // None recorded.
    let o = await follow();
    assert.equal(o.body.reason, "approval_missing", o.text);
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
    await approvedByBob();
    // Not hers.
    e.gh.pr.user = { login: "mallory" };
    o = await follow();
    assert.equal(o.body.reason, "requester_not_author", o.text);
    e.gh.pr.user = { login: "alice" };
    e.gh.repo.permissions = { push: false, pull: true, admin: false };
    o = await follow();
    assert.equal(o.body.reason, "no_merge_permission", o.text);
    e.gh.repo.permissions = { push: true, pull: true, admin: false };
    // bob's refusal was of another head: this one is still his to merge, and she is not asked.
    await e.sql("UPDATE claw_github_audit SET head_sha = $1 WHERE tool = 'gh_pr_merge'", ["2".repeat(40)]);
    o = await follow();
    assert.deepEqual([o.body.status, o.body.reason], ["waiting", "reviewer_may_merge"], o.text);
    await e.sql("UPDATE claw_github_audit SET head_sha = $1 WHERE tool = 'gh_pr_merge'", [HEAD]);
    // A later merge of bob's of this head, refused for another reason, is the one that counts.
    await bobMergeRefused("ci_not_green");
    o = await follow();
    assert.equal(o.body.status, "open", o.text);
    await bobMergeRefused();
    // CI, threads, the merge state.
    e.gh.checkRuns = [{ name: "test", status: "in_progress", conclusion: null }];
    o = await follow();
    assert.equal(o.body.reason, "ci_not_green", o.text);
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
    e.gh.graphql.reviewThreads = { totalCount: 1, nodes: [{ isResolved: false }] };
    o = await follow();
    assert.equal(o.body.reason, "threads_unresolved", o.text);
    e.gh.graphql.reviewThreads = { totalCount: 0, nodes: [] };
    e.gh.graphql.mergeStateStatus = "BEHIND";
    o = await follow();
    assert.equal(o.body.reason, "merge_state_not_clean", o.text);
    assert.equal(e.gh.pr.draft, false);
    e.gh.pr.draft = true;
    o = await follow();
    assert.equal(o.body.reason, "draft", o.text);
    assert.deepEqual(await asks(), [], "nothing asked while a gate is shut");
    assert.equal(writes().length, 0);
    // And once every gate is open, she is asked.
    e.gh.pr.draft = false;
    e.gh.graphql.mergeStateStatus = "CLEAN";
    o = await follow();
    assert.equal(o.body.reason, "requester_asked", o.text);
  });

  test("F4 her no: nothing merged, and she is not asked again for that head", async () => {
    const id = await askAlice();
    const no = await e.service.decide("u-alice", id, "deny");
    assert.equal(no.body.status, "denied");
    const o = await follow();
    assert.deepEqual([o.body.status, o.body.reason, o.body.confirmation_id], ["waiting", "requester_declined", id], o.text);
    assert.equal((await asks()).length, 1);
    assert.equal(writes().length, 0);
  });

  test("F5 her yes after a gate shut merges nothing; bob deciding or writing goes first and her yes waits; GitHub's refusal gives bob's held merge back", async () => {
    // CI turned red after she was asked.
    let id = await askAlice();
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }];
    let a = await e.service.decide("u-alice", id, "allow");
    assert.deepEqual([a.body.status, a.body.reason], ["refused", "ci_not_green"], JSON.stringify(a.body));
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
    // bob's approval was dismissed.
    await e.sql("DELETE FROM claw_github_confirmations");
    id = await askAlice();
    e.gh.reviews[0]!.state = "DISMISSED";
    a = await e.service.decide("u-alice", id, "allow");
    assert.deepEqual([a.body.status, a.body.reason], ["refused", "approval_missing"], JSON.stringify(a.body));
    e.gh.reviews[0]!.state = "APPROVED";
    // A new commit since.
    await e.sql("DELETE FROM claw_github_confirmations");
    id = await askAlice();
    e.gh.pr.head = { ...e.gh.pr.head, sha: "2".repeat(40) };
    a = await e.service.decide("u-alice", id, "allow");
    assert.deepEqual([a.body.status, a.body.reason], ["stale", "head_moved"], JSON.stringify(a.body));
    e.gh.pr.head = { ...e.gh.pr.head, sha: HEAD };
    assert.equal(writes().length, 0);
    // bob deciding his held merge right now: her yes is given back, to press again.
    await e.sql("DELETE FROM claw_github_confirmations");
    id = await askAlice();
    const held = await heldForBob();
    await e.sql("UPDATE claw_github_confirmations SET status = 'merging' WHERE confirmation_id = $1", [held]);
    a = await e.service.decide("u-alice", id, "allow");
    assert.deepEqual([a.body.status, a.body.reason], ["retry", "reviewer_deciding"], JSON.stringify(a.body));
    assert.equal((await statusOf(id)).status, "pending");
    await e.sql("UPDATE claw_github_confirmations SET status = 'pending' WHERE confirmation_id = $1", [held]);
    // bob holding the lock on his writes to it: the same.
    const holder = await acquireWriteLock(e.db, writeLockKey("u-bob", REF), 120);
    assert.ok(holder);
    a = await e.service.decide("u-alice", id, "allow");
    assert.deepEqual([a.body.status, a.body.reason], ["retry", "write_in_progress"], JSON.stringify(a.body));
    await e.sql("DELETE FROM claw_github_write_locks");
    assert.equal(writes().length, 0);
    // GitHub refuses her merge: nothing is said merged, and bob's held merge waits for him again.
    e.gh.mergeStatus = 405;
    a = await e.service.decide("u-alice", id, "allow");
    assert.deepEqual([a.body.status, a.body.reason], ["refused", "not_mergeable"], JSON.stringify(a.body));
    assert.equal((await statusOf(held)).status, "pending");
  });

  test("F5b GitHub's 405 \"Base branch was modified\" on alice's merge is retried after 1 s and 2 s; merged on a retry; refused a third time, it is not_mergeable", async () => {
    const moved = { status: 405, message: "Base branch was modified. Review and try the merge again." };
    let id = await askAlice();
    e.gh.mergeAnswers = [moved, { status: 200, message: "" }];
    let a = await e.service.decide("u-alice", id, "allow");
    assert.equal(a.body.status, "merged", JSON.stringify(a.body));
    assert.equal(puts().length, 2);
    assert.deepEqual(e.sleeps, [1000]);
    e.gh.calls.length = 0;
    e.sleeps.length = 0;
    await e.sql("DELETE FROM claw_github_confirmations");
    id = await askAlice();
    e.gh.mergeAnswers = [moved, moved, moved, { status: 200, message: "" }];
    a = await e.service.decide("u-alice", id, "allow");
    assert.deepEqual([a.body.status, a.body.reason], ["refused", "not_mergeable"], JSON.stringify(a.body));
    assert.equal(puts().length, 3);
    assert.deepEqual(e.sleeps, [1000, 2000]);
  });

  test("F6 merged or closed on GitHub: said so, and what the session held for an answer is closed", async () => {
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
    // Closed while alice's question waits for her: it is closed too.
    await e.sql("DELETE FROM claw_github_confirmations");
    e.gh.pr.state = "open";
    const id = await askAlice();
    e.gh.pr.state = "closed";
    o = await follow();
    assert.equal(o.body.status, "closed", o.text);
    assert.equal((await statusOf(id)).status, "stale");
  });

  test("F7 a review that may not merge by the requester only reads, with bob's account, and bob's switch still counts", async () => {
    await approvedByBob();
    await bobMergeRefused();
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
    assert.deepEqual(await asks(), []);
  });

  test("F8 alice has no GitHub account bound: the pull request is read with bob's account and nothing is asked or merged", async () => {
    await approvedByBob();
    await bobMergeRefused();
    e.identity.answer = async (req) => {
      if (req.userId === "u-alice") throw new IdentityCredentialRefusedError("not_bound", 404, "credential");
      return directory()(req);
    };
    let o = await follow();
    assert.equal(o.body.status, "open", o.text);
    assert.equal(writes().length, 0);
    assert.deepEqual(await asks(), []);
    e.gh.pr.merged = true;
    o = await follow();
    assert.equal(o.body.status, "already_merged", o.text);
  });

  test("F9 writes switched off: she is asked, and her yes merges nothing", async () => {
    e.configure({ CLAW_GITHUB_WRITES_ENABLED: "false" });
    const id = await askAlice();
    const a = await e.service.decide("u-alice", id, "allow");
    assert.deepEqual([a.body.status, a.body.reason], ["refused", "writes_disabled"], JSON.stringify(a.body));
    assert.equal(writes().length, 0);
  });

  test("F10 a merge queue: her yes queues it as alice, never merges it directly", async () => {
    e.gh.graphql.isMergeQueueEnabled = true;
    e.gh.enqueueEntry = { id: "MQE_1", position: 1, state: "QUEUED" };
    const id = await askAlice();
    const held = await heldForBob();
    const a = await e.service.decide("u-alice", id, "allow");
    assert.equal(a.body.status, "queued", JSON.stringify(a.body));
    assert.equal(puts().length, 0);
    assert.equal(e.gh.enqueues.length, 1);
    assert.equal(e.gh.enqueues[0]!.authorization, `Bearer ${REQUESTER_TOKEN}`);
    assert.equal((await statusOf(held)).status, "queued");
    assert.equal((await statusOf(id)).status, "queued");
  });

  test("F11 already in the merge queue: nothing is asked or written and bob's held merge is closed, unless bob is deciding it right now", async () => {
    await approvedByBob();
    await bobMergeRefused();
    e.gh.graphql.isInMergeQueue = true;
    e.gh.graphql.mergeQueueEntry = { id: "MQE_9", position: 2, state: "QUEUED" };
    const held = await heldForBob();
    await e.sql("UPDATE claw_github_confirmations SET status = 'merging' WHERE confirmation_id = $1", [held]);
    let o = await follow();
    assert.equal(o.body.reason, "reviewer_deciding", o.text);
    await e.sql("UPDATE claw_github_confirmations SET status = 'pending' WHERE confirmation_id = $1", [held]);
    o = await follow();
    assert.equal(o.body.status, "queued", o.text);
    assert.equal(o.body.already_queued, true);
    assert.equal(e.gh.enqueues.length, 0);
    assert.equal(writes().length, 0);
    assert.deepEqual(await asks(), []);
    const c = await statusOf(held);
    assert.deepEqual([c.status, c.result.reason], ["stale", "pr_queued"]);
  });
});
