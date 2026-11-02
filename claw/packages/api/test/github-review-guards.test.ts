// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The guards around the account of someone who is asked for: what is held for them, what is refused up front, and which pull request a
 * session may touch at all. The service against a real PostgreSQL engine (PGlite) and a fake GitHub that records every request, so
 * "nothing was written" is a count of requests, and a refusal is asserted by its code and not by its being an error.
 *
 *   H  someone else's request: every write is held for the acting user, and is posted exactly as held, once, when they allow it
 *   Q  a base branch with a merge queue: refused before anything is written, before anyone is asked
 *   R  the requester, asked up front: no usable GitHub account, or the author of the pull request
 *   B  a session bound to one pull request: no tool call names another
 *   N  names: the footer, the marker and the repository's configuration file, and what an earlier release left behind
 */
import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach, describe } from "node:test";
import { LEGACY_REPO_CONFIG_STEM, LEGACY_RUN_MARKER_PREFIX } from "../src/github-review/legacy-names.js";
import type { ToolOutcome } from "../src/github-review/service.js";
import { HEAD } from "./support/fake-github.js";
import { PR, REQUESTER_TOKEN, TOKEN, closeShared, directory, down, expired, reviewEnv as makeEnv, unbound, type ReviewEnv } from "./support/review-env.js";

/** The requester (`u-alice`) is someone else than the acting user (`u-bob`) unless a test says the requester is the acting user. */
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
const inline = { path: "src/app.ts", line: 3, body: "This drops the error." };
const EVENTS = ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const;

describe("H someone else's request is held for the acting user", () => {
  const writes: Array<[string, () => Promise<ToolOutcome>, "merge" | "review"]> = [
    ["a COMMENT review", () => submit({ event: "COMMENT" }), "review"],
    ["a REQUEST_CHANGES review", () => submit({ event: "REQUEST_CHANGES" }), "review"],
    ["an APPROVE review", () => submit({ event: "APPROVE" }), "review"],
    ["a merge of a change the rules call low", () => merge(), "merge"],
  ];

  test("H1 every write on someone else's request stops at confirmation_required: nothing reaches GitHub, one pending row says what is held", async () => {
    for (const [name, write, kind] of writes) {
      e = await env();
      const o = await write();
      assert.equal(o.isError, false, `${name}: ${o.text}`);
      assert.equal(o.body.status, "confirmation_required", name);
      assert.equal(o.body.kind, kind, name);
      assert.match(String((o.body.reasons as string[]).join()), /another user asked/, name);
      assert.equal(e.gh.writes.length, 0, `${name} wrote`);
      const [row, ...more] = await rows();
      assert.equal(more.length, 0, name);
      assert.equal(row?.status, "pending", name);
      assert.equal(row?.kind, kind, name);
      assert.equal(row?.requester_user_id, "u-alice", name);
      assert.equal(row?.actor_user_id, "u-bob", name);
      assert.equal(row?.head_sha, HEAD, name);
      assert.equal(row?.review === null, kind === "merge", name);
    }
  });

  test("H2 the person who asked for their own account needs no confirmation: the same four writes go straight to GitHub", async () => {
    for (const [name, write] of writes) {
      e = await env({}, own);
      e.gh.reviews = [];
      const o = await write();
      assert.notEqual(o.body.status, "confirmation_required", name);
      assert.equal(o.isError, false, `${name}: ${o.text}`);
      assert.equal(e.gh.writes.length > 0, true, `${name} wrote nothing`);
      assert.deepEqual(await rows(), [], name);
    }
  });

  test("H3 a held review keeps what would be posted, event, text and inline comments, so the acting user reads what goes out", async () => {
    const o = await submit({ event: "REQUEST_CHANGES", body: "Please handle the error.", comments: [inline] });
    assert.equal(o.body.status, "confirmation_required");
    const [row] = await rows();
    assert.deepEqual(row?.review, { event: "REQUEST_CHANGES", body: "Please handle the error.", comments: [{ ...inline, side: "RIGHT" }] });
    assert.equal(row?.title, "Fix the thing");
    assert.equal(row?.author, "alice");
  });

  test("H4 the acting user's allow posts exactly the held review, once, with their account, as asked for by the requester; a second click gets nothing", async () => {
    for (const event of EVENTS) {
      e = await env();
      // The session row is where the requester's name for the footer is kept.
      await e.sql("INSERT INTO claw_sessions (session_id, user_id, config) VALUES ('s-1', 'u-alice', $1::jsonb)", [JSON.stringify({ acting_as: "u-bob", acting_as_requester: "Alice A" })]);
      const held = await submit({ event, body: `Held ${event}.`, comments: [inline] });
      const id = String(held.body.confirmation_id);
      assert.equal(e.gh.writes.length, 0, event);
      const done = await e.service.decide("u-bob", id, "allow");
      assert.equal(done.http, 200, event);
      assert.equal(done.body.status, "submitted", JSON.stringify(done.body));
      assert.equal(e.gh.writes.length, 1, event);
      const w = e.gh.writes[0];
      assert.equal(w?.path, "/repos/AMD-AGI/demo/pulls/7/reviews", event);
      assert.equal(w?.body.event, event);
      assert.equal(w?.body.commit_id, HEAD);
      assert.deepEqual(w?.body.comments, [{ ...inline, side: "RIGHT" }]);
      assert.match(w?.body.body, new RegExp(`^Held ${event}\\.\\n\\n---\\nReviewed by Claw on behalf of bob \\(requested by Alice A\\), run [0-9a-f]{12}\\n<!-- claw-review:run:`), event);
      assert.equal(e.gh.calls.every((c) => c.authorization === `Bearer ${TOKEN}`), true, `${event}: only the acting user's token reaches GitHub`);
      assert.equal(e.gh.calls.some((c) => c.authorization.includes(REQUESTER_TOKEN)), false, event);
      const [row] = await rows();
      assert.equal(row?.status, "submitted", event);
      assert.equal(row?.decided_by, "u-bob", event);
      const audit = await e.sql("SELECT requester_user_id, actor_user_id, write, confirmation_id FROM claw_github_audit WHERE tool = 'gh_review_submit' ORDER BY id");
      assert.deepEqual(audit.map((a) => [a.requester_user_id, a.actor_user_id, a.write, a.confirmation_id]), [["u-alice", "u-bob", false, id], ["u-alice", "u-bob", true, id]], event);
      const again = await e.service.decide("u-bob", id, "allow");
      assert.equal(again.body.status, "refused", event);
      assert.equal(e.gh.writes.length, 1, `${event} posted twice`);
    }
  });

  test("H5 only the acting user can answer a held review: the requester and anyone else are refused, and nothing is posted", async () => {
    const id = String((await submit()).body.confirmation_id);
    for (const who of ["u-alice", "u-mallory"]) assert.equal((await e.service.decide(who, id, "allow")).http, 403, who);
    assert.equal(e.gh.writes.length, 0);
    assert.equal((await rows())[0]?.status, "pending");
  });

  test("H6 what the allow does not lift: a denial, a head that moved, CI gone red, a requester who turns out to be the author, comments that left the diff, writes switched off", async () => {
    const cases: Array<[string, (typeof EVENTS)[number], () => void | Promise<void>, "deny" | "allow", string, string]> = [
      ["a denial", "COMMENT", () => {}, "deny", "denied", ""],
      ["a head that moved", "COMMENT", () => { e.gh.pr.head = { ...e.gh.pr.head, sha: "2".repeat(40) }; }, "allow", "stale", "head_moved"],
      ["CI gone red", "APPROVE", () => { e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }]; }, "allow", "refused", "ci_not_green"],
      ["the requester is the author", "APPROVE", () => { e.identity.answer = directory({}, { providerLogin: "alice" }); }, "allow", "refused", "cannot_act_for_own_pull_request"],
      ["a comment that left the diff", "COMMENT", () => { e.gh.files = [{ filename: "src/app.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }]; }, "allow", "refused", "comments_outside_diff"],
      ["a repository that archived itself", "REQUEST_CHANGES", () => { e.gh.repo.archived = true; }, "allow", "refused", "repository_archived"],
    ];
    for (const [name, event, change, decision, status, why] of cases) {
      e = await env();
      const id = String((await submit({ event, comments: [inline] })).body.confirmation_id);
      await change();
      const r = await e.service.decide("u-bob", id, decision);
      assert.equal(r.body.status, status, `${name}: ${JSON.stringify(r.body)}`);
      if (why) assert.equal(r.body.reason, why, name);
      assert.equal(e.gh.writes.length, 0, `${name} wrote`);
    }
    e = await env({ CLAW_GITHUB_WRITES_ENABLED: "false" });
    const id = String((await submit()).body.confirmation_id);
    const off = await e.service.decide("u-bob", id, "allow");
    assert.deepEqual([off.body.status, off.body.reason], ["refused", "writes_disabled"]);
    assert.equal(e.gh.writes.length, 0);
  });

  test("H7 a refusal that will pass keeps the acting user's allow for a held review too; once the review is on its way it does not", async () => {
    const id = String((await submit()).body.confirmation_id);
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

  test("H8 one confirmation is one write: a merge and a review of the same head, reviews that say different things, and the same review of another event are each their own; asking again shows the same one", async () => {
    const a = await submit({ body: "First." });
    const again = await submit({ body: "First." });
    assert.equal(again.body.confirmation_id, a.body.confirmation_id);
    const ids = new Set([
      a.body.confirmation_id,
      (await submit({ body: "Second." })).body.confirmation_id,
      (await submit({ body: "First.", event: "REQUEST_CHANGES" })).body.confirmation_id,
      (await submit({ body: "First.", comments: [inline] })).body.confirmation_id,
      (await merge()).body.confirmation_id,
    ]);
    assert.equal(ids.size, 5);
    assert.equal((await rows()).length, 5);
    assert.equal((await merge()).body.confirmation_id, [...ids].at(-1));
  });

  test("H9 a held merge is decided as a merge and a held review as a review: allowing the review never merges, allowing the merge never posts the review", async () => {
    e.gh.onReview = (r) => { if (r.event === "APPROVE") e.gh.graphql.mergeStateStatus = "CLEAN"; };
    e.gh.graphql.mergeStateStatus = "BLOCKED";
    const review = String((await submit({ body: "Held comment." })).body.confirmation_id);
    const mergeId = String((await merge()).body.confirmation_id);
    assert.equal((await e.service.decide("u-bob", review, "allow")).body.status, "submitted");
    assert.deepEqual(e.gh.writes.map((w) => `${w.method} ${w.path.split("/").slice(-1)[0]}`), ["POST reviews"]);
    assert.equal((await e.service.decide("u-bob", mergeId, "allow")).body.status, "merged");
    assert.deepEqual(e.gh.writes.map((w) => `${w.method} ${w.path.split("/").slice(-1)[0]}`), ["POST reviews", "POST reviews", "PUT merge"]);
    assert.equal(e.gh.writes[0]?.body.event, "COMMENT");
    assert.equal(e.gh.writes[1]?.body.event, "APPROVE", "the merge's own approval is not the held comment");
  });

  test("H10 a row that says it holds a review and does not is refused, never read as a merge", async () => {
    const id = String((await submit()).body.confirmation_id);
    await e.sql("UPDATE claw_github_confirmations SET review = NULL WHERE confirmation_id = $1", [id]);
    const asked = e.gh.calls.length;
    const r = await e.service.decide("u-bob", id, "allow");
    assert.deepEqual([r.body.status, r.body.reason], ["refused", "unreadable_confirmation"]);
    assert.equal(e.gh.writes.length, 0);
    assert.equal(e.gh.calls.length, asked, "nothing was asked of GitHub for it");
  });

  test("H11 the limit on what one acting user is asked counts reviews and merges together", async () => {
    for (let n = 1; n <= 10; n++) {
      e.actor = { ...e.actor, sessionId: `s-${n}` };
      assert.equal((await submit({ body: `Review ${n}.` })).body.status, "confirmation_required", `review ${n}`);
    }
    e.actor = { ...e.actor, sessionId: "s-11" };
    assert.equal(reason(await submit({ body: "One too many." })), "too_many_pending_confirmations");
    assert.equal(reason(await merge()), "too_many_pending_confirmations");
    assert.equal((await rows()).length, 10);
  });

  test("H12 a high-risk merge is still held for the reasons the rules gave, not for the request", async () => {
    e.gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 2, deletions: 0, patch: "@@ -1,2 +1,4 @@\n a\n+b\n+c\n d" }];
    e.gh.pr.changed_files = 1;
    const o = await merge();
    assert.equal(o.body.status, "confirmation_required");
    assert.match((o.body.reasons as string[]).join(), /workflow/);
    assert.doesNotMatch((o.body.reasons as string[]).join(), /another user asked/);
  });

  test("H14 gh_pr_get tells the model, before it tries, that a write on someone else's request waits for the acting user, and a merge's card says an approval comes first", async () => {
    assert.equal(((await get()).body.acting as any).writes_need_acting_user_confirmation, true);
    assert.match(String(((await get()).body.acting as any).note), /held for the acting user to confirm/);
    const merged = await merge();
    assert.match((merged.body.reasons as string[]).join(), /this merge, with an approval first where one is needed/);
    const reviewed = await submit({ body: "Another." });
    assert.match((reviewed.body.reasons as string[]).join(), /this review/);
    e = await env({}, own);
    const mine = (await get()).body.acting as any;
    assert.equal(mine.writes_need_acting_user_confirmation, false);
    assert.doesNotMatch(String(mine.note), /held for the acting user/);
  });

  test("H13 a pull request GitHub's own state refuses is not asked about: CI red and an open thread are refused before the acting user is woken", async () => {
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }];
    assert.equal(reason(await merge()), "ci_not_green");
    e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
    e.gh.graphql.reviewThreads = { totalCount: 1, nodes: [{ isResolved: false }] };
    assert.equal(reason(await merge()), "threads_unresolved");
    assert.deepEqual(await rows(), []);
  });
});

describe("Q a base branch with a merge queue", () => {
  const queue = [
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test" }] } },
    { type: "merge_queue", parameters: { merge_method: "SQUASH", grouping_strategy: "ALLGREEN" } },
  ];
  const highRisk = () => {
    e.gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 2, deletions: 0, patch: "@@ -1,2 +1,4 @@\n a\n+b\n+c\n d" }];
    e.gh.pr.changed_files = 1;
  };

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
      e = await env({}, own);
      e.gh.rules = rules;
      e.gh.checkRuns = [{ name: "test", status: "completed", conclusion: "success" }];
      assert.notEqual(reason(await merge()), "merge_queue_required", JSON.stringify(rules));
    }
  });

  test("Q3 the rules are read once for a merge, by the queue guard and the CI gate together", async () => {
    e = await env({}, own);
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
    const id = String((await merge()).body.confirmation_id);
    e.gh.rules = queue;
    const r = await e.service.decide("u-bob", id, "allow");
    assert.deepEqual([r.body.status, r.body.reason], ["refused", "merge_queue_required"]);
    assert.equal(e.gh.writes.length, 0);
    assert.equal((await rows())[0]?.status, "refused");
  });

  test("Q6 a review is not a merge: with a queue on the branch a comment, a request for changes and an approval are held or posted as ever", async () => {
    e.gh.rules = queue;
    for (const event of EVENTS) assert.equal((await submit({ event })).body.status, "confirmation_required", event);
    assert.equal((await get()).isError, false);
  });
});

describe("R the requester is asked up front", () => {
  const LOADS = ["/repos/AMD-AGI/demo", "/repos/AMD-AGI/demo/pulls/7"];
  const refusals: Array<[string, (acting: ReturnType<typeof directory>) => ReviewEnv["identity"]["answer"], string]> = [
    ["no GitHub account bound", (acting) => (req) => (req.userId === "u-alice" ? unbound() : acting(req)), "requester_not_bound"],
    ["an expired authorization", (acting) => (req) => (req.userId === "u-alice" ? expired() : acting(req)), "requester_credential_expired"],
    ["the identity service down", (acting) => (req) => (req.userId === "u-alice" ? down() : acting(req)), "identity_unavailable"],
    ["a login the identity provider does not give", () => directory({}, { providerLogin: "" }), "requester_not_bound"],
    ["the author of the pull request", () => directory({}, { providerLogin: "Alice" }), "cannot_act_for_own_pull_request"],
  ];
  const approving: Array<[string, (over?: Record<string, unknown>) => Promise<ToolOutcome>]> = [
    ["an APPROVE review", (over) => submit({ event: "APPROVE", ...over })],
    ["a merge", () => merge()],
  ];

  test("R1 an approval or a merge for a requester who cannot pass is refused before CI, threads, the diff or the rules are read, and before anyone is asked", async () => {
    for (const [what, call] of approving) {
      for (const [name, answer, code] of refusals) {
        e = await env();
        e.identity.answer = answer(directory());
        // Inline comments make the review read the change first, which the requester check must come before.
        const o = await call({ comments: [inline] });
        assert.equal(reason(o), code, `${what}, ${name}: ${o.text}`);
        assert.deepEqual(e.gh.calls.map((c) => c.path), LOADS, `${what}, ${name}`);
        assert.deepEqual(await rows(), [], `${what}, ${name}`);
      }
    }
  });

  test("R2 the requester's own credential is used for their login and nowhere else", async () => {
    e.identity.answer = directory({}, { providerLogin: "alice" });
    assert.equal(reason(await submit({ event: "APPROVE" })), "cannot_act_for_own_pull_request");
    assert.deepEqual(e.resolved.filter((r) => r.userId === "u-alice").map((r) => [r.requesterUserId, r.purpose]), [["u-alice", "gh_review_submit:requester_login"]]);
    assert.equal(e.gh.calls.some((c) => c.authorization.includes(REQUESTER_TOKEN)), false);
  });

  test("R3 a comment and a request for changes approve nothing: a requester with no account, or the author, is not refused them, and the acting user is asked", async () => {
    for (const [name, answer] of refusals) {
      e = await env();
      e.identity.answer = answer(directory());
      for (const event of ["COMMENT", "REQUEST_CHANGES"]) {
        const o = await submit({ event });
        assert.equal(o.body.status, "confirmation_required", `${name} / ${event}: ${o.text}`);
      }
    }
  });

  test("R4 the requester's own pull request is only refused for the requester: a requester who is not the author is held for the acting user, as ever", async () => {
    for (const [what, call] of approving) {
      e = await env();
      assert.equal((await call()).body.status, "confirmation_required", what);
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

  test("B3 a bound session's held write is decided and made as ever", async () => {
    e = await bound();
    const id = String((await submit({ body: "Bound." })).body.confirmation_id);
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
  const own_ = () => env({}, own);

  test("N1 the footer names the author as configured, Claw by default, and the name cannot break out of its line", async () => {
    const cases: Array<[string, string]> = [
      ["", "Claw"], ["  Review Bot ", "Review Bot"], ["<<>>", "Claw"], ["Bot\n---\n<!-- x -->`", "Bot --- !-- x --"], ["x".repeat(80), "x".repeat(40)],
    ];
    for (const [value, name] of cases) {
      e = await env(value ? { CLAW_GITHUB_REVIEW_AGENT_NAME: value } : {}, own);
      await submit();
      assert.equal(footerLine(body()).startsWith(`Reviewed by ${name} on behalf of bob (requested by Alice A), run `), true, `${JSON.stringify(value)}: ${footerLine(body())}`);
      assert.doesNotMatch(footerLine(body()), /<|>|`/);
      assert.equal(body().split("\n").filter((l) => l.startsWith("Reviewed by")).length, 1);
    }
    e = await env({ CLAW_GITHUB_REVIEW_AGENT_NAME: "<<>>" }, own);
    assert.match(e.settings.problems.join(), /CLAW_GITHUB_REVIEW_AGENT_NAME has no printable text/);
  });

  test("N2 a review is marked with the neutral prefix, and only with that", async () => {
    e = await own_();
    await submit();
    assert.match(body(), /\n<!-- claw-review:run:[0-9a-f]{12}:COMMENT:[0-9a-f]{12} -->$/);
    assert.equal(body().includes(LEGACY_RUN_MARKER_PREFIX), false);
  });

  test("N3 a review an earlier release posted is still found by its marker: asking for it again posts nothing", async () => {
    e = await own_();
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
      e = await own_();
      e.gh.contents = contents;
      const o = await merge();
      assert.equal(o.body.status, held ? "confirmation_required" : "merged", `${name}: ${o.text}`);
      if (held) assert.match((o.body.reasons as string[]).join(), /every merge/, name);
    }
  });

  test("N5 the earlier name is asked for only when the neutral one is absent, and a neutral file that cannot be read is not rescued by the earlier one", async () => {
    e = await own_();
    e.gh.contents = { [CONFIG]: "confirm_merge: risk\n" };
    await merge();
    assert.deepEqual(e.gh.calls.filter((c) => c.path.includes("/contents/")).map((c) => c.path.split("/contents/")[1]), [CONFIG]);
    e = await own_();
    e.gh.contents = { [CONFIG]: "surprise: 1\n", [OLD_CONFIG]: "confirm_merge: risk\n" };
    const o = await merge();
    assert.equal(o.body.status, "confirmation_required");
    assert.match((o.body.reasons as string[]).join(), /claw-review\.yml could not be read/);
    e = await own_();
    await merge();
    assert.deepEqual(e.gh.calls.filter((c) => c.path.includes("/contents/")).map((c) => c.path.split("/contents/")[1]), [CONFIG, OLD_CONFIG]);
  });
});
