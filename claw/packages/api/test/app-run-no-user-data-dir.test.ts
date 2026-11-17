// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run in a sandbox SaFE gave no USER_DATA_PATH.
 *
 * The case (2026-11-17): a workspace whose hostpath volume has no `enableUserDir`
 * gets no `USER_DATA_PATH` from SaFE, so the manifest's
 * `${USER_DATA_PATH}/.claw-apps/...` state directory could not be expanded (exit
 * 4). The AppRunner counted that like a failing launch: nine refusals, three
 * restarts, then a long backoff that held the task in executing with no error
 * until it was cancelled.
 *
 * Now Claw derives the path as SaFE would (`{mountPath}/users/{USER_ID}`) from
 * the workspace's hostpath volumes, never over a value SaFE set, and a run with
 * nothing to derive from fails at once, saying why.
 *
 * Brain's AppRunner drives a real run row through the API's internal routes
 * against a real Postgres (skipped without DATABASE_URL, and a skip is not a
 * pass); the workspace is read over HTTP from a stand-in SaFE; every command runs
 * in a real `sh` whose environment is the sandbox's.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA } from "@claw/protocol";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const INTERNAL = "internal-test-token-0123456789";
const EPOCH = 2;
const WORKSPACE = "ws-hostpath";
const USER_ID = "0123456789abcdef0123456789abcdef";

const MANIFEST = {
  schema: APP_MANIFEST_SCHEMA,
  name: "example-app",
  version: "1.0.0",
  container: {},
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", 'printf %s "$USER_DATA_PATH" > "$APP_STATE_DIR/udp.txt"; printf \'{"final":true,"returncode":0}\' > "$APP_STATE_DIR/exit.json"'],
  env_map: { state_dir: "APP_STATE_DIR" },
  // Restarts allowed, with a long backoff: what kept the task in executing.
  restart: { max_restarts: 3, backoff_sec: [30, 120, 900] },
};
const RESOURCES = { image: "registry.example.invalid/app:1", gpus: 0, workspace: WORKSPACE };

/** `sh -c command` with `env` and PATH only: the sandbox's environment, with no USER_DATA_PATH unless given. */
function sh(command: string, cwd: string, env: Record<string, string>) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    execFile("sh", ["-c", command], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

describe("an app run in a sandbox SaFE gave no USER_DATA_PATH", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let safe: FastifyInstance;
  let base = "";
  const dirs: string[] = [];
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), "claw-udp-it-")); dirs.push(d); return d; };
  /** What the stand-in SaFE answers for the workspace's volumes. */
  let volumes: unknown[] = [];
  const safeAsked: Array<{ url: string; auth: string | undefined }> = [];
  let plugin = 0;
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  before(async () => {
    process.env.CLAW_DEPLOY_MODE = "safe";
    process.env.AUTH_INTERNAL_TOKEN = INTERNAL;
    h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    const ports = (await import("../src/tasks/app-run.js")).appRunPorts as any;
    ports.workspaceAccess = async () => "ok";
    ports.grant = { issue: async () => undefined };
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      if (req.url.startsWith("/v1/internal/")) return;
      (req as any).user = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "pk-owner", virtualKey: "vk" };
    });
    await (await import("../src/routes/tasks.js")).registerTaskCreateRoute(app);
    await (await import("../src/routes/internal-apps.js")).registerInternalAppRoutes(app);
    base = await app.listen({ host: "127.0.0.1", port: 0 });

    safe = Fastify();
    safe.get("/api/v1/workspaces/:id", async (req, reply) => {
      safeAsked.push({ url: req.url, auth: req.headers.authorization });
      if ((req.params as { id: string }).id !== WORKSPACE) return reply.code(404).send({ error: "not found" });
      return { workspaceId: WORKSPACE, ...(volumes.length > 0 ? { volumes } : {}) };
    });
    // Brain reads SAFE_API_URL when its config is first imported, which is below.
    process.env.SAFE_API_URL = await safe.listen({ host: "127.0.0.1", port: 0 });

    plugin = Number(((await q(
      `INSERT INTO plugins (name, version, resource, owner_user_id, is_public)
       VALUES ('p', '1', $1::jsonb, 'u1', true) RETURNING id`,
      [JSON.stringify({ app: { manifest: MANIFEST } })],
    )).rows[0] as { id: string }).id);
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s1', 't', 'u1', 'claw')");
  });
  after(async () => {
    await app?.close();
    await safe?.close();
    await h?.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await q("DELETE FROM claw_app_runs");
    await q("DELETE FROM claw_tasks");
    safeAsked.length = 0;
  });

  /** A run created through the task route, held by brain-A, driven to its end in a sandbox whose own environment is `env`. */
  async function runIn(env: Record<string, string>) {
    const res = await app.inject({
      method: "POST", url: "/v1/sessions/s1/tasks",
      payload: { mode: "app", plugin_id: plugin, input: { note: "x" }, resources: RESOURCES },
    });
    assert.equal(res.statusCode, 200, res.body);
    const taskId = res.json().task_id as string;
    await q(
      "UPDATE claw_tasks SET lease_owner = 'brain-A', lease_expires_at = NOW() + interval '1 hour', claim_count = $2 WHERE task_id = $1",
      [taskId, EPOCH],
    );
    const { AppRunner } = await import("../../brain/src/apps/app-runner.js");
    const { httpAppRunStore } = await import("../../brain/src/apps/app-run-store.js");
    const { appSandboxNamespace, workspaceUserDataRoots } = await import("../../brain/src/apps/app-sandbox.js");
    const { World } = await import("../../brain/test/support/app-runner-world.js");
    const store = httpAppRunStore({
      baseUrl: () => base,
      headers: (hasBody) => ({ authorization: `Bearer ${INTERNAL}`, ...(hasBody ? { "content-type": "application/json" } : {}) }),
      brainId: "brain-A",
      claimCount: EPOCH,
    });
    // SaFE's workloads stand in as a fake (a workload is made and stopped); the store is the real API, the
    // workspace is read over HTTP as the wiring reads it, and every command runs in a real shell.
    const world = new World();
    world.store = store;
    const commands: string[] = [];
    const cwd = fresh();
    world.sandbox = {
      ...world.sandbox,
      exec: async (_inst, command, _t, opts) => { commands.push(command); return sh(command, cwd, { ...env, ...(opts?.env ?? {}) }); },
      userDataRoots: (run, platformKey) => workspaceUserDataRoots(appSandboxNamespace(run), platformKey),
    };
    const runner = new AppRunner(taskId, "pk-owner", { store, sandbox: world.sandbox, tickMs: 100 });
    const startedAt = Date.now();
    const result = await runner.run(AbortSignal.timeout(30_000));
    const row = (await q("SELECT state, restarts, state_dir FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as any;
    const read = (await app.inject({ method: "GET", url: `/v1/internal/app-runs/${taskId}`, headers: { authorization: `Bearer ${INTERNAL}` } })).json();
    return { taskId, result, row, lastExit: read.run.last_exit, commands, world, ms: Date.now() - startedAt };
  }

  test("absent: derived as {mountPath}/users/{USER_ID} from the workspace's hostpath volume, created, and given to the application", async () => {
    const root = fresh();
    volumes = [{ id: 1, type: "hostpath", hostPath: root, mountPath: root, accessMode: "ReadWriteMany" }];
    const r = await runIn({ USER_ID });
    const userDir = `${root}/users/${USER_ID}`;
    const stateDir = `${userDir}/.claw-apps/${r.taskId}`;
    assert.deepEqual(r.result, { kind: "ended", outcome: { success: true, reason: "app finished", captures: { session_dir: stateDir } } });
    assert.deepEqual({ state: r.row.state, restarts: r.row.restarts, state_dir: r.row.state_dir }, { state: "ended", restarts: 0, state_dir: stateDir });
    assert.equal(readFileSync(`${stateDir}/udp.txt`, "utf8"), userDir, "the application sees the derived USER_DATA_PATH");
    assert.deepEqual(safeAsked, [{ url: `/api/v1/workspaces/${WORKSPACE}`, auth: "Bearer pk-owner" }], "the run's workspace, with the owner's key, once");
  });

  test("injected wins: a USER_DATA_PATH SaFE set is used as it is, and nothing is derived", async () => {
    const root = fresh();
    const injected = fresh();
    volumes = [{ id: 1, type: "hostpath", hostPath: root, mountPath: root }];
    const r = await runIn({ USER_ID, USER_DATA_PATH: injected });
    const stateDir = `${injected}/.claw-apps/${r.taskId}`;
    assert.equal(r.result.kind === "ended" && r.result.outcome.success, true, JSON.stringify(r.result));
    assert.equal(r.row.state_dir, stateDir);
    assert.equal(readFileSync(`${stateDir}/udp.txt`, "utf8"), injected);
    assert.equal(existsSync(join(root, "users")), false, "no derived directory was made");
  });

  test("underivable: the run fails at once with a reason that says so, after one ask, with no restart and nothing started", async () => {
    volumes = [{ id: 1, type: "pfs", mountPath: "/pfs" }];
    const { NO_USER_DATA_DIR_REASON } = await import("../../brain/src/apps/app-runner.js");
    const r = await runIn({ USER_ID });
    assert.equal(r.result.kind, "ended", JSON.stringify(r.result));
    if (r.result.kind !== "ended") return;
    assert.equal(r.result.outcome.success, false);
    assert.equal(r.result.outcome.reason, `app run ended: start failed (${NO_USER_DATA_DIR_REASON})`);
    assert.match(r.result.outcome.reason, /USER_DATA_PATH is unset/);
    assert.ok(r.ms < 15_000, "no restart backoff was waited out");
    assert.deepEqual({ state: r.row.state, restarts: r.row.restarts, state_dir: r.row.state_dir }, { state: "ended", restarts: 0, state_dir: null });
    assert.equal(r.lastExit.cause, "start_failed");
    assert.equal(r.lastExit.stop_reason, NO_USER_DATA_DIR_REASON, "the reason is on the row, for a takeover to report too");
    assert.equal(r.commands.filter((c) => c.includes("exit 4; printf %s")).length, 1, "the directory was asked for once");
    assert.equal(r.commands.some((c) => c.includes("setsid")), false, "nothing was started");
    assert.equal(r.world.stopped.length, 1, "the sandbox was stopped");
  });
});
