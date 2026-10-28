// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every path that dispatches a chat turn hands Brain the session's model.
 *
 * `claw_sessions.model` is only a choice until a turn carries it: Brain takes the
 * model of a run from the execute request, so a path that builds that request
 * without reading the session runs the deployment's default whatever the owner
 * picked. The immediate dispatch and the queue drain build it separately, and each
 * runs either published directly or as a doorbell row that a worker hydrates later,
 * so the same three questions are asked of all four:
 *
 *   M1 a session that chose a model sends exactly that name
 *   M2 a session that chose none sends no `model` field at all
 *   M3 the model is the one the session has when the turn is sent on, not when the
 *      message was accepted: a message parked behind a running turn picks up a
 *      change made while it waited, and a cleared choice leaves it with none
 *
 * The doorbell variants are read back through the real claim, because what a
 * resumed or late-claimed run is given is what its row holds.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Harness } from "./scenario-harness.js";

process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS = "500";
process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.LLM_KEY_SOURCE = "virtualKey";

const { db, MarketplaceDb } = await import("../src/infra/db.js");
const { dispatchTaskToBrain, sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
const { drainOldestPendingMessage } = await import("../src/events/consumer.js");
const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
const { claimRunById } = await import("../src/tasks/run-claim.js");
const { startHarness, seedSession, seedRun } = await import("./scenario-harness.js");
const { openDoorbellBarrier, closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");

const OWNER = "u-owner";
const SESSION = "s-1";

type MarketplaceMethods = Pick<typeof MarketplaceDb, "resourceFirstByType">;
const originalMarketplace: MarketplaceMethods = {
  resourceFirstByType: MarketplaceDb.resourceFirstByType,
};

let h: Harness;
let pgQuery: typeof db.query;
const originalSessionPorts = { ...sessionDispatchPorts };
const originalPendingPorts = { ...pendingDispatchPorts };

before(async () => {
  h = await startHarness();
  pgQuery = db.query;
  // The columns a queued message carries, which the harness's copy of the table
  // leaves out; added here, where the drain is the subject.
  for (const column of [
    "plugin_id INTEGER", "tool_ids JSONB DEFAULT '[]'::jsonb", "workspace_id TEXT",
    "platform_key TEXT", "llm_api_key TEXT", "credentials_blob TEXT", "image TEXT",
    "resources JSONB", "timeout INTEGER", "topology JSONB",
    "bind_attempts INTEGER NOT NULL DEFAULT 0",
    "user_env JSONB DEFAULT '{}'::jsonb", "session_env JSONB DEFAULT '{}'::jsonb",
  ]) {
    await h.sql(`ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS ${column}`);
  }
});
beforeEach(async () => {
  db.query = pgQuery;
  Object.assign(sessionDispatchPorts, originalSessionPorts);
  Object.assign(pendingDispatchPorts, originalPendingPorts);
  Object.assign(MarketplaceDb, originalMarketplace);
  MarketplaceDb.resourceFirstByType = (async () => null) as typeof MarketplaceDb.resourceFirstByType;
  await h.reset();
});
after(async () => {
  db.query = pgQuery;
  Object.assign(sessionDispatchPorts, originalSessionPorts);
  Object.assign(pendingDispatchPorts, originalPendingPorts);
  Object.assign(MarketplaceDb, originalMarketplace);
  await h?.close();
});

/** What a path hands Brain: the execute request, as Brain would receive it. */
type Request = Record<string, unknown>;

interface Scenario {
  /** The session's model when the turn is accepted; null is no choice. */
  model: string | null;
  /** Written to the session after the turn was accepted and before it is sent on. */
  changeTo?: { model: string | null };
}

async function setModel(model: string | null): Promise<void> {
  await h.sql("UPDATE claw_sessions SET model = $1 WHERE session_id = $2", [model, SESSION]);
}

/** A run reclaimed from the spec its row holds: what a late-claimed doorbell run is given. */
async function reclaimed(spec: Record<string, unknown>): Promise<Request> {
  db.query = pgQuery;
  await h.sql("DELETE FROM claw_tasks WHERE task_id = 'run-1'");
  await seedRun(h, "run-1", SESSION, { spec, prompt: "ls /tmp", status: "queued" });
  const claimed = await claimRunById("run-1", "brain-1");
  assert.ok(
    typeof claimed === "object" && "request" in claimed,
    `the stored spec could not be claimed: ${JSON.stringify(claimed)}`,
  );
  return claimed.request as unknown as Request;
}

// --- the immediate dispatch ---------------------------------------------------------

async function immediate(doorbell: boolean, s: Scenario): Promise<Request> {
  await seedSession(h, SESSION, { userId: OWNER });
  await setModel(s.model);
  if (s.changeTo) await setModel(s.changeTo.model);
  const published: string[] = [];
  const opened: Array<Record<string, unknown>> = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/FROM claw_workspace_refs r/.test(text)) {
      return {
        rows: [{ workspace_id: "workspace-1", storage_prefix: "files/", writer_run_id: null }],
        rowCount: 1,
      };
    }
    // The session row is the subject, so it is read for real. Everything else the
    // dispatch reads (turns, skills, memory) is empty here.
    return /^\s*(INSERT|UPDATE|DELETE)/i.test(text) || /FROM claw_sessions/.test(text)
      ? pgQuery(text, params)
      : { rows: [], rowCount: 0 };
  }) as typeof db.query;
  sessionDispatchPorts.doorbellDispatch = doorbell ? openDoorbellBarrier : closedDoorbellBarrier;
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.openChatRun = (async (args: Record<string, unknown>) => {
    opened.push(args);
    return { taskId: "run-1" };
  }) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    published.push(payload);
    return published.length;
  };
  sessionDispatchPorts.failChatRunDispatch = async () => "closed";
  sessionDispatchPorts.recordPublishState = async () => {};
  sessionDispatchPorts.recordDispatchSeq = async () => {};
  sessionDispatchPorts.noteRefusedPublish = async () => {};

  const result = await dispatchTaskToBrain(
    {
      sessionId: SESSION, userId: OWNER, user: null, content: "ls /tmp", messageType: "text",
      toolIds: [], pluginId: undefined, requestImage: undefined, requestResource: undefined,
      requestTimeout: undefined, workspaceId: undefined, mcpServers: undefined,
      capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
    },
    async () => assert.fail("unexpected rollback"),
  );
  assert.equal(result.kind, "dispatched");
  if (doorbell) {
    assert.equal(opened.length, 1);
    return await reclaimed(opened[0]!.spec as Record<string, unknown>);
  }
  assert.equal(published.length, 1, "the turn was not published");
  return JSON.parse(published[0]!) as Request;
}

// --- a message that arrived while the previous turn was running ---------------------

async function queued(doorbell: boolean, s: Scenario): Promise<Request> {
  await seedSession(h, SESSION, { userId: OWNER });
  await setModel(s.model);
  await h.sql(
    "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, 'ls /tmp')",
    [SESSION, OWNER],
  );
  // The turn that was running ends, and the message is sent on. Whatever the
  // owner changed in between is what it should be sent on.
  if (s.changeTo) await setModel(s.changeTo.model);
  const published: string[] = [];
  const opened: Array<Record<string, unknown>> = [];
  // The direct publish records its receipt on the run row, and the row here is
  // whatever the stubbed `openChatRun` below answers with, not one that exists.
  db.query = (async (text: string, params: unknown[] = []) => (
    /^\s*UPDATE claw_tasks/.test(text) ? { rows: [], rowCount: 1 } : pgQuery(text, params)
  )) as typeof db.query;
  pendingDispatchPorts.doorbellDispatch = doorbell ? openDoorbellBarrier : closedDoorbellBarrier;
  pendingDispatchPorts.admit = async () => ({ kind: "admit" });
  pendingDispatchPorts.bindWorkspace = (async () => "kws_1") as typeof pendingDispatchPorts.bindWorkspace;
  pendingDispatchPorts.requireWorkspaceBinding =
    ((workspaceId?: string) => workspaceId as string) as typeof pendingDispatchPorts.requireWorkspaceBinding;
  pendingDispatchPorts.publishSessionEvent =
    (async () => {}) as unknown as typeof pendingDispatchPorts.publishSessionEvent;
  pendingDispatchPorts.openChatRun = (async (args: Record<string, unknown>) => {
    opened.push(args);
    return { taskId: "run-1", workspaceId: "kws_1", lease: { url: "http://api/lease", token: "t0ken" } };
  }) as unknown as typeof pendingDispatchPorts.openChatRun;
  pendingDispatchPorts.publish = (async (_subject: string, payload: string) => {
    published.push(payload);
    return published.length;
  }) as typeof pendingDispatchPorts.publish;

  await drainOldestPendingMessage(SESSION, OWNER);

  if (doorbell) {
    assert.equal(opened.length, 1, "the queued message was not dispatched");
    return await reclaimed(opened[0]!.spec as Record<string, unknown>);
  }
  assert.equal(published.length, 1, "the queued message was not published");
  return JSON.parse(published[0]!) as Request;
}

const PATHS: Array<{ name: string; queued: boolean; run: (s: Scenario) => Promise<Request> }> = [
  { name: "immediate dispatch, published directly", queued: false, run: (s) => immediate(false, s) },
  { name: "immediate dispatch, reclaimed from its row", queued: false, run: (s) => immediate(true, s) },
  { name: "queued message, published directly", queued: true, run: (s) => queued(false, s) },
  { name: "queued message, reclaimed from its row", queued: true, run: (s) => queued(true, s) },
];

for (const path of PATHS) {
  test(`M1 ${path.name}: a session that chose a model sends exactly that name`, async () => {
    const request = await path.run({ model: "claude-sonnet-5.5" });
    assert.equal(request.model, "claude-sonnet-5.5");
  });

  test(`M2 ${path.name}: a session that chose none sends no model field`, async () => {
    const request = await path.run({ model: null });
    assert.equal("model" in request, false, `model leaked as ${JSON.stringify(request.model)}`);
  });
}

for (const path of PATHS.filter((p) => p.queued)) {
  test(`M3 ${path.name}: sent on the model the session has now, not the one it had when parked`, async () => {
    const changed = await path.run({ model: "first-model", changeTo: { model: "second-model" } });
    assert.equal(changed.model, "second-model");
  });

  test(`M3 ${path.name}: a choice cleared while it waited leaves it with none`, async () => {
    await h.reset();
    const cleared = await path.run({ model: "first-model", changeTo: { model: null } });
    assert.equal("model" in cleared, false);
  });

  test(`M3 ${path.name}: a choice made while it waited applies`, async () => {
    await h.reset();
    const chosen = await path.run({ model: null, changeTo: { model: "late-model" } });
    assert.equal(chosen.model, "late-model");
  });
}
