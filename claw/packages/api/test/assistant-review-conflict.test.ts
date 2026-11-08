// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review alice asked of bob that stops on a conflict in the pull request's branch (`assistant/review-conflict.ts`), against a real
 * Postgres with the production schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   C1  bob's worker reports blocked after GitHub refused its merge on merge state DIRTY: alice, who asked, is told through her own
 *       assistant, in the language she writes in, which pull request and that the author resolves the conflict; once per head commit
 *       (a second block on the same head is not told again, a new head that still conflicts is)
 *   C2  nothing is told to alice when the block is not a conflict (BEHIND, a merge that later went through, no merge tried), when the
 *       item is bob's own (no requested_by), when it does not need bob, or when alice asked for a review only (no merge)
 *   C3  the shape production has (2026-11-08, N5): a review handed over on someone's behalf whose session posts its review and then has
 *       its merge refused on DIRTY sends no worker report; the item becomes blocked through `syncReviewItem` (a 'policy' event), and the
 *       one who asked is told from there, once per head commit; a sync that finds the same state again tells nothing new
 * The check runs after the report is answered, not waited for (`checkConflictLater`): the tests wait for it (`conflictChecksSettled`).
 * The audit rows are written as the review service writes them; that it records GitHub's merge state on a refused merge is
 * github-review-service.test.ts M8c.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
type Row = Record<string, any>;

describe("a review stopped by a conflict tells the one who asked", { skip }, () => {
  let w: World;
  let conflict: typeof import("../src/assistant/review-conflict.js");
  let ri: typeof import("../src/assistant/review-items.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({ CLAW_GITHUB_REVIEW_ENABLED: "true", CLAW_GITHUB_REVIEW_MCP_SECRET: "t".repeat(40) });
    conflict = await import("../src/assistant/review-conflict.js");
    ri = await import("../src/assistant/review-items.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_assistant_messages, claw_pending_messages,
      claw_tasks, claw_assistants, claw_sessions, claw_github_audit, claw_github_confirmations CASCADE`);
    alice = await w.user("alice");
    bob = await w.user("bob");
    // alice asked for the review in Chinese, through her own assistant; bob has never written to his.
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, channel_context) VALUES ($1, 'm-ask', 'alice', $2, '{}'::jsonb)`,
      [alice.routerSid, "请 bob 帮我 review 并合入：https://github.com/AMD-AGI/demo/pull/7"],
    );
  });

  const HEAD = "a".repeat(40);
  type Review = { itemId: string; workerSid: string; pr: number };
  /** bob's review item for AMD-AGI/demo#N, asked by `requestedBy` (none: bob's own); the first one made is #7. */
  let made = 0;
  async function reviewFor(requestedBy: string | null, extra: Record<string, unknown> = {}): Promise<Review> {
    // A pull request and a title of its own each: one open review per pull request, and work_create gives the open item of a title back.
    made += 1;
    const pr = 6 + made;
    const item = await w.createItem(bob, `Review+merge AMD-AGI/demo#${pr}`);
    const params = { pr: { owner: "AMD-AGI", repo: "demo", number: pr }, review_only: false, ...(requestedBy ? { requested_by: requestedBy, requester_label: `Name ${requestedBy}` } : {}), ...extra };
    await w.q("UPDATE claw_work_items SET kind = 'review', params = params || $2::jsonb WHERE item_id = $1", [item.itemId, JSON.stringify(params)]);
    return { ...item, pr };
  }
  /** A `gh_pr_merge` call of the session as the review service records it. */
  async function merged(item: Review, result: string, detail: string, mergeState: string | null, head = HEAD): Promise<void> {
    await w.q(
      `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, repo, pr, head_sha, result, detail, merge_state)
       VALUES ('alice', 'bob', $1, 'gh_pr_merge', 'AMD-AGI/demo', $2, $3, $4, $5, $6)`,
      [item.workerSid, item.pr, head, result, detail, mergeState],
    );
  }
  let n = 0;
  async function blocked(item: { itemId: string }): Promise<void> {
    const turn = await w.workerTurn(item.itemId);
    n += 1;
    await w.mod.reports.ingestReport({ itemId: item.itemId, workerSessionId: turn.sid, generation: Number(turn.gen), runId: turn.task_id },
      { kind: "blocked", summary: `GitHub will not merge it (${n})`, question: "The branch has conflicts; what now?" }, "worker");
    await w.closeRun(turn.task_id);
    await conflict.conflictChecksSettled();
  }
  const toldAlice = async (): Promise<Row[]> => w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' ORDER BY created_at");

  test("C1 a block on a conflict is told to the one who asked, in her language, once per head commit", async () => {
    const item = await reviewFor("alice");
    await merged(item, "refused", "merge_state_not_clean", "DIRTY");
    await blocked(item);
    assert.equal((await w.item(item.itemId)).board_state, "needs_you");
    let told = await toldAlice();
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.match(told[0].text, /^你请人评审并合入的 AMD-AGI\/demo#7 合不进去：GitHub 显示这个分支和目标分支有冲突。需要作者先解决冲突/);
    assert.match(told[0].text, /https:\/\/github\.com\/AMD-AGI\/demo\/pull\/7$/);
    // Blocked again on the same head: not told twice.
    await blocked(item);
    assert.equal((await toldAlice()).length, 1);
    // The author pushed, and the new head still conflicts: told again.
    await merged(item, "refused", "merge_state_not_clean", "DIRTY", "b".repeat(40));
    await blocked(item);
    told = await toldAlice();
    assert.equal(told.length, 2);
    // In English to one who writes English.
    await w.q("UPDATE claw_assistant_messages SET content = 'Please ask bob to review and merge AMD-AGI/demo#7' WHERE user_id = 'alice'");
    await merged(item, "refused", "merge_state_not_clean", "DIRTY", "c".repeat(40));
    await blocked(item);
    told = await toldAlice();
    assert.equal(told.length, 3);
    assert.match(told[2].text, /^AMD-AGI\/demo#7, which you asked to be reviewed and merged, cannot be merged: GitHub says its branch has conflicts/);
    // Nothing of this goes to bob through this path: his own notices are his item's.
    assert.equal((await w.q("SELECT 1 FROM claw_assistant_says WHERE user_id = 'bob' AND text LIKE '%which you asked%'")).length, 0);
  });

  test("C2 nothing is told when the block is not a conflict, the review is bob's own, or the item does not need bob", async () => {
    const behind = await reviewFor("alice");
    await merged(behind, "refused", "merge_state_not_clean", "BEHIND");
    await blocked(behind);
    const later = await reviewFor("alice");
    await merged(later, "refused", "merge_state_not_clean", "DIRTY");
    await merged(later, "ok", "merged", null);
    await blocked(later);
    const none = await reviewFor("alice");
    await blocked(none);
    const own = await reviewFor(null);
    await merged(own, "refused", "merge_state_not_clean", "DIRTY");
    await blocked(own);
    assert.deepEqual(await toldAlice(), []);
    // The item does not need bob (a progress report): nothing, even on a conflict.
    const going = await reviewFor("alice");
    await merged(going, "refused", "merge_state_not_clean", "DIRTY");
    const turn = await w.workerTurn(going.itemId);
    await w.mod.reports.ingestReport({ itemId: going.itemId, workerSessionId: turn.sid, generation: Number(turn.gen), runId: turn.task_id },
      { kind: "progress", summary: "looking at it" }, "worker");
    await conflict.conflictChecksSettled();
    assert.deepEqual(await toldAlice(), []);
    // A review only (no merge was asked): nothing, even on a conflict.
    const only = await reviewFor("alice", { review_only: true });
    await merged(only, "refused", "merge_state_not_clean", "DIRTY");
    await blocked(only);
    assert.deepEqual(await toldAlice(), []);
  });

  test("C3 a review handed over on someone's behalf, blocked by its sync on a DIRTY merge, tells the one who asked", async () => {
    // The params a handed-over review is made with in production (`review-items.ts`): bob reviews as himself, alice asked, merge asked.
    const item = await reviewFor("alice", {
      acting_as: "bob", acting_as_name: "Name bob", brief: "Review and merge it", effort: null, model: null, requester_note: null,
    });
    // Its one turn ran and finished: the review was posted, then the merge was refused on DIRTY (gh_pr_follow rows follow it, as live).
    const run = await w.openRun(item.workerSid);
    await w.q(
      `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, repo, pr, head_sha, result, detail, at)
       VALUES ('alice', 'bob', $1, 'gh_review_submit', 'AMD-AGI/demo', $2, $3, 'ok', 'submitted', NOW() - interval '10 seconds')`,
      [item.workerSid, item.pr, HEAD],
    );
    await merged(item, "refused", "merge_state_not_clean", "DIRTY");
    await w.q(
      `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, repo, pr, head_sha, result, detail)
       VALUES ('alice', 'bob', $1, 'gh_pr_follow', 'AMD-AGI/demo', $2, $3, 'ok', 'merge_state_not_clean')`,
      [item.workerSid, item.pr, HEAD],
    );
    await w.closeRun(run.taskId);
    await ri.syncReviewItem(item.itemId);
    await conflict.conflictChecksSettled();
    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you");
    assert.equal(row.last_report_kind, "blocked");
    const events = await w.itemEvents(item.itemId);
    assert.deepEqual(events.filter((e: Row) => e.kind === "blocked").map((e: Row) => e.source), ["policy"]);
    // Through the same sync as bob's own blocked notice, nothing reported by a worker.
    assert.equal(events.filter((e: Row) => e.source === "worker").length, 0);
    let told = await toldAlice();
    assert.equal(told.length, 1, JSON.stringify(told));
    const pr = `AMD-AGI/demo#${item.pr}`;
    assert.ok(told[0].text.startsWith(`你请人评审并合入的 ${pr} 合不进去：GitHub 显示这个分支和目标分支有冲突`), told[0].text);
    assert.match(told[0].text, new RegExp(`https://github\\.com/AMD-AGI/demo/pull/${item.pr}$`));
    // A sync that finds the same state writes nothing and tells nothing new.
    await ri.syncReviewItem(item.itemId);
    await conflict.conflictChecksSettled();
    assert.equal((await toldAlice()).length, 1);
    // The author pushed, and the merge on the new head is refused on DIRTY again: the state reads the same, the one who asked is told again.
    await merged(item, "refused", "merge_state_not_clean", "DIRTY", "b".repeat(40));
    await ri.syncReviewItem(item.itemId);
    await conflict.conflictChecksSettled();
    told = await toldAlice();
    assert.equal(told.length, 2);
    // A block that is not a conflict, through the same sync: nothing more.
    await merged(item, "refused", "merge_state_not_clean", "BEHIND", "c".repeat(40));
    await ri.syncReviewItem(item.itemId);
    await conflict.conflictChecksSettled();
    assert.equal((await toldAlice()).length, 2);
  });
});
