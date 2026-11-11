// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `submitSessionMessage` in the mode the route uses: the decision made under
 * the session row's lock, as the statements it issues show it.
 *
 * The route tests (session-run-id-response and the publish suites) drive the
 * same paths through HTTP and are unchanged by the extraction; these ask the
 * function directly, so a later caller that is not an HTTP request is held to
 * the same contract.
 *
 * Coverage:
 *   X1  an idle session: the gate is taken inside the lock's transaction, then
 *       the message is dispatched and the answer names the run
 *   X2  a running session: the message is parked, the gate is not touched and
 *       nothing is dispatched
 *   X3  a caller that has gone away after the gate was taken gets the gate
 *       back and nothing is dispatched
 *   X4  a publish that failed is reported as such, with the gate handed back
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { sessionDispatchPorts } from "../src/sessions/dispatch.js";
import { submitSessionMessage, type SubmitSessionMessageInput } from "../src/sessions/submit-message.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";
import { stubDb, type Answer, type DbStub } from "./support/db-stub.js";

const SID = "sess-1";
const CALLER: UserInfo = {
  userId: "u-caller", userName: "u-caller", roles: ["default"], platformKey: "pk", virtualKey: "vk-caller",
};
const OPENED_RUN = "ktsk_opened";

const originalPorts = { ...sessionDispatchPorts };
const originalLockConnect = db.lockPool.connect;
let dbStub: DbStub | null = null;
let published: string[] = [];

afterEach(() => {
  Object.assign(sessionDispatchPorts, originalPorts);
  db.lockPool.connect = originalLockConnect;
  dbStub?.restore();
  dbStub = null;
});

function stubFor(agentStatus: "idle" | "running", extra?: Answer): DbStub {
  dbStub = stubDb((sql, params) => {
    if (/FROM claw_workspace_refs r/.test(sql)) {
      return [{
        workspace_id: "kws_1", owner_user_id: CALLER.userId,
        storage_prefix: `users/${CALLER.userId}/sessions/${SID}/`, version: "0",
        writer_run_id: null, retention_expires_at: null, deleted_at: null,
      }];
    }
    if (/FROM claw_sessions WHERE session_id = \$1 AND deleted_at IS NULL FOR UPDATE/.test(sql)) {
      return [{ agent_status: agentStatus, user_id: CALLER.userId }];
    }
    return extra?.(sql, params) ?? [];
  });
  return dbStub;
}

function dispatchOpensRun(publishTask?: () => Promise<void>): void {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  published = [];
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.openChatRun =
    (async () => ({ taskId: OPENED_RUN })) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.recordPublishState = async () => {};
  sessionDispatchPorts.recordDispatchSeq = async () => {};
  sessionDispatchPorts.noteRefusedPublish = async () => {};
  sessionDispatchPorts.failChatRunDispatch =
    (async () => {}) as typeof sessionDispatchPorts.failChatRunDispatch;
  sessionDispatchPorts.publishTask = async (subject: string) => {
    if (publishTask) await publishTask();
    published.push(subject);
    return published.length;
  };
}

const message = (over: Partial<SubmitSessionMessageInput> = {}): SubmitSessionMessageInput => ({
  sessionId: SID, userId: CALLER.userId, user: CALLER,
  content: "hello", messageType: "text", toolIds: [], sessionEnv: {},
  ...over,
}) as SubmitSessionMessageInput;

const gateWrites = (stub: DbStub) => stub.seen.filter(
  (q) => /^UPDATE claw_sessions SET agent_status/.test(q.sql),
);

test("X1 an idle session: the gate is taken inside the lock's transaction, then the message is dispatched", async () => {
  dispatchOpensRun();
  const stub = stubFor("idle");

  const result = await submitSessionMessage(message());

  assert.equal(result.kind, "dispatched");
  if (result.kind !== "dispatched") return;
  assert.equal(result.runId, OPENED_RUN, "the answer names the run the dispatch opened");
  assert.ok(result.messageId.startsWith("claw-"), "and the turn it gated is the turn it dispatched");
  assert.deepEqual(published, ["tasks.execute"]);

  const lock = stub.seen.findIndex((q) => /FOR UPDATE/.test(q.sql));
  const take = stub.seen.findIndex((q) => /^UPDATE claw_sessions SET agent_status = \$3/.test(q.sql));
  const commit = stub.seen.findIndex((q) => q.sql === "COMMIT");
  assert.ok(lock > 0 && take > lock && commit > take, "lock, then gate, then commit");
  assert.equal(stub.seen[lock].conn, stub.seen[take].conn, "the gate is taken on the lock's own connection");
  assert.equal(stub.seen[lock].conn, stub.seen[commit].conn);
  assert.ok(!stub.ran(/INSERT INTO claw_pending_messages/), "an idle session queues nothing");
});

test("X2 a running session: the message is parked, the gate is not touched and nothing is dispatched", async () => {
  dispatchOpensRun();
  // The queued row names plugin 9, which the insert holds (and finds) first.
  const stub = stubFor("running", (sql) => (/FROM plugins WHERE id = \$1/.test(sql) ? [{ "?column?": 1 }] : undefined));

  const result = await submitSessionMessage(message({ pluginId: 9 }));

  assert.deepEqual(
    { kind: result.kind, ...(result.kind === "queued" ? { drain: result.drain } : {}) },
    { kind: "queued", drain: "awaiting_turn" },
  );
  const insert = stub.seen.find((q) => /INSERT INTO claw_pending_messages/.test(q.sql));
  assert.ok(insert, "parked on the queue");
  assert.ok(!/dedupe_key/.test(insert.sql), "a keyless insert names no key column");
  assert.equal(insert.params[0], SID);
  assert.equal(insert.params[1], "hello");
  assert.equal(insert.params[3], 9, "the plugin travels with the row");
  assert.equal(gateWrites(stub).length, 0, "the running turn keeps its gate");
  assert.deepEqual(published, [], "nothing is dispatched behind a running turn");
});

test("X3 a caller that has gone away after the gate was taken gets the gate back and nothing is dispatched", async () => {
  dispatchOpensRun();
  const stub = stubFor("idle");

  const result = await submitSessionMessage(message({ isCancelled: () => true }));

  assert.equal(result.kind, "client_gone");
  assert.deepEqual(published, [], "no turn is started for a request nobody is waiting on");
  const writes = gateWrites(stub);
  assert.equal(writes.length, 2, "taken, then handed back");
  assert.match(writes[1].sql, /SET agent_status = \$2, agent_gate_message_id = NULL/);
});

test("X4 a publish that failed is reported as such, with the gate handed back", async () => {
  dispatchOpensRun(async () => { throw new Error("stream unavailable"); });
  const stub = stubFor("idle");

  const result = await submitSessionMessage(message());

  assert.equal(result.kind, "dispatch_failed");
  if (result.kind !== "dispatch_failed") return;
  assert.ok(result.messageId.startsWith("claw-"));
  assert.ok(result.error instanceof Error);
  assert.ok(gateWrites(stub).length >= 2, "the gate taken for the turn is given back for it");
});
