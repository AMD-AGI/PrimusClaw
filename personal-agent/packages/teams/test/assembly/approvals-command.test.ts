// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/approvals` from a person the assistant understands, end to end on the Teams activity: the activity Teams sends, read by the
 * adapter, routed by the router `buildFeatures` builds, answered from a fake Claw over real HTTP.
 *
 * 2026-11-26 03:24: a person sent `/approvals` to the bot from Teams on iOS and was answered by the assistant, in its own words. The
 * text that reached the worker was "@clawy /approvals" (the name typed, no mention entity behind it), which was not an exact command.
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

let claw: FakeHttpServer;

before(async () => {
  claw = await FakeHttpServer.start([
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
  return { features: buildFeatures(base), surface };
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

async function aliceSends(raw: unknown) {
  const { features, surface } = assembled();
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
