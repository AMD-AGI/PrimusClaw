// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a turn that Brain is handed says about the sandbox's keys, for a session that acts as a user (`withhold_sandbox_keys`): the keys
 * the model could print out of its sandbox are the session owner's, and the model of such a session reads what strangers wrote. Brain
 * keeps the keys for its own calls and puts none in the sandbox (brain/test/ensure-hands-acting-session-keys*.test.ts); here is what
 * tells it to, on each of the ways a turn reaches Brain from a stored session.
 *
 * The first turn and the tools of the session are github-review-session.test.ts (T6-T8), and a message to it is
 * github-review-acting-turns.test.ts. What is here:
 *   D1  a turn claimed from the queue (the doorbell path) is marked from the live row at the claim, and its keys are still handed to Brain
 *   D2  a task of a DAG (the scheduler's dispatch) is marked from the session's stored config, and its key is still handed to Brain
 *   D3  each place that hands Brain a turn for a stored session decides the sandbox's keys
 *   D4  a hosted application's sandbox is made with the owner's keys, so none is made for such a session
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

process.env.CLAW_GITHUB_REVIEW_ENABLED = "true";
process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = "t".repeat(40);
process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS = "200";
process.env.CLAW_DEPLOY_MODE = "safe";

const { db } = await import("../src/infra/db.js");
const { initUserEnvCrypto } = await import("../src/crypto/user-env.js");
const { registerInternalRunRoutes } = await import("../src/routes/internal-runs.js");
const { runClaimPorts } = await import("../src/tasks/run-claim.js");
const { sealRunCredentials } = await import("../src/tasks/run-secrets.js");
const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");
const { checkAppRunRequest, appRunPorts } = await import("../src/tasks/app-run.js");

const TOKEN = "cluster-internal-token";
const originalQuery = db.query;
const originalConnect = db.pool.connect;
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;
const originalHistory = runClaimPorts.buildHistory;
let app: FastifyInstance;
let blob: string;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  blob = sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" });
  app = Fastify();
  await registerInternalRunRoutes(app);
  await app.ready();
  db.pool.connect = (async () => ({ query: (text: string, params?: unknown[]) => db.query(text, params), release: () => {} })) as never;
  runClaimPorts.buildHistory = (async () => []) as typeof runClaimPorts.buildHistory;
});
after(async () => {
  db.query = originalQuery;
  db.pool.connect = originalConnect;
  runClaimPorts.buildHistory = originalHistory;
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN; else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app.close();
});

/** What the session's stored `acting_as` is, for the three shapes that matter: one that names a user, one that is not an id, and none. */
const ACTING: Array<[string, unknown, boolean]> = [
  ["a session that acts as a user", "u-bob", true],
  ["an acting_as that is not a well-formed id is an ordinary session", "has space", false],
  ["no acting_as", undefined, false],
];

async function claim(actingAs: unknown): Promise<{ request: Record<string, unknown>; asked: string[] }> {
  const asked: string[] = [];
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    asked.push(sql);
    if (/UPDATE claw_tasks/.test(sql)) {
      return { rows: [{ task_id: "ktsk_1", session_id: "s-1", status: "preparing", deadline_at: null, input: { prompt: "hello", session_id: "s-1", user_id: "u-1", credentials: blob } }], rowCount: 1 };
    }
    if (/SELECT config->'acting_as' AS acting_as FROM claw_sessions/.test(sql)) return { rows: actingAs === undefined ? [{ acting_as: null }] : [{ acting_as: actingAs }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const res = await app.inject({ method: "POST", url: "/v1/internal/tasks/ktsk_1/claim", headers: { authorization: `Bearer ${TOKEN}` }, payload: { brain_id: "brain-7" } });
  assert.equal(res.statusCode, 200, res.body);
  return { request: res.json().request as Record<string, unknown>, asked };
}

test("D1 a turn claimed from the queue is marked for a session that acts as a user, from the live row, and its keys still go to Brain", async () => {
  for (const [what, actingAs, marked] of ACTING) {
    const { request } = await claim(actingAs);
    assert.equal(request.withhold_sandbox_keys, marked ? true : undefined, what);
    assert.equal(request.effort, marked ? "high" : undefined, `${what}: a review runs at the review's effort`);
    assert.equal(request.platform_key, "pk-live", `${what}: Brain still needs the key for the model and for SaFE`);
    assert.equal(request.llm_api_key, "sk-live", what);
  }
});

const NOW = new Date().toISOString();
const taskRow = () => ({
  task_id: "t-1", session_id: "s-1", status: "preparing", mode: "script", prompt: "", input: {}, plugin_id: null, sandbox_spec: "none",
  dag_root_task_id: null, started_at: NOW, created_at: NOW,
});

async function dispatchDag(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) return { rows: [{ user_id: "u-1", config }], rowCount: 1 };
    if (/^UPDATE claw_tasks/.test(sql) || /FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) return { rows: [taskRow()], rowCount: 1 };
    if (/claw_workspace/.test(sql)) return { rows: [{ workspace_id: "kws_1", storage_prefix: "users/u-1/sessions/s-1/" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const published: Array<Record<string, unknown>> = [];
  const publish = taskPublisher.publish;
  taskPublisher.publish = (async (payload: string) => { published.push(JSON.parse(payload)); }) as typeof taskPublisher.publish;
  try {
    await dispatchTask("t-1");
  } finally {
    taskPublisher.publish = publish;
  }
  assert.equal(published.length, 1, "the run was dispatched");
  return published[0]!;
}

test("D2 a task of a DAG is marked for a session that acts as a user, and its key still goes to Brain", async () => {
  for (const [what, actingAs, marked] of ACTING) {
    const request = await dispatchDag({ platform_key: "pk-user-1", _server_managed_credentials: true, ...(actingAs === undefined ? {} : { acting_as: actingAs }) });
    assert.equal(request.withhold_sandbox_keys, marked ? true : undefined, what);
    assert.equal(request.effort, marked ? "high" : undefined, `${what}: a review runs at the review's effort`);
    assert.equal(request.platform_key, "pk-user-1", `${what}: Brain still needs the key to own the workload`);
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("D3 each place that hands Brain a turn for a stored session decides the sandbox's keys, and a new one is not added without", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  // Which turns can reach a stored session at all is github-review-acting-turns.test.ts (A8). Of those, the three that Brain gets through the
  // queue or the wire are built by `applyAppMcpToTask` (the live row, which also gives the tools), and the scheduler's by the stored config.
  const calls = (re: RegExp): string[] => walk(src).filter((f) => re.test(strip(readFileSync(f, "utf8")))).map((f) => f.slice(src.length)).sort();
  assert.deepEqual(calls(/\bapplyAppMcpToTask\((?!task: Record)/), ["sessions/dispatch.ts", "tasks/pending-dispatch.ts", "tasks/run-claim.ts"]);
  assert.deepEqual(calls(/\bwithholdsSandboxKeys\(cfg\)/), ["tasks/dispatcher.ts"]);
  assert.match(strip(readFileSync(join(src, "sessions/app-mcp.ts"), "utf8")), /await applySandboxKeyPolicyToTask\(task, sessionId\);/);
});

test("D4 a hosted application run is refused for a session that acts as a user, before anything is looked up, and is asked of any other session as it always was", async () => {
  const asked: string[] = [];
  const answerFor = (actingAs: unknown) => (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    asked.push(sql);
    if (/SELECT config->'acting_as' AS acting_as FROM claw_sessions/.test(sql)) return { rows: [{ acting_as: actingAs === undefined ? null : actingAs }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const ports = { ...appRunPorts, enabled: () => true };
  const user = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
  for (const [what, actingAs, marked] of ACTING) {
    db.query = answerFor(actingAs);
    asked.length = 0;
    const out = await checkAppRunRequest({ sessionId: "s-1", user, auth: {}, body: { plugin_id: 7, input: {} }, idemKey: null, requestHash: "h" }, ports);
    if (marked) {
      assert.deepEqual([out, asked.some((sql) => /FROM plugins/.test(sql))], [{ statusCode: 409, response: { ok: false, error: "app_run_not_allowed_for_acting_session" } }, false], what);
    } else {
      assert.deepEqual([out, asked.some((sql) => /FROM plugins/.test(sql))], [{ statusCode: 404, response: { ok: false, error: "plugin_not_found" } }, true], `${what}: the next check is the one it was`);
    }
  }
});
