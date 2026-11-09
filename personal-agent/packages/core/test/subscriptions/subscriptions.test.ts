// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { SeededRandom } from "../../../../test-support/random.js";
import { silentLogger, type LogFields, type Logger } from "../../src/ports/logger.js";
import { APPROVALS_TYPES_VERSION, ASSISTANT_TYPES_VERSION, wantedTypes } from "../../src/subscriptions/event-types.js";
import {
  RETRY_SECONDS,
  Subscriptions,
  UPGRADE_RETRY_SECONDS,
  type SubscriptionsOptions,
} from "../../src/subscriptions/subscriptions.js";
import { ClawStatusError, FakeClawSubscriptions, FakeSubscriptionStore } from "./fakes.js";

const BASE = "http://agent.example.svc/claw-events";

function world(options: Partial<SubscriptionsOptions> = {}) {
  const store = new FakeSubscriptionStore();
  const claw = new FakeClawSubscriptions();
  const subs = new Subscriptions({
    store,
    claw,
    random: new SeededRandom(7),
    logger: silentLogger,
    baseUrl: `${BASE}/`,
    ...options,
  });
  return { store, claw, subs };
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  private add(level: string, message: string, fields?: LogFields): void {
    this.lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  }
  debug(m: string, f?: LogFields): void {
    this.add("debug", m, f);
  }
  info(m: string, f?: LogFields): void {
    this.add("info", m, f);
  }
  warn(m: string, f?: LogFields): void {
    this.add("warn", m, f);
  }
  error(m: string, f?: LogFields): void {
    this.add("error", m, f);
  }
  child(): Logger {
    return this;
  }
}

it("link creates the users own subscription with their own key", async () => {
  const { store, claw, subs } = world();
  store.link("aad-a", "ak-alice");
  await subs.ensure("aad-a");
  const [row] = claw.of("ak-alice");
  const sub = store.subs.get("aad-a");
  assert.ok(row && sub);
  assert.equal(row.url, `${BASE}/${sub.route}`);
  assert.match(sub.route, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(sub.secret, row.secret);
  assert.deepEqual(row.event_types, ["run.completed", "run.failed"]);
  assert.equal(sub.typesVersion, 0);
});

it("two users two subscriptions two routes", async () => {
  const { store, claw, subs } = world();
  store.link("aad-a", "ak-alice");
  store.link("aad-b", "ak-bob");
  await subs.ensure("aad-a");
  await subs.ensure("aad-b");
  assert.equal(claw.of("ak-alice").length, 1);
  assert.equal(claw.of("ak-bob").length, 1);
  assert.notEqual(store.subs.get("aad-a")?.route, store.subs.get("aad-b")?.route);
});

it("a stale or shared subscription to this worker is replaced not stacked", async () => {
  const { store, claw, subs } = world();
  store.link("aad-a", "ak-alice");
  await claw.create("ak-alice", BASE);
  await claw.create("ak-alice", `${BASE}/orphan`);
  await claw.create("ak-alice", "http://elsewhere.example/hook");
  await subs.ensure("aad-a");
  assert.deepEqual(
    claw.of("ak-alice").map((r) => r.url.startsWith(`${BASE}/`) || r.url === BASE),
    [false, true],
  );
});

it("a refused create is retried at most daily", async () => {
  const { store, claw, subs } = world();
  store.link("aad-a", "ak-alice");
  claw.down = true;
  await subs.ensure("aad-a");
  claw.down = false;
  await subs.ensure("aad-a");
  assert.equal(store.subs.size, 0);
  store.now += RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  assert.equal(store.subs.size, 1);
});

it("unlink deletes the subscription and still forgets it when claw refuses", async () => {
  const { store, claw, subs } = world();
  store.link("aad-a", "ak-alice");
  await subs.ensure("aad-a");
  await subs.remove("aad-a", "ak-alice");
  assert.equal(claw.of("ak-alice").length, 0);
  assert.equal(store.subs.size, 0);
  await subs.ensure("aad-a");
  store.now += RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  claw.down = true;
  await subs.remove("aad-a", "ak-alice");
  assert.equal(store.subs.size, 0);
});

it("with the assistant on the subscription asks for the assistants events and the work items approvals", async () => {
  const { store, claw, subs } = world({ assistant: true });
  store.link("aad-a", "ak-alice", "u-a");
  await subs.ensure("aad-a");
  const [row] = claw.of("ak-alice");
  assert.deepEqual(row?.event_types, [
    "run.completed",
    "run.failed",
    "assistant.say",
    "work_item.needs_you",
    "approval.requested",
  ]);
  assert.deepEqual(claw.of("ak-alice").at(0)?.sources, ["trigger", "long_run", "assistant_item"]);
  assert.equal(store.subs.get("aad-a")?.typesVersion, APPROVALS_TYPES_VERSION);
  assert.ok(subs.hasAssistantTypes("aad-a"));
});

it("a person the assistant understands also gets assistant action", async () => {
  const { store, claw, subs } = world({ assistant: true, understood: () => true });
  store.link("aad-a", "ak-alice");
  await subs.ensure("aad-a");
  assert.ok(claw.of("ak-alice")[0]?.event_types.includes("assistant.action"));
});

it("an old claw without the assistants types gets the base subscription and the types later", async () => {
  const { store, claw, subs } = world({ assistant: true });
  claw.knownTypes = new Set(["run.completed", "run.failed", "approval.requested"]);
  claw.knownSources = new Set(["trigger", "long_run"]);
  store.link("aad-a", "ak-alice");
  await subs.ensure("aad-a");
  assert.equal(store.subs.get("aad-a")?.typesVersion, 0);
  assert.equal(subs.hasAssistantTypes("aad-a"), false);
  claw.knownTypes.add("assistant.say");
  claw.knownTypes.add("work_item.needs_you");
  store.now += UPGRADE_RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  assert.equal(store.subs.get("aad-a")?.typesVersion, ASSISTANT_TYPES_VERSION);
  claw.knownSources.add("assistant_item");
  await subs.ensure("aad-a");
  assert.equal(store.subs.get("aad-a")?.typesVersion, ASSISTANT_TYPES_VERSION);
  store.now += UPGRADE_RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  assert.equal(store.subs.get("aad-a")?.typesVersion, APPROVALS_TYPES_VERSION);
});

it("a subscription claw turned off is turned on again and one claw deleted is made again", async () => {
  const { store, claw, subs } = world({ assistant: true });
  store.link("aad-a", "ak-alice");
  await subs.ensure("aad-a");
  const [row] = claw.of("ak-alice");
  assert.ok(row);
  row.enabled = false;
  store.now += UPGRADE_RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  assert.equal(row.enabled, true);
  claw.rows.clear();
  store.now += UPGRADE_RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  assert.equal(store.subs.size, 0);
  store.now += RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  assert.equal(claw.of("ak-alice").length, 1);
  assert.equal(store.subs.get("aad-a")?.subscriptionId, claw.of("ak-alice")[0]?.subscription_id);
});

it("a claw that refuses every rung takes the person back to sessions", async () => {
  const { store, claw, subs } = world({ assistant: true });
  store.link("aad-a", "ak-alice");
  await subs.ensure("aad-a");
  claw.knownTypes = new Set(["run.completed"]);
  const [row] = claw.of("ak-alice");
  if (row) row.event_types = ["run.completed"];
  store.now += UPGRADE_RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  assert.equal(store.subs.get("aad-a")?.typesVersion, 0);
});

it("the assistant users list limits whose subscription gets the types", async () => {
  const { store, claw, subs } = world({ assistant: true, assistantFor: (aad) => aad === "aad-a" });
  store.link("aad-a", "ak-alice");
  store.link("aad-b", "ak-bob");
  assert.equal(await subs.ensureAll(), 1);
  assert.equal(claw.of("ak-alice").length, 1);
  assert.equal(claw.of("ak-bob").length, 0);
  await subs.ensure("aad-b");
  assert.deepEqual(claw.of("ak-bob")[0]?.event_types, ["run.completed", "run.failed"]);
});

it("ensure all fills in missing claw user ids even with the assistant off", async () => {
  const ids = new Map([["ak-alice", "u-a"]]);
  const { store, subs } = world({ userIdOf: (key) => Promise.resolve(ids.get(key)) });
  store.link("aad-a", "ak-alice");
  store.link("aad-b", "ak-bob");
  assert.equal(await subs.ensureAll(), 0);
  assert.equal(store.userIds.get("aad-a"), "u-a");
  assert.equal(store.userIds.has("aad-b"), false);
  assert.equal(await subs.fillUserIds(), 0);
});

it("a lookup that fails is tried again next time", async () => {
  let fail = true;
  const { store, subs } = world({
    userIdOf: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve("u-a")),
  });
  store.link("aad-a", "ak-alice");
  assert.equal(await subs.fillUserId("aad-a"), false);
  fail = false;
  assert.equal(await subs.fillUserId("aad-a"), true);
});

it("reachable says why not in order", async () => {
  const { store, claw, subs } = world({ assistant: true, userIdOf: () => Promise.resolve(undefined) });
  assert.equal(await subs.reachable("aad-x"), "unlinked");
  store.link("aad-a", "ak-alice");
  claw.down = true;
  assert.equal(await subs.reachable("aad-a"), "no_subscription");
  claw.down = false;
  store.now += RETRY_SECONDS + 1;
  assert.equal(await subs.reachable("aad-a"), "no_user_id");
  store.userIds.set("aad-a", "u-a");
  store.refs.delete("aad-a");
  assert.equal(await subs.reachable("aad-a"), "no_chat");
  store.refs.add("aad-a");
  assert.equal(await subs.reachable("aad-a"), "");
});

it("secrets and keys are never logged", async () => {
  const logger = new RecordingLogger();
  const { store, claw, subs } = world({ logger, assistant: true });
  store.link("aad-a", "ak-alice-SECRETKEY");
  claw.down = true;
  await subs.ensure("aad-a");
  claw.down = false;
  store.now += RETRY_SECONDS + 1;
  await subs.ensure("aad-a");
  await subs.remove("aad-a", "ak-alice-SECRETKEY");
  assert.ok(logger.lines.length > 0);
  for (const line of logger.lines) assert.ok(!line.includes("SECRETKEY") && !line.includes("secret-"), line);
});

it("off means no assistant types and a refusal other than 400 is not a ladder step", async () => {
  const { store, claw, subs } = world({ assistant: true });
  store.link("aad-a", "ak-alice");
  claw.create = () => Promise.reject(new ClawStatusError(503));
  await subs.ensure("aad-a");
  assert.equal(store.subs.size, 0);
});

it("the ladder has no repeated rung", () => {
  assert.equal(wantedTypes(false).length, 2);
  assert.equal(wantedTypes(true).length, 4);
});
