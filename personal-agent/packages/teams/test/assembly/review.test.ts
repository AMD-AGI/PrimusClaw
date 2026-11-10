// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review service as the worker assembles it (TEAMS_GITHUB_REVIEW_ENABLED): built with the router it runs on, it hears of
 * every stopped item once (a Stop on a work item's card, a group's "停 N"), its follows are taken up again at start, its open
 * cards are swept on a timer, and a review the assistant hands back goes to it. Through `buildFeatures` and the real router,
 * with Claw a fake over real HTTP.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  neutralPlugins,
  noMetrics,
  SecurityLog,
  silentLogger,
  type Logger,
  type Settings,
} from "@primusclaw/personal-agent";
import {
  alsRequestScope,
  ChatLog,
  createClawClient,
  readSettings,
  systemClock,
} from "@primusclaw/personal-agent-runtime";

import { FakeHttpServer } from "../../../../test-support/http-server.js";
import { inboundMessage } from "../../../../test-support/inbound.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface } from "../../../../test-support/surface.js";
import { toInboundEvent } from "../../src/activity/inbound/to-event.js";
import { teamsSettingsFromEnv } from "../../src/config/env.js";
import { buildFeatures, type AssemblyBase } from "../../src/assembly/features.js";
import { workCardPoster } from "../../src/assembly/features-review.js";

const ALICE = { id: "aad-a", channelUserId: "29:aad-a", name: "Alice", email: "" };
const ITEM = { item_id: "item-7", seq: 7, title: "Review acme/app#825", kind: "review", board_state: "in_progress" };
const STOPPED = { ...ITEM, board_state: "done", status: "stopped" };

let claw: FakeHttpServer;

before(async () => {
  claw = await FakeHttpServer.start([
    {
      method: "POST",
      path: "/v1/work-items/item-7/stop",
      handle: () => ({ status: 200, json: { ok: true, data: STOPPED } }),
    },
    {
      method: "GET",
      path: "/v1/work-items",
      handle: () => ({
        status: 200,
        json: { ok: true, data: [{ ...ITEM, params: { pr: { owner: "acme", repo: "app", number: 825 } } }] },
      }),
    },
  ]);
});

after(async () => {
  await claw.close();
});

function reviewSettings(): Settings {
  const read = readSettings({
    TEAMS_ENCRYPTION_KEYS: "k",
    CLAW_API_URL: claw.url,
    SAFE_API_URL: "https://safe.example.com",
    PUBLIC_BASE_URL: "https://claw.example.com",
  });
  return {
    ...read,
    githubReview: {
      enabled: true,
      owners: ["acme"],
      intentModel: "",
      credentialUrl: "https://claw.example.com/oauth/external-credentials",
      clientId: "cli",
    },
    assistant: { ...read.assistant, enabled: true, understandingUsers: new Set([ALICE.id]) },
  };
}

function assembled(options: { readonly review?: boolean; readonly logger?: Logger } = {}) {
  const { store } = openTestStore();
  const surface = new FakeSurface();
  const plugins = neutralPlugins();
  const requestScope = alsRequestScope();
  const settings = reviewSettings();
  const base: AssemblyBase = {
    settings:
      options.review === false ? { ...settings, githubReview: { ...settings.githubReview, enabled: false } } : settings,
    teams: teamsSettingsFromEnv({}, { queues: false }),
    store,
    claw: createClawClient({ baseUrl: claw.url, clock: systemClock }),
    surface,
    clock: systemClock,
    random: new SeededRandom(5),
    logger: options.logger ?? silentLogger,
    metrics: noMetrics,
    securityLog: new SecurityLog(silentLogger, noMetrics, requestScope),
    requestScope,
    chatLog: new ChatLog(
      requestScope,
      (text) => text,
      () => Date.now() / 1000,
    ),
    plugins,
    exchange: plugins.tokenExchange,
    fetch: globalThis.fetch,
    env: {},
  };
  const features = buildFeatures(base);
  store.links.redeemPending(ALICE.id, ALICE.name, store.links.stashPending("ak-alice"));
  return { features, store, surface };
}

/** How many times the review service heard of a stopped item, from now on. */
function stopsHeard(features: ReturnType<typeof assembled>["features"]): string[] {
  const service = features.review;
  assert.ok(service !== undefined);
  const heard: string[] = [];
  const own = service.itemStopped.bind(service);
  service.itemStopped = (itemId: string) => {
    heard.push(itemId);
    own(itemId);
  };
  return heard;
}

/** Alice presses Stop on the work item's card in her 1:1 chat, as Teams sends it (the card's own button data). */
function stopPress(cardId: string) {
  const read = toInboundEvent(
    {
      type: "invoke",
      name: "adaptiveCard/action",
      id: "1767225600200",
      replyToId: "card-7",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      from: { id: ALICE.channelUserId, aadObjectId: ALICE.id, name: ALICE.name },
      recipient: { id: "28:bot" },
      conversation: { id: "dm-a", conversationType: "personal", tenantId: "t1" },
      value: {
        action: {
          type: "Action.Execute",
          verb: "primusclaw.work_stop",
          data: { primusclaw: "work", op: "stop", card: cardId },
        },
      },
    },
    { botName: "Clawy", logger: silentLogger },
  );
  assert.ok(read.ok && read.value !== undefined);
  return read.value;
}

describe("the review service in the worker", () => {
  it("a Stop on a work item's card reaches the review service once, through the router", async () => {
    // (Python test_review_items.py::test_a_stopped_item_ends_its_followed_turn_as_stopped_not_as_a_failure: the wiring)
    const { features, store } = assembled();
    const heard = stopsHeard(features);
    const cardId = store.assistantCards.addAssistantCard(ALICE.id, "item-7", 1, false);
    await features.router.handle(stopPress(cardId));
    await features.router.settled();
    assert.deepEqual(heard, ["item-7"]);
    assert.ok(claw.requests.some((r) => r.method === "POST" && r.path === "/v1/work-items/item-7/stop"));
  });

  it("a group's 停 N from a person the assistant understands stops the item at once, and the review service hears it once", async () => {
    // (Python test_review_items.py::test_a_review_through_the_assistant_and_one_through_the_old_path_both_start_and_both_stop:
    // the group stop and the review service hearing of it)
    const { features, surface } = assembled();
    const heard = stopsHeard(features);
    await features.router.handle(
      inboundMessage({
        id: "1767225600300",
        sender: ALICE,
        conversation: { id: "19:group", kind: "group", tenantId: "t1", wire: { conversation: { id: "19:group" } } },
        text: "停 825",
        mentioned: true,
      }),
    );
    await features.router.settled();
    assert.deepEqual(heard, ["item-7"]);
    const said = surface.outbox.flatMap((r) =>
      r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : [],
    );
    assert.ok(
      said.some((t) => t.includes("acme/app#825")),
      JSON.stringify(said),
    );
  });

  it("its follows are taken up again at start, and its open cards are swept on a timer from the start", async () => {
    const { features } = assembled();
    const service = features.review;
    assert.ok(service !== undefined);
    let resumed = 0;
    service.resume = () => {
      resumed += 1;
      return 0;
    };
    await features.start();
    assert.equal(resumed, 1);
    const sweep = features.timers.find((t) => t.name === "sweep_review_cards");
    assert.ok(sweep !== undefined && sweep.runAtStart && sweep.everyMs === 120_000);
    await sweep.run(); // (one pass; it returns)
  });

  it("a review the assistant hands back goes to the review service, which reads it", async () => {
    const logger = new RecordingLogger();
    const { features } = assembled({ logger });
    const event = { type: "assistant.action", action: { name: "review_for_other" }, review: {}, event_id: "ev-1" };
    assert.equal(await features.deliverEvent(ALICE.id, {}, event), "dropped");
    // (not one this chat declared: the review service says so; without it nothing is read at all)
    assert.ok(logger.dump().includes("a review handed back by the assistant was not taken"), logger.dump());
  });

  it("with the review service off there is none: nothing hears a stop and no card is swept", () => {
    const { features } = assembled({ review: false });
    assert.equal(features.review, undefined);
    assert.equal(
      features.timers.find((t) => t.name === "sweep_review_cards"),
      undefined,
    );
  });
});

describe("the reviewer's work card", () => {
  it("is in the language of what it says, or of the item's title, as Python's work_card without a language", async () => {
    const { store } = openTestStore();
    const surface = new FakeSurface();
    const post = workCardPoster({ store });
    const conversation = surface.conversation({ id: "dm-b", kind: "personal", tenantId: "t1", wire: {} });
    const item = { itemId: "item-9", seq: 9, title: "Review acme/app#9", resultVersion: 0, canAccept: false } as never;
    await post(conversation, "aad-b", item, "The review waits for you: approve or request changes.");
    await post(conversation, "aad-b", item, "代审在等你：批准或者要求修改。");
    const langs = surface.outbox.flatMap((r) =>
      r.op === "post" && r.message.body.type === "view" ? [(r.message.body.view.model as { lang: string }).lang] : [],
    );
    assert.deepEqual(langs, ["en", "zh"]);
  });
});
