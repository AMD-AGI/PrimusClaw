// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assembled features, end to end on one message: a linked person writes "hello" in their 1:1 chat, the router built by
 * `buildFeatures` creates a Claw session with it (POST /v1/sessions on a fake Claw over real HTTP), follows the session's
 * stream (GET /v1/chat/sessions/s1/messages, server-sent events) and answers in the chat (the Python gate's chat-plain case).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  integrationRegistry,
  neutralPlugins,
  noMetrics,
  SecurityLog,
  silentLogger,
  type Plugins,
  type Settings,
} from "@primusclaw/personal-agent";
import {
  alsRequestScope,
  ChatLog,
  createClawClient,
  HttpIdentityLookup,
  readSettings,
  systemClock,
} from "@primusclaw/personal-agent-runtime";

import { FakeHttpServer } from "../../../../test-support/http-server.js";
import { inboundMessage } from "../../../../test-support/inbound.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface } from "../../../../test-support/surface.js";
import { teamsSettingsFromEnv } from "../../src/config/env.js";
import { buildFeatures, ON_BEHALF_PATH, type AssemblyBase } from "../../src/assembly/features.js";
import { StartupError } from "../../src/assembly/outbound.js";
import { DEFAULT_STYLE } from "../../src/config/style.js";
import { toInboundEvent } from "../../src/activity/inbound/to-event.js";
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

function readSettingsForTest(): Settings {
  return readSettings({
    TEAMS_ENCRYPTION_KEYS: "k",
    CLAW_API_URL: claw.url,
    SAFE_API_URL: "https://safe.example.com",
    PUBLIC_BASE_URL: "https://claw.example.com",
  });
}

interface Overrides {
  readonly plugins?: Plugins;
  readonly settings?: Partial<Settings>;
}

function assembled(env: Record<string, string> = {}, security = new RecordingLogger(), overrides: Overrides = {}) {
  const { store } = openTestStore();
  const surface = new FakeSurface();
  const settings: Settings = { ...readSettingsForTest(), ...overrides.settings };
  const plugins = overrides.plugins ?? neutralPlugins();
  const requestScope = alsRequestScope();
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
    securityLog: new SecurityLog(security, noMetrics, requestScope),
    requestScope,
    chatLog: new ChatLog(
      requestScope,
      (text) => text,
      () => Date.now() / 1000,
    ),
    plugins,
    exchange: plugins.tokenExchange,
    fetch: globalThis.fetch,
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
        ["sweep_group_context", 60_000, false],
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

/** The activity Teams sends when Alice presses Deny on an approval card in her 1:1 chat (the card's own button data). */
/** (An activity id as Teams sends one; a record keeps only id-shaped values, never one that reads as a link code.) */
function denyPress(activityId: string) {
  return {
    type: "invoke",
    name: "adaptiveCard/action",
    id: activityId,
    replyToId: "card-1",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: ALICE.channelUserId, aadObjectId: ALICE.id, name: ALICE.name },
    recipient: { id: "28:bot" },
    conversation: { id: "dm-a", conversationType: "personal", tenantId: "t1" },
    value: {
      action: {
        type: "Action.Execute",
        verb: "primusclaw.decision",
        data: { primusclaw: "decision", action: "deny", session_id: "s-held", tool_use_id: "tu-1", tool: "bash" },
      },
    },
  };
}

function securityRecords(security: RecordingLogger, event: string) {
  return security.lines
    .map((line) => JSON.parse(line.message) as Record<string, unknown>)
    .filter((record) => record["event"] === event);
}

describe("the request scope", () => {
  it("an audit record written while an inbound press is handled names that activity", async () => {
    const security = new RecordingLogger();
    const { features, store } = assembled({}, security);
    store.links.redeemPending(ALICE.id, ALICE.name, store.links.stashPending("ak-alice"));
    // (a held tool call of Alice's turn; Claw no longer has it, so the answer is recorded as expired)
    store.approvals.saveApproval({
      userId: ALICE.id,
      sessionId: "s-held",
      toolUseId: "tu-1",
      tool: "bash",
      expiresAt: store.now() + 600,
      envelope: {},
    });
    const read = toInboundEvent(denyPress("1767225600123"), { botName: "Clawy", logger: silentLogger });
    assert.ok(read.ok && read.value !== undefined);
    await features.router.handle(read.value);
    await features.router.settled();
    const answered = securityRecords(security, "approval_answered");
    assert.equal(answered.length, 1, JSON.stringify(security.lines.map((l) => l.message)));
    const [record] = answered;
    assert.ok(record !== undefined);
    assert.equal(record["activity_id"], "1767225600123");
    assert.equal(record["decision"], "deny");
    assert.equal(record["outcome"], "expired");
  });
});

describe("the platform services", () => {
  it("the subscriptions fill in a linked person's Claw user id from /users/self, asked with their own key, on their timer", async () => {
    // (Python test_reviewer_reach.py::test_the_agent_fills_claw_user_ids_on_its_timer)
    const safe = await FakeHttpServer.start([
      { method: "GET", path: "/users/self", handle: () => ({ status: 200, json: { id: "u-alice", name: "alice" } }) },
    ]);
    try {
      const plugins = neutralPlugins({ identityLookup: new HttpIdentityLookup(safe.url) });
      const env = { PROACTIVE_ENABLED: "1", NOTIFY_WEBHOOK_URL: "http://w/claw-events" };
      const { features, store } = assembled(env, new RecordingLogger(), { plugins });
      store.links.redeemPending(ALICE.id, ALICE.name, store.links.stashPending("ak-alice"));
      assert.ok(store.links.needsClawUserId(ALICE.id));
      const mend = features.timers.find((t) => t.name === "mend_subscriptions");
      assert.ok(mend !== undefined);
      await mend.run();
      assert.equal(store.links.clawUserIdOf(ALICE.id), "u-alice");
      assert.deepEqual(
        safe.requests.map((r) => r.headers["authorization"]),
        ["Bearer ak-alice"],
      );
    } finally {
      await safe.close();
    }
  });

  it("a fallback model with no refusal policy stops the start: it would never be used", () => {
    const models = { ...readSettingsForTest().models, fallback: "backup-model" };
    assert.throws(
      () => assembled({}, new RecordingLogger(), { settings: { models } }),
      (error: unknown) => error instanceof StartupError && /CLAWY_FALLBACK_MODEL/.test(error.message),
    );
    const policy = { refusal: () => undefined } as unknown as Plugins["modelRefusalPolicy"];
    assembled({}, new RecordingLogger(), {
      settings: { models },
      plugins: neutralPlugins({ modelRefusalPolicy: policy }),
    });
  });

  it("people allowed on behalf with no plugin serving the route stops the start: the route would not exist", () => {
    const settings = { onBehalfUsers: new Set(["u-coordinator"]) };
    assert.throws(
      () => assembled({}, new RecordingLogger(), { settings }),
      (error: unknown) => error instanceof StartupError && /TEAMS_ON_BEHALF_USERS/.test(error.message),
    );
    const route = {
      method: "POST" as const,
      path: ON_BEHALF_PATH,
      handle: () => Promise.resolve({ status: 202, body: {} }),
    };
    assembled({}, new RecordingLogger(), { settings, plugins: neutralPlugins({ routeExtensions: [route] }) });
    // (the route answers POST: one on its path for another method does not serve it)
    const get = { ...route, method: "GET" as const };
    assert.throws(
      () => assembled({}, new RecordingLogger(), { settings, plugins: neutralPlugins({ routeExtensions: [get] }) }),
      /TEAMS_ON_BEHALF_USERS/,
    );
  });
});

describe("the deployment's integrations", () => {
  it("a deployment's integrations reach /whoami: its line follows GitHub's", async () => {
    const registry = integrationRegistry();
    registry.addConnectionLine((_owner, lang) => (lang === "zh" ? "- 追踪：已连接" : "- Tracker: connected"));
    const plugins = neutralPlugins({ integrations: registry });
    const { features, store, surface } = assembled({}, new RecordingLogger(), { plugins });
    store.links.redeemPending(ALICE.id, ALICE.name, store.links.stashPending("ak-alice"));
    await features.router.handle(
      inboundMessage({
        id: "act-whoami",
        sender: ALICE,
        conversation: {
          id: "dm-a",
          kind: "personal",
          tenantId: "t1",
          wire: { conversation: { id: "dm-a", conversationType: "personal" }, user: { aadObjectId: ALICE.id } },
        },
        text: "/whoami",
      }),
    );
    await features.router.settled();
    assert.ok(
      texts(surface).some((t) => t.includes("- Tracker: connected")),
      JSON.stringify(texts(surface)),
    );
  });
});
