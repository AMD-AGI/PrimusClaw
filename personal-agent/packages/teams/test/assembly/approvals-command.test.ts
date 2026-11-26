// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/approvals` from a person the assistant understands, end to end on the Teams activity: the activity Teams sends, read by the
 * adapter, routed by the router `buildFeatures` builds, answered from a fake Claw over real HTTP.
 *
 * 2026-11-26 03:24: a person sent `/approvals` to the bot from Teams on iOS and was answered by the assistant, in its own words. The
 * text that reached the worker was "@clawy /approvals" (the name typed, no mention entity behind it), which was not an exact command.
 *
 * In a chat attached to a remote session what the person types goes to the coding agent, except words that start by naming the bot:
 * both spellings of the name ("@clawy /x" and "clawy /x") are the bot's, so a slash word that is no command of the bot's is never sent
 * bare to the agent.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { neutralPlugins, noMetrics, SecurityLog, silentLogger, type Settings } from "@primusclaw/personal-agent";
import {
  alsRequestScope,
  ChatLog,
  createClawClient,
  readSettings,
  systemClock,
} from "@primusclaw/personal-agent-runtime";
import { buildFeatures, type AssemblyBase } from "@primusclaw/personal-agent-runtime/worker";

import { FakeHttpServer } from "../../../../test-support/http-server.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface } from "../../../../test-support/surface.js";
import { teamsShape } from "../../src/assembly/worker.js";
import { teamsSettingsFromEnv } from "../../src/config/env.js";
import { toInboundEvent } from "../../src/activity/inbound/to-event.js";

const ALICE = "aad-a";
const BOT = "28:bot";
const NAME = "Clawy";

const SESSION = "s1";
const COMMANDS = `/v1/remote-agents/sessions/${SESSION}/commands`;

let claw: FakeHttpServer;

before(async () => {
  claw = await FakeHttpServer.start([
    // (what an attached chat sends its session: the tests below say whether it was reached)
    { method: "POST", path: COMMANDS, handle: () => ({ status: 200, json: { ok: true, data: {} } }) },
    {
      method: "GET",
      path: `/v1/remote-agents/sessions/${SESSION}/events`,
      handle: () => ({ status: 200, json: { ok: true, data: [] } }),
    },
    {
      method: "GET",
      path: "/v1/remote-agents/approvals",
      handle: () => ({ status: 200, json: { ok: true, data: { enabled: true, summary_minutes: 60 } } }),
    },
    {
      method: "GET",
      path: "/v1/remote-agents/approvals/mutes",
      handle: () => ({
        status: 200,
        json: {
          ok: true,
          data: [{ item: 12, machine: "yihan-dev-pod", title: "clean", muted_since: "2026-11-26T03:21:56.359Z" }],
        },
      }),
    },
  ]);
});

after(async () => {
  await claw.close();
});

function assembled() {
  const settings: Settings = {
    ...readSettings({
      TEAMS_ENCRYPTION_KEYS: "k",
      CLAW_API_URL: claw.url,
      SAFE_API_URL: "https://safe.example.com",
      PUBLIC_BASE_URL: "https://claw.example.com",
      ASSISTANT_ENABLED: "1",
      PA_ASSISTANT_UNDERSTANDING: "on",
      PA_ASSISTANT_UNDERSTANDING_USERS: ALICE,
    }),
    botName: NAME,
  };
  const { store } = openTestStore();
  const surface = new FakeSurface();
  const requestScope = alsRequestScope();
  const base: AssemblyBase = {
    settings,
    shape: teamsShape(teamsSettingsFromEnv({}, { queues: false })),
    store,
    claw: createClawClient({ baseUrl: claw.url, clock: systemClock }),
    surface,
    clock: systemClock,
    random: new SeededRandom(5),
    logger: silentLogger,
    metrics: noMetrics,
    securityLog: new SecurityLog(new RecordingLogger(), noMetrics, requestScope),
    requestScope,
    chatLog: new ChatLog(
      requestScope,
      (text) => text,
      () => Date.now() / 1000,
    ),
    plugins: neutralPlugins(),
    exchange: neutralPlugins().tokenExchange,
    fetch: globalThis.fetch,
    env: { REMOTE_AGENTS_ENABLED: "1" },
  };
  store.links.redeemPending(ALICE, "Alice", store.links.stashPending("ak-alice"));
  return { features: buildFeatures(base), surface, store };
}

/** The activity Teams sends for what Alice typed in her 1:1 chat with the bot. */
function typed(text: string, entities: unknown[] = []) {
  return {
    type: "message",
    id: "act-1",
    text,
    from: { id: "29:a", aadObjectId: ALICE, name: "Alice" },
    recipient: { id: BOT, name: NAME },
    entities,
    attachments: [],
    serviceUrl: "https://smba.test/",
    channelId: "msteams",
    conversation: { id: "dm-a", conversationType: "personal", tenantId: "t1" },
  };
}

function texts(surface: FakeSurface): string[] {
  return surface.outbox.flatMap((r) => {
    if (r.op !== "send" && r.op !== "update" && r.op !== "post") return [];
    const body = r.message.body;
    return body.type === "text" ? [body.text] : body.type === "rich" ? [body.markdown] : [];
  });
}

async function aliceSends(raw: unknown, attached = false) {
  const { features, surface, store } = assembled();
  if (attached) {
    store.remoteState.attachRemote(ALICE, {
      sessionId: SESSION,
      connectorId: "c1",
      agentId: "claude",
      agentLabel: "Claude Code",
      host: "dev-pod",
      cwd: "/repo",
    });
  }
  claw.requests.length = 0;
  const event = toInboundEvent(raw, { botName: NAME });
  assert.ok(event.ok && event.value?.type === "message");
  await features.router.handle(event.value);
  await features.router.settled();
  return { surface, requests: claw.requests.map((r) => `${r.method} ${r.path}`) };
}

describe("/approvals, for a person the assistant understands", () => {
  const STATE = [
    /^Approvals from terminals are on: /,
    /at most once every 60 minutes/,
    /Muted conversations \(1\)/,
    /- #12 · clean · yihan-dev-pod \(muted since 11-26 03:21Z\)$/,
  ];

  for (const [how, raw] of [
    ["typed as it is", typed("/approvals")],
    ["with the bot's name typed as words ahead of it, as Teams on iOS sent it", typed("@clawy /approvals")],
    ["with the bot's name typed ahead of it, without the @", typed("Clawy /approvals")],
    [
      "with the bot's mention picked (an entity)",
      typed("<at>Clawy</at> /approvals", [
        { type: "mention", text: "<at>Clawy</at>", mentioned: { id: BOT, name: NAME } },
      ]),
    ],
  ] as const) {
    it(`answers with the whole state: ${how}`, async () => {
      const { surface, requests } = await aliceSends(raw);
      const said = texts(surface);
      assert.equal(said.length, 1, JSON.stringify(said));
      const lines = (said[0] ?? "").split("\n");
      assert.equal(lines.length, 4, JSON.stringify(lines));
      for (const [i, pattern] of STATE.entries()) assert.match(lines[i] ?? "", pattern);
      assert.deepEqual(requests.sort(), [
        "GET /v1/remote-agents/approvals",
        "GET /v1/remote-agents/approvals",
        "GET /v1/remote-agents/approvals/mutes",
      ]);
    });
  }
});

// A chat attached to a remote session sends what the person types to the coding agent, except words that start by naming the bot. The name
// is the bot's in either spelling: "clawy /clear" was read as "/clear" (the name taken off) yet not as naming the bot, so it went on bare
// to the agent, while "@clawy /clear" stayed with the bot (2026-11-26, review of #949).
describe("in a chat attached to a remote session", () => {
  // (what the chat asks of Claw beside following its session's events, which a background read adds when it likes)
  const asked = (requests: readonly string[]): string[] => requests.filter((r) => !r.endsWith("/events")).sort();
  const sentToAgent = (): string[] =>
    claw.requests.filter((r) => r.method === "POST" && r.path === COMMANDS).map((r) => JSON.stringify(r.json));

  it("sends what the person types to the agent (the control for the cases below)", async () => {
    const { surface } = await aliceSends(typed("/clear"), true);
    assert.deepEqual(sentToAgent(), [JSON.stringify({ type: "prompt", text: "/clear" })]);
    assert.deepEqual(texts(surface), []);
  });

  it("keeps a slash word that is no command of the bot's from the agent, whichever way the bot is named", async () => {
    const outcomes = new Map<string, { said: string[]; requests: string[] }>();
    for (const text of ["@clawy /clear", "clawy /clear", "CLAWY  /clear", "@Clawy /compact", "Clawy /compact"]) {
      const { surface, requests } = await aliceSends(typed(text), true);
      assert.deepEqual(sentToAgent(), [], `${text}: sent to the agent`);
      const said = texts(surface);
      assert.equal(said.length, 1, `${text}: ${JSON.stringify(said)}`);
      // (the assistant has no subscription in this assembly: its "cannot reach you" line is how its taking the message shows)
      assert.match(said[0] ?? "", /your assistant/u, text);
      outcomes.set(text, { said, requests: asked(requests) });
    }
    // the two spellings of the name are routed the same way
    assert.deepEqual(outcomes.get("clawy /clear"), outcomes.get("@clawy /clear"));
    assert.deepEqual(outcomes.get("Clawy /compact"), outcomes.get("@Clawy /compact"));
  });

  for (const [how, text] of [
    ["with the name typed as words (@)", "@clawy /approvals"],
    ["with the name typed without the @", "clawy /approvals"],
  ] as const) {
    it(`answers /approvals, ${how}, and sends nothing to the agent`, async () => {
      const { surface, requests } = await aliceSends(typed(text), true);
      assert.deepEqual(sentToAgent(), []);
      const said = texts(surface);
      assert.equal(said.length, 1, JSON.stringify(said));
      assert.match(said[0] ?? "", /^Approvals from terminals are on: /u);
      assert.deepEqual(asked(requests), [
        "GET /v1/remote-agents/approvals",
        "GET /v1/remote-agents/approvals",
        "GET /v1/remote-agents/approvals/mutes",
      ]);
    });
  }

  it("still sends words that only look like naming the bot to the agent", async () => {
    for (const text of ["clawyx /clear", "hi clawy /clear", "clawy: /clear", "clawy /tmp/app.log is huge"]) {
      await aliceSends(typed(text), true);
      assert.deepEqual(sentToAgent(), [JSON.stringify({ type: "prompt", text })], text);
    }
  });
});
