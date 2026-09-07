// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A fleet whose asserted floor moves while a turn is being dispatched.
 *
 * The gate is read once, at the branch, and the rest of that dispatch belongs
 * to whichever answer it got. What each case here holds is the agreement
 * between the two halves of one dispatch: a row stamped one way and a payload
 * published the other is the mixed-version defect, and it is reachable only
 * through the window between the row insert and the publish.
 */

import "./doorbell-dispatch-on-env.js";

import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  DOORBELL_SEMANTICS_VERSION, doorbellDedupId, isRunDoorbell, RUN_DOORBELL_KIND, taskSubject,
} from "@claw/protocol";

import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { db } from "../src/infra/db.js";
import { dispatchTaskToBrain, sessionDispatchPorts } from "../src/sessions/dispatch.js";
import { dispatchPendingMessage, pendingDispatchPorts } from "../src/tasks/pending-dispatch.js";
import {
  beginDoorbellDispatch, doorbellGateOpen, doorbellInFlight, resetDoorbellGate, setDoorbellLatch,
  type DoorbellLatch,
} from "../src/tasks/doorbell-gate.js";

interface SeenQuery { sql: string; params: unknown[] }
interface Published { subject: string; payload: string; msgId?: string }

const SUPPORTED = DOORBELL_SEMANTICS_VERSION;
const FLOOR: DoorbellLatch = { state: "floor", version: SUPPORTED };
const originalQuery = db.query;
const originalPorts = { ...sessionDispatchPorts };
const originalPendingPorts = { ...pendingDispatchPorts };

before(() => {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
});

afterEach(() => {
  db.query = originalQuery;
  Object.assign(sessionDispatchPorts, originalPorts);
  Object.assign(pendingDispatchPorts, originalPendingPorts);
  resetDoorbellGate();
});

/** The workspace lookup, which is the query the binding is decided on. */
const BIND_LOOKUP = /FROM claw_workspace_refs r/;

const INPUT = {
  sessionId: "s-1",
  userId: "u-1",
  user: null,
  content: "summarise the logs",
  messageType: "text",
  toolIds: [] as number[],
  pluginId: undefined,
  requestImage: undefined,
  requestResource: undefined,
  requestTimeout: undefined,
  workspaceId: undefined,
  mcpServers: undefined,
  capturedUserEnvSnapshot: {},
  capturedSessionEnv: {},
};

function boundWorkspace() {
  return {
    rows: [{
      workspace_id: "kws_1", owner_user_id: "u-1",
      storage_prefix: "users/u-1/sessions/s-1/", version: "0",
      writer_run_id: null, retention_expires_at: null, deleted_at: null,
    }],
    rowCount: 1,
  };
}

/** The real `openChatRun` runs here, so the row stamp is read out of its own insert. */
function stubDb(): SeenQuery[] {
  const seen: SeenQuery[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    if (BIND_LOOKUP.test(sql)) return boundWorkspace();
    if (/^INSERT INTO claw_tasks/.test(sql)) return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  return seen;
}

function recordPublishes(): Published[] {
  const published: Published[] = [];
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (subject, payload, msgId) => {
    published.push({ subject, payload, msgId });
    return 1;
  };
  return published;
}

function taskInsert(seen: SeenQuery[]): {
  status: string; metadata: Record<string, unknown>; tokenHash: unknown;
} {
  const q = seen.find((s) => /^INSERT INTO claw_tasks/.test(s.sql));
  assert.ok(q, "the dispatch has to have written a row");
  return {
    status: q.params[25] as string,
    metadata: JSON.parse(q.params[26] as string),
    tokenHash: q.params[24],
  };
}

/**
 * Move the latch inside the window the branch has already left.
 *
 * `openChatRun` is the one port both branches call after the gate read and
 * before their publish, so wrapping it is what makes the flip land where a
 * `DELETE` reaching the pod mid-dispatch would.
 */
function flipLatchDuringOpen(next: DoorbellLatch): () => number {
  const realOpen = sessionDispatchPorts.openChatRun;
  let flips = 0;
  sessionDispatchPorts.openChatRun = (async (args) => {
    flips += 1;
    setDoorbellLatch(next);
    return await realOpen(args);
  }) as typeof sessionDispatchPorts.openChatRun;
  return () => flips;
}

/** The two halves of one dispatch, which must say the same thing. */
function assertAgreement(metadata: Record<string, unknown>, published: Published[]): void {
  assert.equal(published.length, 1);
  assert.equal(
    metadata.dispatch === "doorbell",
    isRunDoorbell(JSON.parse(published[0].payload)),
    "a row stamped one way and published the other is the mixed-version defect",
  );
}

test("a floor below this API's constant sends every chat turn down the fat branch", async () => {
  // `PUT "0"` is what a floor below 1 actually reaches this pod as: the value
  // does not parse as a version, so the latch is invalid rather than a floor.
  setDoorbellLatch({ state: "invalid", value: String(SUPPORTED - 1) });
  const seen = stubDb();
  const published = recordPublishes();

  const result = await dispatchTaskToBrain(INPUT, async () => {});

  assert.equal(result.kind, "dispatched");
  const { status, metadata, tokenHash } = taskInsert(seen);
  assert.equal(status, "preparing");
  assert.equal(metadata.dispatch, "fat");
  assert.equal(metadata.doorbell_semantics, undefined);
  assert.equal(typeof metadata.dispatch_compensation, "object");
  assert.notEqual(tokenHash, null, "a fat row is issued a lease");
  assert.equal(published.length, 1);
  assert.equal(published[0].msgId, undefined);
  assert.equal(isRunDoorbell(JSON.parse(published[0].payload)), false);
});

test("a floor at this API's constant sends it down the doorbell branch", async () => {
  setDoorbellLatch(FLOOR);
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  const seen = stubDb();
  const published = recordPublishes();

  const result = await dispatchTaskToBrain(INPUT, async () => {});

  assert.equal(result.kind, "dispatched");
  const { status, metadata, tokenHash } = taskInsert(seen);
  assert.equal(status, "queued");
  assert.equal(metadata.dispatch, "doorbell");
  assert.equal(metadata.doorbell_semantics, SUPPORTED);
  assert.equal(tokenHash, null);
  assert.equal(published.length, 1);
  const payload = JSON.parse(published[0].payload);
  assert.equal(isRunDoorbell(payload), true);
  assert.equal(payload.kind, RUN_DOORBELL_KIND);
  assert.equal(published[0].subject, taskSubject());
  assert.equal(published[0].msgId, doorbellDedupId("s-1", payload.message_id));
});

test("a floor above this API's constant is still the doorbell branch", async () => {
  setDoorbellLatch({ state: "floor", version: SUPPORTED + 1 });
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  const seen = stubDb();
  const published = recordPublishes();

  const result = await dispatchTaskToBrain(INPUT, async () => {});

  assert.equal(result.kind, "dispatched");
  const { status, metadata } = taskInsert(seen);
  assert.equal(status, "queued");
  assert.equal(metadata.dispatch, "doorbell");
  assert.equal(
    metadata.doorbell_semantics, SUPPORTED,
    "the row carries the contract this API speaks, not the fleet's floor",
  );
  assert.equal(isRunDoorbell(JSON.parse(published[0].payload)), true);
});

test("a revocation landing after the branch still publishes the doorbell it stamped", async () => {
  setDoorbellLatch(FLOOR);
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  const seen = stubDb();
  const published = recordPublishes();
  const flips = flipLatchDuringOpen({ state: "revoked" });

  const result = await dispatchTaskToBrain(INPUT, async () => {});

  assert.equal(flips(), 1, "the window between the branch and the publish was exercised");
  assert.equal(doorbellGateOpen(), false);
  assert.equal(result.kind, "dispatched");
  const { status, metadata } = taskInsert(seen);
  assert.equal(status, "queued");
  assert.equal(metadata.dispatch, "doorbell");
  assertAgreement(metadata, published);
  assert.equal(doorbellInFlight(), 0);
});

test("a floor asserted after the branch does not turn a fat dispatch into a doorbell", async () => {
  setDoorbellLatch({ state: "revoked" });
  const seen = stubDb();
  const published = recordPublishes();
  const flips = flipLatchDuringOpen(FLOOR);

  const result = await dispatchTaskToBrain(INPUT, async () => {});

  assert.equal(flips(), 1);
  assert.equal(doorbellGateOpen(), true);
  assert.equal(result.kind, "dispatched");
  const { status, metadata, tokenHash } = taskInsert(seen);
  assert.equal(status, "preparing");
  assert.equal(metadata.dispatch, "fat");
  assert.equal(metadata.doorbell_semantics, undefined);
  assert.notEqual(tokenHash, null);
  assert.equal(published[0].msgId, undefined);
  assertAgreement(metadata, published);
  assert.equal(doorbellInFlight(), 0);
});

test("a dispatch already past the branch keeps the pod's in-flight count raised until it publishes", async () => {
  setDoorbellLatch(FLOOR);
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  stubDb();
  const published = recordPublishes();
  let inFlightAtPublish = -1;
  let gateAtPublish = true;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (subject, payload, msgId) => {
    inFlightAtPublish = doorbellInFlight();
    gateAtPublish = doorbellGateOpen();
    published.push({ subject, payload, msgId });
    return 1;
  };
  const flips = flipLatchDuringOpen({ state: "revoked" });

  await dispatchTaskToBrain(INPUT, async () => {});

  assert.equal(flips(), 1);
  assert.equal(inFlightAtPublish, 1);
  assert.equal(gateAtPublish, false, "a closed gate over a raised count is not a drained pod");
  assert.equal(doorbellInFlight(), 0);
});

test("a revocation after the branch does not strand the token when the publish throws", async () => {
  setDoorbellLatch(FLOOR);
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  const seen = stubDb();
  const published = recordPublishes();
  sessionDispatchPorts.publishTask = async () => { throw new Error("nats down"); };
  sessionDispatchPorts.failChatRunDispatch =
    (async () => "closed") as typeof sessionDispatchPorts.failChatRunDispatch;
  const flips = flipLatchDuringOpen({ state: "revoked" });

  let rolledBack = false;
  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(flips(), 1);
  assert.equal(result.kind, "publish_failed");
  assert.equal(rolledBack, true);
  assert.equal(taskInsert(seen).metadata.dispatch, "doorbell");
  assert.deepEqual(published, [], "nothing was published, so nothing disagrees");
  assert.equal(doorbellInFlight(), 0);
});

test("a revocation after the branch does not strand the token when the turn is queued", async () => {
  setDoorbellLatch(FLOOR);
  sessionDispatchPorts.admit = async () => ({ kind: "queue", position: 3 });
  const seen = stubDb();
  const published = recordPublishes();
  const flips = flipLatchDuringOpen({ state: "revoked" });

  const result = await dispatchTaskToBrain(INPUT, async () => {
    throw new Error("queued runs keep the session gate");
  });

  assert.equal(flips(), 1);
  assert.equal(result.kind, "queued");
  assert.equal(result.kind === "queued" ? result.queuePosition : 0, 3);
  assert.deepEqual(published, []);
  const { status, metadata } = taskInsert(seen);
  assert.equal(status, "queued");
  assert.equal(metadata.dispatch, "doorbell");
  assert.equal(typeof metadata.queued_since, "string");
  assert.equal(doorbellInFlight(), 0);
});

test("the same flip on the pending-message drain behaves identically", async () => {
  // The pending suite's seam replaces `openChatRun` outright, so the row here
  // is what the port was asked for rather than what an insert wrote.
  const opened: Array<Record<string, unknown>> = [];
  const published: Published[] = [];
  const run = async (next: DoorbellLatch) => {
    opened.length = 0;
    published.length = 0;
    pendingDispatchPorts.admit = async () => ({ kind: "admit" });
    pendingDispatchPorts.bindWorkspace = (async () => "kws_1") as typeof pendingDispatchPorts.bindWorkspace;
    pendingDispatchPorts.requireWorkspaceBinding =
      ((workspaceId?: string) => workspaceId as string) as typeof pendingDispatchPorts.requireWorkspaceBinding;
    pendingDispatchPorts.publishSessionEvent =
      (async () => {}) as unknown as typeof pendingDispatchPorts.publishSessionEvent;
    pendingDispatchPorts.openChatRun = (async (args: Record<string, unknown>) => {
      opened.push(args);
      setDoorbellLatch(next);
      return { taskId: "ktsk_1", workspaceId: "kws_1", lease: { url: "http://api/lease", token: "t0ken" } };
    }) as unknown as typeof pendingDispatchPorts.openChatRun;
    pendingDispatchPorts.publish = (async (subject: string, payload: string, msgId: string) => {
      published.push({ subject, payload, msgId });
      return published.length;
    }) as typeof pendingDispatchPorts.publish;
    db.query = (async () => ({ rows: [], rowCount: 1 })) as typeof db.query;
    await dispatchPendingMessage({
      sessionId: "s-1", pendingId: 42, userId: "u-1", messageId: "claw-1700000000000",
      prompt: "carry on", workspaceId: "kws_1",
      task: { session_id: "s-1", prompt: "carry on", llm_api_key: "sk-live" },
    });
  };

  setDoorbellLatch(FLOOR);
  await run({ state: "revoked" });
  assert.equal(opened[0].dispatch, "doorbell");
  assert.equal(
    opened[0].dispatch === "doorbell",
    isRunDoorbell(JSON.parse(published[0].payload)),
    "a row stamped one way and published the other is the mixed-version defect",
  );
  assert.equal(doorbellInFlight(), 0);

  await run(FLOOR);
  assert.equal(opened[0].dispatch, "fat");
  assert.equal(opened[0].dispatch === "doorbell", isRunDoorbell(JSON.parse(published[0].payload)));
  assert.equal(doorbellInFlight(), 0);
});

test("neither branch re-reads the gate after the branch", async () => {
  const countedReads = () => {
    let reads = 0;
    sessionDispatchPorts.doorbellDispatch = () => { reads += 1; return beginDoorbellDispatch(); };
    return () => reads;
  };

  setDoorbellLatch(FLOOR);
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  stubDb();
  recordPublishes();
  let reads = countedReads();
  await dispatchTaskToBrain(INPUT, async () => {});
  assert.equal(reads(), 1);

  setDoorbellLatch({ state: "revoked" });
  stubDb();
  recordPublishes();
  reads = countedReads();
  await dispatchTaskToBrain(INPUT, async () => {});
  assert.equal(reads(), 1);
});
