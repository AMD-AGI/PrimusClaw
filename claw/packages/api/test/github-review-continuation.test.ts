// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A re-review that continues the last one (C1b), through the service the review tools call, against PGlite and a fake GitHub. The review
 * item that says what is continued (`assistant/review-items.ts`) is stood in for by `continuationOf`; its own tests are against Postgres.
 *
 *   N1  a posted review's findings are recorded with their threads, for a review item only: anything else is posted as before, unrecorded
 *   N2  a thread that cannot be read back leaves the finding without one; the review is posted all the same
 *   N3  the scope is the code's: a plain continuation that is small reads only the change since the last head (files and diff), and says so
 *   N4  the same head: nothing new to read
 *   N5  a force push (the last head is gone, or no ancestor): the whole pull request again
 *   N6  a large change since: the whole pull request again
 *   N7  a change since that touches security or CI paths: the whole pull request again
 *   N8  a first review is not asked about any of it
 *   T1  gh_thread_resolve resolves a thread the last review recorded and opened with the acting user's account
 *   T2  ... and nothing else: a thread not recorded, another person's, another pull request's, at a head that moved, of a stopped review
 *   T3  a thread already resolved is not resolved again; with writes off nothing is; none of it counts against the hourly review limits
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";
import type { ReviewContinuation } from "../src/github-review/service.js";
import { HEAD } from "./support/fake-github.js";
import { PR, closeShared, readSection, reviewEnv, type ReviewEnv } from "./support/review-env.js";

const OLD = "2".repeat(40);
const LOW = { level: "low", reason: "an ordinary change, nothing for a person to look at" };
/** The whole pull request: the first round's lines and the fix commit's. */
const PR_PATCH = "@@ -1,4 +1,7 @@\n a\n-b\n+b2_first_round\n+c_fixed\n+d_new_issue\n e\n f";
/** What the fix commit changed since the last review's head. */
const DELTA_PATCH = "@@ -2,3 +2,4 @@\n b2_first_round\n-c\n+c_fixed\n+d_new_issue";

let e: ReviewEnv;
let continuation: ReviewContinuation | null;
let stopped: boolean;
afterEach(async () => { await e?.close(); });
after(closeShared);

async function env(o: { recordPosted?: boolean; continued?: boolean; writes?: boolean } = {}): Promise<ReviewEnv> {
  continuation = o.continued === false ? null : {
    sinceHeadSha: OLD,
    findings: [{ path: "src/app.ts", line: 3, thread_id: "PRRT_1", note: "c is wrong", resolved: false }],
  };
  stopped = false;
  e = await reviewEnv(o.writes === false ? { CLAW_GITHUB_WRITES_ENABLED: "false" } : {}, {
    deps: { continuationOf: async () => continuation, recordPosted: o.recordPosted ?? true, sessionStopped: async () => stopped },
  });
  e.gh.files = [{ filename: "src/app.ts", status: "modified", additions: 4, deletions: 1, patch: PR_PATCH }];
  e.gh.pr.additions = 4;
  e.gh.compares[`${OLD}...${HEAD}`] = { status: "ahead", files: [{ filename: "src/app.ts", status: "modified", additions: 2, deletions: 1, patch: DELTA_PATCH }] };
  // The last review's thread, as GitHub has it: opened by the acting user's account (bob) on this pull request.
  e.gh.threads.push({ id: "PRRT_1", isResolved: false, path: "src/app.ts", line: 3, reviewId: 800, author: "bob", pr: 7, repo: "AMD-AGI/demo" });
  return e;
}

const overview = async () => (await e.service.getPr(e.actor, { pr: PR })).body as Record<string, any>;
const resolve = (over: Record<string, unknown> = {}) => e.service.resolveThread(e.actor, { pr: PR, thread_id: "PRRT_1", head_sha: HEAD, ...over });
const audit = async (tool: string) => e.sql("SELECT result, detail, write, posted, arguments FROM claw_github_audit WHERE tool = $1 ORDER BY id", [tool]);

describe("N recording and scope", () => {
  test("N1 a posted review's findings are recorded with the threads GitHub opened for them; without recordPosted nothing is read or kept", async () => {
    await env({ continued: false });
    const o = await e.service.submitReview(e.actor, {
      pr: PR, head_sha: HEAD, event: "REQUEST_CHANGES", body: "Two things.", risk_judgement: LOW,
      comments: [{ path: "src/app.ts", line: 3, body: "c_fixed is\n  still   wrong" }, { path: "src/app.ts", line: 4, body: "d_new_issue leaks" }],
    });
    assert.equal(o.body.status, "submitted", o.text);
    const [row] = await audit("gh_review_submit");
    assert.deepEqual(row?.posted, {
      event: "REQUEST_CHANGES", review_id: 900,
      findings: [
        { path: "src/app.ts", line: 3, thread_id: "PRRT_2", note: "c_fixed is still wrong" },
        { path: "src/app.ts", line: 4, thread_id: "PRRT_3", note: "d_new_issue leaks" },
      ],
    });

    await env({ continued: false, recordPosted: false });
    const before = e.gh.calls.length;
    const plain = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "One.", risk_judgement: LOW, comments: [{ path: "src/app.ts", line: 3, body: "x" }] });
    assert.equal(plain.body.status, "submitted");
    assert.equal((await audit("gh_review_submit"))[0]?.posted, null, "nothing is kept for a session that is no review item");
    assert.equal(e.gh.calls.slice(before).filter((c) => /pullRequestReview\{databaseId\}/.test(String(c.body?.query ?? ""))).length, 0, "and GitHub is not asked for the threads");
  });

  test("N1b a dry run and a refusal record nothing", async () => {
    await env({ continued: false, writes: false });
    const dry = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "One.", risk_judgement: LOW, comments: [{ path: "src/app.ts", line: 3, body: "x" }] });
    assert.equal(dry.body.status, "dry_run");
    const refused = await e.service.submitReview(e.actor, { pr: PR, head_sha: "9".repeat(40), event: "COMMENT", body: "One.", risk_judgement: LOW });
    assert.equal(refused.body.reason, "head_moved");
    assert.deepEqual((await audit("gh_review_submit")).map((r) => r.posted), [null, null]);
  });

  test("N2 a thread that cannot be read back leaves its finding without one, and the review is posted all the same", async () => {
    await env({ continued: false });
    e.gh.threadsReadFails = true;
    const o = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "One.", risk_judgement: LOW, comments: [{ path: "src/app.ts", line: 3, body: "x" }] });
    assert.equal(o.body.status, "submitted", o.text);
    assert.equal(o.isError, false);
    assert.deepEqual((await audit("gh_review_submit"))[0]?.posted.findings, [{ path: "src/app.ts", line: 3, thread_id: null, note: "x" }]);
  });

  test("N3 a small plain continuation reads only the change since the last head, says so, and keeps the whole pull request's risk", async () => {
    await env();
    const o = await overview();
    assert.deepEqual(o.continuation, {
      since_head_sha: OLD, scope: "delta", reason: "small_delta", evidence: [], delta_files: ["src/app.ts"],
      findings: [{ path: "src/app.ts", line: 3, thread_id: "PRRT_1", resolved: false, note: "c is wrong" }],
    });
    assert.match(o.how_to_read, /^This is a re-review of only what changed since 222222222222: `files` and `diff` hold that change/);
    assert.match(o.how_to_read, /gh_thread_resolve/);
    assert.equal(e.gh.count(/\/compare\//, "GET"), 1, "one compare of the two heads");
    const diff = (await readSection(e.service, e.actor, PR, "diff")).text;
    assert.match(diff, /\+d_new_issue/, "the new issue is in what is read");
    assert.match(diff, /\+c_fixed/);
    assert.doesNotMatch(diff, /-b\n\+b2_first_round/, "the first round's change is not read again");
    assert.equal(o.files_complete, true);
    assert.ok(o.pull_request, "the overview is the whole pull request's otherwise");
  });

  test("N4 the same head: nothing new to read, only the findings to check", async () => {
    await env();
    continuation!.sinceHeadSha = HEAD;
    const o = await overview();
    assert.deepEqual([o.continuation.scope, o.continuation.reason, o.continuation.delta_files], ["unchanged", "head_unchanged", []]);
    assert.equal((await readSection(e.service, e.actor, PR, "diff")).text, "");
    assert.equal(e.gh.count(/\/compare\//), 0);
  });

  test("N5 a force push: the last head is gone, or is no ancestor, and the whole pull request is read again", async () => {
    await env();
    delete e.gh.compares[`${OLD}...${HEAD}`];
    let o = await overview();
    assert.deepEqual([o.continuation.scope, o.continuation.reason], ["full", "history_rewritten"]);
    assert.match((await readSection(e.service, e.actor, PR, "diff")).text, /\+b2_first_round/);
    assert.match(o.how_to_read, /the whole pull request is reviewed again \(history_rewritten\)/);
    await env();
    e.gh.compares[`${OLD}...${HEAD}`]!.status = "diverged";
    o = await overview();
    assert.deepEqual([o.continuation.scope, o.continuation.reason], ["full", "history_rewritten"]);
  });

  test("N6 a large change since the last head: the whole pull request again, by the review path's own limits", async () => {
    await env();
    e.configure({ CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES: "2" });
    let o = await overview();
    assert.deepEqual([o.continuation.scope, o.continuation.reason, o.continuation.delta_files], ["full", "large_delta", []]);
    await env();
    e.configure({ CLAW_GITHUB_REVIEW_FAST_MAX_FILES: "0" });
    o = await overview();
    assert.equal(o.continuation.reason, "large_delta");
  });

  test("N7 a change since that touches security or CI paths: the whole pull request again, with why", async () => {
    for (const filename of ["src/auth/session.ts", ".github/workflows/ci.yml"]) {
      await env();
      e.gh.compares[`${OLD}...${HEAD}`]!.files = [{ filename, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n x\n+y" }];
      const o = await overview();
      assert.deepEqual([o.continuation.scope, o.continuation.reason], ["full", "security_path"], filename);
      assert.ok(o.continuation.evidence.some((x: string) => x.includes(filename)), filename);
    }
  });

  test("N8 a first review is not asked about a continuation and reads as before", async () => {
    await env({ continued: false });
    const o = await overview();
    assert.equal(o.continuation, undefined);
    assert.doesNotMatch(o.how_to_read, /re-review/);
    assert.equal(e.gh.count(/\/compare\//), 0);
  });
});

describe("T gh_thread_resolve", () => {
  test("T1 resolves a thread the last review recorded and the acting user's account opened", async () => {
    await env();
    const o = await resolve();
    assert.equal(o.body.status, "resolved", o.text);
    assert.equal(e.gh.resolves.length, 1);
    assert.equal(e.gh.resolves[0]?.body.variables.id, "PRRT_1");
    assert.equal(e.gh.threads[0]?.isResolved, true);
    const [row] = await audit("gh_thread_resolve");
    assert.deepEqual([row?.result, row?.detail, row?.write, row?.arguments.thread_id], ["ok", "resolved", false, "PRRT_1"]);
  });

  test("T2 nothing else is resolved: a thread not recorded, another person's, another pull request's, a moved head, a stopped review", async () => {
    const cases: Array<[string, () => void | Promise<void>, Record<string, unknown>]> = [
      ["thread_not_recorded", () => { e.gh.threads.push({ ...e.gh.threads[0]!, id: "PRRT_9" }); }, { thread_id: "PRRT_9" }],
      ["thread_not_recorded", () => { continuation = null; }, {}],
      ["not_own_thread", () => { e.gh.threads[0]!.author = "alice"; }, {}],
      ["thread_not_on_pull_request", () => { e.gh.threads[0]!.pr = 8; }, {}],
      ["thread_not_on_pull_request", () => { e.gh.threads[0]!.repo = "AMD-AGI/other"; }, {}],
      ["head_moved", () => {}, { head_sha: "9".repeat(40) }],
      ["review_stopped", () => { stopped = true; }, {}],
      ["invalid_thread", () => {}, { thread_id: "PRRT 1; drop" }],
      ["review_target_mismatch", () => { e.actor.reviewTarget = { owner: "AMD-AGI", repo: "demo", number: 8 }; }, {}],
    ];
    for (const [code, arrange, over] of cases) {
      await env();
      await arrange();
      const o = await resolve(over);
      assert.equal(o.isError, true, `${code}: ${o.text}`);
      assert.equal(o.body.reason, code, o.text);
      assert.equal(e.gh.resolves.length, 0, `${code}: nothing resolved`);
      assert.equal(e.gh.threads[0]?.isResolved, false);
    }
  });

  test("T3 one already resolved is not resolved again; with writes off nothing is; none of it counts as a review or a merge", async () => {
    await env();
    e.gh.threads[0]!.isResolved = true;
    assert.equal((await resolve()).body.status, "already_resolved");
    assert.equal(e.gh.resolves.length, 0);
    await env({ writes: false });
    assert.equal((await resolve()).body.status, "dry_run");
    assert.equal(e.gh.resolves.length, 0);
    await env();
    e.configure({ CLAW_GITHUB_REVIEWS_PER_TOKEN_PER_HOUR: "1" });
    for (const id of ["PRRT_1", "PRRT_2", "PRRT_3"]) {
      if (id !== "PRRT_1") {
        e.gh.threads.push({ ...e.gh.threads[0]!, id, isResolved: false });
        continuation!.findings.push({ path: "src/app.ts", line: 3, thread_id: id, note: "", resolved: false });
      }
      assert.equal((await resolve({ thread_id: id })).body.status, "resolved", id);
    }
    const posted = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "One.", risk_judgement: LOW });
    assert.equal(posted.body.status, "submitted", "resolving three threads used none of the hour's one review");
  });
});
