// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * "Return to source": a person with a subscription on each of two chat surfaces (Teams and Slack) reads each assistant message once,
 * on the right one (`notifications/surfaces.ts`). Against a real Postgres whose schema `initDb` built, with the person's messages sent
 * through the session route a channel uses and the subscriptions made through the subscription route.
 *
 *   S1 a reply goes back only to the surface the turn's message came from
 *   S2 a proactive message (an item's update, its needs-you) goes to the surface the person wrote from last
 *   S3 after a message from Teams, a reply and what follows go to Teams
 *   S4 a surface whose subscription was deleted falls back to the next most recent one, never to nothing
 *   S5 an old client (no surface on the subscription, no channel on the message) is Teams, and its one subscription gets everything
 *   S6 a person who never wrote, or whose subscriptions are all of one surface, gets it on each, as before
 *   S7 a surface label is a lowercase word: refused otherwise, kept on the subscription, changed by PATCH
 *   S8 delivery is unchanged: the slack receiver is posted the signed event, the teams one nothing
 *
 * Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";
import type { OutboundRequest } from "../src/notifications/transport.js";

const skip = postgresSkipReason();
const TEAMS_URL = "https://93.184.216.34/teams/route-a";
const SLACK_URL = "https://93.184.216.35/slack/route-a";

describe("return to source", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let alice: { userId: string; routerSid: string };
  let surfaces: typeof import("../src/notifications/surfaces.js");

  before(async () => {
    w = await startWorld({ NOTIFY_WEBHOOK_ALLOWED_HOSTS: "" });
    surfaces = await import("../src/notifications/surfaces.js");
    w.mod.outbound.registerAssistantDeliveryHook();
    const { registerSessionRoutes } = await import("../src/routes/sessions.js");
    const { registerNotificationSubscriptionRoutes } = await import("../src/routes/notification-subscriptions.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { userId: "alice", userName: "Alice", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
    });
    await registerSessionRoutes(app);
    await registerNotificationSubscriptionRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await w?.stop(); });

  beforeEach(async () => {
    for (const t of [
      "claw_notification_outbox", "claw_notification_subscriptions", "claw_assistant_says", "claw_assistant_messages",
      "claw_assistant_surfaces", "claw_work_items", "claw_pending_messages", "claw_tasks",
    ]) await w.q(`DELETE FROM ${t}`);
    await w.q("DELETE FROM claw_assistants WHERE user_id = 'alice'");
    alice = await w.user("alice");
    // A turn is running (a worker's report being read): every message of the person's queues behind it, under the id its turn will carry.
    await w.openRun(alice.routerSid, { messageId: "claw-report-turn" });
  });

  /** A subscription made through the route, as a channel's worker makes it; `surface` undefined: an old worker that names none. */
  async function subscribe(url: string, surface?: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: "/v1/notification-subscriptions",
      payload: { url, event_types: ["assistant.say", "work_item.needs_you", "assistant.action"], ...(surface ? { surface } : {}) },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().data.subscription_id as string;
  }

  /** The person writes to their assistant from a channel; `channel` undefined: an old client that sends no channel context. */
  async function write(content: string, channel?: string): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/v1/sessions/${alice.routerSid}/messages`,
      payload: { content, ...(channel ? { channel_context: { channel, channel_message_id: `${channel}-${content}` } } : {}) },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { queued?: boolean; message_id?: string };
    assert.equal(body.queued, true, "queued behind the running turn");
    return body.message_id!;
  }

  /** The router answers the turn of `mid`. */
  const reply = (mid: string, text: string) =>
    w.mod.outbound.recordAssistantSay({ userId: "alice", sessionId: alice.routerSid, text, turnMessageId: mid }, w.sayDeps);

  /** An item's update, said by the system with no message of the person's behind it. */
  let notices = 0;
  const update = (text: string) => {
    notices += 1;
    return w.mod.outbound.recordSystemNotice({ userId: "alice", sessionId: alice.routerSid, text, key: `update-${notices}` }, w.sayDeps);
  };

  /** Which subscriptions the say was queued for. */
  const queuedFor = async (sayId: string) =>
    (await w.q("SELECT subscription_id FROM claw_notification_outbox WHERE event_id = $1 ORDER BY subscription_id", [sayId]))
      .map((r) => r.subscription_id as string);

  test("S1-S3 a reply returns to its message's surface, and a proactive message goes to the one used last", async () => {
    const teams = await subscribe(TEAMS_URL, "teams");
    const slack = await subscribe(SLACK_URL, "slack");

    const fromSlack = await write("what is on my board?", "slack");
    const answer = await reply(fromSlack, "Two items are running.");
    assert.equal(answer.subscribers, 1);
    assert.deepEqual(await queuedFor(answer.say_id), [slack], "S1 the reply goes to Slack only");

    // S2 an item's update, and its needs-you, with nobody's message behind them: Slack, used last.
    const said = await update("#1 finished its first step.");
    assert.deepEqual(await queuedFor(said!.say_id), [slack], "S2 the update goes to Slack");
    const created = await w.createItem(alice, "Fix the build");
    await w.openRun(alice.routerSid, { messageId: "claw-report-turn-2" }); // (creating it ran a turn of its own, which ended)
    await w.q("UPDATE claw_work_items SET board_state = 'needs_you', pending_question = 'Merge it?', attention_seq = 1 WHERE item_id = $1", [created.itemId]);
    const needs = await w.mod.outbound.recordNeedsYouFallback({ itemId: created.itemId }, w.sayDeps);
    assert.deepEqual(await queuedFor(needs!.say_id), [slack], "S2 the needs-you goes to Slack");

    // S3 the person writes from Teams: the reply goes there, and so does what is said next with no message behind it.
    const fromTeams = await write("and the build?", "teams");
    const teamsAnswer = await reply(fromTeams, "It is red.");
    assert.deepEqual(await queuedFor(teamsAnswer.say_id), [teams], "S3 the reply goes to Teams");
    const later = await update("#1 is done.");
    assert.deepEqual(await queuedFor(later!.say_id), [teams], "S3 the next proactive message goes to Teams");

    // A reply to the earlier Slack message, said after the Teams one, still goes back to Slack: its turn's message came from there.
    const lateSlack = await reply(fromSlack, "One more thing about your board.");
    assert.deepEqual(await queuedFor(lateSlack.say_id), [slack], "a turn's reply follows its own message, not the latest");
  });

  test("S4 a surface whose subscription was deleted falls back to the next most recent one", async () => {
    const teams = await subscribe(TEAMS_URL, "teams");
    const slack = await subscribe(SLACK_URL, "slack");
    await write("hello from teams", "teams");
    const fromSlack = await write("hello from slack", "slack");
    const del = await app.inject({ method: "DELETE", url: `/v1/notification-subscriptions/${slack}` });
    assert.equal(del.statusCode, 200, del.body);

    const answer = await reply(fromSlack, "Hello.");
    assert.equal(answer.subscribers, 1, "not dropped");
    assert.deepEqual(await queuedFor(answer.say_id), [teams], "the reply falls back to Teams");
    const said = await update("#2 started.");
    assert.deepEqual(await queuedFor(said!.say_id), [teams], "so does a proactive message");

    // A third surface the person used last, with no subscription at all, is passed over the same way.
    await subscribe(SLACK_URL, "slack");
    await write("from the web", "web");
    const order = await surfaces.preferredSurfaces(w.h.app.db.db.query.bind(w.h.app.db.db), "alice");
    assert.deepEqual(order, ["web", "slack", "teams"], "the rule: most recent first");
    const next = await update("#2 is waiting.");
    const rows = await w.q("SELECT s.surface FROM claw_notification_outbox o JOIN claw_notification_subscriptions s USING (subscription_id) WHERE o.event_id = $1", [next!.say_id]);
    assert.deepEqual(rows.map((r) => r.surface), ["slack"], "web has no subscription: the next most recent surface, Slack");
  });

  test("S5 an old client is Teams, and its single subscription gets every message as before", async () => {
    const only = await subscribe(TEAMS_URL);
    const listed = await app.inject({ method: "GET", url: "/v1/notification-subscriptions" });
    assert.deepEqual(listed.json().data.map((s: { surface: string }) => s.surface), ["teams"], "a subscription that names none is Teams");
    const mid = await write("hi");
    assert.deepEqual(await w.q("SELECT surface FROM claw_assistant_surfaces WHERE user_id = 'alice'"), [{ surface: "teams" }],
      "a message with no channel context came from Teams");
    const answer = await reply(mid, "Hi.");
    assert.deepEqual(await queuedFor(answer.say_id), [only]);
    const said = await update("#3 started.");
    assert.deepEqual(await queuedFor(said!.say_id), [only]);
  });

  test("S6 nobody narrowed: a person who never wrote, and one whose subscriptions are all of one surface", async () => {
    const teams = await subscribe(TEAMS_URL, "teams");
    const slack = await subscribe(SLACK_URL, "slack");
    const said = await update("Good morning.");
    assert.deepEqual(await queuedFor(said!.say_id), [teams, slack].sort(), "nothing known: every subscription, as before the label");

    await w.q("DELETE FROM claw_notification_subscriptions");
    const a = await subscribe(TEAMS_URL, "teams");
    const b = await subscribe("https://93.184.216.36/teams/route-b", "teams");
    const mid = await write("hi", "slack");
    const answer = await reply(mid, "Hi.");
    assert.deepEqual(await queuedFor(answer.say_id), [a, b].sort(), "one surface: each of its subscriptions, as before");
  });

  test("S7 a surface label is a lowercase word, kept on the subscription and changed by PATCH", async () => {
    for (const bad of ["", "Slack Bot", "1slack", "slack!", "x".repeat(33), 7, ["slack"]]) {
      const res = await app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload: { url: TEAMS_URL, surface: bad } });
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)}: ${res.body}`);
    }
    const res = await app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload: { url: SLACK_URL, surface: " Slack " } });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().data.surface, "slack", "read as the label it spells");
    const id = res.json().data.subscription_id as string;
    const patched = await app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${id}`, payload: { surface: "mattermost" } });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().data.surface, "mattermost");
    const kept = await app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${id}`, payload: { enabled: true } });
    assert.equal(kept.json().data.surface, "mattermost", "a change that names no surface keeps it");
    const refused = await app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${id}`, payload: { surface: "Matter most" } });
    assert.equal(refused.statusCode, 400);
  });

  test("S8 the slack receiver is posted the signed event and the teams one nothing", async () => {
    await subscribe(TEAMS_URL, "teams");
    await subscribe(SLACK_URL, "slack");
    const mid = await write("ping", "slack");
    const answer = await reply(mid, "pong");
    const sent: OutboundRequest[] = [];
    await w.mod.outbox.deliverDue({
      transport: async (req) => { sent.push(req); return 200; }, resolve: async () => [{ address: "93.184.216.35", family: 4 }],
      allowedHosts: new Set<string>(),
    });
    const ours = sent.filter((r) => JSON.parse(r.body).event_id === answer.say_id);
    assert.deepEqual(ours.map((r) => r.target.url.toString()), [SLACK_URL]);
    const headers = Object.keys(ours[0]!.headers).map((h) => h.toLowerCase());
    assert.ok(headers.includes("x-claw-signature") && headers.includes("x-claw-event-id"), headers.join(", "));
    assert.equal((await w.q("SELECT delivered_at FROM claw_assistant_says WHERE say_id = $1", [answer.say_id]))[0].delivered_at instanceof Date, true);
  });
});
