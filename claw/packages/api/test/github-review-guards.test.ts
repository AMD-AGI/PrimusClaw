// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The guards around the account of someone who is asked for: what is held for them, what is refused up front, and which pull request a
 * session may touch at all. The service against a real PostgreSQL engine (PGlite) and a fake GitHub that records every request, so
 * "nothing was written" is a count of requests, and a refusal is asserted by its code and not by its being an error.
 *
 * The ordinary request is the author of a pull request asking for a committer's review and merge, which that committer has allowed once
 * (their delegation setting): it goes through as the committer, with no card, unless the change is high risk.
 *
 *   H  what is held for the acting user: a high-risk merge and a high-risk approval, each posted exactly as held, once, when they allow it
 *   A  the author of the pull request asks: no look at the requester's own GitHub, and the committer's account does the work
 *   Q  a base branch with a merge queue, shown by its rules or only by GitHub's own answer: refused before anything is written, before anyone is asked
 *   O  the acting user wrote the pull request: refused up front
 *   B  a session bound to one pull request: no tool call names another
 *   N  names: the footer, the marker and the repository's configuration file, and what an earlier release left behind
 */
import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach, describe } from "node:test";
import { LEGACY_REPO_CONFIG_STEM, LEGACY_RUN_MARKER_PREFIX } from "../src/github-review/legacy-names.js";
import type { ToolOutcome } from "../src/github-review/service.js";
import { HEAD } from "./support/fake-github.js";
import { PR, REQUESTER_TOKEN, TOKEN, closeShared, credential, directory, down, reviewEnv as makeEnv, unbound, type ReviewEnv } from "./support/review-env.js";

/**
 * The requester (`u-alice`, the author of the pull request) asks for the account of the acting user (`u-bob`, the committer), who has
 * allowed that, unless a test says the requester is the acting user.
 */
const env = (vars: Record<string, string> = {}, over: Parameters<typeof makeEnv>[1] = {}): Promise<ReviewEnv> => makeEnv(vars, over);
const own = { actor: { requesterUserId: "u-bob" } } as const;

let e: ReviewEnv;
beforeEach(async () => { e = await env(); });
afterEach(async () => { await e.close(); });
after(closeShared);

const get = () => e.service.getPr(e.actor, { pr: PR });
const submit = (over: Record<string, unknown> = {}) => e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "Looks fine.", ...over });
const merge = (over: Record<string, unknown> = {}) => e.service.mergePr(e.actor, { pr: PR, head_sha: HEAD, ...over });
const reason = (o: ToolOutcome) => String(o.body.reason ?? o.body.status);
const rows = () => e.sql("SELECT * FROM claw_github_confirmations ORDER BY created_at, confirmation_id");
/** A change the rules call high risk: a workflow file is edited. */
const highRisk = () => {
  e.gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 2, deletions: 0, patch: "@@ -1,2 +1,4 @@\n a\n+b\n+c\n d" }];
  e.gh.pr.changed_files = 1;
};
const inline = { path: ".github/workflows/ci.yml", line: 2, body: "This runs untrusted input." };
const EVENTS = ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const;
const stages = (o: { gh: ReviewEnv["gh"] }): string[] => o.gh.writes.map((w) => `${w.method} ${w.path.split("/").slice(-1)[0]}`);

describe("H what is held for the acting user", () => {
  test("H1 with the acting user's standing permission a COMMENT, a REQUEST_CHANGES, an APPROVE and a merge of a change the rules call low go straight to GitHub as the acting user, whoever asked: nobody is asked", async () => {
    for (const [name, write, wrote] of [
      ["a COMMENT review", () => submit({ event: "COMMENT" }), ["POST reviews"]],
      ["a REQUEST_CHANGES review", () => submit({ event: "REQUEST_CHANGES" }), ["POST reviews"]],
      ["an APPROVE review", () => submit({ event: "APPROVE" }), ["POST reviews"]],
      ["a merge", () => merge(), ["POST reviews", "PUT merge"]],
    ] as const) {
      e = await env();
      e.gh.pr.user = { login: "alice" };
      e.gh.reviews = [];
      e.gh.onReview = (r) => { if (r.event === "APPROVE") e.gh.graphql.mergeStateStatus = "CLEAN"; };
      e.gh.graphql.mergeStateStatus = "BLOCKED";
      const o = await write();
      assert.equal(o.isError, false, `${name}: ${o.text}`);
      assert.notEqual(o.body.status, "confirmation_required", name);
      assert.deepEqual(stages(e), wrote, name);
      assert.deepEqual(await rows(), [], `${name} asked someone`);
      assert.equal(e.gh.calls.every((c) => c.authorization === `Bearer ${TOKEN}`), true, `${name}: only the acting user's token reaches GitHub`);
    }
  });

  test("H2 a change the rules call high risk is held: a merge and an APPROVE stop at confirmation_required for the rules' reasons and write nothing, while a COMMENT and a REQUEST_CHANGES on it are posted", async () => {
    highRisk();
    for (const [name, write, kind] of [["a merge", () => merge(), "merge"], ["an APPROVE review", () => submit({ event: "APPROVE" }), "review"]] as const) {
      e = await env();
      highRisk();
      const o = await write();
      assert.equal(o.isError, false, `${name}: ${o.text}`);
      assert.deepEqual([o.body.status, o.body.kind], ["confirmation_required", kind], name);
      assert.match((o.body.reasons as string[]).join(), /workflow/, name);
      assert.equal(e.gh.writes.length, 0, `${name} wrote`);
      const [row, ...more] = await rows();
      assert.equal(more.length, 0, name);
      assert.deepEqual([row?.status, row?.kind, row?.requester_user_id, row?.actor_user_id, row?.head_sha], ["pending", kind, "u-alice", "u-bob", HEAD], name);
      assert.equal(row?.review === null, kind === "merge", name);
    }
    e = await env();
    highRisk();
    e.gh.reviews = [];
    for (const event of ["COMMENT", "REQUEST_CHANGES"]) assert.equal((await submit({ event })).body.status, "submitted", event);
    assert.deepEqual(e.gh.writes.map((w) => w.body.event), ["COMMENT", "REQUEST_CHANGES"]);
    assert.deepEqual(await rows(), []);
  });

  test("H3 high risk holds for the person who asked for their own account too, as it always has", async () => {
    for (const [name, write, kind] of [["a merge", () => merge(), "merge"], ["an APPROVE review", () => submit({ event: "APPROVE" }), "review"]] as const) {
      e = await env({}, own);
      highRisk();
      const o = await write();
      assert.deepEqual([o.body.status, o.body.kind], ["confirmation_required", kind], name);
      assert.equal(e.gh.writes.length, 0, name);
    }
  });

  test("H4 a held review keeps what would be posted, event, text and inline comments, so the acting user reads what goes out", async () => {
    highRisk();
    const o = await submit({ event: "APPROVE", body: "Looks right to me.", comments: [inline] });
    assert.equal(o.body.status, "confirmation_required");
    const [row] = await rows();
    assert.deepEqual(row?.review, { event: "APPROVE", body: "Looks right to me.", comments: [{ ...inline, side: "RIGHT" }] });
    assert.equal(row?.title, "Fix the thing");
    assert.equal(row?.author, "alice");
  });

  test("H5 the acting user's allow posts exactly the held approval, once, with their account, as asked for by the requester; a second click gets nothing", async () => {
    // The session row is where the requester's name for the footer is kept.
    await e.sql("INSERT INTO claw_sessions (session_id, user_id, config) VALUES ('s-1', 'u-alice', $1::jsonb)", [JSON.stringify({ acting_as: "u-bob", acting_as_requester: "Alice A" })]);
    highRisk();
    const held = await submit({ event: "APPROVE", body: "Held APPROVE.", comments: [inline] });
    const id = String(held.body.confirmation_id);
    assert.equal(e.gh.writes.length, 0);
    const done = await e.service.decide("u-bob", id, "allow");
    assert.equal(done.http, 200);
    assert.equal(done.body.status, "submitted", JSON.stringify(done.body));
    assert.equal(e.gh.writes.length, 1);
    const w = e.gh.writes[0];
    assert.equal(w?.path, "/repos/AMD-AGI/demo/pulls/7/reviews");
    assert.equal(w?.body.event, "APPROVE");
    assert.equal(w?.body.commit_id, HEAD);
    assert.deepEqual(w?.body.comments, [{ ...inline, side: "RIGHT" }]);
    assert.match(w?.body.body, /^Held APPROVE\.\n\n---\nReviewed by Claw on behalf of bob \(requested by Alice A\), run [0-9a-f]{12}\n<!-- claw-review:run:/);
    assert.equal(e.gh.calls.every((c) => c.authorization === `Bearer ${TOKEN}`), true, "only the acting user's token reaches GitHub");
    assert.equal(e.resolved.some((r) => r.userId === "u-alice"), false, "the requester's own credential is never asked for");
    const [row] = await rows();
    assert.equal(row?.status, "submitted");
    assert.equal(row?.decided_by, "u-bob");
    const audit = await e.sql("SELECT requester_user_id, actor_user_id, write, confirmation_id FROM claw_github_audit WHERE tool = 'gh_review_submit' ORDER BY id");
    assert.deepEqual(audit.map((a) => [a.requester_user_id, a.actor_user_id, a.write, a.confirmation_id]), [["u-alice", "u-bob", false, id], ["u-alice", "u-bob", true, id]]);
    const again = await e.service.decide("u-bob", id, "allow");
    assert.equal(again.body.status, "refused");
    assert.equal(e.gh.writes.length, 1, "posted twice");
  });

  test("H6 only the acting user can answer a held write: the requester and anyone else are refused, and nothing is posted", async () => {
    highRisk();
    for (const held of [await submit({ event: "APPROVE" }), await merge()]) {
      const id = String(held.body.confirmation_id);
      for (const who of ["u-alice", "u-mallory"]) assert.equal((await e.service.decide(who, id, "allow")).http, 403, who);
    }
    assert.equal(e.gh.writes.length, 0);
    assert.deepEqual((await rows()).map((r) => r.status), ["pending", "pending"]);
  });

  test("H7 what the allow does not lift: a denial, a head that moved, CI gone red, an acting user whose login has become the author's, comments that left the diff, a repository that archived itself, writes switched off", async () => {
    const cases: Array<[string, () => void | Promise<void>, "deny" | "allow", string, string]> = [
      ["a denial", () => {}, "deny", "denied", ""],
      ["a head that moved", () => { e.gh.pr.head = { ...e.gh.pr.head, sha: "2".repeat(40) }; }, "allow", "stale", "head_moved"],
      ["CI gone red", () => { e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }]; }, "allow", "refused", "ci_not_green"],
      ["an acting user whose login has become the author's", () => { e.gh.pr.user = { login: "bob" }; }, "allow", "refused", "cannot_approve_own_pull_request"],
      ["a comment that left the diff", () => { e.gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+a" }]; }, "allow", "refused", "comments_outside_diff"],
      ["a repository that archived itself", () => { e.gh.repo.archived = true; }, "allow", "refused", "repository_archived"],
    ];
    for (const [name, change, decision, status, why] of cases) {
      e = await env();
      highRisk();
      const id = String((await submit({ event: "APPROVE", comments: [inline] })).body.confirmation_id);
      await change();
      const r = await e.service.decide("u-bob", id, decision);
      assert.equal(r.body.status, status, `${name}: ${JSON.stringify(r.body)}`);
      if (why) assert.equal(r.body.reason, why, name);
      assert.equal(e.gh.writes.length, 0, `${name} wrote`);
    }
    e = await env({ CLAW_GITHUB_WRITES_ENABLED: "false" });
    highRisk();
    const id = String((await submit({ event: "APPROVE" })).body.confirmation_id);
    const off = await e.service.decide("u-bob", id, "allow");
    assert.deepEqual([off.body.status, off.body.reason], ["refused", "writes_disabled"]);
    assert.equal(e.gh.writes.length, 0);
  });

  test("H8 a refusal that will pass keeps the acting user's allow for a held review; once the review is on its way it does not", async () => {
    highRisk();
    const id = String((await submit({ event: "APPROVE" })).body.confirmation_id);
    const acting = directory();
    e.identity.answer = (req) => (req.userId === "u-bob" ? down() : acting(req));
    const retry = await e.service.decide("u-bob", id, "allow");
    assert.deepEqual([retry.body.status, retry.body.reason], ["retry", "identity_unavailable"]);
    assert.equal((await rows())[0]?.status, "pending");
    e.identity.answer = acting;
    e.gh.fail["/repos/AMD-AGI/demo/pulls/7/reviews"] = { status: 502, message: "bad gateway", method: "POST" };
    const failed = await e.service.decide("u-bob", id, "allow");
    assert.equal(failed.body.status, "refused");
    assert.equal(failed.body.wrote, true, "a 502 on the write may mean it went through: the try is closed");
    assert.match(String(failed.body.message), /already sent to GitHub/);
  });

  test("H9 one confirmation is one write: a merge and an approval of the same head, approvals that say different things, are each their own; asking again shows the same one", async () => {
    highRisk();
    const a = await submit({ event: "APPROVE", body: "First." });
    const again = await submit({ event: "APPROVE", body: "First." });
    assert.equal(again.body.confirmation_id, a.body.confirmation_id);
    const ids = new Set([
      a.body.confirmation_id,
      (await submit({ event: "APPROVE", body: "Second." })).body.confirmation_id,
      (await submit({ event: "APPROVE", body: "First.", comments: [inline] })).body.confirmation_id,
      (await merge()).body.confirmation_id,
    ]);
    assert.equal(ids.size, 4);
    assert.equal((await rows()).length, 4);
    assert.equal((await merge()).body.confirmation_id, [...ids].at(-1));
  });

  test("H10 a held merge is decided as a merge and a held approval as an approval: allowing the approval never merges, allowing the merge never posts the approval's text", async () => {
    highRisk();
    e.gh.onReview = (r) => { if (r.event === "APPROVE") e.gh.graphql.mergeStateStatus = "CLEAN"; };
    e.gh.graphql.mergeStateStatus = "BLOCKED";
    const review = String((await submit({ event: "APPROVE", body: "Held approval." })).body.confirmation_id);
    const mergeId = String((await merge()).body.confirmation_id);
    assert.equal((await e.service.decide("u-bob", review, "allow")).body.status, "submitted");
    assert.deepEqual(stages(e), ["POST reviews"]);
    assert.equal(e.gh.writes[0]?.body.body.startsWith("Held approval."), true);
    assert.equal((await e.service.decide("u-bob", mergeId, "allow")).body.status, "merged");
    assert.deepEqual(stages(e), ["POST reviews", "PUT merge"], "the merge finds the approval already given and adds none");
  });

  test("H11 a row that says it holds a review and does not is refused, never read as a merge", async () => {
    highRisk();
    const id = String((await submit({ event: "APPROVE" })).body.confirmation_id);
    await e.sql("UPDATE claw_github_confirmations SET review = NULL WHERE confirmation_id = $1", [id]);
    const asked = e.gh.calls.length;
    const r = await e.service.decide("u-bob", id, "allow");
    assert.deepEqual([r.body.status, r.body.reason], ["refused", "unreadable_confirmation"]);
    assert.equal(e.gh.writes.length, 0);
    assert.equal(e.gh.calls.length, asked, "nothing was asked of GitHub for it");
  });

  test("H12 the limit on what one acting user is asked counts approvals and merges together", async () => {
    highRisk();
    for (let n = 1; n <= 10; n++) {
      e.actor = { ...e.actor, sessionId: `s-${n}` };
      assert.equal((await submit({ event: "APPROVE", body: `Review ${n}.` })).body.status, "confirmation_required", `review ${n}`);
    }
    e.actor = { ...e.actor, sessionId: "s-11" };
    assert.equal(reason(await submit({ event: "APPROVE", body: "One too many." })), "too_many_pending_confirmations");
    assert.equal(reason(await merge()), "too_many_pending_confirmations");
    assert.equal((await rows()).length, 10);
  });

  test("H13 a pull request GitHub's own state refuses is not asked about: CI red and an open thread are refused before the acting user is woken, for an approval as for a merge", async () => {
    highRisk();
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }];
    assert.equal(reason(await merge()), "ci_not_green");
    assert.equal(reason(await submit({ event: "APPROVE" })), "ci_not_green");
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
    e.gh.graphql.reviewThreads = { totalCount: 1, nodes: [{ isResolved: false }] };
    assert.equal(reason(await merge()), "threads_unresolved");
    assert.equal(reason(await submit({ event: "APPROVE" })), "threads_unresolved");
    assert.deepEqual(await rows(), []);
  });

  test("H14 gh_pr_get tells the model, before it tries, that a high-risk approval or merge waits for the acting user, and says nothing of a hold on every write", async () => {
    const acting = (await get()).body.acting as any;
    assert.equal(acting.writes_need_acting_user_confirmation, undefined);
    assert.equal(acting.requested_by_acting_user, false);
    assert.equal(acting.acting_user_allows_others, true);
    assert.match(String(acting.note), /a high-risk approval or merge waits for the acting user's confirmation/);
    assert.doesNotMatch(String(acting.note), /every review and merge is held/);
    e = await env({}, own);
    assert.equal(((await get()).body.acting as any).requested_by_acting_user, true);
  });
});

describe("A the author of the pull request asks", () => {
  test("A1 the author asks for the committer's review and merge: the committer's account approves and merges, the author's GitHub is never looked at, nobody is asked", async () => {
    e.identity.answer = (req) => (req.userId === "u-alice" ? unbound() : directory()(req));
    e.gh.pr.user = { login: "alice" };
    e.gh.onReview = (r) => { if (r.event === "APPROVE") e.gh.graphql.mergeStateStatus = "CLEAN"; };
    e.gh.graphql.mergeStateStatus = "BLOCKED";
    await e.sql("INSERT INTO claw_sessions (session_id, user_id, config) VALUES ('s-1', 'u-alice', $1::jsonb)", [JSON.stringify({ acting_as: "u-bob", acting_as_requester: "Alice A" })]);
    const o = await merge();
    assert.equal(o.body.status, "merged", o.text);
    assert.deepEqual(stages(e), ["POST reviews", "PUT merge"]);
    assert.equal(e.gh.writes[0]?.body.event, "APPROVE");
    assert.match(String(e.gh.writes[0]?.body.body), /Reviewed by Claw on behalf of bob \(requested by Alice A\)/);
    assert.deepEqual(e.resolved.filter((r) => r.userId === "u-alice"), []);
    assert.equal(e.gh.calls.every((c) => c.authorization === `Bearer ${TOKEN}`), true);
    assert.deepEqual(await rows(), []);
  });

  test("A2 the committer's standing permission is the only say: switched off, nothing is done for the author, a read and a comment included; the author's own GitHub binding does not stand in for it", async () => {
    e.identity.answer = (req) => (req.userId === "u-alice" ? Promise.resolve(credential({ token: REQUESTER_TOKEN, providerLogin: "alice", delegation: true })) : directory({ delegation: false })(req));
    for (const call of [() => get(), () => submit({ event: "COMMENT" }), () => submit({ event: "APPROVE" }), () => merge()]) assert.equal(reason(await call()), "delegation_off");
    assert.equal(e.gh.calls.length, 0);
    assert.equal(e.resolved.every((r) => r.userId === "u-bob"), true);
  });

  test("A3 the author asks for a high-risk change: the committer is asked, the author cannot answer for them, and the committer's allow merges it with their own account", async () => {
    highRisk();
    e.gh.onReview = (r) => { if (r.event === "APPROVE") e.gh.graphql.mergeStateStatus = "CLEAN"; };
    e.gh.graphql.mergeStateStatus = "BLOCKED";
    const id = String((await merge()).body.confirmation_id);
    assert.equal((await e.service.decide("u-alice", id, "allow")).http, 403);
    assert.equal(e.gh.writes.length, 0);
    const done = await e.service.decide("u-bob", id, "allow");
    assert.equal(done.body.status, "merged", JSON.stringify(done.body));
    assert.deepEqual(stages(e), ["POST reviews", "PUT merge"]);
    assert.equal(e.gh.calls.every((c) => c.authorization === `Bearer ${TOKEN}`), true);
  });
});

describe("Q a base branch with a merge queue", () => {
  const queue = [
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } },
    { type: "merge_queue", parameters: { merge_method: "SQUASH", grouping_strategy: "ALLGREEN" } },
  ];

  test("Q1 a merge is refused as merge_queue_required, for the requester's own account and for someone else's, high risk or not, with nothing written and no one asked", async () => {
    const cases: Array<[string, Parameters<typeof makeEnv>[1], () => void]> = [
      ["the requester's own account", own, () => {}],
      ["someone else's account", {}, () => {}],
      ["someone else's account, high risk", {}, highRisk],
    ];
    for (const [name, over, setup] of cases) {
      e = await env({}, over);
      e.gh.rules = queue;
      setup();
      const o = await merge();
      assert.equal(o.isError, true, name);
      assert.equal(reason(o), "merge_queue_required", `${name}: ${o.text}`);
      assert.equal(e.gh.writes.length, 0, `${name} wrote`);
      assert.equal(e.gh.calls.filter((c) => /\/reviews$/.test(c.path)).length, 0, `${name} even looked at the reviews`);
      assert.deepEqual(await rows(), [], `${name} asked someone`);
    }
  });

  test("Q2 only a merge_queue rule is a queue: other rules, an empty list and the same rule on another branch's answer are not", async () => {
    for (const rules of [[], [{ type: "pull_request", parameters: {} }], [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }]]) {
      e = await env();
      e.gh.rules = rules;
      e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
      assert.notEqual(reason(await merge()), "merge_queue_required", JSON.stringify(rules));
    }
  });

  test("Q3 the rules are read once for a merge, by the queue guard and the CI gate together", async () => {
    assert.equal((await merge()).body.status, "merged");
    assert.equal(e.gh.count(/\/rules\/branches\//), 1);
  });

  test("Q4 rules GitHub would not give are not read as 'no queue': the CI gate refuses them before anything is written", async () => {
    e.gh.rulesStatus = 404;
    const o = await merge();
    assert.equal(reason(o), "ci_not_green");
    assert.match(String(o.body.message), /required checks of the base branch could not be read/);
    assert.equal(e.gh.writes.length, 0);
    assert.deepEqual(await rows(), []);
  });

  test("Q5 a queue that appears after the acting user was asked refuses at their allow, with nothing written and the confirmation closed", async () => {
    highRisk();
    const id = String((await merge()).body.confirmation_id);
    e.gh.rules = queue;
    const r = await e.service.decide("u-bob", id, "allow");
    assert.deepEqual([r.body.status, r.body.reason], ["refused", "merge_queue_required"]);
    assert.equal(e.gh.writes.length, 0);
    assert.equal((await rows())[0]?.status, "refused");
  });

  test("Q6 a review is not a merge: with a queue on the branch a comment, a request for changes and an approval are posted as ever", async () => {
    e.gh.rules = queue;
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
    e.gh.reviews = [];
    for (const event of EVENTS) assert.equal((await submit({ event })).body.status, "submitted", event);
    assert.equal((await get()).isError, false);
  });
});

describe("Q (continued) a merge queue the rules do not show", () => {
  // Classic branch protection ("require merge queue") is not a ruleset rule: only the pull request's own isMergeQueueEnabled says it.
  test("Q7 a queue only GitHub's isMergeQueueEnabled shows is refused as merge_queue_required, for the requester's own account and someone else's, high risk or not, with nothing written and no one asked", async () => {
    const cases: Array<[string, Parameters<typeof makeEnv>[1], () => void]> = [
      ["the requester's own account", own, () => {}],
      ["someone else's account", {}, () => {}],
      ["someone else's account, high risk", {}, highRisk],
      ["someone else's account, CI red: the queue is what is said, not CI", {}, () => { e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }]; }],
    ];
    for (const [name, over, setup] of cases) {
      e = await env({}, over);
      e.gh.rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } }];
      e.gh.graphql.isMergeQueueEnabled = true;
      setup();
      const o = await merge();
      assert.equal(o.isError, true, name);
      assert.equal(reason(o), "merge_queue_required", `${name}: ${o.text}`);
      assert.equal(e.gh.writes.length, 0, `${name} wrote`);
      assert.equal(e.gh.calls.filter((c) => /\/reviews$/.test(c.path)).length, 0, `${name} even looked at the reviews`);
      assert.deepEqual(await rows(), [], `${name} asked someone`);
      assert.equal(e.gh.calls.some((c) => c.path === "/graphql" && JSON.stringify(c.body).includes("isMergeQueueEnabled")), true, `${name}: the field was never asked for`);
    }
  });

  test("Q8 only a true isMergeQueueEnabled is a queue: false, null and an answer without the field are not", async () => {
    for (const value of [false, null, undefined]) {
      e = await env();
      if (value === undefined) delete e.gh.graphql.isMergeQueueEnabled; else e.gh.graphql.isMergeQueueEnabled = value;
      const o = await merge();
      assert.equal(o.body.status, "merged", `${String(value)}: ${o.text}`);
    }
  });

  test("Q9 a queue that GitHub reports after the acting user was asked refuses at their allow, with nothing written and the confirmation closed", async () => {
    highRisk();
    const id = String((await merge()).body.confirmation_id);
    e.gh.graphql.isMergeQueueEnabled = true;
    const r = await e.service.decide("u-bob", id, "allow");
    assert.deepEqual([r.body.status, r.body.reason], ["refused", "merge_queue_required"]);
    assert.equal(e.gh.writes.length, 0);
    assert.equal((await rows())[0]?.status, "refused");
  });

  test("Q10 a review is not a merge: the same queue does not stop a comment, a request for changes or an approval", async () => {
    e.gh.graphql.isMergeQueueEnabled = true;
    e.gh.reviews = [];
    for (const event of EVENTS) assert.equal((await submit({ event })).body.status, "submitted", event);
  });
});

describe("O the acting user wrote the pull request", () => {
  const LOADS = ["/repos/AMD-AGI/demo", "/repos/AMD-AGI/demo/pulls/7"];
  const approving: Array<[string, () => Promise<ToolOutcome>]> = [
    // Inline comments make the review read the change first, which the check must come before.
    ["an APPROVE review", () => submit({ event: "APPROVE", comments: [{ path: "src/app.ts", line: 3, body: "x" }] })],
    ["a merge", () => merge()],
  ];

  test("O1 an approval or a merge with the account of the author is refused as cannot_approve_own_pull_request before CI, threads, the diff or the rules are read, and before anyone is asked, whoever asked", async () => {
    for (const over of [{}, own]) {
      for (const [what, call] of approving) {
        e = await env({}, over);
        e.gh.pr.user = { login: "bob" };
        highRisk();
        const o = await call();
        assert.equal(reason(o), "cannot_approve_own_pull_request", `${what}: ${o.text}`);
        assert.deepEqual(e.gh.calls.map((c) => c.path), LOADS, what);
        assert.deepEqual(await rows(), [], what);
        assert.equal(e.gh.writes.length, 0, what);
      }
    }
  });

  test("O2 a comment and a request for changes approve nothing: the acting user's own pull request is not refused them", async () => {
    e.gh.pr.user = { login: "bob" };
    e.gh.reviews = [];
    for (const event of ["COMMENT", "REQUEST_CHANGES"]) assert.equal((await submit({ event })).body.status, "submitted", event);
  });

  test("O3 the refusal is about the acting user's account and nobody else's: the author as requester passes, and so does a pull request someone else wrote", async () => {
    for (const author of ["alice", "carol", "bobby"]) {
      e = await env();
      e.gh.pr.user = { login: author };
      e.gh.reviews = [];
      assert.equal((await submit({ event: "APPROVE" })).body.status, "submitted", author);
    }
  });
});

describe("B a session bound to one pull request", () => {
  const target = { owner: "AMD-AGI", repo: "demo", number: 7 };
  const bound = (over: Parameters<typeof makeEnv>[1] = {}) => env({}, { ...over, actor: { reviewTarget: target, ...over.actor } });
  const others = ["AMD-AGI/demo#8", "AMD-AGI/other#7", "evil/demo#7", "https://github.com/AMD-AGI/demo/pull/8", "https://github.com/AMD-AGI/other/pull/7/files"];
  const tools: Array<[string, (pr: string) => Promise<ToolOutcome>]> = [
    ["gh_pr_get", (pr) => e.service.getPr(e.actor, { pr })],
    ["gh_pr_risk", (pr) => e.service.assessPr(e.actor, { pr })],
    ["a COMMENT review", (pr) => e.service.submitReview(e.actor, { pr, head_sha: HEAD, event: "COMMENT", body: "x" })],
    ["a REQUEST_CHANGES review", (pr) => e.service.submitReview(e.actor, { pr, head_sha: HEAD, event: "REQUEST_CHANGES", body: "x" })],
    ["an APPROVE review", (pr) => e.service.submitReview(e.actor, { pr, head_sha: HEAD, event: "APPROVE", body: "x" })],
    ["gh_pr_merge", (pr) => e.service.mergePr(e.actor, { pr, head_sha: HEAD })],
  ];

  test("B1 every tool refuses every other pull request as review_target_mismatch, before the acting user's credential is looked up or GitHub is asked anything", async () => {
    for (const own_ of [false, true]) {
      e = await bound(own_ ? own : {});
      for (const [name, call] of tools) {
        for (const pr of others) {
          const o = await call(pr);
          assert.equal(o.isError, true, `${name} ${pr}`);
          assert.equal(reason(o), "review_target_mismatch", `${name} ${pr}: ${o.text}`);
          assert.equal(o.body.review_target, "AMD-AGI/demo#7", `${name} ${pr}`);
        }
      }
      assert.equal(e.gh.calls.length, 0);
      assert.equal(e.resolved.length, 0);
      assert.deepEqual(await rows(), []);
      const audit = await e.sql("SELECT result, detail, write FROM claw_github_audit");
      assert.equal(audit.length, tools.length * others.length);
      assert.equal(audit.every((a) => a.result === "refused" && a.detail === "review_target_mismatch" && a.write === false), true);
    }
  });

  test("B2 the bound pull request itself is open to every tool, however it is spelled", async () => {
    for (const pr of [PR, "amd-agi/DEMO#7", "https://github.com/AMD-AGI/demo/pull/7", "https://github.com/amd-agi/demo/pull/7/files"]) {
      e = await bound(own);
      for (const [name, call] of tools) {
        const o = await call(pr);
        assert.notEqual(reason(o), "review_target_mismatch", `${name} ${pr}`);
      }
      assert.equal((await e.service.getPr(e.actor, { pr })).isError, false, pr);
    }
  });

  test("B3 a bound session's held approval is decided and made as ever", async () => {
    e = await bound();
    highRisk();
    const id = String((await submit({ event: "APPROVE", body: "Bound." })).body.confirmation_id);
    assert.equal((await e.service.decide("u-bob", id, "allow")).body.status, "submitted");
    assert.equal(e.gh.writes.length, 1);
  });

  test("B4 a malformed reference is invalid_pull_request, whatever the session is bound to; the repo and number arguments are held to the binding too", async () => {
    e = await bound();
    assert.equal(reason(await e.service.getPr(e.actor, { pr: "not a pull request" })), "invalid_pull_request");
    assert.equal(reason(await e.service.getPr(e.actor, { repo: "AMD-AGI/demo", number: 8 })), "review_target_mismatch");
    assert.equal((await e.service.getPr(e.actor, { repo: "AMD-AGI/demo", number: 7 })).isError, false);
  });

  test("B5 a session that is not bound may act on any pull request of an allowed owner, as before", async () => {
    for (const pr of ["AMD-AGI/demo#8", "AMD-AGI/other#7", "https://github.com/AMD-AGI/demo/pull/9"]) {
      assert.equal((await e.service.getPr(e.actor, { pr })).isError, false, pr);
    }
    assert.equal(reason(await e.service.getPr(e.actor, { pr: "evil/demo#7" })), "owner_not_allowed");
  });
});

describe("N names: the footer, the marker and the repository's configuration file", () => {
  const body = () => String(e.gh.writes[0]?.body.body);
  const footerLine = (text: string) => text.split("\n").find((l) => l.startsWith("Reviewed by")) ?? "";
  const CONFIG = ".github/claw-review.yml";
  const OLD_CONFIG = `.github/${LEGACY_REPO_CONFIG_STEM}.yml`;
  const fresh = () => env();

  test("N1 the footer names the author as configured, Claw by default, and the name cannot break out of its line", async () => {
    const cases: Array<[string, string]> = [
      ["", "Claw"], ["  Review Bot ", "Review Bot"], ["<<>>", "Claw"], ["Bot\n---\n<!-- x -->`", "Bot --- !-- x --"], ["x".repeat(80), "x".repeat(40)],
    ];
    for (const [value, name] of cases) {
      e = await env(value ? { CLAW_GITHUB_REVIEW_AGENT_NAME: value } : {});
      await submit();
      assert.equal(footerLine(body()).startsWith(`Reviewed by ${name} on behalf of bob (requested by Alice A), run `), true, `${JSON.stringify(value)}: ${footerLine(body())}`);
      assert.doesNotMatch(footerLine(body()), /<|>|`/);
      assert.equal(body().split("\n").filter((l) => l.startsWith("Reviewed by")).length, 1);
    }
    e = await env({ CLAW_GITHUB_REVIEW_AGENT_NAME: "<<>>" });
    assert.match(e.settings.problems.join(), /CLAW_GITHUB_REVIEW_AGENT_NAME has no printable text/);
  });

  test("N2 a review is marked with the neutral prefix, and only with that", async () => {
    e = await fresh();
    await submit();
    assert.match(body(), /\n<!-- claw-review:run:[0-9a-f]{12}:COMMENT:[0-9a-f]{12} -->$/);
    assert.equal(body().includes(LEGACY_RUN_MARKER_PREFIX), false);
  });

  test("N3 a review an earlier release posted is still found by its marker: asking for it again posts nothing", async () => {
    e = await fresh();
    await submit();
    const posted = e.gh.reviews[0] as Record<string, any>;
    posted.body = String(posted.body).replace("claw-review:run:", `${LEGACY_RUN_MARKER_PREFIX}:`);
    assert.equal(posted.body.includes(`<!-- ${LEGACY_RUN_MARKER_PREFIX}:`), true);
    const again = await submit();
    assert.equal(again.body.status, "already_submitted", again.text);
    assert.equal(e.gh.writes.length, 1);
    // A different review is not that one.
    assert.equal((await submit({ body: "Something else." })).body.status, "submitted");
  });

  test("N4 the repository's configuration is read from the neutral name, from the earlier name where that is absent, and the neutral one wins where both exist", async () => {
    const always = "confirm_merge: always\n";
    const cases: Array<[string, Record<string, string>, boolean]> = [
      ["neither", {}, false],
      ["the neutral name", { [CONFIG]: always }, true],
      ["the earlier name only", { [OLD_CONFIG]: always }, true],
      ["both, the neutral one says risk", { [CONFIG]: "confirm_merge: risk\n", [OLD_CONFIG]: always }, false],
      ["both, the neutral one says always", { [CONFIG]: always, [OLD_CONFIG]: "confirm_merge: risk\n" }, true],
    ];
    for (const [name, contents, held] of cases) {
      e = await fresh();
      e.gh.contents = contents;
      const o = await merge();
      assert.equal(o.body.status, held ? "confirmation_required" : "merged", `${name}: ${o.text}`);
      if (held) assert.match((o.body.reasons as string[]).join(), /every merge/, name);
    }
  });

  test("N5 the earlier name is asked for only when the neutral one is absent, and a neutral file that cannot be read is not rescued by the earlier one", async () => {
    e = await fresh();
    e.gh.contents = { [CONFIG]: "confirm_merge: risk\n" };
    await merge();
    assert.deepEqual(e.gh.calls.filter((c) => c.path.includes("/contents/")).map((c) => c.path.split("/contents/")[1]), [CONFIG]);
    e = await fresh();
    e.gh.contents = { [CONFIG]: "surprise: 1\n", [OLD_CONFIG]: "confirm_merge: risk\n" };
    const o = await merge();
    assert.equal(o.body.status, "confirmation_required");
    assert.match((o.body.reasons as string[]).join(), /claw-review\.yml could not be read/);
    e = await fresh();
    await merge();
    assert.deepEqual(e.gh.calls.filter((c) => c.path.includes("/contents/")).map((c) => c.path.split("/contents/")[1]), [CONFIG, OLD_CONFIG]);
  });
});
