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
  ok,
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
import { buildFeatures, ON_BEHALF_PATH, platformPlugins, type AssemblyBase } from "@primusclaw/personal-agent-worker";

import { FakeHttpServer } from "../../../../test-support/http-server.js";
import { FakeExchange } from "../../../../test-support/routing/fixtures.js";
import { inboundMessage } from "../../../../test-support/inbound.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { advanceSeconds, openTestStore } from "../../../../test-support/store.js";
import { FakeSurface } from "../../../../test-support/surface.js";
import { teamsShape } from "../../src/assembly/worker.js";
import { StartupError } from "../../src/assembly/outbound.js";
import { teamsSettingsFromEnv } from "../../src/config/env.js";
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

function assembled(
  env: Record<string, string> = {},
  security = new RecordingLogger(),
  overrides: Overrides = {},
  clawUrl = claw.url,
) {
  const { store, clock: storeClock } = openTestStore();
  const surface = new FakeSurface();
  const settings: Settings = { ...readSettingsForTest(), ...overrides.settings };
  const plugins = overrides.plugins ?? neutralPlugins();
  const requestScope = alsRequestScope();
  const base: AssemblyBase = {
    settings,
    shape: teamsShape(teamsSettingsFromEnv({}, { queues: false })),
    store,
    claw: createClawClient({ baseUrl: clawUrl, clock: systemClock }),
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
  return { features: buildFeatures(base), store, surface, storeClock };
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

describe("the identity card after a refused answer", () => {
  it("a say whose turn was refused for want of a confirmed identity is followed by the binding card: once per turn, once a day, none once confirmed", async () => {
    const exchange = new FakeExchange();
    const plugins: Plugins = { ...neutralPlugins(), tokenExchange: exchange };
    const base = readSettingsForTest();
    const { features, store, surface, storeClock } = assembled({}, new RecordingLogger(), {
      plugins,
      settings: { exchange: { ...base.exchange, forChat: true } },
    });
    store.links.redeemPending(ALICE.id, ALICE.name, store.links.stashPending("ak-alice"));
    const reference = { serviceUrl: "https://smba.test/", conversation: { id: "dm-a" }, bot: { id: "28:bot" } };
    const say = (id: string, turn = "m1") => ({
      type: "assistant.say",
      event_id: id,
      turn_message_id: turn,
      text: "先确认一次身份。",
      needs_identity: true,
    });
    const bindings = () =>
      surface.outbox.flatMap((r) =>
        r.op === "send" && r.message.body.type === "view" && r.message.body.view.name === "binding"
          ? [r.message.body.view.model]
          : [],
      );
    await features.deliverEvent(ALICE.id, reference, say("s1"));
    assert.equal(bindings().length, 1);
    assert.equal((bindings()[0] as { confirmUrl: string }).confirmUrl, `https://id.test/confirm?u=${ALICE.id}`);
    // A later say of the same turn (it replaces the first) carries the field too: no second card.
    await features.deliverEvent(ALICE.id, reference, say("s2"));
    assert.equal(bindings().length, 1);
    // Another refused turn the same day (the 0.3.0 acceptance's second request): no second card.
    await features.deliverEvent(ALICE.id, reference, say("s3", "m2"));
    assert.equal(bindings().length, 1);
    // A day after the card: the next refused turn offers it again, and two says of that one turn delivered at once send one.
    advanceSeconds(storeClock, 24 * 3600);
    await Promise.all([
      features.deliverEvent(ALICE.id, reference, say("s4", "m3")),
      features.deliverEvent(ALICE.id, reference, say("s5", "m3")),
    ]);
    assert.equal(bindings().length, 2);
    // Confirmed by now: a refused turn, however much later, offers nothing.
    exchange.tokens.set(ALICE.id, "tok-a");
    advanceSeconds(storeClock, 2 * 24 * 3600);
    await features.deliverEvent(ALICE.id, reference, say("s6", "m4"));
    assert.equal(bindings().length, 2);
  });
});

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

describe("a person bound at the identity service with no link", () => {
  it("a person bound with no link: their 1:1 message reaches the assistant, with the subscription and id from their token", async () => {
    const bound = await FakeHttpServer.start([
      { method: "GET", path: "/v1/notification-subscriptions", handle: () => ({ status: 200, json: { data: [] } }) },
      {
        method: "POST",
        path: "/v1/notification-subscriptions",
        handle: () => ({ status: 200, json: { data: { subscription_id: "sub-1", secret: "s" } } }),
      },
      {
        method: "POST",
        path: "/v1/assistant",
        handle: () => ({ status: 200, json: { data: { session_id: "asst-1" } } }),
      },
    ]);
    try {
      const exchange = new FakeExchange();
      exchange.tokens.set(ALICE.id, "tok-alice");
      const identityLookup = {
        ownerOfKey: (key: string) =>
          Promise.resolve(
            key === "tok-alice" ? { id: "u-alice", name: "Liu, Alice", email: "", accountType: "" } : undefined,
          ),
      };
      const base = readSettingsForTest();
      const { features, store } = assembled(
        { PROACTIVE_ENABLED: "1", NOTIFY_WEBHOOK_URL: "http://w/claw-events" },
        new RecordingLogger(),
        {
          plugins: neutralPlugins({ tokenExchange: exchange, identityLookup }),
          settings: {
            exchange: { ...base.exchange, enabled: true, forChat: true },
            assistant: { ...base.assistant, enabled: true, users: new Set() },
          },
        },
        bound.url,
      );
      await features.router.handle(
        inboundMessage({
          id: "act-b1",
          sender: ALICE,
          conversation: {
            id: "dm-a",
            kind: "personal",
            tenantId: "t1",
            wire: { conversation: { id: "dm-a", conversationType: "personal" }, user: { aadObjectId: ALICE.id } },
          },
          text: "connect my dev environment",
        }),
      );
      await features.router.settled();
      assert.equal(store.links.getKey(ALICE.id), null, "(no link)");
      assert.equal(store.links.clawUserIdOf(ALICE.id), "u-alice");
      const asked = (method: string, path: string) =>
        bound.requests.filter((r) => r.method === method && r.path === path).map((r) => r.headers["authorization"]);
      assert.deepEqual(asked("POST", "/v1/notification-subscriptions"), ["Bearer tok-alice"]);
      assert.deepEqual(asked("POST", "/v1/assistant"), ["Bearer tok-alice"], "the assistant's session, on the token");
      assert.deepEqual(asked("POST", "/v1/sessions"), [], "no plain Claw session");
    } finally {
      await bound.close();
    }
  });
});

// Production: SaFE's /users/self refuses the token (it is for Claw's audience), Claw's /v1/me answers for it.
const EXCHANGED = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1LWFsaWNlIn0.c2ln";
let tokenSafe: FakeHttpServer;
let tokenClaw: FakeHttpServer;

async function startPlatform(): Promise<void> {
  tokenSafe = await FakeHttpServer.start([
    {
      method: "GET",
      path: "/api/v1/users/self",
      handle: (r) =>
        r.headers["authorization"] === "Bearer ak-alice"
          ? { status: 200, json: { id: "u-alice", name: "alice (key)", email: "alice@example.com" } }
          : { status: 401, json: { message: "unauthorized" } },
    },
  ]);
  tokenClaw = await FakeHttpServer.start([
    {
      method: "GET",
      path: "/claw-api/v1/me",
      handle: (r) =>
        r.headers["authorization"] === `Bearer ${EXCHANGED}`
          ? { status: 200, json: { userId: "u-alice", name: "Liu, Alice", email: "alice@example.com", roles: [] } }
          : { status: 401, json: { error: "authentication_required" } },
    },
  ]);
}

async function stopPlatform(): Promise<void> {
  await tokenSafe.close();
  await tokenClaw.close();
}

/** The worker as production assembles it: the platform plugins, chats on the exchange, Alice bound (and linked). */
function bound() {
  const base = readSettingsForTest();
  const settings: Settings = {
    ...base,
    safeApiUrl: `${tokenSafe.url}/api/v1`,
    clawApiUrl: `${tokenClaw.url}/claw-api`,
    exchange: { ...base.exchange, enabled: true, forChat: true },
  };
  const exchange = {
    enabled: true,
    tokenFor: (userId: string) => {
      assert.equal(userId, ALICE.id);
      return Promise.resolve(ok(EXCHANGED));
    },
    bindingRequest: () => Promise.reject(new Error("not asked")),
    invalidate: () => undefined,
  };
  const plugins = platformPlugins(neutralPlugins({ tokenExchange: exchange }), {
    env: {},
    settings,
    secrets: new Map(),
    fetch: globalThis.fetch,
    now: () => Date.now() / 1000,
    logger: silentLogger,
  });
  const world = assembled({}, new RecordingLogger(), { plugins, settings });
  world.store.links.redeemPending(ALICE.id, ALICE.name, world.store.links.stashPending("ak-alice"));
  return world;
}

const GROUP_CHAT = {
  id: "19:group",
  kind: "group" as const,
  tenantId: "t1",
  wire: { conversation: { id: "19:group" } },
};
const PERSONAL_CHAT = {
  id: "dm-a",
  kind: "personal" as const,
  tenantId: "t1",
  wire: { conversation: { id: "dm-a", conversationType: "personal" }, user: { aadObjectId: ALICE.id } },
};

describe("/whoami of a person whose chats run on an exchanged identity token (TEAMS_EXCHANGE_FOR_CHAT)", () => {
  before(startPlatform);
  after(stopPlatform);

  it("in a group it names the token's SaFE user, asked of Claw's /v1/me with the token, never of SaFE", async () => {
    tokenSafe.requests.length = 0;
    tokenClaw.requests.length = 0;
    const { features, surface } = bound();
    await features.router.handle(
      inboundMessage({ id: "g-who", sender: ALICE, conversation: GROUP_CHAT, text: "/whoami", mentioned: true }),
    );
    await features.router.settled();
    assert.deepEqual(texts(surface), ["Alice are connected to SaFE user Liu, Alice."]);
    assert.deepEqual(
      tokenClaw.requests.map((r) => [r.path, r.headers["authorization"]]),
      [["/claw-api/v1/me", `Bearer ${EXCHANGED}`]],
    );
    assert.deepEqual(tokenSafe.requests, []);
  });

  it('in a group in Chinese it is not "SaFE 没告诉我是谁的账号"', async () => {
    const { features, surface } = bound();
    await features.router.handle(
      inboundMessage({
        id: "g-who-zh",
        sender: ALICE,
        conversation: GROUP_CHAT,
        text: "/whoami",
        mentioned: true,
        locale: "zh-CN",
      }),
    );
    await features.router.settled();
    assert.deepEqual(texts(surface), ["Alice 已连接到 SaFE 用户 Liu, Alice。"]);
  });

  it("in a 1:1 chat its first line names the token's SaFE user", async () => {
    const { features, surface } = bound();
    await features.router.handle(
      inboundMessage({ id: "d-who", sender: ALICE, conversation: PERSONAL_CHAT, text: "/whoami" }),
    );
    await features.router.settled();
    const [first] = texts(surface);
    assert.ok(
      first?.startsWith("This chat is connected to SaFE user Liu, Alice (alice@example.com)."),
      JSON.stringify(texts(surface)),
    );
  });
});
