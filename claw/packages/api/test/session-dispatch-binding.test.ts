// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * When a chat turn cannot be told which files it writes.
 *
 * The turn is refused: dispatching it anyway hands it a gate key that lets two
 * runs over one directory delete each other's work, silently. What these tests
 * pin is *where* the refusal happens, which is the part that was wrong. The
 * binding used to be checked after the user's message had been persisted and
 * published, and the rollback only returns the session to idle -- so a refused
 * turn stayed in the conversation, answered by nobody, and was handed to the
 * model as history on the next turn.
 *
 * Coverage:
 *   D1 a turn that cannot be bound is refused before anything is written
 *   D2 the refusal is identifiable, so a caller can tell it from other failures
 *   D3 the binding is decided before the user's message is persisted
 *   D4 a turn whose run row could not open does not publish
 *   D5 a doorbell hard refusal rolls the session back and does not open a row
 *   D6 a doorbell soft queue returns a position and does not publish a wakeup
 *   D7 a doorbell whose wakeup cannot be published closes the queued row
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { db } from "../src/infra/db.js";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { dispatchTaskToBrain, sessionDispatchPorts } from "../src/sessions/dispatch.js";
import { isWorkspaceBindingError } from "../src/workspace/store.js";

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
const originalPorts = { ...sessionDispatchPorts };
afterEach(() => {
  db.query = originalQuery;
  Object.assign(sessionDispatchPorts, originalPorts);
});

function stubDb(behaviour?: (sql: string) => unknown): SeenQuery[] {
  const seen: SeenQuery[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    return behaviour?.(sql) ?? { rows: [], rowCount: 0 };
  }) as typeof db.query;
  return seen;
}

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

test("D1 a turn that cannot be bound is refused before anything is written", async () => {
  // No workspace row and none creatable, which is what a database that has just
  // gone away looks like from here.
  const seen = stubDb();
  let rolledBack = false;

  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(result.kind, "publish_failed");
  assert.ok(rolledBack, "the session was marked running by the caller and has to go back");
  assert.ok(
    !seen.some((q) => /INSERT INTO claw_session_events/.test(q.sql)),
    "a message persisted for a turn that was refused stays in the conversation forever",
  );
  assert.ok(
    !seen.some((q) => /INSERT INTO claw_tasks/.test(q.sql)),
    "and no row for a run that will never be dispatched",
  );
});

test("D2 the refusal is identifiable, so a caller can tell it from other failures", async () => {
  // Matching on the message is how a retriable refusal turns into a permanent
  // failure the day the wording changes.
  stubDb();
  const result = await dispatchTaskToBrain(INPUT, async () => {});

  assert.equal(result.kind, "publish_failed");
  assert.ok(
    isWorkspaceBindingError(result.kind === "publish_failed" ? result.error : null),
    "the workspace binding has to be distinguishable from a NATS or template failure",
  );
});

test("D3 the binding is decided before the user's message is persisted", async () => {
  // The ordering is the fix. This turn gets a workspace and goes on to fail
  // later for want of a NATS connection, which is fine -- what is asserted is
  // that nothing was written before the answer to "may this run at all".
  const seen = stubDb((sql) => (BIND_LOOKUP.test(sql)
    ? {
      rows: [{
        workspace_id: "kws_1",
        owner_user_id: "u-1",
        storage_prefix: "users/u-1/sessions/s-1/",
        version: "0",
        writer_run_id: null,
        retention_expires_at: null,
        deleted_at: null,
      }],
      rowCount: 1,
    }
    : undefined));

  await dispatchTaskToBrain(INPUT, async () => {});

  const boundAt = seen.findIndex((q) => BIND_LOOKUP.test(q.sql));
  const persistedAt = seen.findIndex((q) => /INSERT INTO claw_session_events/.test(q.sql));
  assert.ok(boundAt >= 0, "the turn has to be bound to something");
  assert.ok(
    persistedAt > boundAt,
    "the user's message must not be written until the turn is known to be dispatchable",
  );
});

test("D4 a turn whose run row could not open does not publish", async () => {
  // The insert is best-effort at openChatRun, but publishing without the row
  // is how sessions sat at running with no lease and no deadline. Fail the
  // dispatch instead, so the caller can return the session to idle.
  stubDb((sql) => (BIND_LOOKUP.test(sql)
    ? {
      rows: [{
        workspace_id: "kws_1",
        owner_user_id: "u-1",
        storage_prefix: "users/u-1/sessions/s-1/",
        version: "0",
        writer_run_id: null,
        retention_expires_at: null,
        deleted_at: null,
      }],
      rowCount: 1,
    }
    : undefined));
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.openChatRun = (async () => null) as typeof sessionDispatchPorts.openChatRun;
  const published: string[] = [];
  sessionDispatchPorts.publishTask = async () => { published.push("task"); };

  let rolledBack = false;
  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(result.kind, "publish_failed");
  assert.equal(
    result.kind === "publish_failed" ? result.error.message : "",
    "chat_run.open_failed",
  );
  assert.deepEqual(published, [], "an untracked message is worse than a refused turn");
  assert.ok(rolledBack, "the session was marked running by the caller and has to go back");
});

function boundWorkspace() {
  return {
    rows: [{
      workspace_id: "kws_1",
      owner_user_id: "u-1",
      storage_prefix: "users/u-1/sessions/s-1/",
      version: "0",
      writer_run_id: null,
      retention_expires_at: null,
      deleted_at: null,
    }],
    rowCount: 1,
  };
}

test("D5 a doorbell hard refusal rolls the session back and does not open a row", async () => {
  const seen = stubDb((sql) => (BIND_LOOKUP.test(sql) ? boundWorkspace() : undefined));
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = true;
  sessionDispatchPorts.admit = async () => ({ kind: "reject", reason: "runs_hard_limit" });
  const published: string[] = [];
  sessionDispatchPorts.publishTask = async () => { published.push("task"); };
  let opened = 0;
  sessionDispatchPorts.openChatRun = (async () => {
    opened += 1;
    return { taskId: "ktsk_1" };
  }) as typeof sessionDispatchPorts.openChatRun;

  let rolledBack = false;
  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(result.kind, "rejected");
  assert.equal(result.kind === "rejected" ? result.reason : "", "runs_hard_limit");
  assert.equal(opened, 0);
  assert.deepEqual(published, []);
  assert.ok(rolledBack);
  assert.ok(
    seen.some((q) => /DELETE FROM claw_session_events/.test(q.sql) && q.params[0]),
    "a refused follow-up must not leave the UserMessage in history",
  );
});

test("D6 a doorbell soft queue returns a position and does not publish a wakeup", async () => {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  stubDb((sql) => (BIND_LOOKUP.test(sql) ? boundWorkspace() : undefined));
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = true;
  sessionDispatchPorts.admit = async () => ({ kind: "queue", position: 3 });
  const published: string[] = [];
  sessionDispatchPorts.publishTask = async () => { published.push("task"); };
  sessionDispatchPorts.openChatRun = (async () => ({ taskId: "ktsk_q" })) as typeof sessionDispatchPorts.openChatRun;

  const result = await dispatchTaskToBrain(INPUT, async () => {
    throw new Error("queued runs keep the session gate");
  });

  assert.equal(result.kind, "queued");
  assert.equal(result.kind === "queued" ? result.queuePosition : 0, 3);
  assert.equal(result.kind === "queued" ? result.runId : "", "ktsk_q");
  assert.deepEqual(published, []);
});

test("D7 a doorbell whose wakeup cannot be published closes the queued row", async () => {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  stubDb((sql) => (BIND_LOOKUP.test(sql) ? boundWorkspace() : undefined));
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = true;
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  sessionDispatchPorts.openChatRun = (async () => ({ taskId: "ktsk_1" })) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.publishTask = async () => { throw new Error("nats down"); };
  const failed: Array<string | null> = [];
  // true: this stub stands in for a close that succeeded, which is the case
  // this test is about. The row being closed is what makes the rollback right.
  sessionDispatchPorts.failChatRunDispatch = (async (taskId) => {
    failed.push(taskId);
    return "closed";
  }) as typeof sessionDispatchPorts.failChatRunDispatch;

  let rolledBack = false;
  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(result.kind, "publish_failed");
  assert.ok(failed.includes("ktsk_1"), "the queued row is the one that will never run");
  assert.ok(rolledBack);
});

test("D7b a failed wakeup does not roll back a run claim-next already claimed", async () => {
  // The other half of D7, and the whole reason the verdict has to travel: the
  // row was taken between the insert and the publish, so the close declines
  // and the turn is running. Rolling back here deletes the user's message and
  // answers 429, and the run then replies to a message that is gone.
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  stubDb((sql) => (BIND_LOOKUP.test(sql) ? boundWorkspace() : undefined));
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = true;
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  sessionDispatchPorts.openChatRun = (async () => ({ taskId: "ktsk_1" })) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.publishTask = async () => { throw new Error("nats down"); };
  sessionDispatchPorts.failChatRunDispatch = (async () => "held") as typeof sessionDispatchPorts.failChatRunDispatch;

  let rolledBack = false;
  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(result.kind, "dispatched", "the turn is running, so say so");
  assert.equal(rolledBack, false, "and leave the user's message where it is");
});

test("D8 the default path does not roll back a run a worker already holds", async () => {
  // The doorbell half of this is D7b. The fat path reached the same state --
  // a publish that timed out after delivery, a worker renewing the lease, a
  // compensation that declines -- and rolled back anyway, returning the
  // session to idle under a turn that was running.
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  stubDb((sql) => (BIND_LOOKUP.test(sql) ? boundWorkspace() : undefined));
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = false;
  sessionDispatchPorts.openChatRun = (async () => ({ taskId: "ktsk_1" })) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.publishTask = async () => { throw new Error("publish timed out"); };
  sessionDispatchPorts.failChatRunDispatch = (async () => "held") as typeof sessionDispatchPorts.failChatRunDispatch;

  let rolledBack = false;
  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(result.kind, "dispatched", "the turn is running, so say so");
  assert.equal(rolledBack, false, "and leave the user's message where it is");
});

test("D8 it still rolls back when the row really was closed", async () => {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  stubDb((sql) => (BIND_LOOKUP.test(sql) ? boundWorkspace() : undefined));
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = false;
  sessionDispatchPorts.openChatRun = (async () => ({ taskId: "ktsk_1" })) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.publishTask = async () => { throw new Error("nats down"); };
  sessionDispatchPorts.failChatRunDispatch = (async () => "closed") as typeof sessionDispatchPorts.failChatRunDispatch;

  let rolledBack = false;
  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(result.kind, "publish_failed");
  assert.ok(rolledBack, "nothing will execute it, so the turn is refused");
});

test("D9 a compensation that could not run rolls back rather than guessing", async () => {
  // `unknown`, not `held`. Nothing established that a worker has the row, so
  // the honest move is the rollback: it hands the session back. Treating this
  // as "a worker is running it" left the row at `preparing` with no lease --
  // invisible to every reaper, and occupying a fleet-wide admission slot.
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  stubDb((sql) => (BIND_LOOKUP.test(sql) ? boundWorkspace() : undefined));
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = false;
  sessionDispatchPorts.openChatRun = (async () => ({ taskId: "ktsk_1" })) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.publishTask = async () => { throw new Error("publish timed out"); };
  sessionDispatchPorts.failChatRunDispatch =
    (async () => "unknown") as typeof sessionDispatchPorts.failChatRunDispatch;

  let rolledBack = false;
  const result = await dispatchTaskToBrain(INPUT, async () => { rolledBack = true; });

  assert.equal(result.kind, "publish_failed");
  assert.ok(rolledBack, "the session is handed back, which is the one thing still in reach");
});
