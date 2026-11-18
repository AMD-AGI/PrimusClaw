// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every path that builds an execute request for a session hands Brain the session's placement.
 *
 * `claw_sessions.config.placement` only constrains a sandbox if the request that opens it
 * carries it, and a sandbox is opened again after an idle reclaim, by a queued message, by a
 * run reclaimed from its row, and by a task, DAG node or application run. So:
 *
 *   L1 a session with a placement sends exactly that placement, on every path
 *   L2 a session with none sends no `placement` field at all (a run's persisted spec is
 *      byte-identical to what it was before the field existed)
 *   L3 a stored value that fails the check is still sent, for Brain to refuse: dropping it
 *      would put the sandbox on nodes the session excluded
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
    "resources JSONB", "timeout INTEGER", "topology JSONB", "tools_allowlist JSONB",
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
  /** What `claw_sessions.config.placement` holds when the turn is sent; undefined leaves the key out. */
  placement: unknown;
}

async function setPlacement(placement: unknown): Promise<void> {
  const config = placement === undefined ? {} : { placement };
  await h.sql("UPDATE claw_sessions SET config = $1::jsonb WHERE session_id = $2", [JSON.stringify(config), SESSION]);
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
  await setPlacement(s.placement);
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
  await setPlacement(s.placement);
  await h.sql(
    "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, 'ls /tmp')",
    [SESSION, OWNER],
  );
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

  // The turn in front has ended and handed the session back: a drain only runs on a free session.
  await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [SESSION]);
  await drainOldestPendingMessage(SESSION, OWNER);

  if (doorbell) {
    assert.equal(opened.length, 1, "the queued message was not dispatched");
    return await reclaimed(opened[0]!.spec as Record<string, unknown>);
  }
  assert.equal(published.length, 1, "the queued message was not published");
  return JSON.parse(published[0]!) as Request;
}

// --- a task, DAG node or application run ------------------------------------------

const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");

async function task(s: Scenario): Promise<Request> {
  const now = new Date().toISOString();
  const row = {
    task_id: "t-1", session_id: SESSION, status: "preparing", mode: "script", prompt: "", input: {},
    plugin_id: null, sandbox_spec: "none", dag_root_task_id: null, started_at: now, created_at: now,
  };
  const config = s.placement === undefined ? {} : { placement: s.placement };
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) return { rows: [{ user_id: OWNER, config }], rowCount: 1 };
    if (/^UPDATE claw_tasks SET/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/claw_workspace/.test(sql)) {
      return { rows: [{ workspace_id: "kws_1", storage_prefix: `users/${OWNER}/sessions/${SESSION}/` }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const published: Request[] = [];
  const originalPublish = taskPublisher.publish;
  taskPublisher.publish = (async (payload: string) => { published.push(JSON.parse(payload) as Request); }) as typeof taskPublisher.publish;
  try {
    await dispatchTask("t-1");
  } finally {
    taskPublisher.publish = originalPublish;
  }
  assert.equal(published.length, 1, "the task was not dispatched");
  return published[0]!;
}

const PATHS: Array<{ name: string; queued: boolean; run: (s: Scenario) => Promise<Request> }> = [
  { name: "task or DAG node", queued: false, run: (s) => task(s) },
  { name: "immediate dispatch, published directly", queued: false, run: (s) => immediate(false, s) },
  { name: "immediate dispatch, reclaimed from its row", queued: false, run: (s) => immediate(true, s) },
  { name: "queued message, published directly", queued: true, run: (s) => queued(false, s) },
  { name: "queued message, reclaimed from its row", queued: true, run: (s) => queued(true, s) },
];

const PLACEMENT = { nodeLabels: { "autopilot.amd.com/preemptible": "false", "example.com/pool": "reserved" } };

for (const path of PATHS) {
  test(`L1 ${path.name}: a session with a placement sends exactly that placement`, async () => {
    const request = await path.run({ placement: PLACEMENT });
    assert.deepEqual(request.placement, PLACEMENT);
  });

  test(`L2 ${path.name}: a session with no placement sends no placement field`, async () => {
    for (const placement of [undefined, null, {}]) {
      await h.reset();
      const request = await path.run({ placement });
      assert.equal("placement" in request, false, `placement leaked as ${JSON.stringify(request.placement)}`);
    }
  });

  test(`L3 ${path.name}: a stored value that fails the check is sent as stored, for Brain to refuse`, async () => {
    const bad = { nodeLabels: { "kubernetes.io/hostname": "node-1" } };
    const request = await path.run({ placement: bad });
    assert.deepEqual(request.placement, bad);
  });
}

test("L4 a deployment that does not create sandboxes through SaFE refuses a placement rather than ignore it", async () => {
  db.query = pgQuery;
  const Fastify = (await import("fastify")).default;
  const { registerSessionRoutes } = await import("../src/routes/sessions.js");
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: unknown }).user = { userId: OWNER, userName: OWNER, roles: ["default"], virtualKey: "vk" };
  });
  await registerSessionRoutes(app);
  await app.ready();
  try {
    const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "k8s", placement: PLACEMENT } });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as { error: string }).error, "placement is supported only when sandboxes are created through SaFE");
    assert.equal(Number((await h.sql("SELECT count(*)::int AS n FROM claw_sessions"))[0].n), 0);
    const plain = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "k8s" } });
    assert.equal(plain.statusCode, 200, plain.body);
  } finally {
    await app.close();
  }
});
