// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whose account merges a review asked of someone else ("请 bob 帮我 review 并合入"), the whole way: a real Postgres with the production
 * schema, the review started as the channel starts it, the real review service (`GithubReview`) for bob's review and every merge, the
 * real follow sweep (`followReviewItems`), the real outbox for the card, and the card's real decision route. GitHub is a fake that
 * answers in GitHub's own shapes and records every request with the token it came with. Skipped without DATABASE_URL, and a skip is
 * not a pass.
 *
 * The rule (2026-11-20): the reviewer's account merges whenever it can; the requester's own account only when the reviewer
 * cannot, and then only on the requester's yes, asked with a card.
 *
 *   MA1 bob is fully_auto: his approval and his merge are made with his account; the sweep only reads; alice's account is never asked for
 *   MA2 bob is high_risk_confirm and his merge is held: it waits for bob (his held merge, his to answer, his account when he allows it);
 *       the sweep never uses alice's account, merges nothing and asks alice nothing (an item made under the old rule included)
 *   MA3 bob approved but GitHub refused his merge for a permission reason: alice is asked once, by a card in her own conversation
 *       ("Bob 已批准，但 Bob 没有合入权限；要用你自己的账号合入吗？", 合入 / 不合, the body the chat's own test reads), the item waits
 *       for her and bob is not asked about it; 合入 reads every gate again and merges with alice's account
 *   MA4 不合 leaves it unmerged and ends the item; she is not asked again for that head
 *   MA5 合入 after a gate shut (CI red, a new commit) merges nothing and says why
 *   MA6 alice did not write the pull request: she is never asked, and nothing is ever merged with her account, not even on a yes
 *   MA7 GitHub refused bob's merge with a 403 that is not a permission (an abuse-detection limit with Retry-After, a bare "Forbidden"):
 *       bob may merge once it passes, so alice is never asked and her account is never fetched
 *   MA8 GitHub's merge state is UNSTABLE (only a check the base branch does not require failed): bob's own merge goes ahead as GitHub
 *       would, but alice's account needs CLEAN: she is not asked while it is UNSTABLE, and 合入 pressed while it is merges nothing
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

const ALICE = "u-alice";
const BOB = "u-bob";
/** The body Claw signs and posts to alice's chat for MA3's question, with what differs per run written as `<…>`. */
const FIXTURE = join(import.meta.dirname, "fixtures/github-requester-merge-card.outbox.json");
/** GitHub's answer to a merge by an account a protected branch does not let push (405, as `PUT /pulls/{n}/merge` gives it). */
const NOT_AUTHORIZED = { status: 405, message: "You're not authorized to push to this branch. Visit https://docs.github.com/articles/about-protected-branches/ for more information." };
/** GitHub's passing 403s for a merge: a retry gets past them, so neither says bob may not merge. */
const PASSING_403S = [
  { status: 403, message: "You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.", headers: { "retry-after": "60" } },
  { status: 403, message: "Forbidden" },
];
const CHAT_TYPES = ["run.completed", "run.failed", "assistant.say", "work_item.needs_you", "assistant.action", "approval.requested"];

describe("whose account merges a review asked of someone else", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let ri: typeof import("../src/assistant/review-items.js");
  let svc: typeof import("../src/github-review/service.js");
  let store: typeof import("../src/github-review/store.js");
  let fake: typeof import("./support/fake-github.js");
  let env: typeof import("./support/review-env.js");
  let gh: InstanceType<typeof import("./support/fake-github.js").FakeGithub>;
  let service: InstanceType<typeof import("../src/github-review/service.js").GithubReview>;
  /** Every credential the review service asked the identity service for, by whose account. */
  let resolved: string[];
  let db: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> };

  before(async () => {
    w = await startWorld({
      CLAW_GITHUB_REVIEW_ENABLED: "true",
      CLAW_GITHUB_REVIEW_MCP_SECRET: "t".repeat(40),
      CLAW_ASSISTANT_REVIEW_ITEMS: "true",
      CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: "chat-client",
      CLAW_GITHUB_REVIEWS_PER_TOKEN_PER_HOUR: "50",
      CLAW_GITHUB_REVIEWS_PER_HOUR: "50",
      CLAW_TRIGGERS_ENABLED: "false",
      CLAW_USER_SKILLS_ENABLED: "false",
    });
    ri = await import("../src/assistant/review-items.js");
    svc = await import("../src/github-review/service.js");
    store = await import("../src/github-review/store.js");
    fake = await import("./support/fake-github.js");
    env = await import("./support/review-env.js");
    (await import("../src/assistant/reports.js")).reportPorts.sayDeps = w.sayDeps;
    const pg = w.h.app.db.db;
    db = { query: async (text, params) => { const r = await pg.query(text, params as never); return { rows: r.rows, rowCount: r.rowCount }; } };
    const { readGithubReviewSettings } = await import("../src/github-review/settings.js");
    // One review service for the whole file, as the process has one; each test gives it a fresh GitHub.
    service = new svc.GithubReview({
      settings: () => readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: env.SECRET, CLAW_GITHUB_WRITES_ENABLED: "true" }, true),
      db, fetchImpl: (input, init) => gh.fetch(input, init), sleep: async () => {}, recordPosted: true, sessionStopped: ri.reviewSessionStopped,
      resolveCredential: async (req) => {
        resolved.push(req.userId);
        return req.userId === BOB ? env.credential() : env.credential({ token: env.REQUESTER_TOKEN, providerLogin: "alice" });
      },
    });
    const { decideConfirmation, registerGithubReviewRoutes } = await import("../src/github-review/mcp.js");
    const tools = await import("../src/assistant/review-tools.js");
    tools.reviewToolPorts.decide = (user, id, decision, via, guard) => decideConfirmation(service, db, user, id, decision, via, guard);
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      (req as any).user = { userId: id, userName: `Name ${id}`, platformKey: `pk-${id}`, virtualKey: `vk-${id}`, roles: ["default"] };
      (req as any).authMethod = "identity_token";
    });
    // The real service behind the review routes: the review items check the pull request and follow it with it (`reviewItemPorts`).
    await registerGithubReviewRoutes(app, { service });
    await (await import("../src/routes/assistant-proactive.js")).registerAssistantProactiveRoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await w?.stop();
  });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants,
      claw_assistant_messages, claw_sessions, claw_github_confirmations, claw_github_audit, claw_github_review_settings, claw_github_write_locks,
      claw_notification_outbox, claw_notification_subscriptions CASCADE`);
    gh = new fake.FakeGithub();
    resolved = [];
  });

  const PR = { owner: "AMD-AGI", repo: "demo", number: 7 };
  const person = (userId: string) => ({ userId, userName: `Name ${userId}`, platformKey: `pk-${userId}`, virtualKey: `vk-${userId}`, roles: ["default"] });
  type Actor = import("../src/github-review/service.js").ReviewActor;

  /**
   * alice (who writes Chinese to her assistant, and whose chat subscribes) asks bob to review and merge `AMD-AGI/demo#7`, which she
   * wrote; bob's review mode is `mode`. As the channel starts it (`startReviews` with bob's own credentials). Bob's review tools act as
   * the session's config says.
   */
  async function askBob(mode: "fully_auto" | "high_risk_confirm"): Promise<{ itemId: string; sessionId: string; actor: Actor; aliceSid: string }> {
    const alice = await w.user(ALICE);
    await w.user(BOB);
    await w.subscribe(ALICE, CHAT_TYPES);
    await w.q(
      "INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, channel_context) VALUES ($1, gen_random_uuid()::text, $2, $3, '{}'::jsonb)",
      [alice.routerSid, ALICE, "请 bob 帮我 review 并合入 https://github.com/AMD-AGI/demo/pull/7"],
    );
    await store.setReviewMode(db, BOB, mode);
    const [created] = await ri.startReviews(person(ALICE) as never, "identity_token", {
      prs: [{ pr: PR, message: null }], actingAs: BOB, actingAsName: "Bob", actingAsUser: person(BOB) as never,
      model: undefined, effort: undefined, reviewOnly: false,
    });
    assert.equal((created as Record<string, unknown>).merge_by_requester, true, "a review asked of someone else that may merge");
    const { mergeNeedsConfirmationOf, reviewOnlyOf } = await import("../src/github-review/review-target.js");
    const [cfg] = await w.q("SELECT config FROM claw_sessions WHERE session_id = $1", [created!.session_id]);
    const actor: Actor = {
      sessionId: created!.session_id, requesterUserId: ALICE, actorUserId: BOB, requesterLabel: "Name alice",
      reviewOnly: reviewOnlyOf(cfg.config), mergeNeedsConfirmation: mergeNeedsConfirmationOf(cfg.config),
    };
    return { itemId: created!.item_id, sessionId: created!.session_id, actor, aliceSid: alice.routerSid };
  }

  /** bob's review turn, as its tools make it: it reads the head, approves it, and calls `gh_pr_merge` judged `level`; then the turn ends. */
  async function bobReviews(r: { sessionId: string; actor: Actor }, level: "low" | "high"): Promise<Record<string, any>> {
    await env.reviewedHead({ sql: (text: string, params?: unknown[]) => w.q(text, params as never), actor: r.actor }, { pr: env.PR });
    const approved = await service.submitReview(r.actor, {
      pr: env.PR, head_sha: fake.HEAD, event: "APPROVE", body: "No blocking findings.", risk_judgement: { level: "low", reason: "an ordinary change" },
      coverage: gh.files.map((f) => ({ path: f.filename, status: "reviewed" })),
    });
    assert.equal(approved.body.status, "submitted", approved.text);
    const merged = await service.mergePr(r.actor, { pr: env.PR, head_sha: fake.HEAD, risk_judgement: { level, reason: level === "high" ? "a person should look" : "an ordinary change" } });
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [r.sessionId]);
    const run = await w.openRun(r.sessionId);
    await w.closeRun(run.taskId);
    await ri.sweepReviewItems();
    return merged.body;
  }

  /** One look of the sweep, as each tick makes it (always due: `now` is moved past the last look). */
  let tick = 0;
  async function sweep(): Promise<number> {
    tick += 1;
    return ri.followReviewItems(Date.now() + tick * 2 * ri.REVIEW_FOLLOW_MS);
  }

  const puts = () => gh.calls.filter((c) => c.method === "PUT");
  const asAlice = () => gh.calls.filter((c) => c.authorization === `Bearer ${env.REQUESTER_TOKEN}`);
  const asks = async (sessionId: string) =>
    w.q("SELECT confirmation_id::text AS id, actor_user_id, status, head_sha, kind FROM claw_github_confirmations WHERE session_id = $1 AND kind = 'requester_merge' ORDER BY created_at", [sessionId]);
  const cardsTo = async (user: string) =>
    w.q("SELECT event_id, payload FROM claw_notification_outbox o JOIN claw_notification_subscriptions s USING (subscription_id) WHERE s.owner_user_id = $1 AND o.payload->'confirm_write' IS NOT NULL ORDER BY o.id", [user]);
  async function press(user: string, id: string, decision: "allow" | "deny"): Promise<Record<string, any>> {
    const r = await app.inject({ method: "POST", url: `/v1/assistant/confirmations/${id}/decision`, payload: { decision }, headers: { "x-test-user": user } });
    return { http: r.statusCode, ...(r.json() as Record<string, any>) };
  }

  /** bob approves, GitHub refuses his merge for a permission reason, and the sweep asks alice: her question's id, and its card. */
  async function bobCannotMerge(): Promise<{ itemId: string; sessionId: string; aliceSid: string; askId: string; card: Record<string, any> }> {
    const r = await askBob("fully_auto");
    gh.mergeAnswers = [NOT_AUTHORIZED];
    const merged = await bobReviews(r, "low");
    assert.deepEqual([merged.status, merged.reason], ["refused", "merge_not_permitted"], JSON.stringify(merged));
    assert.equal(puts().length, 1);
    assert.equal(puts()[0]!.authorization, `Bearer ${env.TOKEN}`, "bob's merge was tried first, with bob's account");
    assert.equal(asAlice().length, 0);
    gh.calls.length = 0;
    assert.equal(await sweep(), 0, "the item does not end: it waits for alice's answer");
    const [ask, ...more] = await asks(r.sessionId);
    assert.ok(ask, "alice is asked");
    assert.deepEqual(more, []);
    assert.deepEqual([ask.actor_user_id, ask.status, ask.head_sha], [ALICE, "pending", fake.HEAD], "the question is alice's, for this head");
    assert.equal(puts().length, 0, "nothing is merged by asking");
    const [card] = await cardsTo(ALICE);
    assert.ok(card, "the question reached alice's chat as a card");
    return { ...r, askId: ask.id, card };
  }

  test("MA1 bob is fully_auto: his account approves and merges; the sweep only reads, and alice's account is never asked for", async () => {
    const r = await askBob("fully_auto");
    const merged = await bobReviews(r, "low");
    assert.equal(merged.status, "merged", JSON.stringify(merged));
    assert.equal(puts().length, 1);
    assert.equal(puts()[0]!.authorization, `Bearer ${env.TOKEN}`, "merged with bob's own account");
    // GitHub now has it merged; the sweep sees that, with bob's account, and the item ends.
    gh.pr.merged = true;
    gh.pr.state = "closed";
    gh.calls.length = 0;
    await sweep();
    const item = await w.item(r.itemId);
    assert.deepEqual([item.board_state, item.outcome], ["done", "accepted"]);
    assert.equal(asAlice().length, 0);
    assert.ok(!resolved.includes(ALICE), `alice's credential was never fetched: ${resolved.join(",")}`);
    assert.deepEqual(await asks(r.sessionId), [], "nobody asked alice");
    assert.deepEqual(await cardsTo(ALICE), []);
  });

  test("MA2 bob is high_risk_confirm and his merge is held: it waits for bob, the sweep asks alice nothing and uses nothing of hers", async () => {
    const r = await askBob("high_risk_confirm");
    const merged = await bobReviews(r, "high");
    assert.equal(merged.status, "confirmation_required", JSON.stringify(merged));
    const [held] = await w.q("SELECT confirmation_id::text AS id, actor_user_id, status, kind FROM claw_github_confirmations WHERE session_id = $1", [r.sessionId]);
    assert.deepEqual([held.actor_user_id, held.status, held.kind], [BOB, "pending", "merge"], "the merge is held for bob");
    const waiting = await w.item(r.itemId);
    assert.deepEqual([waiting.board_state, waiting.summary], ["needs_you", "the merge of AMD-AGI/demo#7 is held"], "bob's to answer");
    // An item made under the old rule is this very item (its params carried merge_by_requester then as now): many looks change nothing.
    gh.calls.length = 0;
    for (let i = 0; i < 3; i++) assert.equal(await sweep(), 0);
    assert.equal(gh.calls.length > 0, true, "the sweep looked at the pull request");
    assert.ok(gh.calls.every((c) => c.authorization === `Bearer ${env.TOKEN}`), "read with bob's account only");
    assert.equal(puts().length, 0, "nothing merged while bob has not answered");
    assert.ok(!resolved.includes(ALICE), `alice's credential was never fetched: ${resolved.join(",")}`);
    assert.deepEqual(await asks(r.sessionId), []);
    assert.deepEqual(await cardsTo(ALICE), [], "no card for alice");
    assert.equal((await w.q("SELECT status FROM claw_github_confirmations WHERE confirmation_id = $1", [held.id]))[0].status, "pending", "still bob's to answer");
    // The held merge is bob's card to answer (only bob can), and his allow merges with his account.
    assert.equal((await press(ALICE, held.id, "allow")).http, 404, "alice cannot answer bob's held merge");
    const answer = await press(BOB, held.id, "allow");
    assert.equal(answer.data?.status, "merged", JSON.stringify(answer));
    assert.equal(puts().length, 1);
    assert.equal(puts()[0]!.authorization, `Bearer ${env.TOKEN}`, "merged with bob's account, on bob's confirmation");
    assert.equal(asAlice().length, 0);
  });

  test("MA3 bob cannot merge: alice is asked once with a card, bob is not asked about it, and 合入 merges with her account after every gate is read again", async () => {
    const { itemId, sessionId, aliceSid, askId, card } = await bobCannotMerge();
    const ref = askId.replace(/-/g, "").slice(0, 6);
    assert.equal(card.payload.type, "assistant.say");
    assert.deepEqual({ ...card.payload.confirm_write, expires_at: undefined },
      { confirmation_id: askId, ref, kind: "github_merge", allow_label: "合入", expires_at: undefined });
    assert.ok(card.payload.text.startsWith("Bob 已批准 AMD-AGI/demo#7，但 Bob 没有合入权限；要用你自己的账号合入吗？"), card.payload.text);
    // Said in alice's own assistant conversation, where she asked.
    assert.equal((await w.q("SELECT session_id FROM claw_assistant_says WHERE say_id = $1", [card.event_id]))[0].session_id, aliceSid);
    // The body her chat gets, signed, is the one the chat's own test reads.
    await w.q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE delivered_at IS NULL");
    const sent: string[] = [];
    await w.mod.outbox.deliverDue({
      transport: async (req) => { sent.push(req.body); return 200; },
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      allowedHosts: new Set<string>(),
    });
    const body = sent.map((b) => JSON.parse(b)).find((b) => b.event_id === card.event_id);
    assert.ok(body, "posted to her chat");
    const normalised = {
      ...body, event_id: "<event_id>", occurred_at: "<occurred_at>", text: String(body.text).replaceAll(ref, "<ref>"),
      confirm_write: { ...body.confirm_write, confirmation_id: "<confirmation_id>", ref: "<ref>", expires_at: "<expires_at>" },
    };
    assert.deepEqual(normalised, JSON.parse(readFileSync(FIXTURE, "utf8")),
      "the chat's test reads this very body (personal-agent/packages/teams/test/assistant-github-confirm-card.test.ts K4)");
    // The item waits for alice, and it is not bob's to look at.
    let item = await w.item(itemId);
    assert.deepEqual([item.board_state, item.summary],
      ["in_progress", "AMD-AGI/demo#7: approved, the reviewer cannot merge; asking the requester"]);
    // More looks ask nothing more.
    assert.equal(await sweep(), 0);
    assert.equal((await asks(sessionId)).length, 1);
    assert.equal((await cardsTo(ALICE)).length, 1, "one card, once");
    assert.equal(puts().length, 0);
    // bob cannot answer alice's question.
    assert.equal((await press(BOB, askId, "allow")).http, 404);
    // 合入: every gate read again, with alice's account, and merged with it.
    gh.calls.length = 0;
    const answer = await press(ALICE, askId, "allow");
    assert.equal(answer.data?.status, "merged", JSON.stringify(answer));
    assert.equal(puts().length, 1);
    assert.equal(puts()[0]!.authorization, `Bearer ${env.REQUESTER_TOKEN}`, "merged with alice's own account");
    assert.deepEqual(puts()[0]!.body, { sha: fake.HEAD, merge_method: "squash" });
    assert.ok(gh.calls.some((c) => /\/check-runs$/.test(c.path) && c.authorization === `Bearer ${env.REQUESTER_TOKEN}`), "CI read again before the merge");
    assert.ok(gh.calls.some((c) => /\/pulls\/7\/reviews\/\d+$/.test(c.path)), "bob's approval read again before the merge");
    const [done] = await asks(sessionId);
    assert.equal(done.status, "merged");
    const [audit] = await w.q("SELECT actor_user_id, requester_user_id, result, detail, write FROM claw_github_audit WHERE session_id = $1 AND tool = 'gh_pr_merge_as_requester'", [sessionId]);
    assert.deepEqual(audit, { actor_user_id: ALICE, requester_user_id: ALICE, result: "ok", detail: "merged", write: true });
    item = await w.item(itemId);
    assert.deepEqual([item.board_state, item.outcome, item.summary],
      ["done", "accepted", "AMD-AGI/demo#7 merged with the requester's account (reviewer cannot merge)"]);
    assert.equal(item.params.requester_view.merged, true);
    // Pressed again: nothing more is merged.
    const again = await press(ALICE, askId, "allow");
    assert.notEqual(again.data?.status, "merged");
    assert.equal(puts().length, 1);
  });

  test("MA4 不合 leaves it unmerged and ends the item; alice is not asked again for that head", async () => {
    const { itemId, sessionId, askId } = await bobCannotMerge();
    gh.calls.length = 0;
    const answer = await press(ALICE, askId, "deny");
    assert.equal(answer.data?.status, "denied", JSON.stringify(answer));
    assert.equal(puts().length, 0);
    const item = await w.item(itemId);
    assert.deepEqual([item.board_state, item.outcome, item.summary], ["done", "stopped", "the requester chose not to merge AMD-AGI/demo#7"]);
    // (an item that ended is not followed again; asked directly, the follow says she declined and opens nothing)
    const looked = await service.followPullRequest({
      sessionId, ref: PR, actingUserId: BOB, requesterUserId: ALICE, requesterLabel: "Name alice", mergeByRequester: true,
    });
    assert.deepEqual([looked.body.status, looked.body.reason], ["waiting", "requester_declined"], looked.text);
    assert.equal((await asks(sessionId)).length, 1);
    assert.equal(puts().length, 0);
  });

  test("MA5 合入 after a gate shut merges nothing and says why: CI red, then a new commit", async () => {
    let s = await bobCannotMerge();
    gh.checkRuns = [{ name: "test", status: "completed", conclusion: "failure" }];
    gh.calls.length = 0;
    let answer = await press(ALICE, s.askId, "allow");
    assert.deepEqual([answer.data?.status, answer.data?.reason], ["refused", "ci_not_green"], JSON.stringify(answer));
    assert.equal(puts().length, 0);
    // A push after she was asked: the head she was asked about is not the pull request's any more.
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_assistant_messages, claw_sessions, claw_github_confirmations, claw_github_audit, claw_notification_outbox, claw_notification_subscriptions CASCADE");
    gh = new fake.FakeGithub();
    s = await bobCannotMerge();
    gh.pr.head = { ...gh.pr.head, sha: "2".repeat(40) };
    gh.calls.length = 0;
    answer = await press(ALICE, s.askId, "allow");
    assert.deepEqual([answer.data?.status, answer.data?.reason], ["stale", "head_moved"], JSON.stringify(answer));
    assert.equal(puts().length, 0);
  });

  test("MA6 alice did not write the pull request: she is never asked, and her account merges nothing even on a yes", async () => {
    gh.pr.user = { login: "mallory" };
    const r = await askBob("fully_auto");
    gh.mergeAnswers = [NOT_AUTHORIZED];
    const merged = await bobReviews(r, "low");
    assert.equal(merged.reason, "merge_not_permitted");
    gh.calls.length = 0;
    await sweep();
    await sweep();
    assert.deepEqual(await asks(r.sessionId), [], "never asked");
    assert.deepEqual(await cardsTo(ALICE), []);
    assert.equal(puts().length, 0);
    // A question that somehow stood (one opened by hand) is refused at her yes, since she did not write it.
    const c = await store.openConfirmation(db, {
      sessionId: r.sessionId, requesterUserId: ALICE, actorUserId: ALICE, repo: "AMD-AGI/demo", pr: 7, headSha: fake.HEAD, title: "t", author: "mallory",
      kind: "requester_merge", review: null, reasons: [], checks: {}, ttlSeconds: 3600,
    });
    const answer = await press(ALICE, c.id, "allow");
    assert.deepEqual([answer.data?.status, answer.data?.reason], ["refused", "requester_not_author"], JSON.stringify(answer));
    assert.equal(puts().length, 0, "nothing merged with alice's account");
  });

  test("MA8 an UNSTABLE merge state (only an advisory check failed) is not CLEAN: alice is not asked, and 合入 pressed while it is merges nothing", async () => {
    // UNSTABLE before she is asked: bob's merge is tried (and refused for a permission), the sweep asks her nothing.
    const r = await askBob("fully_auto");
    gh.statuses = [{ context: "codecov/patch", state: "failure" }];
    gh.graphql.mergeStateStatus = "UNSTABLE";
    gh.mergeAnswers = [NOT_AUTHORIZED];
    const merged = await bobReviews(r, "low");
    assert.deepEqual([merged.status, merged.reason], ["refused", "merge_not_permitted"], JSON.stringify(merged));
    assert.equal(puts()[0]!.authorization, `Bearer ${env.TOKEN}`, "bob's merge went ahead on UNSTABLE, as GitHub would");
    gh.calls.length = 0;
    for (let i = 0; i < 3; i++) assert.equal(await sweep(), 0);
    assert.deepEqual(await asks(r.sessionId), [], "never asked while the merge state is UNSTABLE");
    assert.deepEqual(await cardsTo(ALICE), []);
    assert.equal(puts().length, 0);
    // UNSTABLE after she was asked: her 合入 reads it again and merges nothing.
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_assistant_messages, claw_sessions, claw_github_confirmations, claw_github_audit, claw_github_review_settings, claw_github_write_locks, claw_notification_outbox, claw_notification_subscriptions CASCADE");
    gh = new fake.FakeGithub();
    const s = await bobCannotMerge();
    gh.statuses = [{ context: "codecov/patch", state: "failure" }];
    gh.graphql.mergeStateStatus = "UNSTABLE";
    gh.calls.length = 0;
    const answer = await press(ALICE, s.askId, "allow");
    assert.deepEqual([answer.data?.status, answer.data?.reason], ["refused", "merge_state_not_clean"], JSON.stringify(answer));
    assert.equal(puts().length, 0, "nothing merged with alice's account");
  });

  test("MA7 a 403 that is not a permission (abuse detection with Retry-After, a bare Forbidden) is not bob's missing permission: alice is never asked and her account never fetched", async () => {
    for (const answer of PASSING_403S) {
      await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_assistant_messages, claw_sessions, claw_github_confirmations, claw_github_audit, claw_github_review_settings, claw_github_write_locks, claw_notification_outbox, claw_notification_subscriptions CASCADE");
      gh = new fake.FakeGithub();
      resolved = [];
      const r = await askBob("fully_auto");
      gh.mergeAnswers = [answer];
      const merged = await bobReviews(r, "low");
      assert.equal(merged.status, "refused", JSON.stringify(merged));
      assert.notEqual(merged.reason, "merge_not_permitted", `${answer.message}: ${JSON.stringify(merged)}`);
      assert.equal(puts().length, 1);
      assert.equal(puts()[0]!.authorization, `Bearer ${env.TOKEN}`, "bob's merge, with bob's account");
      const [audit] = await w.q("SELECT detail FROM claw_github_audit WHERE tool = 'gh_pr_merge' ORDER BY id DESC LIMIT 1");
      assert.notEqual(audit?.detail, "merge_not_permitted", answer.message);
      gh.calls.length = 0;
      for (let i = 0; i < 3; i++) await sweep();
      assert.deepEqual(await asks(r.sessionId), [], `alice is never asked after "${answer.message}"`);
      assert.deepEqual(await cardsTo(ALICE), [], answer.message);
      assert.equal(asAlice().length, 0, answer.message);
      assert.ok(!resolved.includes(ALICE), `alice's credential was never fetched after "${answer.message}": ${resolved.join(",")}`);
      assert.ok(puts().every((c) => c.authorization === `Bearer ${env.TOKEN}`), "any merge the sweep makes is bob's");
    }
  });
});
