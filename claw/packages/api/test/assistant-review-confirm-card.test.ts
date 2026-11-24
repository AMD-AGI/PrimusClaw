// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card for a merge (or an approval) that a review the assistant started for the person's own account holds for them, on a real
 * Postgres with the production schema, through the real outbox and its signed delivery. GitHub is the one thing faked (the review
 * service's `decide`). Skipped without DATABASE_URL, and a skip is not a pass.
 *
 * 2026-11-18 (N54): Primus-SaFE#892's merge was held for its owner (`confirmation_required`), the item went to "needs you", and the
 * assistant told them to press the card's button; no card was ever sent, since only a chat that started the review drew one.
 *
 *   C1  the held merge goes out as an `assistant.say` carrying `confirm_write` (`github_merge`, its ref, the button's label), in the
 *       person's language, signed to their chat exactly as `test/fixtures/github-merge-card.outbox.json` (the body the personal agent's
 *       own test reads); a later sync sends nothing more, and a new held merge (a new head) gets its own card
 *   C2  a held approval is a `github_review` card
 *   C3  no card for a review asked of someone else (its chat draws one for the reviewer), nor for one a chat started over the route
 *   C4  the card's button: `POST /v1/assistant/confirmations/:id/decision` is the review's own decision for the person it asks, with how
 *       they signed in; anyone else's press finds nothing, a key is refused, and nothing is decided for either
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

/** The body Claw signs and posts to the person's chat for C1's card, with what differs per run written as `<…>`. */
const FIXTURE = join(import.meta.dirname, "fixtures/github-merge-card.outbox.json");
const ALICE = "u-alice";
const BOB = "u-bob";
const PR = { owner: "AMD-AGI", repo: "Primus-SaFE", number: 892 };
const HEAD = "45b73efb65887734e089e62294ef6b28222f0546";
/** The event types the personal agent's subscription asks for (`personal-agent/packages/core/src/subscriptions/event-types.ts`). */
const CHAT_TYPES = ["run.completed", "run.failed", "assistant.say", "work_item.needs_you", "assistant.action", "approval.requested"];

describe("the card of a write a review the assistant started holds for its owner", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let ri: typeof import("../src/assistant/review-items.js");
  let tools: typeof import("../src/assistant/review-tools.js");
  let decided: Array<{ user: string; id: string; decision: string; via: unknown }>;

  before(async () => {
    w = await startWorld({
      CLAW_GITHUB_REVIEW_ENABLED: "true",
      CLAW_GITHUB_REVIEW_MCP_SECRET: "t".repeat(40),
      CLAW_ASSISTANT_REVIEW_ITEMS: "true",
      CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: "chat-client",
      // (no schedule tools, no personal skills: the review items alone put the decision route there)
      CLAW_TRIGGERS_ENABLED: "false",
      CLAW_USER_SKILLS_ENABLED: "false",
    });
    ri = await import("../src/assistant/review-items.js");
    tools = await import("../src/assistant/review-tools.js");
    // What the system says on its own is published to the session the way the world records it.
    (await import("../src/assistant/reports.js")).reportPorts.sayDeps = w.sayDeps;
    const { decideConfirmation } = await import("../src/github-review/mcp.js");
    const { db } = await import("../src/infra/db.js");
    // The review service, as the route's decision makes it, with GitHub left out: it answers the acting user only, as the real one does.
    const service = {
      delegationOf: async () => "on",
      checkPullRequest: async () => ({ isError: false, text: "", body: { status: "ok", title: "t", head_sha: HEAD } }),
      decide: async (user: string, id: string, decision: string, via: unknown) => {
        const [row] = await w.q("SELECT actor_user_id FROM claw_github_confirmations WHERE confirmation_id = $1", [id]);
        if (!row) return { http: 404, body: { ok: false, error: "not_found" } };
        if (row.actor_user_id !== user) return { http: 403, body: { ok: false, error: "only_the_acting_user_can_decide" } };
        decided.push({ user, id, decision, via });
        const status = decision === "allow" ? "merged" : "denied";
        await w.q("UPDATE claw_github_confirmations SET status = $2, decided_at = NOW() WHERE confirmation_id = $1", [id, status]);
        return { http: 200, body: { ok: true, status, ...(status === "merged" ? { merge_sha: "f".repeat(40) } : {}) } };
      },
    };
    tools.reviewToolPorts.decide = (user, id, decision, via, guard) => decideConfirmation(service as never, db, user, id, decision, via, guard);
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      const client = req.headers["x-test-client"];
      (req as any).user = {
        userId: id, userName: `Name ${id}`, platformKey: `pk-${id}`, virtualKey: `vk-${id}`, roles: ["default"],
        ...(typeof client === "string" ? { delegation: { actorSub: "svc-sub", clientId: client } } : {}),
      };
      const method = req.headers["x-test-method"];
      (req as any).authMethod = typeof method === "string" ? method : "identity_token";
    });
    await (await import("../src/github-review/mcp.js")).registerGithubReviewRoutes(app, { service: service as never });
    await (await import("../src/routes/assistant-proactive.js")).registerAssistantProactiveRoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await w?.stop();
  });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants,
      claw_assistant_messages, claw_sessions, claw_github_confirmations, claw_github_audit, claw_notification_outbox,
      claw_notification_subscriptions CASCADE`);
    decided = [];
  });

  const person = (userId: string) => ({ userId, userName: `Name ${userId}`, platformKey: `pk-${userId}`, virtualKey: `vk-${userId}`, roles: ["default"] });

  /** The person writes Chinese to their assistant, subscribes as their chat does, and starts the review as the router's `review_start`. */
  async function ownReview(o: { byAssistant?: boolean; zh?: boolean } = {}): Promise<{ itemId: string; seq: number; sessionId: string; routerSid: string }> {
    const { routerSid } = await w.user(ALICE);
    await w.subscribe(ALICE, CHAT_TYPES);
    if (o.zh ?? true) {
      await w.q(
        "INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, channel_context) VALUES ($1, gen_random_uuid()::text, $2, $3, '{}'::jsonb)",
        [routerSid, ALICE, "帮我审一下并合入 https://github.com/AMD-AGI/Primus-SaFE/pull/892"],
      );
    }
    const [created] = await ri.startReviews(person(ALICE) as never, "identity_token", {
      prs: [{ pr: PR, message: null }], actingAs: null, actingAsName: null, model: undefined, effort: undefined, reviewOnly: false,
      ...(o.byAssistant ?? true ? { mergeNeedsConfirmation: true } : {}),
    });
    // The review's turn ran and ended (the drain the world stubs would have handed it to a run).
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [created!.session_id]);
    const run = await w.openRun(created!.session_id);
    await w.closeRun(run.taskId);
    return { itemId: created!.item_id, seq: created!.seq, sessionId: created!.session_id, routerSid };
  }

  /** What the review tools write when `gh_pr_merge` (or an approval) is held for the acting user: a pending confirmation of the session. */
  async function held(sessionId: string, o: { kind?: "merge" | "review"; actor?: string; requester?: string; head?: string } = {}): Promise<string> {
    return (await w.q(
      `INSERT INTO claw_github_confirmations (confirmation_id, session_id, requester_user_id, actor_user_id, repo, pr, head_sha, title, author,
         reasons, status, kind, review, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'AMD-AGI/Primus-SaFE', 892, $4, 'feat: n54', 'octocat',
         '["this review was started through the assistant: a merge waits for the acting user"]'::jsonb, 'pending', $5, $6::jsonb,
         NOW() + INTERVAL '1 day')
       RETURNING confirmation_id::text AS id`,
      [sessionId, o.requester ?? ALICE, o.actor ?? ALICE, o.head ?? HEAD, o.kind ?? "merge",
        o.kind === "review" ? JSON.stringify({ event: "APPROVE", body: "LGTM", comments: [] }) : null],
    ))[0].id as string;
  }

  /** What the outbox holds that carries a card for a held GitHub write, oldest first. */
  const cards = async () => (await w.q(
    "SELECT event_id, subscription_id, payload FROM claw_notification_outbox WHERE payload->'confirm_write' IS NOT NULL ORDER BY id",
  )) as Array<{ event_id: string; subscription_id: string; payload: Record<string, any> }>;

  /** What the outbox posts, as the receiver gets it: the signed body of every due row. */
  async function delivered(): Promise<Array<{ url: string; headers: Record<string, string>; body: string }>> {
    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    await w.q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE delivered_at IS NULL");
    await w.mod.outbox.deliverDue({
      transport: async (req) => { sent.push({ url: req.target.url.toString(), headers: req.headers, body: req.body }); return 200; },
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      allowedHosts: new Set<string>(),
    });
    return sent;
  }

  /** The body as the fixture writes it: what differs per run (ids, times, the ref) as `<…>`. */
  function normalised(body: Record<string, any>, id: string): Record<string, any> {
    const ref = id.replace(/-/g, "").slice(0, 6);
    const text = String(body.text).replaceAll(ref, "<ref>");
    return {
      ...body, event_id: "<event_id>", occurred_at: "<occurred_at>", text,
      confirm_write: { ...body.confirm_write, confirmation_id: "<confirmation_id>", ref: "<ref>", expires_at: "<expires_at>" },
    };
  }

  test("C1 the held merge goes to the person's chat as a card, once, signed as the fixture the chat's own test reads", async () => {
    const r = await ownReview();
    const id = await held(r.sessionId);
    await ri.syncReviewItem(r.itemId);
    const item = await w.item(r.itemId);
    assert.equal(item.board_state, "needs_you", "the held merge needs its owner");
    const [card, ...more] = await cards();
    assert.ok(card, "a card went out for the held merge");
    assert.deepEqual(more, []);
    const ref = id.replace(/-/g, "").slice(0, 6);
    assert.equal(card.payload.type, "assistant.say");
    assert.equal(card.payload.user_id, ALICE);
    assert.deepEqual({ ...card.payload.confirm_write, expires_at: undefined },
      { confirmation_id: id, ref, kind: "github_merge", allow_label: "合入", expires_at: undefined });
    assert.ok(Date.parse(card.payload.confirm_write.expires_at) > Date.now(), "it lapses when the confirmation does");
    assert.equal(card.payload.text,
      `#${r.seq} Primus-SaFE#892 的合入在等你确认：点「合入」，或回复 批准 #${ref}；不想合就回复 拒绝 #${ref}。`);
    assert.equal(card.payload.item, undefined, "a card of its own, not a message about the item (whose card is the board's)");
    // Said in the assistant's own session too, as a web client and an evaluation read it.
    assert.equal((await w.q("SELECT session_id FROM claw_assistant_says WHERE say_id = $1", [card.event_id]))[0].session_id, r.routerSid);

    const posts = await delivered();
    const mine = posts.filter((p) => JSON.parse(p.body).event_id === card.event_id);
    assert.equal(mine.length, 1, "posted to the chat once");
    assert.equal(mine[0]!.url, "https://hooks.example.com/claw");
    assert.ok(mine[0]!.headers["x-claw-signature"] && mine[0]!.headers["x-claw-event-id"] === card.event_id, "signed, with its id");
    const body = JSON.parse(mine[0]!.body);
    assert.deepEqual(normalised(body, id), JSON.parse(readFileSync(FIXTURE, "utf8")),
      "the chat's test reads this very body (personal-agent/packages/teams/test/assistant-github-confirm-card.test.ts)");

    // Synced again (the turn's end, the answer's, the sweep): nothing more for the same held merge.
    await ri.syncReviewItem(r.itemId);
    await ri.syncReviewItem(r.itemId);
    assert.equal((await cards()).length, 1, "one card per held write");
    // The pull request got new commits, the review ran again and its merge is held on the new head: a card of its own.
    await w.q("UPDATE claw_github_confirmations SET status = 'stale' WHERE confirmation_id = $1", [id]);
    const again = await held(r.sessionId, { head: "b".repeat(40) });
    await ri.syncReviewItem(r.itemId);
    assert.deepEqual((await cards()).map((c) => c.payload.confirm_write.confirmation_id), [id, again]);
  });

  test("C2 a held approval is a card of its own kind, in English for a person who writes English", async () => {
    const r = await ownReview({ zh: false });
    const id = await held(r.sessionId, { kind: "review" });
    await ri.syncReviewItem(r.itemId);
    const [card] = await cards();
    const ref = id.replace(/-/g, "").slice(0, 6);
    assert.deepEqual([card?.payload.confirm_write.kind, card?.payload.confirm_write.allow_label], ["github_review", "Post the approval"]);
    assert.equal(card?.payload.text,
      `#${r.seq} The approval of Primus-SaFE#892 waits for your confirmation: press "Post the approval", or reply approve #${ref}; reply deny #${ref} to not approve it.`);
  });

  test("C3 no card for a review asked of someone else, nor for one a chat started over the route, nor for a write that asks someone else", async () => {
    // A chat started it (no `review_start`): the chat that started it draws the card itself.
    const byChat = await ownReview({ byAssistant: false });
    await held(byChat.sessionId);
    await ri.syncReviewItem(byChat.itemId);
    assert.equal((await w.item(byChat.itemId)).board_state, "needs_you");
    assert.deepEqual(await cards(), [], "a chat-started review: no card from here");

    // Asked of bob by alice: bob's item, and his chat (which started it) puts the card to him.
    await w.q("UPDATE claw_work_items SET board_state = 'done', closed_at = NOW() WHERE item_id = $1", [byChat.itemId]);
    await w.user(BOB);
    await w.subscribe(BOB, CHAT_TYPES);
    const [asked] = await ri.startReviews(person(ALICE) as never, "identity_token", {
      prs: [{ pr: { ...PR, number: 893 }, message: null }], actingAs: BOB, actingAsName: "Bob", model: undefined, effort: undefined,
      reviewOnly: false, actingAsUser: person(BOB) as never, mergeNeedsConfirmation: true,
    });
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [asked!.session_id]);
    const run = await w.openRun(asked!.session_id);
    await w.closeRun(run.taskId);
    await held(asked!.session_id, { actor: BOB, requester: ALICE });
    await ri.syncReviewItem(asked!.item_id);
    assert.deepEqual(await cards(), [], "a review asked of someone else: no card from here");

    // The owner's own review, but a write that asks someone else (never the owner's to press).
    const own = await ownReview();
    await held(own.sessionId, { actor: BOB });
    await ri.syncReviewItem(own.itemId);
    assert.deepEqual(await cards(), []);
  });

  test("C4 the card's button is the review's own decision, for the person it asks, signed in", async () => {
    const r = await ownReview();
    const id = await held(r.sessionId);
    await ri.syncReviewItem(r.itemId);
    const press = async (user: string, decision: string, headers: Record<string, string> = {}) => {
      const res = await app.inject({
        method: "POST", url: `/v1/assistant/confirmations/${id}/decision`, payload: { decision }, headers: { "x-test-user": user, ...headers },
      });
      return { status: res.statusCode, body: res.json() };
    };
    // A key is not the person: refused before anything is looked up.
    const key = await press(ALICE, "allow", { "x-test-method": "api_key" });
    assert.deepEqual([key.status, key.body.error], [403, "interactive_sign_in_required"]);
    // Someone else's press finds no card of theirs.
    const other = await press(BOB, "allow");
    assert.equal(other.status, 404);
    assert.deepEqual(decided, [], "nothing decided for either");
    // The person's own press, made for them by their chat (an allowed service): the review's decision, with who pressed it.
    const mine = await press(ALICE, "allow", { "x-test-client": "chat-client" });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body, { ok: true, data: { ok: true, status: "merged", merge_sha: "f".repeat(40) } });
    assert.deepEqual(decided, [{ user: ALICE, id, decision: "allow", via: { clientId: "chat-client", actorSub: "svc-sub" } }]);
    // The answer closed the item, as the typed command's does (`decideConfirmation` syncs it).
    const item = await w.item(r.itemId);
    assert.deepEqual([item.board_state, item.outcome], ["done", "accepted"]);
  });
});
