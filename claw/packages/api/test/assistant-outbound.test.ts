// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an assistant says to its user, from the stored message to the receiver's
 * 2xx, against a real Postgres whose schema `initDb` built with
 * `CLAW_NOTIFICATIONS_ENABLED` and `CLAW_ASSISTANT_ENABLED` on. Skipped without
 * DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { EVENT_ID_HEADER } from "../src/notifications/signing.js";
import type { OutboundRequest, Transport } from "../src/notifications/transport.js";

const skip = postgresSkipReason();
const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });
const pub = async () => [{ address: "93.184.216.34", family: 4 }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

describe("assistant outbound", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let caller = user("u1");
  let outbox: typeof import("../src/notifications/outbox.js");
  let outbound: typeof import("../src/assistant/outbound.js");
  let config: typeof import("../src/config.js");
  let crypto: typeof import("../src/crypto/user-env.js");
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  /** A receiver that records what it was sent and answers with `status`. */
  const sent: OutboundRequest[] = [];
  let status = 200;
  const transport: Transport = async (req) => { sent.push(req); return status; };
  const deliveryDeps = () => ({ transport, resolve: pub, allowedHosts: new Set<string>() });
  const deliver = () => outbox.deliverDue(deliveryDeps());
  const makeDue = () => q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE delivered_at IS NULL AND dropped_at IS NULL");

  /** The kicks a say started, so a test can wait for the delivery they ran. */
  let kicks: Promise<void>[] = [];
  /** The session events a say published. */
  let events: Array<{ sessionId: string; event: Record<string, any> }> = [];
  const deps = (extra: Partial<import("../src/assistant/outbound.js").SayDeps> = {}) => ({
    publishSessionEvent: async (sessionId: string, event: Record<string, unknown>) => { events.push({ sessionId, event }); },
    kick: () => { const p = outbox.kickDelivery(deliveryDeps()); kicks.push(p); return p; },
    ...extra,
  });
  const settle = () => Promise.all(kicks);

  const say = (text: string, o: Partial<import("../src/assistant/outbound.js").SayInput> = {}, d = deps()) =>
    outbound.recordAssistantSay({ userId: "u1", sessionId: "assistant-u1", text, ...o }, d);

  async function subscribe(owner = "u1", types: string[] = ["assistant.say", "work_item.needs_you"], extra: { sources?: string[]; enabled?: boolean } = {}) {
    const id = outbox.newSubscriptionId();
    await q(
      `INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc, event_types, enabled)
       VALUES ($1, $2, 'https://hooks.example.com/claw', $3, $4::text[], $5)`,
      [id, owner, crypto.encryptUserEnvValue("sub-secret-" + owner), types, extra.enabled ?? true],
    );
    if (extra.sources) await q("UPDATE claw_notification_subscriptions SET sources = $2::text[] WHERE subscription_id = $1", [id, extra.sources]);
    return id;
  }

  let itemNo = 0;
  async function seedItem(o: Record<string, unknown> = {}): Promise<string> {
    itemNo += 1;
    const row = {
      item_id: `kwi_item${itemNo}`, user_id: "u1", seq: itemNo, title: "Fix the build", board_state: "needs_you",
      last_report_kind: "ready", pending_question: null, result_version: 1, attention_seq: 1, ...o,
    };
    await q(
      `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, last_report_kind, pending_question, result_version, attention_seq, worker_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [row.item_id, row.user_id, row.seq, row.title, row.board_state, row.last_report_kind, row.pending_question, row.result_version, row.attention_seq, `worker-${row.item_id}`],
    );
    return row.item_id as string;
  }

  const outboxRows = async () => (await q("SELECT * FROM claw_notification_outbox ORDER BY id")).rows as any[];
  const saysRows = async () => (await q("SELECT * FROM claw_assistant_says ORDER BY created_at")).rows as any[];

  before(async () => {
    h = await startAdmissionCluster({ CLAW_NOTIFICATIONS_ENABLED: "true", CLAW_ASSISTANT_ENABLED: "true" });
    crypto = await import("../src/crypto/user-env.js");
    crypto.initUserEnvCrypto();
    outbox = await import("../src/notifications/outbox.js");
    outbound = await import("../src/assistant/outbound.js");
    config = await import("../src/config.js");
    outbound.registerAssistantDeliveryHook();
    app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = caller; });
    await (await import("../src/routes/notification-subscriptions.js")).registerNotificationSubscriptionRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.stop(); });
  beforeEach(async () => {
    caller = user("u1");
    sent.length = 0;
    status = 200;
    kicks = [];
    events = [];
    await q("DELETE FROM claw_notification_outbox");
    await q("DELETE FROM claw_notification_subscriptions");
    await q("DELETE FROM claw_assistant_says");
    await q("DELETE FROM claw_work_items");
    await q("DELETE FROM claw_assistants");
  });

  describe("a message the assistant says", () => {
    test("is stored once and queued for each subscription that asked for the type, whatever its sources", async () => {
      const asked = await subscribe("u1", ["assistant.say"]);
      const askedLongRunOnly = await subscribe("u1", ["assistant.say"], { sources: ["long_run"] });
      await subscribe("u1", ["run.completed", "run.failed"]);
      await subscribe("u1", ["assistant.say"], { enabled: false });
      await subscribe("u2", ["assistant.say"]);

      const out = await say("I started #1.");
      assert.equal(out.subscribers, 2);

      const says = await saysRows();
      assert.equal(says.length, 1);
      assert.equal(says[0].say_id, out.say_id);
      assert.deepEqual([says[0].user_id, says[0].text, says[0].fallback, says[0].item_id], ["u1", "I started #1.", false, null]);

      const rows = await outboxRows();
      assert.deepEqual(rows.map((r) => r.subscription_id).sort(), [asked, askedLongRunOnly].sort());
      const payload = rows[0].payload;
      assert.equal(rows[0].event_id, out.say_id);
      assert.deepEqual(Object.keys(payload).sort(), ["event_id", "occurred_at", "text", "type", "user_id"]);
      assert.deepEqual([payload.event_id, payload.type, payload.user_id, payload.text], [out.say_id, "assistant.say", "u1", "I started #1."]);
      assert.equal(new Date(payload.occurred_at).toISOString(), new Date(says[0].created_at).toISOString());
    });

    test("with no subscription is still stored, reports no subscribers, and starts no delivery", async () => {
      const out = await say("anyone there?");
      assert.equal(out.subscribers, 0);
      assert.equal((await saysRows()).length, 1);
      assert.equal((await outboxRows()).length, 0);
      assert.equal(kicks.length, 0);
    });

    test("about an item carries a snapshot whose can_accept follows the item's state", async () => {
      await subscribe();
      const cases: Array<{ board_state: string; last_report_kind: string | null; can_accept: boolean }> = [
        { board_state: "needs_you", last_report_kind: "ready", can_accept: true },
        { board_state: "needs_you", last_report_kind: "failed", can_accept: false },
        { board_state: "needs_you", last_report_kind: "blocked", can_accept: false },
        { board_state: "needs_you", last_report_kind: "waiting", can_accept: false },
        { board_state: "in_progress", last_report_kind: "progress", can_accept: false },
        { board_state: "in_progress", last_report_kind: "ready", can_accept: false },
        { board_state: "done", last_report_kind: "ready", can_accept: false },
      ];
      for (const c of cases) {
        const itemId = await seedItem({ ...c, result_version: 3, attention_seq: 4, title: "Port the parser" });
        await say("about it", { itemId });
        const payload = (await outboxRows()).at(-1)!.payload;
        assert.deepEqual(payload.item, {
          item_id: itemId, seq: itemNo, title: "Port the parser", board_state: c.board_state, result_version: 3, can_accept: c.can_accept,
        }, JSON.stringify(c));
        const stored = (await saysRows()).at(-1)!;
        assert.deepEqual([stored.item_id, stored.item_attention_seq], [itemId, 4]);
      }
    });

    test("about another user's item, or one that does not exist, is refused with nothing written", async () => {
      await subscribe();
      const theirs = await seedItem({ user_id: "u2" });
      for (const itemId of [theirs, "kwi_nosuchitem"]) {
        await assert.rejects(say("hello", { itemId }), (e: any) => e.name === "SayRefused" && e.code === "item_not_found");
      }
      assert.equal((await saysRows()).length, 0);
      assert.equal((await outboxRows()).length, 0);
    });

    test("about an item named by its number is about the caller's own item with that number", async () => {
      await subscribe();
      const mine = await seedItem({ seq: 40, title: "Mine" });
      const theirs = await seedItem({ user_id: "u2", seq: 40, title: "Theirs" });
      const other = await seedItem({ user_id: "u2", seq: 41, title: "Theirs only" });
      for (const ref of ["#40", "40", "item 40", mine]) {
        await say("about it", { itemId: ref });
        const stored = (await saysRows()).at(-1)!;
        assert.equal(stored.item_id, mine, ref);
        assert.equal((await outboxRows()).at(-1)!.payload.item.title, "Mine", ref);
      }
      // The other user's #41 is not this user's, and neither is the id of their #40.
      for (const ref of ["#41", other, theirs]) {
        await assert.rejects(say("hello", { itemId: ref }), (e: any) => e.name === "SayRefused" && e.code === "item_not_found", ref);
      }
      assert.equal((await saysRows()).length, 4, "only the four that named the caller's own item");
    });

    test("an item that is not named as an item is refused for what it is", async () => {
      await subscribe();
      await seedItem({ seq: 50 });
      const code = async (itemId: string) => { try { await say("hello", { itemId }); } catch (e: any) { return e.code; } return "accepted"; };
      assert.equal(await code("#99"), "item_not_found");
      assert.equal(await code("the build one"), "invalid_item_ref");
      assert.equal(await code("#50, #51"), "ambiguous_item_ref");
      assert.equal(await code("  "), "accepted", "a blank item is no item, as before");
      assert.equal((await saysRows()).length, 1, "and only that one was stored");
    });

    test("is refused, with nothing written, when the caller's guard throws", async () => {
      await subscribe();
      await assert.rejects(
        say("hello", { guard: async () => { throw new Error("not your turn"); } }),
        /not your turn/,
      );
      assert.equal((await saysRows()).length, 0);
      assert.equal((await outboxRows()).length, 0);
      assert.equal(events.length, 0);
    });

    test("the guard runs in the same transaction as the write", async () => {
      await say("one", { guard: async (query) => { await query("SELECT 1"); } });
      assert.equal((await saysRows()).length, 1);
      // A failure after the guard rolls the whole say back, which it could not if the guard committed on its own.
      await assert.rejects(
        say("two", { itemId: "kwi_nosuchitem", guard: async (query) => { await query("UPDATE claw_assistant_says SET text = 'tampered'"); } }),
        (e: any) => e.code === "item_not_found",
      );
      assert.deepEqual((await saysRows()).map((s) => s.text), ["one"]);
    });

    test("must have text of at most SAY_TEXT_MAX (9000) characters: a long answer whole, never more", async () => {
      assert.equal(outbound.SAY_TEXT_MAX, 9000);
      const cases: Array<{ text: string; code?: string }> = [
        { text: "", code: "empty_text" },
        { text: " \n\t ", code: "empty_text" },
        { text: "x".repeat(9001), code: "text_too_long" },
        { text: "x".repeat(9000) },
        { text: `  ${"y".repeat(9000)}  ` },
      ];
      for (const c of cases) {
        if (c.code) await assert.rejects(say(c.text), (e: any) => e.code === c.code, c.code);
        else assert.ok((await say(c.text)).say_id);
      }
      assert.equal((await saysRows()).length, 2);
    });

    test("is masked where it leaves the system, whatever the model repeated", async () => {
      await subscribe();
      const itemId = await seedItem({ title: "Deploy with Bearer titlesecret987654" });
      await say("use header Authorization: Bearer abcdef123456 to call it", { itemId });
      const payload = (await outboxRows())[0].payload;
      assert.ok(!payload.text.includes("abcdef123456"), payload.text);
      assert.ok(!payload.item.title.includes("titlesecret987654"), payload.item.title);
      assert.ok(!JSON.stringify(events[0].event).includes("abcdef123456"));
    });

    test("is shown to a web client as an AssistantSay event in the assistant's session, and one that fails to publish does not fail the say", async () => {
      await subscribe();
      const itemId = await seedItem();
      const out = await say("done with #1", { itemId });
      assert.equal(events.length, 1);
      const { sessionId, event } = events[0];
      assert.equal(sessionId, "assistant-u1");
      assert.deepEqual(
        [event.type, event.session_id, event.say_id, event.text, event.fallback, event.item.item_id, typeof event.ts],
        ["AssistantSay", "assistant-u1", out.say_id, "done with #1", false, itemId, "number"],
      );

      const failing = deps({ publishSessionEvent: async () => { throw new Error("nats is down"); } });
      const again = await say("second", {}, failing);
      assert.equal(again.subscribers, 1);
      assert.equal((await saysRows()).length, 2);
      assert.equal((await outboxRows()).length, 2);
    });
  });

  describe("the limit on how much an assistant says", () => {
    test("is 120 an hour unless configured", () => {
      assert.equal(config.CLAW_ASSISTANT_SAY_MAX_PER_HOUR, 120);
    });

    test("stops a user at the limit, for that user only, and counts only the last hour", async () => {
      const limited = deps({ maxPerHour: 3 });
      for (let i = 0; i < 3; i += 1) await say(`m${i}`, {}, limited);
      await assert.rejects(say("m3", {}, limited), (e: any) => e.name === "SayRefused" && e.code === "say_rate_limited");
      const modelSays = async () => (await saysRows()).filter((s) => !s.fallback);
      assert.equal((await modelSays()).length, 3);

      await outbound.recordAssistantSay({ userId: "u2", sessionId: "assistant-u2", text: "mine" }, limited);
      assert.equal((await modelSays()).length, 4);

      await q("UPDATE claw_assistant_says SET created_at = NOW() - interval '61 minutes' WHERE user_id = 'u1'");
      await say("a new hour", {}, limited);
      assert.equal((await modelSays()).filter((s) => s.user_id === "u1").length, 4);
    });

    test("tells the user at the first refusal in an hour, once, in their language, tells the model it was not delivered, and counts every refusal", async () => {
      const limited = deps({ maxPerHour: 2 });
      const family = h.app.metrics.registry.getSingleMetric("claw_assistant_say_rate_limited_total");
      assert.ok(family, "the counter is on the api registry");
      const counted = async (notice: string) => (await family.get()).values.find((v) => v.labels.notice === notice)?.value ?? 0;
      const before = { sent: await counted("sent"), already: await counted("already_sent") };
      const tally = async () => [await counted("sent") - before.sent, await counted("already_sent") - before.already];
      const notices = async () => (await saysRows()).filter((s) => s.fallback);
      const capped = (e: any) => e.code === "say_rate_limited";

      await say("one", {}, limited);
      await say("two", {}, limited);
      assert.equal((await notices()).length, 0, "no notice while there is room");
      await assert.rejects(
        say("three", {}, limited),
        (e: any) => capped(e) && /NOT delivered/.test(e.message) && /has been told/.test(e.message),
      );
      const [notice] = await notices();
      assert.deepEqual([notice?.text, notice?.user_id], [outbound.sayCapNotice("three"), "u1"], "the system's words, as a message of its own");
      assert.deepEqual(events.filter((e) => e.event.text === notice.text).map((e) => e.sessionId), ["assistant-u1"], "the web client is told");

      // The rest of the hour: refused and counted, and the user is not told again.
      await assert.rejects(say("four", {}, limited), capped);
      await assert.rejects(say("five", {}, limited), capped);
      assert.equal((await notices()).length, 1);
      assert.deepEqual(await tally(), [1, 2]);

      // Under a steady overload the cap lets one message through each time the oldest turns an hour old: still the same hour.
      await q(`UPDATE claw_assistant_says SET created_at = NOW() - interval '61 minutes'
                WHERE say_id = (SELECT say_id FROM claw_assistant_says WHERE NOT fallback ORDER BY created_at LIMIT 1)`);
      await say("six", {}, limited);
      await assert.rejects(say("seven", {}, limited), capped);
      assert.equal((await notices()).length, 1);
      assert.deepEqual(await tally(), [1, 3]);

      // A notice sent in the last clock hour, less than an hour ago, counts as well.
      const hour = Number((await q("SELECT floor(extract(epoch FROM clock_timestamp()) / 3600)::bigint AS h")).rows[0].h);
      const noticeId = (h: number) => outbox.deterministicEventId("assistant.notice", "u1", `say_capped:${h}`);
      await q("UPDATE claw_assistant_says SET say_id = $1, created_at = NOW() - interval '30 minutes' WHERE fallback", [noticeId(hour - 1)]);
      await assert.rejects(say("eight", {}, limited), capped);
      assert.equal((await notices()).length, 1);
      assert.deepEqual(await tally(), [1, 4]);

      // An hour on, the next refusal tells the user again, in the language they are spoken to in.
      await q("UPDATE claw_assistant_says SET created_at = created_at - interval '61 minutes'");
      await say("九", {}, limited);
      await say("十", {}, limited);
      await assert.rejects(say("构建好了", {}, limited), capped);
      assert.deepEqual((await notices()).map((s) => s.text), [outbound.sayCapNotice("three"), outbound.sayCapNotice("构建好了")]);
      assert.match(outbound.sayCapNotice("构建好了"), /稍后再试/);
      assert.deepEqual(await tally(), [2, 4]);
    });

    for (const order of ["the earlier hour first", "the later hour first"] as const) {
      test(`tells the user once when two refusals come at once on either side of an hour, ${order}`, async () => {
        const limited = deps({ maxPerHour: 1 });
        await say("one", {}, limited);
        // Each refusal's notice reads the hour, and waits there a little for the other: without the user's lock both
        // would look for a notice before either had stored one, under two different hours. The later hour first is a
        // transaction that started before the hour turned and got the lock after one that started after it.
        let arrived = 0;
        let bothThere!: () => void;
        const both = new Promise<void>((resolve) => { bothThere = resolve; });
        outbound.setCapNoticeHourForTest(async (hour) => {
          arrived += 1;
          const mine = arrived;
          if (arrived === 2) bothThere();
          await Promise.race([both, sleep(300)]);
          return order === "the earlier hour first" ? hour + mine - 1 : hour + 2 - mine;
        });
        try {
          const results = await Promise.allSettled([say("two", {}, limited), say("three", {}, limited)]);
          assert.ok(results.every((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "say_rate_limited"));
        } finally {
          outbound.setCapNoticeHourForTest(null);
        }
        assert.equal(arrived, 2, "both refusals reached the notice");
        assert.equal((await saysRows()).filter((s) => s.fallback).length, 1);
      });
    }

    test("is a hard cap under concurrent says", async () => {
      const limited = deps({ maxPerHour: 3 });
      // Hold every transaction open until all eight are, so each of them reaches the count before any has written.
      const burst = 8;
      let open = 0;
      let release!: () => void;
      const allOpen = new Promise<void>((r) => { release = r; });
      const barrier = async () => { open += 1; if (open === burst) release(); await allOpen; };
      const results = await Promise.allSettled(Array.from({ length: burst }, (_, i) => say(`burst ${i}`, { guard: barrier }, limited)));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
      assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "say_rate_limited"));
      assert.equal((await saysRows()).filter((s) => !s.fallback).length, 3);
      assert.equal((await saysRows()).filter((s) => s.fallback).length, 1, "five refusals at once, one notice");
    });

    test("does not count the system's own needs-you messages, which are what is left when the assistant has not spoken", async () => {
      const limited = deps({ maxPerHour: 1 });
      for (let i = 0; i < 3; i += 1) await outbound.recordNeedsYouFallback({ itemId: await seedItem() }, limited);
      assert.equal((await saysRows()).filter((s) => s.fallback).length, 3);
      await say("still allowed", {}, limited);
      await assert.rejects(say("now over", {}, limited), (e: any) => e.code === "say_rate_limited");
    });
  });

  describe("delivery", () => {
    test("starts as soon as the message is stored, without waiting for the poll, and stamps delivered_at when the receiver answers 2xx", async () => {
      await subscribe();
      const out = await say("hello");
      await settle();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].headers[EVENT_ID_HEADER], out.say_id);
      assert.deepEqual([JSON.parse(sent[0].body).type, JSON.parse(sent[0].body).text], ["assistant.say", "hello"]);
      assert.notEqual((await saysRows())[0].delivered_at, null);
      assert.notEqual((await outboxRows())[0].delivered_at, null);
    });

    test("leaves delivered_at empty while the receiver refuses, and stamps it when a retry gets through", async () => {
      await subscribe();
      status = 500;
      await say("hello");
      await settle();
      assert.equal(sent.length, 1);
      assert.equal((await saysRows())[0].delivered_at, null);
      assert.equal((await outboxRows())[0].delivered_at, null);

      status = 200;
      await makeDue();
      await deliver();
      assert.equal(sent.length, 2);
      assert.notEqual((await saysRows())[0].delivered_at, null);
    });

    test("keeps the time of the first receiver to take it when a second one does later", async () => {
      await subscribe();
      await subscribe();
      await say("to both", {}, deps({ kick: async () => {} }));
      // Deliveries to the two subscriptions run side by side; take them one at a time here.
      const [, second] = await outboxRows();
      await q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() + interval '1 hour' WHERE id = $1", [second.id]);
      await deliver();
      const first = (await saysRows())[0].delivered_at;
      assert.notEqual(first, null);
      await sleep(30);
      await makeDue();
      await deliver();
      assert.equal((await outboxRows()).filter((r) => r.delivered_at).length, 2);
      assert.equal((await saysRows())[0].delivered_at.getTime(), first.getTime());
    });

    test("a kick while delivery runs goes round again for what was written after its claim, and sends never overlap", { timeout: 10_000 }, async () => {
      await subscribe();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let inFlight = 0;
      let maxInFlight = 0;
      let sends = 0;
      const slow: Transport = async () => {
        sends += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (sends === 1) await gate;
        inFlight -= 1;
        return 200;
      };
      const slowDeps = () => deps({ kick: () => { const p = outbox.kickDelivery({ transport: slow, resolve: pub, allowedHosts: new Set() }); kicks.push(p); return p; } });

      // A say returns while the receiver still holds the first send: a model's tool call does not wait for a webhook.
      // The valve lets a say that does wait come back, so that fails the assertion instead of hanging the file.
      let valved = false;
      const valve = setTimeout(() => { valved = true; release(); }, 1500);
      await say("one", {}, slowDeps());
      assert.equal(valved, false, "the say waited for the receiver");
      await until("the first send", () => sends === 1);
      await say("two", {}, slowDeps());
      await sleep(50);
      assert.equal(sends, 1, "the second send waits for the first");
      clearTimeout(valve);
      release();
      await settle();
      assert.equal(sends, 2);
      assert.equal(maxInFlight, 1);
      assert.equal((await outboxRows()).filter((r) => r.delivered_at).length, 2);
    });
  });

  describe("the hook that runs after a delivery", () => {
    const calls: Array<{ eventId: string; type: string }> = [];
    before(() => {
      outbox.onDelivered(["assistant.say"], async (row) => {
        calls.push({ eventId: row.eventId, type: row.payload.type });
        if ((row.payload as { text?: string }).text === "boom") throw new Error("hook failed");
      });
    });
    beforeEach(() => { calls.length = 0; });

    test("is called for the types it asked for after a 2xx, and not for a refusal or another type", async () => {
      await subscribe("u1", ["assistant.say", "work_item.needs_you", "run.completed"]);
      status = 503;
      await say("later");
      await settle();
      assert.deepEqual(calls, []);

      status = 200;
      await makeDue();
      await deliver();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].type, "assistant.say");

      calls.length = 0;
      await outbound.recordNeedsYouFallback({ itemId: await seedItem() }, deps());
      await settle();
      assert.equal(sent.at(-1) && JSON.parse(sent.at(-1)!.body).type, "work_item.needs_you");
      assert.deepEqual(calls, [], "the hook was registered for assistant.say only");
    });

    test("that throws does not undo the delivery, and the row is not sent again", async () => {
      await subscribe();
      await say("boom");
      await settle();
      assert.equal(calls.length, 1);
      assert.notEqual((await outboxRows())[0].delivered_at, null);
      await makeDue();
      await deliver();
      assert.equal(sent.length, 1);
    });
  });

  describe("a needs-you message from the system", () => {
    test("says what the item needs in its own words, for each kind of report", async () => {
      await subscribe();
      const cases: Array<{ kind: string | null; question: string | null; text: string; can_accept: boolean }> = [
        { kind: "ready", question: null, text: '#SEQ "Fix the build" is ready for your review (v2).', can_accept: true },
        { kind: "waiting", question: "Which branch?", text: '#SEQ "Fix the build" needs your answer: Which branch?', can_accept: false },
        { kind: "blocked", question: "Need a token", text: '#SEQ "Fix the build" is blocked and needs your answer: Need a token', can_accept: false },
        { kind: "blocked", question: null, text: '#SEQ "Fix the build" is blocked and needs your help.', can_accept: false },
        { kind: "failed", question: null, text: '#SEQ "Fix the build" failed and needs your attention.', can_accept: false },
        { kind: null, question: null, text: '#SEQ "Fix the build" needs your attention.', can_accept: false },
      ];
      for (const c of cases) {
        await q("DELETE FROM claw_notification_outbox");
        const itemId = await seedItem({ last_report_kind: c.kind, pending_question: c.question, result_version: 2, attention_seq: 5 });
        const out = await outbound.recordNeedsYouFallback({ itemId }, deps());
        assert.ok(out, JSON.stringify(c));
        assert.equal(out!.subscribers, 1);
        const payload = (await outboxRows())[0].payload;
        assert.deepEqual(
          [payload.type, payload.fallback, payload.event_id, payload.user_id, payload.text, payload.item.item_id, payload.item.can_accept],
          ["work_item.needs_you", true, out!.say_id, "u1", c.text.replace("SEQ", String(itemNo)), itemId, c.can_accept],
          JSON.stringify(c),
        );
        const stored = (await saysRows()).find((s) => s.say_id === out!.say_id);
        assert.deepEqual([stored.fallback, stored.item_id, stored.item_attention_seq], [true, itemId, 5]);
      }
    });

    test("reaches only subscriptions that listed work_item.needs_you", async () => {
      await subscribe("u1", ["assistant.say"]);
      const wants = await subscribe("u1", ["work_item.needs_you"]);
      const out = await outbound.recordNeedsYouFallback({ itemId: await seedItem() }, deps());
      assert.equal(out!.subscribers, 1);
      assert.deepEqual((await outboxRows()).map((r) => r.subscription_id), [wants]);
    });

    test("is sent once for each attention the item has needed, however often it is asked", async () => {
      await subscribe();
      const itemId = await seedItem({ attention_seq: 1 });
      const first = await outbound.recordNeedsYouFallback({ itemId }, deps());
      assert.ok(first);
      assert.equal(await outbound.recordNeedsYouFallback({ itemId }, deps()), null);
      assert.equal((await saysRows()).length, 1);
      assert.equal((await outboxRows()).length, 1);

      await q("UPDATE claw_work_items SET attention_seq = 2 WHERE item_id = $1", [itemId]);
      const second = await outbound.recordNeedsYouFallback({ itemId }, deps());
      assert.ok(second);
      assert.notEqual(second!.say_id, first!.say_id);
      assert.equal((await saysRows()).length, 2);
    });

    test("is not sent for an item that no longer needs the user, or that does not exist", async () => {
      await subscribe();
      const inProgress = await seedItem({ board_state: "in_progress", last_report_kind: "progress" });
      const done = await seedItem({ board_state: "done" });
      for (const itemId of [inProgress, done, "no-such-item"]) {
        assert.equal(await outbound.recordNeedsYouFallback({ itemId }, deps()), null, itemId);
      }
      assert.equal((await saysRows()).length, 0);
      assert.equal((await outboxRows()).length, 0);
    });

    test("is shown to a web client in the user's assistant session when there is one", async () => {
      const { sessionId } = await (await import("../src/assistant/assistant.js")).getOrCreateAssistant("u1");
      const itemId = await seedItem();
      const out = await outbound.recordNeedsYouFallback({ itemId }, deps());
      assert.equal(events.length, 1);
      assert.deepEqual(
        [events[0].sessionId, events[0].event.type, events[0].event.say_id, events[0].event.fallback, events[0].event.item.can_accept],
        [sessionId, "AssistantSay", out!.say_id, true, true],
      );

      events = [];
      await q("DELETE FROM claw_assistants");
      await outbound.recordNeedsYouFallback({ itemId: await seedItem() }, deps());
      assert.equal(events.length, 0);
    });

    test("belongs to the item's owner, not to whoever asked", async () => {
      await subscribe("u2");
      const out = await outbound.recordNeedsYouFallback({ itemId: await seedItem({ user_id: "u2" }) }, deps());
      assert.equal(out!.subscribers, 1);
      assert.equal((await saysRows())[0].user_id, "u2");
      assert.equal((await outboxRows())[0].payload.user_id, "u2");
    });
  });

  describe("subscriptions for the assistant's events", () => {
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload: payload as object });

    test("accept both types, and a new subscription does not get them unless it asks", async () => {
      const asked = await post({ url: "https://93.184.216.34/a", event_types: ["assistant.say", "work_item.needs_you"] });
      assert.equal(asked.statusCode, 201, asked.body);
      assert.deepEqual(asked.json().data.event_types, ["assistant.say", "work_item.needs_you"]);
      const plain = await post({ url: "https://93.184.216.34/b" });
      assert.deepEqual(plain.json().data.event_types, ["run.completed", "run.failed"]);
    });

    test("can be added to an existing subscription, and an unknown type is still refused", async () => {
      const id = (await post({ url: "https://93.184.216.34/a" })).json().data.subscription_id;
      const patch = (types: string[]) => app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${id}`, payload: { event_types: types } });
      const ok = await patch(["run.completed", "run.failed", "assistant.say", "work_item.needs_you"]);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().data.event_types.length, 4);
      assert.equal((await patch(["assistant.shout"])).statusCode, 400);
    });
  });
  describe("a message no channel can carry", () => {
    const counter = () => h.app.metrics.registry.getSingleMetric("claw_assistant_say_unreachable_total")!;
    const unreachable = async (type: string) => (await counter().get()).values.find((v) => v.labels.type === type)?.value ?? 0;
    let warned: Array<Record<string, unknown>> = [];
    let realWarn: typeof outbound.outboundLog.unreachable;
    beforeEach(() => {
      warned = [];
      realWarn = outbound.outboundLog.unreachable;
      outbound.outboundLog.unreachable = (fields) => { warned.push(fields); };
    });
    const restore = () => { outbound.outboundLog.unreachable = realWarn; };

    test("is counted every time, and warned about once per user an hour, with the user and the item", async () => {
      try {
        const before = await unreachable("assistant.say");
        const itemId = await seedItem();
        const first = await say("about it", { itemId });
        assert.equal(first.subscribers, 0);
        await say("again");
        await outbound.recordAssistantSay({ userId: "u2", sessionId: "assistant-u2", text: "hello" }, deps());
        assert.equal(await unreachable("assistant.say") - before, 3, "every one is counted");
        assert.deepEqual(warned, [
          { user_id: "u1", item_id: itemId, say_id: first.say_id, type: "assistant.say" },
          { user_id: "u2", item_id: null, say_id: warned[1]?.say_id, type: "assistant.say" },
        ], "one line per user, the first of the hour, naming the user and the item");

        // An hour on, the user is warned about again.
        await q("UPDATE claw_assistant_says SET created_at = date_trunc('hour', NOW()) - interval '1 minute'");
        const later = await say("a new hour");
        assert.equal(warned.length, 3);
        assert.equal(warned[2].say_id, later.say_id);

        // A message a subscription carries is neither counted nor warned about.
        await subscribe("u1", ["assistant.say"]);
        const counted = await unreachable("assistant.say");
        assert.equal((await say("carried")).subscribers, 1);
        assert.equal(await unreachable("assistant.say"), counted);
        assert.equal(warned.length, 3);
      } finally { restore(); }
    });

    test("is not taken for told by the silent sweep: an unreached fallback is sent once a subscription takes it", async () => {
      const silent = await import("../src/assistant/silent-sweep.js");
      const ports = { ...silent.silentSweepPorts };
      silent.silentSweepPorts.recordNeedsYouFallback = (i) => outbound.recordNeedsYouFallback(i, deps());
      try {
        const itemId = await seedItem();
        await q("UPDATE claw_work_items SET updated_at = NOW() - interval '1 hour'");
        assert.equal(await silent.tellSilentItems(300), 1, "the fallback is stored");
        const [fallback] = (await saysRows()).filter((x) => x.fallback);
        assert.equal(fallback.item_id, itemId);
        assert.equal((await outboxRows()).length, 0, "nothing could carry it");
        assert.equal(await silent.tellSilentItems(300), 0, "with nothing to carry it, the item is not picked again");

        const sub = await subscribe("u1", ["work_item.needs_you"]);
        assert.equal(await silent.tellSilentItems(300), 1, "an undelivered fallback is not told");
        const rows = await outboxRows();
        assert.deepEqual(rows.map((r) => [r.event_id, r.subscription_id, r.payload.type, r.payload.item.item_id]),
          [[fallback.say_id, sub, "work_item.needs_you", itemId]]);
        assert.equal(await silent.tellSilentItems(300), 0, "once: its outbox row now tells it");
        assert.equal((await outboxRows()).length, 1);
      } finally {
        Object.assign(silent.silentSweepPorts, ports);
        restore();
      }
    });

    test("is sent by the type a subscription takes: with only assistant.say taken, the model's say goes and the item is not picked again", async () => {
      const silent = await import("../src/assistant/silent-sweep.js");
      const ports = { ...silent.silentSweepPorts };
      silent.silentSweepPorts.recordNeedsYouFallback = (i) => outbound.recordNeedsYouFallback(i, deps());
      try {
        const itemId = await seedItem();
        const said = await say("#1 is ready for your review.", { itemId });
        await q("UPDATE claw_work_items SET updated_at = NOW() - interval '1 hour'");
        assert.equal(await silent.tellSilentItems(300), 1, "the fallback is stored, newer than the say");
        const sub = await subscribe("u1", ["assistant.say"]);
        assert.equal(await silent.tellSilentItems(300), 1);
        assert.deepEqual((await outboxRows()).map((r) => [r.event_id, r.subscription_id, r.payload.type]),
          [[said.say_id, sub, "assistant.say"]], "the say the subscription takes, not the newer fallback it does not");
        assert.equal(await silent.tellSilentItems(300), 0, "told now: not picked again");
      } finally {
        Object.assign(silent.silentSweepPorts, ports);
        restore();
      }
    });

    test("a fallback whose only send was refused 410 goes to a subscription added later, and only to it", async () => {
      const silent = await import("../src/assistant/silent-sweep.js");
      const ports = { ...silent.silentSweepPorts };
      silent.silentSweepPorts.recordNeedsYouFallback = (i) => outbound.recordNeedsYouFallback(i, deps());
      try {
        await seedItem();
        await q("UPDATE claw_work_items SET updated_at = NOW() - interval '1 hour'");
        assert.equal(await silent.tellSilentItems(300), 1, "stored, to nobody");
        const first = await subscribe("u1", ["work_item.needs_you"]);
        assert.equal(await silent.tellSilentItems(300), 1, "handed to the first subscription");
        status = 410;
        await deliver();
        const [gone] = await outboxRows();
        assert.deepEqual([gone.subscription_id, gone.last_status, gone.dropped_at !== null], [first, "http_410", true]);
        assert.equal(await silent.tellSilentItems(300), 0, "nothing new can carry it: not picked");

        const second = await subscribe("u1", ["work_item.needs_you"]);
        assert.equal(await silent.tellSilentItems(300), 1, "a dropped send is not a told user");
        const rows = await outboxRows();
        assert.deepEqual(rows.map((r) => r.subscription_id), [first, second], "the refusing subscription is not handed it again");
        assert.equal(rows[1].event_id, gone.event_id);
        assert.equal(await silent.tellSilentItems(300), 0, "queued now: told");
      } finally {
        Object.assign(silent.silentSweepPorts, ports);
        restore();
      }
    });

    test("an answer the sweep said while nothing could carry it is sent when a subscription takes it", async () => {
      const silent = await import("../src/assistant/silent-sweep.js");
      const ports = { ...silent.silentSweepPorts };
      silent.silentSweepPorts.recordNeedsYouFallback = (i) => outbound.recordNeedsYouFallback(i, deps());
      try {
        const itemId = await seedItem({ board_state: "done", last_report_kind: "answer" });
        await q("UPDATE claw_work_items SET outcome = 'answered', closed_at = NOW(), updated_at = NOW() - interval '1 hour' WHERE item_id = $1", [itemId]);
        await q(
          "INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary) VALUES ($1, 'answer', 'worker', 1, 'It is 42.')",
          [itemId],
        );
        assert.equal(await silent.tellSilentItems(300), 1, "the answer is said, to nobody");
        assert.equal((await outboxRows()).length, 0);
        assert.equal(await silent.tellSilentItems(300), 0);

        const post = await app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload: { url: "https://93.184.216.34/a", event_types: ["work_item.needs_you"] } });
        assert.equal(post.statusCode, 201, post.body);
        const rows = await outboxRows();
        assert.equal(rows.length, 1);
        assert.deepEqual([rows[0].payload.type, rows[0].payload.item.item_id], ["work_item.needs_you", itemId]);
        assert.match(rows[0].payload.text, /It is 42\./);
        assert.equal(await silent.tellSilentItems(300), 0, "told now");
      } finally {
        Object.assign(silent.silentSweepPorts, ports);
        restore();
      }
    });

    test("is sent to a subscription when it starts taking the assistant's events, once, for items that still need the user", async () => {
      const post = (payload: unknown) => app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload: payload as object });
      try {
        const waiting = await seedItem();
        const moved = await seedItem();
        const said = await say("#1 is ready for your review.", { itemId: waiting });
        await say("#2 is ready too.", { itemId: moved });
        await q("UPDATE claw_work_items SET board_state = 'in_progress' WHERE item_id = $1", [moved]);
        assert.equal((await outboxRows()).length, 0);

        const plain = await post({ url: "https://93.184.216.34/a" });
        assert.equal(plain.statusCode, 201, plain.body);
        assert.equal((await outboxRows()).length, 0, "a subscription without the assistant's events gets nothing");

        const id = plain.json().data.subscription_id;
        const patch = () => app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${id}`, payload: { event_types: ["assistant.say"] } });
        assert.equal((await patch()).statusCode, 200);
        const rows = await outboxRows();
        assert.deepEqual(rows.map((r) => [r.event_id, r.subscription_id, r.payload.type, r.payload.text, r.payload.item.item_id]),
          [[said.say_id, id, "assistant.say", "#1 is ready for your review.", waiting]], "only the item that still needs the user");
        assert.equal((await patch()).statusCode, 200);
        assert.equal((await outboxRows()).length, 1, "once");
      } finally { restore(); }
    });
  });
  describe("an item's result, said by the system on its own", () => {
    /** A user whose assistant session is made (or, after a delete, made again) the way the product makes it. */
    const assistantOf = async (userId = "u1") => (await import("../src/assistant/assistant.js")).getOrCreateAssistant(userId);
    const deleteSession = (sessionId: string) => q("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = $1", [sessionId]);
    let workerNo = 0;
    /** An item started from the user's current assistant session (`insertWorkItem`), answered, and quiet past the sweep's threshold. */
    async function answeredItem(title: string, answer: string): Promise<string> {
      const wi = await import("../src/assistant/work-items.js");
      workerNo += 1;
      const made = await wi.insertWorkItem({ query: (t: string, p?: unknown[]) => q(t, p ?? []) } as never, {
        userId: "u1", title, workerSessionId: `worker-answered-${Date.now()}-${workerNo}`,
      });
      assert.ok(made.ok, JSON.stringify(made));
      const itemId = (made as { itemId: string }).itemId;
      await q(
        "INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary) VALUES ($1, 'answer', 'worker', 1, $2)",
        [itemId, answer],
      );
      await q(
        `UPDATE claw_work_items SET board_state = 'done', outcome = 'answered', last_report_kind = 'answer', closed_at = NOW(),
                updated_at = NOW() - interval '1 hour' WHERE item_id = $1`,
        [itemId],
      );
      return itemId;
    }
    async function sweep(d = deps()): Promise<number> {
      const silent = await import("../src/assistant/silent-sweep.js");
      const ports = { ...silent.silentSweepPorts };
      silent.silentSweepPorts.recordNeedsYouFallback = (i) => outbound.recordNeedsYouFallback(i, d);
      silent.silentSweepPorts.reshowFallback = (i) => outbound.reshowFallback(i, d);
      try { return await silent.tellSilentItems(300); } finally { Object.assign(silent.silentSweepPorts, ports); }
    }
    const shown = () => events.filter((e) => e.event.type === "AssistantSay").map((e) => ({ session: e.sessionId, text: String(e.event.text) }));

    test("one the assistant said in its session is not said again, there or in the session that replaced it (2026-11-06: #119, #120, #121)", async () => {
      const first = await assistantOf();
      const kept = await answeredItem("jobs.csv 按 workspace 汇总", "总计 39,144.2 GPU 小时");
      const reset = await answeredItem("后台运行 slow_job.sh", "RESULT=86972");
      await say("✅ 总计 39,144.2 GPU 小时", { itemId: kept, sessionId: first.sessionId });
      await say("✅ RESULT=86972", { itemId: reset, sessionId: first.sessionId });
      assert.equal(shown().length, 2);

      assert.equal(await sweep(), 0, "said in the session, which is where a user with no channel reads it: nothing is said again");
      await deleteSession(first.sessionId);
      assert.equal(await sweep(), 0, "deleted and not yet made again: still told");
      assert.equal((await q("SELECT session_id FROM claw_assistants WHERE user_id = 'u1'")).rows[0].session_id, first.sessionId, "and no session is made for it");
      const second = await assistantOf();
      assert.equal(second.created, true);
      assert.notEqual(second.sessionId, first.sessionId);
      assert.equal(await sweep(), 0, "a new session is not a reason to say the old results again");
      assert.deepEqual(shown().map((e) => e.session), [first.sessionId, first.sessionId], "nothing reached the new session");
      assert.deepEqual((await saysRows()).filter((x) => x.fallback), [], "no system message was stored");
    });

    test("one whose session event failed to publish told nobody: the sweep says it, once", async () => {
      const own = await assistantOf();
      const itemId = await answeredItem("后台运行 slow_job.sh", "RESULT=86972");
      await say("✅ RESULT=86972", { itemId, sessionId: own.sessionId }, deps({ publishSessionEvent: async () => { throw new Error("nats is down"); } }));
      assert.equal(shown().length, 0);
      assert.equal(await sweep(), 1);
      assert.equal(await sweep(), 0, "once");
      assert.deepEqual(shown().map((e) => e.session), [own.sessionId]);
    });

    test("the system's own message whose publish failed is shown again until it is, then never", async () => {
      const own = await assistantOf();
      await answeredItem("后台运行 slow_job.sh", "RESULT=86972");
      const down = deps({ publishSessionEvent: async () => { throw new Error("nats is down"); } });
      assert.equal(await sweep(down), 1, "stored");
      assert.equal(shown().length, 0);
      assert.equal(await sweep(down), 0, "still down: not shown, not counted");
      assert.equal(await sweep(), 1, "shown now");
      assert.equal(await sweep(), 0, "once");
      const told = shown();
      assert.equal(told.length, 1);
      assert.equal(told[0].session, own.sessionId);
      assert.match(told[0].text, /RESULT=86972/);
      assert.equal((await saysRows()).filter((x) => x.fallback).length, 1, "one message, shown under its one id");
    });

    test("one said in a session deleted before its event was published told nobody", async () => {
      const own = await assistantOf();
      const itemId = await answeredItem("后台运行 slow_job.sh", "RESULT=86972");
      await deleteSession(own.sessionId);
      await say("✅ RESULT=86972", { itemId, sessionId: own.sessionId });
      assert.equal((await saysRows())[0].session_id, null, "not recorded as shown");
      assert.equal(await sweep(), 1, "said again, in a session that is read");
      const next = (await q("SELECT session_id FROM claw_assistants WHERE user_id = 'u1'")).rows[0].session_id;
      assert.notEqual(next, own.sessionId);
      assert.equal(shown().at(-1)?.session, next);
    });

    test("one nobody said goes to the item's own session, once", async () => {
      const own = await assistantOf();
      const itemId = await answeredItem("jobs.csv 去掉 cancelled 后汇总", "36,661.0 GPU 小时");
      assert.equal(await sweep(), 1);
      assert.equal(await sweep(), 0, "once");
      assert.deepEqual(shown(), [{ session: own.sessionId, text: "#" + (await q("SELECT seq FROM claw_work_items WHERE item_id = $1", [itemId])).rows[0].seq + " jobs.csv 去掉 cancelled 后汇总：36,661.0 GPU 小时" }]);
    });

    test("one nobody said, whose session was deleted and not yet made again, goes to the session made for it, once", async () => {
      const first = await assistantOf();
      await answeredItem("jobs.csv 去掉 cancelled 后汇总", "36,661.0 GPU 小时");
      await deleteSession(first.sessionId);
      assert.equal(await sweep(), 1);
      assert.equal(await sweep(), 0, "once");
      const made = (await q("SELECT session_id FROM claw_assistants WHERE user_id = 'u1'")).rows[0].session_id;
      assert.notEqual(made, first.sessionId, "made as the user's next visit would");
      const told = shown();
      assert.equal(told.length, 1);
      assert.equal(told[0].session, made, "never the deleted session");
      assert.ok(told[0].text.startsWith(outbound.MOVED_PREFIX_ZH), told[0].text);
      const again = await assistantOf();
      assert.deepEqual([again.sessionId, again.created], [made, false], "the user's next visit finds that session");
    });

    test("one nobody said, whose session the user deleted, goes to the session they have now, once, saying where it came from", async () => {
      const first = await assistantOf();
      await answeredItem("jobs.csv 去掉 cancelled 后汇总", "36,661.0 GPU 小时");
      await deleteSession(first.sessionId);
      const second = await assistantOf();
      assert.equal(await sweep(), 1);
      assert.equal(await sweep(), 0, "once");
      const told = shown();
      assert.equal(told.length, 1);
      assert.equal(told[0].session, second.sessionId, "the session the user has now: the deleted one is read by nobody");
      assert.ok(told[0].text.startsWith(outbound.MOVED_PREFIX_ZH), told[0].text);
      assert.match(told[0].text, /36,661\.0 GPU 小时/);
      const [stored] = (await saysRows()).filter((x) => x.fallback);
      assert.equal(stored.session_id, second.sessionId);
    });
  });
});
