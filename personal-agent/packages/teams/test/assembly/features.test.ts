// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assembled features, end to end on one message: a linked person writes "hello" in their 1:1 chat, the router built by
 * `buildFeatures` creates a Claw session with it (POST /v1/sessions on a fake Claw over real HTTP), follows the session's
 * stream (GET /v1/chat/sessions/s1/messages, server-sent events) and answers in the chat (the Python gate's chat-plain case).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { neutralPlugins, noMetrics, SecurityLog, silentLogger } from "@primusclaw/personal-agent";
import { createClawClient, readSettings, systemClock } from "@primusclaw/personal-agent-runtime";

import { FakeHttpServer } from "../../../../test-support/http-server.js";
import { inboundMessage } from "../../../../test-support/inbound.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface } from "../../../../test-support/surface.js";
import { teamsSettingsFromEnv } from "../../src/config/env.js";
import { buildFeatures, type AssemblyBase } from "../../src/assembly/features.js";
import { DEFAULT_STYLE } from "../../src/config/style.js";
import { activityOf } from "../../src/messenger/render.js";
import { RENDERERS } from "../../src/views/index.js";

const ALICE = { id: "aad-a", channelUserId: "29:aad-a", name: "Alice", email: "" };

function sse(name: string, data: Record<string, unknown>, id: string) {
  return { event: name, id, data: JSON.stringify(data) };
}

let claw: FakeHttpServer;
/** What the session's stream says next (the plain answer, or a turn that fails). */
let stream: ReturnType<typeof sse>[] = [];

before(async () => {
  claw = await FakeHttpServer.start([
    {
      method: "POST",
      path: "/v1/sessions",
      handle: () => ({ status: 200, json: { ok: true, data: { session_id: "s1", message: { message_id: "m1" } } } }),
    },
    {
      method: "GET",
      path: "/v1/chat/sessions/s1/messages",
      handle: () => ({ sse: stream }),
    },
  ]);
});

after(async () => {
  await claw.close();
});

function assembled(env: Record<string, string> = {}) {
  const { store } = openTestStore();
  const surface = new FakeSurface();
  const settings = readSettings({
    TEAMS_ENCRYPTION_KEYS: "k",
    CLAW_API_URL: claw.url,
    SAFE_API_URL: "https://safe.example.com",
    PUBLIC_BASE_URL: "https://claw.example.com",
  });
  const plugins = neutralPlugins();
  const base: AssemblyBase = {
    settings,
    teams: teamsSettingsFromEnv({}, { queues: false }),
    store,
    claw: createClawClient({ baseUrl: claw.url, clock: systemClock }),
    surface,
    clock: systemClock,
    random: new SeededRandom(5),
    logger: silentLogger,
    metrics: noMetrics,
    securityLog: new SecurityLog(silentLogger, noMetrics),
    plugins,
    exchange: plugins.tokenExchange,
    env,
  };
  return { features: buildFeatures(base), store, surface };
}

function texts(surface: FakeSurface): string[] {
  return surface.outbox.flatMap((r) => {
    if (r.op !== "send" && r.op !== "update" && r.op !== "post" && r.op !== "stream.finish") return [];
    const body = r.message.body;
    if (body.type === "text") return [body.text];
    return body.type === "rich" ? [body.markdown] : [];
  });
}

function said(text: string) {
  return sse("AssistantMessage", { message_id: "m1", data: { content: [{ type: "text", text }] } }, "e1");
}

function ended(text: string, subtype: string) {
  return sse("ResultMessage", { message_id: "m1", final_text: text, data: { subtype } }, "e2");
}

/** Alice, linked, writes `text` in her 1:1 chat; resolves when the turn it starts is over. */
async function aliceSays(
  features: ReturnType<typeof assembled>["features"],
  store: ReturnType<typeof assembled>["store"],
  text: string,
) {
  store.links.redeemPending(ALICE.id, ALICE.name, store.links.stashPending("ak-alice"));
  await features.router.handle(
    inboundMessage({
      id: "act-1",
      sender: ALICE,
      conversation: {
        id: "dm-a",
        kind: "personal",
        tenantId: "t1",
        wire: { conversation: { id: "dm-a", conversationType: "personal" }, user: { aadObjectId: ALICE.id } },
      },
      text,
    }),
  );
  await features.router.settled();
}

describe("the assembled features", () => {
  it("chat plain: a linked person's hello creates a session and is answered", async () => {
    stream = [said("Hello, Alice."), ended("Hello, Alice.", "success")];
    claw.requests.length = 0;
    const { features, store, surface } = assembled();
    await aliceSays(features, store, "hello");
    const created = claw.requests.filter((r) => r.method === "POST" && r.path === "/v1/sessions");
    assert.equal(created.length, 1);
    assert.equal(created[0]?.headers["authorization"], "Bearer ak-alice");
    assert.ok(claw.requests.some((r) => r.method === "GET" && r.path === "/v1/chat/sessions/s1/messages"));
    assert.ok(texts(surface).includes("Hello, Alice."), JSON.stringify(texts(surface)));
    assert.deepEqual(features.gate.madeSessions(), ["s1"]);
    assert.equal(store.sessions.getSession(ALICE.id), "s1");
  });

  it("a turn that failed ends with the report a problem card", async () => {
    stream = [said("Counting: one, two"), ended("Counting: one, two", "error")];
    const { features, store, surface } = assembled();
    await aliceSays(features, store, "count to a hundred slowly");
    const last = surface.outbox.at(-1);
    assert.equal(last?.op, "send");
    const message = last.message;
    assert.equal(message.body.type, "view");
    // (rendered as the Python worker sent it: mobile-stop's last outbound, its prompt id the store's)
    const activity = activityOf(message, { style: DEFAULT_STYLE, renderers: RENDERERS, masker: undefined });
    const attachments = activity["attachments"] as { content: Record<string, unknown> }[];
    const card = attachments[0]?.content ?? {};
    const actions = card["actions"] as { data: { prompt: string } }[];
    const prompt = actions[0]?.data.prompt ?? "";
    assert.match(prompt, /^[A-Za-z0-9_-]{12}$/);
    assert.deepEqual(card, {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      actions: [
        {
          data: { primusclaw: "report", prompt },
          title: "Report a problem",
          type: "Action.Execute",
          verb: "primusclaw.feedback",
        },
      ],
      body: [
        {
          isSubtle: true,
          size: "Small",
          text: "\u{1F4AC} Did something go wrong? You can tell the PrimusClaw team.",
          type: "TextBlock",
          wrap: true,
        },
      ],
      type: "AdaptiveCard",
      version: "1.5",
    });
  });

  it("the background loops are the Python worker's, notifications off", () => {
    const { features } = assembled();
    assert.deepEqual(
      features.timers.map((t) => [t.name, t.everyMs, t.runAtStart]),
      [
        ["sweep_expired", 60_000, false],
        ["retry_feedback", 60_000, false],
        ["release_held", 60_000, false],
        ["resend_approval_cards", 60_000, true],
      ],
    );
    assert.equal(features.gate.subscriptions, undefined);
  });

  it("proactive messages need the address claw sends events to", () => {
    assert.throws(() => assembled({ PROACTIVE_ENABLED: "1" }), /NOTIFY_WEBHOOK_URL/);
    const { features } = assembled({ PROACTIVE_ENABLED: "1", NOTIFY_WEBHOOK_URL: "http://worker/claw-events" });
    assert.ok(features.timers.some((t) => t.name === "mend_subscriptions" && t.everyMs === 600_000 && t.runAtStart));
    assert.notEqual(features.gate.subscriptions, undefined);
  });
});
