// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's services a deployment's plugins are built with (`WorkerServices`), and the plugin factory through the
 * real `buildWorker`: what the factory returns is what the worker runs with (a route it adds satisfies
 * TEAMS_ON_BEHALF_USERS), and the services it is given work once the worker is assembled.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";

import { noMetrics, SecurityLog, silentLogger, type InboundEvent, type Router } from "@primusclaw/personal-agent";
import { alsRequestScope } from "@primusclaw/personal-agent-runtime";

import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface } from "../../../../test-support/surface.js";
import { ON_BEHALF_PATH } from "../../src/assembly/features.js";
import { buildWorker } from "../../src/assembly/worker.js";
import { workerServices } from "../../src/assembly/worker-services.js";
import type { WorkerServices } from "../../src/worker-api.js";

const ALICE = "aad-a";
const REFERENCE = {
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  conversation: { id: "dm-a", conversationType: "personal", tenantId: "t1" },
  bot: { id: "28:bot", name: "Clawy" },
  user: { id: "29:aad-a", aadObjectId: ALICE, name: "Alice" },
  locale: "zh-CN",
};

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "w3b-services-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function services() {
  const { store } = openTestStore();
  const surface = new FakeSurface();
  const security = new RecordingLogger();
  const bound = workerServices({
    store,
    surface,
    securityLog: new SecurityLog(security, noMetrics, alsRequestScope()),
    logger: silentLogger,
    botName: "Clawy",
  });
  return { bound, store, surface, security };
}

it("the store's reads name a linked person by their directory id", () => {
  const { bound, store } = services();
  store.links.redeemPending(ALICE, "Alice", store.links.stashPending("ak-alice"));
  store.links.setClawUserId(ALICE, "u-alice");
  store.references.saveReference(ALICE, REFERENCE);
  store.members.rememberMember("29:aad-a", ALICE, "Alice");
  const s = bound.services;
  assert.deepEqual(s.channelUsersOf("u-alice"), [ALICE]);
  assert.equal(s.clawUserOf(ALICE), "u-alice");
  assert.equal(s.hasKey(ALICE), true);
  assert.equal(s.hasKey("aad-nobody"), false);
  assert.equal(s.conversationOf(ALICE)?.id, "dm-a");
  assert.deepEqual(s.knownPeople(), [{ name: "Alice", objectId: ALICE }]);
});

it("a message handled as the person's own reaches the router as theirs, with provenance on_behalf", async () => {
  const { bound, store } = services();
  store.references.saveReference(ALICE, REFERENCE);
  const conversation = bound.services.conversationOf(ALICE);
  assert.ok(conversation !== undefined);
  await assert.rejects(bound.services.handleAsTyped(conversation, ALICE, "m-1", "hi"), /not assembled yet/);
  const handled: InboundEvent[] = [];
  bound.bind({ handle: (event: InboundEvent) => Promise.resolve(void handled.push(event)) } as unknown as Router);
  await bound.services.handleAsTyped(conversation, ALICE, "m-1", "请 Bob 帮我 review 合入 acme/app#1");
  const [event] = handled;
  assert.ok(event?.type === "message");
  assert.deepEqual(
    [event.id, event.sender.id, event.conversation.id, event.text, event.provenance],
    ["m-1", ALICE, "dm-a", "请 Bob 帮我 review 合入 acme/app#1", "on_behalf"],
  );
});

it("a post goes to the conversation, and the audit is one on_behalf_message event", async () => {
  const { bound, store, surface, security } = services();
  store.references.saveReference(ALICE, REFERENCE);
  const conversation = bound.services.conversationOf(ALICE);
  assert.ok(conversation !== undefined);
  await bound.services.post(conversation, "（协调者代发）hi");
  assert.equal(surface.outbox.at(-1)?.op, "post");
  bound.services.audit({ outcome: "success", status: 202, count: 1 });
  const record = JSON.parse(security.lines.at(-1)?.message ?? "{}") as Record<string, unknown>;
  assert.deepEqual(
    [record["event"], record["operation"], record["outcome"]],
    ["on_behalf_message", "on_behalf", "success"],
  );
});

it("buildWorker builds a deployment's plugins with the worker's services, and runs with what they return", async () => {
  const env = {
    TEAMS_ENCRYPTION_KEYS: "x".repeat(43) + "=",
    TEAMS_DB_PATH: join(dir, "state.db"),
    PUBLIC_BASE_URL: "https://claw.example.com",
    CLAW_API_URL: "http://claw.invalid",
    SAFE_API_URL: "http://safe.invalid/api/v1",
    OUTBOUND_MODE: "direct",
    BOT_MSI_CLIENT_ID: "x",
    SECRETS_SOURCE: "env",
    TEAMS_GATE_ENTRY: "1",
    GATE_RUN_ID: "services-test",
    TEAMS_GATE_CONNECTOR_URL: "http://127.0.0.1:9",
    TEAMS_ON_BEHALF_USERS: "u-coordinator",
  };
  const given: WorkerServices[] = [];
  const route = {
    method: "POST" as const,
    path: ON_BEHALF_PATH,
    handle: () => Promise.resolve({ status: 202, body: {} }),
  };
  const options = { logger: silentLogger };
  const worker = await buildWorker(
    env,
    (services) => {
      given.push(services);
      return { routeExtensions: [route] };
    },
    options,
  );
  assert.equal(given.length, 1);
  assert.deepEqual(given[0]?.knownPeople(), []);
  await worker.stop();
  // (without the route the same configuration does not start)
  await assert.rejects(
    buildWorker({ ...env, TEAMS_DB_PATH: join(dir, "state2.db") }, () => ({}), options),
    /TEAMS_ON_BEHALF_USERS/,
  );
});
