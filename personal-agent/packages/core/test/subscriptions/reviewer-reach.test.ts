// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What waits for a person reaches them (test_reviewer_reach.py): every linked person's Claw user id is filled in on the timer;
 * a reviewer handed a review has their subscription made or mended at once, and when what waits for them cannot reach their
 * chat the reason is said, in order. Over the real store, with a Claw that keeps subscriptions as Python's `SubsClaw` does.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError } from "../../src/claw/errors.js";
import type { ClawNotificationsPort, ClawSubscription } from "../../src/ports/claw/index.js";
import { silentLogger } from "../../src/ports/logger.js";
import { KeyOwners } from "../../src/routing/identity.js";
import { ASSISTANT_SUBSCRIPTION_TYPES } from "../../src/subscriptions/event-types.js";
import { Subscriptions } from "../../src/subscriptions/subscriptions.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { openTestStore } from "../../../../test-support/store.js";

const BOB_DM = "conv-aad-b";
type Store = ReturnType<typeof openTestStore>["store"];

/** Claw's notification subscriptions as the client sees them: made, listed and mended (Python `SubsClaw`). */
class SubsClaw implements ClawNotificationsPort {
  readonly subs = new Map<string, ClawSubscription[]>();
  readonly patches: string[][] = [];

  constructor(private readonly refuse = 0) {}

  list(key: string): Promise<ClawSubscription[]> {
    if (this.refuse) return Promise.reject(new ClawError(this.refuse));
    return Promise.resolve((this.subs.get(key) ?? []).map((s) => ({ ...s })));
  }

  create(
    key: string,
    url: string,
    eventTypes?: readonly string[],
    sources?: readonly string[],
  ): Promise<ClawSubscription> {
    if (this.refuse) return Promise.reject(new ClawError(this.refuse));
    const rows = this.subs.get(key) ?? [];
    const row: ClawSubscription = {
      subscription_id: `sub-${key}-${String(rows.length)}`,
      url,
      enabled: true,
      event_types: [...(eventTypes?.length ? eventTypes : ["run.completed", "run.failed"])],
      ...(sources === undefined ? {} : { sources: [...sources] }),
    };
    this.subs.set(key, [...rows, row]);
    return Promise.resolve({ ...row, secret: "whsec" });
  }

  updateTypes(
    key: string,
    subscriptionId: string,
    eventTypes: readonly string[],
    options: { enable?: boolean; sources?: readonly string[] } = {},
  ): Promise<ClawSubscription> {
    if (this.refuse) return Promise.reject(new ClawError(this.refuse));
    this.patches.push([...eventTypes]);
    const rows = (this.subs.get(key) ?? []).map((row) =>
      row["subscription_id"] === subscriptionId
        ? {
            ...row,
            event_types: [...eventTypes],
            enabled: row["enabled"] === true || options.enable === true,
            ...(options.sources === undefined ? {} : { sources: [...options.sources] }),
          }
        : row,
    );
    this.subs.set(key, rows);
    return Promise.resolve({});
  }

  delete(key: string, subscriptionId: string): Promise<void> {
    this.subs.set(
      key,
      (this.subs.get(key) ?? []).filter((s) => s["subscription_id"] !== subscriptionId),
    );
    return Promise.resolve();
  }
}

function link(store: Store, aad: string, name: string, key: string): void {
  assert.equal(store.links.redeemPending(aad, name, store.links.stashPending(key)), "ok");
}

function ids(known: Map<string, string>) {
  return (key: string): Promise<string | undefined> => Promise.resolve(known.get(key));
}

function subscriptions(
  store: Store,
  claw: SubsClaw,
  assistant: boolean,
  userIdOf: (key: string) => Promise<string | undefined>,
) {
  return new Subscriptions({
    store,
    claw,
    random: new SeededRandom(7),
    logger: silentLogger,
    baseUrl: "http://w/claw-events",
    assistant,
    userIdOf,
  });
}

/** Bob linked (with his chat known unless `reference` is false), and the subscriptions of a worker with the assistant on. */
function reachableWorld(options: { claw?: SubsClaw; known?: Map<string, string>; reference?: boolean } = {}) {
  const { store } = openTestStore();
  link(store, "aad-b", "Bob", "ak-b");
  if (options.reference !== false) {
    store.references.saveReference("aad-b", {
      serviceUrl: "https://smba.test/",
      conversation: { id: BOB_DM },
      bot: { id: "28:bot" },
      user: { id: "29:b", aadObjectId: "aad-b" },
    });
  }
  const claw = options.claw ?? new SubsClaw();
  const subs = subscriptions(store, claw, true, ids(options.known ?? new Map([["ak-b", "u-bob"]])));
  return { store, claw, subs };
}

it("ensure all fills in every linked persons claw user id", async () => {
  const { store } = openTestStore();
  link(store, "aad-a", "Alice", "ak-a");
  link(store, "aad-b", "Bob", "ak-b");
  link(store, "aad-c", "Carol", "ak-c");
  const known = new Map([
    ["ak-a", "u-alice"],
    ["ak-b", "u-bob"],
  ]);
  const subs = subscriptions(store, new SubsClaw(), false, ids(known));
  await subs.ensureAll();
  assert.deepEqual([store.links.clawUserIdOf("aad-a"), store.links.clawUserIdOf("aad-b")], ["u-alice", "u-bob"]);
  assert.equal(store.links.needsClawUserId("aad-c"), true); // (not readable now)
  known.set("ak-c", "u-carol");
  await subs.ensureAll();
  assert.equal(store.links.clawUserIdOf("aad-c"), "u-carol");
});

it("a recorded claw user id is not read again", async () => {
  const { store } = openTestStore();
  link(store, "aad-a", "Alice", "ak-a");
  store.links.setClawUserId("aad-a", "u-alice");
  const asked: string[] = [];
  await subscriptions(store, new SubsClaw(), true, (key) => {
    asked.push(key);
    return Promise.resolve("u-other");
  }).ensureAll();
  assert.deepEqual(asked, []);
  assert.equal(store.links.clawUserIdOf("aad-a"), "u-alice");
});

it("a reviewer whose subscription lacks the assistants types has it mended when handed a review", async () => {
  const { store, claw, subs } = reachableWorld();
  claw.subs.set("ak-b", [
    {
      subscription_id: "sub-old",
      url: "http://w/claw-events/r-b",
      enabled: true,
      event_types: ["run.completed", "run.failed"],
    },
  ]);
  store.notifySubs.saveNotifySub("aad-b", {
    route: "r-b",
    subscriptionId: "sub-old",
    secret: "whsec",
    typesVersion: 0,
  });
  assert.equal(await subs.reachable("aad-b"), "");
  const rows = claw.subs.get("ak-b") ?? [];
  assert.equal(rows.length, 1);
  const types = new Set(rows[0]?.["event_types"] as string[]);
  assert.ok(
    ASSISTANT_SUBSCRIPTION_TYPES.every((t) => types.has(t)),
    [...types].join(","),
  );
  assert.equal(subs.hasAssistantTypes("aad-b"), true);
});

it("a reviewer without a subscription gets one made when handed a review", async () => {
  const { claw, subs } = reachableWorld();
  assert.equal(await subs.reachable("aad-b"), "");
  const rows = claw.subs.get("ak-b") ?? [];
  assert.equal(rows.length, 1);
  const types = new Set(rows[0]?.["event_types"] as string[]);
  assert.ok(ASSISTANT_SUBSCRIPTION_TYPES.every((t) => types.has(t)));
});

it("why a reviewer cannot be reached is said in order", async () => {
  const { subs } = reachableWorld({ claw: new SubsClaw(503) });
  assert.equal(await subs.reachable("aad-x"), "unlinked");
  assert.equal(await subs.reachable("aad-b"), "no_subscription"); // (Claw would not make one)
});

it("a reviewer without a claw user id is not reachable", async () => {
  const { subs } = reachableWorld({ known: new Map() });
  assert.equal(await subs.reachable("aad-b"), "no_user_id");
});

it("a reviewer with no chat known is not reachable", async () => {
  const { subs } = reachableWorld({ reference: false });
  assert.equal(await subs.reachable("aad-b"), "no_chat");
});

it("the agent fills claw user ids on its timer", async () => {
  // The worker's subscriptions read a person's Claw user id from SaFE's /users/self with their own key (KeyOwners, as the
  // router uses it for /link): the timer asks with that key and records the id.
  const { store } = openTestStore();
  const seen: string[] = [];
  const owners = new KeyOwners({
    ownerOfKey: (key) => {
      seen.push(key);
      return Promise.resolve({ id: "u-alice", name: "alice", email: "", accountType: "" });
    },
  });
  link(store, "aad-a", "Alice", "ak-alice");
  assert.equal(store.links.needsClawUserId("aad-a"), true);
  await subscriptions(store, new SubsClaw(), false, (key) => owners.userIdOf(key)).ensureAll();
  assert.equal(store.links.clawUserIdOf("aad-a"), "u-alice");
  assert.deepEqual(seen, ["ak-alice"]);
});
