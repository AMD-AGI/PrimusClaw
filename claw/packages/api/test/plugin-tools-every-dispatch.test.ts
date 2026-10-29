// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every path that dispatches a turn under a plugin hands Brain the plugin's tools.
 *
 * Brain expands `plugin_tools` into the run's MCP servers, skills, rules and
 * bash approval rules. A message that names `plugin_id` and carries no list is
 * read as "the plugin's rules are unknown", so the run loads nothing from the
 * plugin and every bash command is held. Only the immediate dispatch attached
 * the list; a message sent while the previous turn was still running (the queue
 * drain) and a task-system agent run named the plugin and left it out.
 *
 * One table of the ways a turn reaches Brain, and the same three questions asked
 * of each:
 *
 *   T1 the request Brain receives carries the plugin's tools, equal to the ones
 *      the immediate dispatch attaches
 *   T2 a plugin the session owner may not see arrives as null, never as its tools
 *   T3 a turn that names no plugin carries neither field
 *
 * "Resume" is the doorbell rows: a run that is reclaimed (after an interrupt, a
 * roll, a second claim) is hydrated from the spec stored on its row, so what the
 * row holds is what a resumed run gets. Those paths are read back through the
 * real claim.
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
const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");
const { claimRunById } = await import("../src/tasks/run-claim.js");
const { startHarness, seedSession, seedRun } = await import("./scenario-harness.js");
const { openDoorbellBarrier, closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");

const OWNER = "u-owner";
const STRANGER = "u-stranger";
const PLUGIN_ID = 7;
const SESSION = "s-1";

// Written out rather than derived from the production formatter, so a change
// to what the immediate path attaches is a change to this file as well.
const TOOL_CONFIG = {
  mcpServers: { files: { url: "http://mcp.invalid/files" } },
  bash_approval: [{ label: "no rm", regex: "\\brm\\b" }],
};
const EXPECTED_TOOLS = [
  { id: 11, type: "mcp", name: "files-tool", description: "file access", config: TOOL_CONFIG },
];

type MarketplaceMethods = Pick<
  typeof MarketplaceDb, "pluginGetById" | "toolsGetByIds" | "resourceFirstByType"
>;
const originalMarketplace: MarketplaceMethods = {
  pluginGetById: MarketplaceDb.pluginGetById,
  toolsGetByIds: MarketplaceDb.toolsGetByIds,
  resourceFirstByType: MarketplaceDb.resourceFirstByType,
};

/** The one plugin every path is asked about; `ownedBy` decides who may see it. */
function stubPlugin(ownedBy: string, opts: { isPublic?: boolean; throws?: boolean } = {}): void {
  MarketplaceDb.pluginGetById = (async (id: number) => {
    if (opts.throws) throw new Error("marketplace unavailable");
    return id === PLUGIN_ID
      ? {
        id: PLUGIN_ID, name: "plugin", version: "1", images: [], resource: {},
        tools: [{ id: 11 }], owner_user_id: ownedBy, is_public: opts.isPublic ?? false,
      }
      : null;
  }) as typeof MarketplaceDb.pluginGetById;
  MarketplaceDb.toolsGetByIds = (async () => [
    { id: 11, type: "mcp", name: "files-tool", description: "file access", config: TOOL_CONFIG },
  ]) as typeof MarketplaceDb.toolsGetByIds;
  MarketplaceDb.resourceFirstByType = (async () => null) as typeof MarketplaceDb.resourceFirstByType;
}

let h: Harness;
let pgQuery: typeof db.query;
const originalSessionPorts = { ...sessionDispatchPorts };
const originalPendingPorts = { ...pendingDispatchPorts };
const originalPublish = taskPublisher.publish;

before(async () => {
  h = await startHarness();
  pgQuery = db.query;
  // The columns a queued message carries, which the harness's copy of the table
  // leaves out. Added here, where the drain is the subject, rather than to the
  // shared DDL that every other scenario reads.
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
  taskPublisher.publish = originalPublish;
  await h.reset();
});
after(async () => {
  db.query = pgQuery;
  Object.assign(sessionDispatchPorts, originalSessionPorts);
  Object.assign(pendingDispatchPorts, originalPendingPorts);
  Object.assign(MarketplaceDb, originalMarketplace);
  taskPublisher.publish = originalPublish;
  await h?.close();
});

/** What a path hands Brain: the execute request, as Brain would receive it. */
type Request = Record<string, unknown>;

interface Scenario {
  /** The plugin the turn names; undefined is a turn that names none. */
  pluginId: number | undefined;
}

/** A run reclaimed from the spec its row holds: what a resumed doorbell run is given. */
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

// --- the immediate dispatch (the path every other one is measured against) ---------

async function immediate(doorbell: boolean, s: Scenario): Promise<Request> {
  await seedSession(h, SESSION, { userId: OWNER });
  const published: string[] = [];
  const opened: Array<Record<string, unknown>> = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/FROM claw_workspace_refs r/.test(text)) {
      return {
        rows: [{ workspace_id: "workspace-1", storage_prefix: "files/", writer_run_id: null }],
        rowCount: 1,
      };
    }
    // Everything else the dispatch reads (turns, skills, memory) is empty here.
    return /^\s*(INSERT|UPDATE|DELETE)/i.test(text) ? pgQuery(text, params) : { rows: [], rowCount: 0 };
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
      toolIds: [], pluginId: s.pluginId, requestImage: undefined, requestResource: undefined,
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

// --- a message that arrived while the previous turn was running --------------------

async function queued(doorbell: boolean, s: Scenario): Promise<Request> {
  await seedSession(h, SESSION, { userId: OWNER });
  await h.sql(
    `INSERT INTO claw_pending_messages (session_id, user_id, content, plugin_id)
     VALUES ($1, $2, 'ls /tmp', $3)`,
    [SESSION, OWNER, s.pluginId ?? null],
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

  await drainOldestPendingMessage(SESSION, OWNER);

  if (doorbell) {
    assert.equal(opened.length, 1, "the queued message was not dispatched");
    return await reclaimed(opened[0]!.spec as Record<string, unknown>);
  }
  assert.equal(published.length, 1, "the queued message was not published");
  return JSON.parse(published[0]!) as Request;
}

// --- a task-system run (DAG node, workbench, POST /tasks) -------------------------

async function taskSystem(mode: string, s: Scenario): Promise<Request> {
  const now = new Date().toISOString();
  const row = {
    task_id: "t-1", session_id: SESSION, status: "preparing", mode, prompt: "ls /tmp", input: {},
    plugin_id: s.pluginId ?? null, sandbox_spec: "none", dag_root_task_id: null,
    started_at: now, created_at: now,
  };
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) {
      return {
        rows: [{ user_id: OWNER, config: { platform_key: "pk-1", _server_managed_credentials: true } }],
        rowCount: 1,
      };
    }
    if (/^UPDATE claw_tasks SET/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/claw_workspace/.test(sql)) {
      return { rows: [{ workspace_id: "kws_1", storage_prefix: "users/u/sessions/s/" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const published: string[] = [];
  taskPublisher.publish = (async (payload: string) => { published.push(payload); }) as typeof taskPublisher.publish;

  const result = await dispatchTask("t-1");
  assert.equal(result.ok, true, `the task was not dispatched: ${JSON.stringify(result)}`);
  assert.equal(published.length, 1);
  return JSON.parse(published[0]!) as Request;
}

const PATHS: Array<{ name: string; run: (s: Scenario) => Promise<Request> }> = [
  { name: "immediate dispatch, published directly", run: (s) => immediate(false, s) },
  { name: "immediate dispatch, reclaimed from its row", run: (s) => immediate(true, s) },
  { name: "queued message, published directly", run: (s) => queued(false, s) },
  { name: "queued message, reclaimed from its row (resume)", run: (s) => queued(true, s) },
  { name: "task-system agent run", run: (s) => taskSystem("llm", s) },
];

for (const path of PATHS) {
  test(`T1 ${path.name}: carries the plugin's tools, equal to the immediate dispatch's`, async () => {
    stubPlugin(OWNER);
    const request = await path.run({ pluginId: PLUGIN_ID });
    assert.equal(request.plugin_id, PLUGIN_ID);
    assert.deepEqual(request.plugin_tools, EXPECTED_TOOLS);

    // And equal to what the reference path sends for the same plugin, which is
    // the statement being made: no path has a list of its own.
    await h.reset();
    const reference = await immediate(false, { pluginId: PLUGIN_ID });
    assert.deepEqual(request.plugin_tools, reference.plugin_tools);
  });

  test(`T2 ${path.name}: a plugin the owner cannot see is null, not its tools`, async () => {
    stubPlugin(STRANGER, { isPublic: false });
    const request = await path.run({ pluginId: PLUGIN_ID });
    assert.equal(request.plugin_id, PLUGIN_ID);
    assert.equal(request.plugin_tools, null);
    assert.ok(!JSON.stringify(request).includes("mcp.invalid"), "the private plugin's config reached the message");
  });
}

for (const path of PATHS.filter((p) => !p.name.startsWith("task-system"))) {
  test(`T3 ${path.name}: a turn with no plugin names none and carries no list`, async () => {
    stubPlugin(OWNER);
    const request = await path.run({ pluginId: undefined });
    assert.equal(request.plugin_id, undefined);
    assert.equal("plugin_tools" in request, false);
  });
}

test("T3 task-system agent run: a row with no plugin names none and carries no list", async () => {
  stubPlugin(OWNER);
  const request = await taskSystem("llm", { pluginId: undefined });
  assert.equal(request.plugin_id, undefined);
  assert.equal("plugin_tools" in request, false);
});

test("T4 task-system runs that are not agent runs do not carry the plugin's config", async () => {
  // A script run is told each step's scope when it is rendered and an app run is
  // dispatched as admitted; neither reads the list, and it holds server config.
  stubPlugin(OWNER);
  for (const mode of ["script", "app"]) {
    const request = await taskSystem(mode, { pluginId: PLUGIN_ID });
    assert.equal(request.plugin_id, PLUGIN_ID, mode);
    assert.equal("plugin_tools" in request, false, `${mode} run carries plugin_tools`);
  }
});

for (const path of PATHS.filter((p) => /queued message, published|task-system/.test(p.name))) {
  test(`T5 ${path.name}: a plugin that cannot be read at dispatch fails closed, not open`, async () => {
    // null is what Brain holds bash on. Absent would say the turn named no
    // plugin, and an empty list would say the plugin declares no rules.
    stubPlugin(OWNER, { throws: true });
    const request = await path.run({ pluginId: PLUGIN_ID });
    assert.equal(request.plugin_id, PLUGIN_ID);
    assert.equal(request.plugin_tools, null);
  });
}
