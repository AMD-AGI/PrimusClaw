// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run's sandbox state and its outcome, as `GET /v1/tasks/:id` and
 * `GET /v1/runs?session_ids=` answer them, end to end.
 *
 * Until now a caller saw an app task read `running` from the moment a Brain
 * accepted it, while its sandbox was still queued or pulling its image, with
 * `placement.workload_id` empty; and how the run ended only as prose in
 * `failure_reason` ("app exited final with return code N (...)", "app run ended:
 * restarts exhausted"), which callers had to prefix-match.
 *
 * Here the run is created through the API's task route, driven by Brain's real
 * AppRunner through the API's internal routes, against a real Postgres (skipped
 * without DATABASE_URL, and a skip is not a pass). The sandbox is made by Brain's
 * real `ensureAppSandbox` and SaFE provider against a stand-in SaFE over HTTP,
 * answering in the shapes the platform answers with; the application runs in a
 * real `sh`, and writes its own `exit.json`.
 *
 * Coverage:
 *   L  pending (queued, workload id shown) -> running -> ended, `since` moving at
 *      each step, on both routes; the outcome `exited` with the application's
 *      return code, `final`, and its `error` masked and cut to 300 characters
 *   one run per cause the runner can reach: restarts_exhausted, start_failed,
 *      deadline, cancelled, task_closed, no_exit_record, sandbox_rejected,
 *      sandbox_unschedulable, sandbox_create_failed (the deadline reached while
 *      every create failed), sandbox_failed (the workload failed before it was ready)
 *   F  a run cancelled, or reaching its deadline, while its sandbox was queued:
 *      the stop writes nothing (no restart counted), its sandbox never reads
 *      running, and the cause is the stop's
 *   P  a sandbox lost while the application ran: back to pending (and a new
 *      `since`) while the next one queues, then running, then ended; with no
 *      restart left, ended from the move to finishing
 *   R  a run whose first create was refused and whose second sandbox ran: the
 *      refusal is cleared from the row once the sandbox is Running
 *   D  a database without the sandbox columns, or the table, which the schema
 *      guard only warns about with app runs off: a run still moves and both
 *      routes still answer
 *   O  a non-app run on the same routes: `app: null`, nothing else changed
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA } from "@claw/protocol";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const INTERNAL = "internal-test-token-5d1c9e7a3b";
const EPOCH = 3;
const WORKSPACE = "ws-app-status";
const OWNER_KEY = "pk-owner-app-status";
/** A credential shaped like a GitHub token, made here so it is plainly not one. */
const LEAKED = `ghp_${"Q7vR2mK9xT4wL8nB3cF6hJ1dS5gP0aZyE2uX".slice(0, 36)}`;

/** What the stand-in SaFE does with the next run's sandbox. */
interface SafeScript {
  create: "ok" | "rejected" | "5xx" | "rejected_once";
  /** What a read of a created workload answers until `release`. */
  poll: "pending" | "running" | "unschedulable" | "admin_failed";
}
let script: SafeScript = { create: "ok", poll: "running" };
let released = false;
let creates = 0;
/**
 * Live workloads: id -> the run it was created for, whether it was stopped, and whether
 * it is a reader (the small sandbox a run makes to look at its state directory after
 * losing its own), which this stand-in always starts at once.
 */
const workloads = new Map<string, { runId: string; stopped: boolean; reader: boolean }>();

const wid = () => `claw-${Date.now()}-sandbox-${Math.random().toString(36).slice(2, 7)}`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

/** SaFE's workload API as this test needs it, in the shapes the live platform answers with. */
function startFakeSafe(): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === `/api/v1/workspaces/${WORKSPACE}`) {
      return send(200, { workspaceId: WORKSPACE });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/workloads") {
      const runId = url.searchParams.get("envValue");
      const items = [...workloads].filter(([, w]) => w.runId === runId && !w.stopped).map(([id]) => ({
        workloadId: id, phase: released || script.poll === "running" ? "Running" : "Pending",
        groupVersionKind: { kind: "Sandbox" },
      }));
      return send(200, { items, totalCount: items.length });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/workloads") {
      creates += 1;
      const body = JSON.parse(raw) as { env?: Record<string, string> };
      if (script.create === "rejected" || (script.create === "rejected_once" && creates === 1)) {
        return send(400, {
          errorCode: "Primus.00002",
          errorMessage: "admission webhook \"vworkload.kb.io\" denied the request: Bad request. "
            + `timeout 64800 exceeds the qos limit of 10800 seconds for scope Sandbox; token ${LEAKED}`,
        });
      }
      if (script.create === "5xx") {
        res.writeHead(503, { "content-type": "text/plain" });
        return res.end("upstream connect error or disconnect/reset before headers.\nreset reason: overflow");
      }
      const id = wid();
      workloads.set(id, { runId: String(body.env?.CLAW_APP_RUN_ID ?? ""), stopped: false, reader: body.env?.CLAW_APP_RUN_ID === undefined });
      return send(200, { workloadId: id });
    }
    const one = /^\/api\/v1\/workloads\/([^/]+)(\/stop)?$/.exec(url.pathname);
    if (one) {
      const w = workloads.get(decodeURIComponent(one[1]!));
      if (!w) return send(404, { errorMessage: "not found" });
      if (req.method !== "GET") { w.stopped = true; return send(200, {}); }
      if (w.stopped) return send(200, { phase: "Stopped" });
      if (released || script.poll === "running" || w.reader) return send(200, { phase: "Running", pods: [{ adminNodeName: "node-a1" }] });
      if (script.poll === "admin_failed") {
        return send(200, {
          phase: "Failed",
          conditions: [{
            type: "AdminFailed", status: "True", reason: "FailedCreatePod",
            message: "pods is forbidden: exceeded quota: sandbox-quota, requested: cpu=4, limited: cpu=2",
          }],
        });
      }
      if (script.poll === "unschedulable") {
        return send(200, {
          phase: "NotReady", queuePosition: null, pods: null,
          message: "In queue - waiting for scale-up - 0/3 nodes are available: 3 node(s) were unschedulable.",
        });
      }
      return send(200, { phase: "Pending", queuePosition: 2, pods: null, message: "In queue - insufficient resources" });
    }
    return send(200, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server });
  }));
}

/** `sh -c command` with `env` and PATH only: the sandbox's environment. */
function sh(command: string, cwd: string, env: Record<string, string>) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    execFile("sh", ["-c", command], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/**
 * An application that waits for `go` in its state directory, then writes `exit` (when
 * given) and exits. It ignores SIGTERM, as a slow application does; it also goes once
 * its state directory is removed, so a run the test stopped leaves nothing behind.
 */
function appScript(exit: Record<string, unknown> | null): string {
  const write = exit ? `printf '%s' '${JSON.stringify(exit).replace(/'/g, "'\\''")}' > "$APP_STATE_DIR/exit.json"; ` : "";
  return `trap '' TERM; while [ ! -f "$APP_STATE_DIR/go" ]; do [ -d "$APP_STATE_DIR" ] || exit 0; sleep 0.1; done; ${write}exit 0`;
}

function manifest(over: Record<string, unknown> = {}, exit: Record<string, unknown> | null = { final: true, returncode: 0 }) {
  return {
    schema: APP_MANIFEST_SCHEMA,
    name: "example-app",
    version: "1.0.0",
    container: {},
    state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
    command: ["sh", "-c", appScript(exit)],
    env_map: { state_dir: "APP_STATE_DIR" },
    restart: { max_restarts: 0, backoff_sec: [1] },
    stop_grace_sec: 1,
    ...over,
  };
}

type Json = Record<string, any>;

describe("an app run's sandbox state and outcome on the task and run routes", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let safe: Server;
  let base = "";
  const dirs: string[] = [];
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), "claw-app-status-")); dirs.push(d); return d; };
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);
  let brain: {
    AppRunner: typeof import("../../brain/src/apps/app-runner.js")["AppRunner"];
    httpAppRunStore: typeof import("../../brain/src/apps/app-run-store.js")["httpAppRunStore"];
    realAppSandbox: typeof import("../../brain/src/apps/app-runner-wiring.js")["realAppSandbox"];
  };

  before(async () => {
    process.env.CLAW_DEPLOY_MODE = "safe";
    process.env.AUTH_INTERNAL_TOKEN = INTERNAL;
    const fake = await startFakeSafe();
    safe = fake.server;
    // Brain reads these when its config is first imported, which is below.
    Object.assign(process.env, {
      SAFE_API_URL: fake.url,
      SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS: "1",
      SANDBOX_PENDING_TIMEOUT_SECONDS: "600",
    });
    h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    const ports = (await import("../src/tasks/app-run.js")).appRunPorts as any;
    ports.workspaceAccess = async () => "ok";
    ports.grant = { issue: async () => undefined };
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      if (req.url.startsWith("/v1/internal/")) return;
      (req as any).user = { userId: "u1", userName: "u1", roles: ["default"], platformKey: OWNER_KEY, virtualKey: "vk" };
    });
    const tasks = await import("../src/routes/tasks.js");
    await tasks.registerTaskCreateRoute(app);
    await tasks.registerTaskReadRoutes(app);
    await (await import("../src/routes/internal-apps.js")).registerInternalAppRoutes(app);
    await (await import("../src/runs/routes.js")).registerRunRoutes(app);
    base = await app.listen({ host: "127.0.0.1", port: 0 });
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s1', 't', 'u1', 'claw')");
    brain = {
      AppRunner: (await import("../../brain/src/apps/app-runner.js")).AppRunner,
      httpAppRunStore: (await import("../../brain/src/apps/app-run-store.js")).httpAppRunStore,
      realAppSandbox: (await import("../../brain/src/apps/app-runner-wiring.js")).realAppSandbox,
    };
  });
  after(async () => {
    await app?.close();
    await new Promise<void>((r) => (safe ? safe.close(() => r()) : r()));
    await h?.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  beforeEach(async () => {
    script = { create: "ok", poll: "running" };
    released = false;
    creates = 0;
  });

  /** The session of each run: one live app run per session. */
  const sessionOf = new Map<string, string>();
  let sessions = 0;

  /** A run created through the task route, in a session of its own, and held by brain-A, as a claim leaves it. */
  async function createRun(m: Record<string, unknown>) {
    const sessionId = `s-app-status-${++sessions}`;
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ($1, 't', 'u1', 'claw')", [sessionId]);
    const plugin = Number(((await q(
      `INSERT INTO plugins (name, version, resource, owner_user_id, is_public)
       VALUES ('p-' || md5(random()::text), '1', $1::jsonb, 'u1', true) RETURNING id`,
      [JSON.stringify({ app: { manifest: m } })],
    )).rows[0] as { id: string }).id);
    const res = await app.inject({
      method: "POST", url: `/v1/sessions/${sessionId}/tasks`,
      payload: { mode: "app", plugin_id: plugin, input: { note: "x" }, resources: { image: "registry.example.invalid/app:1", gpus: 0, workspace: WORKSPACE, cpu: 4, memory_gi: 16 } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const taskId = res.json().task_id as string;
    sessionOf.set(taskId, sessionId);
    // What a claim leaves on the row, and what the task reads once a Brain accepted it.
    await q(
      `UPDATE claw_tasks SET lease_owner = 'brain-A', lease_expires_at = NOW() + interval '1 hour', claim_count = $2,
              status = 'running', started_at = NOW() WHERE task_id = $1`,
      [taskId, EPOCH],
    );
    return taskId;
  }

  /** Brain's AppRunner on the run, as `createAppRunner` builds it, with commands run in a real shell. */
  function runnerFor(taskId: string, env: Record<string, string>, seen?: string[]) {
    const store = brain.httpAppRunStore({
      baseUrl: () => base,
      headers: (hasBody) => ({ authorization: `Bearer ${INTERNAL}`, ...(hasBody ? { "content-type": "application/json" } : {}) }),
      brainId: "brain-A",
      claimCount: EPOCH,
    });
    if (seen) {
      // After every write the runner makes, what a caller reads: the states in between included.
      const write = store.patch.bind(store);
      store.patch = async (...a: Parameters<typeof write>) => {
        const rec = await write(...a);
        seen.push(`${rec.state}:${(await readRun(taskId)).app.sandbox.state}`);
        return rec;
      };
    }
    const cwd = fresh();
    const sandbox = { ...brain.realAppSandbox(store), exec: async (_i: unknown, command: string, _t: string, opts?: { env?: Record<string, string> }) => sh(command, cwd, { ...env, ...(opts?.env ?? {}) }) };
    const runner = new brain.AppRunner(taskId, OWNER_KEY, { store, sandbox: sandbox as never, tickMs: 100, claimCount: EPOCH });
    return { runner, store };
  }

  async function readTask(taskId: string): Promise<Json> {
    const res = await app.inject({ method: "GET", url: `/v1/tasks/${taskId}` });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().item;
  }
  async function readRun(taskId: string): Promise<Json> {
    const res = await app.inject({ method: "GET", url: `/v1/runs?session_ids=${sessionOf.get(taskId) ?? "s1"}` });
    assert.equal(res.statusCode, 200, res.body);
    const run = (res.json().runs as Json[]).find((r) => r.run_id === taskId);
    assert.ok(run, `run ${taskId} is in the session's runs`);
    return run!;
  }
  /** Both routes, which must agree on the app status. */
  async function readBoth(taskId: string): Promise<{ task: Json; run: Json; app: Json }> {
    const [task, run] = [await readTask(taskId), await readRun(taskId)];
    assert.deepEqual(task.app, run.app, "GET /v1/tasks/:id and GET /v1/runs say the same");
    return { task, run, app: run.app };
  }
  async function until(what: string, check: () => Promise<boolean>, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
  }
  const rowState = async (taskId: string) =>
    ((await q("SELECT state FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as { state: string }).state;

  /** A run driven to its end, the application told to go as soon as it started. */
  async function runToEnd(m: Record<string, unknown>, env: Record<string, string> | null = null) {
    return driveToEnd(await createRun(m), env);
  }
  async function driveToEnd(taskId: string, env: Record<string, string> | null = null) {
    const udp = fresh();
    const { runner } = runnerFor(taskId, env ?? { USER_DATA_PATH: udp });
    writeFileSync(join(udp, "placeholder"), "");
    const done = runner.run(AbortSignal.timeout(30_000));
    // The state directory is made by the runner; `go` is dropped there once it exists.
    const go = setInterval(async () => {
      const dir = ((await q("SELECT state_dir FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as { state_dir: string | null })?.state_dir;
      if (dir) { try { writeFileSync(join(dir, "go"), ""); } catch { /* not made yet */ } }
    }, 50);
    const result = await done.finally(() => clearInterval(go));
    return { taskId, result, ...(await readBoth(taskId)) };
  }

  test("L: pending while queued, running once SaFE says Running, ended after; the outcome as stable fields", async () => {
    script = { create: "ok", poll: "pending" };
    const error = `Traceback (most recent call last): RuntimeError: upstream said Authorization: Bearer ${LEAKED} `
      + `and GITHUB_TOKEN=${LEAKED}\n` + "x".repeat(400);
    const taskId = await createRun(manifest({}, { final: true, returncode: 3, error }));
    const udp = fresh();
    const { runner } = runnerFor(taskId, { USER_DATA_PATH: udp });
    const done = runner.run(AbortSignal.timeout(60_000));

    // Queued: the task reads running, its sandbox does not.
    await until("a workload id while queued", async () => (await readRun(taskId)).app?.sandbox.workload_id !== "");
    const queued = await readBoth(taskId);
    assert.equal(queued.task.status, "running", "the task reads running as soon as it is accepted");
    assert.equal(queued.app.sandbox.state, "pending");
    assert.match(queued.app.sandbox.workload_id, /^claw-\d+-sandbox-[a-z0-9]+$/);
    assert.equal(queued.run.placement.workload_id, queued.app.sandbox.workload_id, "placement names the app sandbox");
    assert.equal(queued.app.outcome, null);
    const pendingSince = Date.parse(queued.app.sandbox.since);
    assert.ok(Number.isFinite(pendingSince));
    assert.equal(await rowState(taskId), "provisioning");

    // Running: SaFE answers Running, the runner moves on, the application starts and waits.
    await new Promise((r) => setTimeout(r, 30));
    released = true;
    await until("the sandbox running", async () => (await readRun(taskId)).app.sandbox.state === "running");
    const up = await readBoth(taskId);
    assert.equal(up.app.sandbox.workload_id, queued.app.sandbox.workload_id);
    assert.ok(Date.parse(up.app.sandbox.since) > pendingSince, "since moved when the sandbox started");
    assert.equal(up.app.outcome, null, "no outcome while the run is going");

    // Ended: once the application is up, it writes its exit and goes.
    await until("the application up", async () => (await rowState(taskId)) === "running");
    assert.equal((await readRun(taskId)).app.sandbox.since, up.app.sandbox.since, "since stays while the sandbox stays running");
    const dir = ((await q("SELECT state_dir FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as { state_dir: string }).state_dir;
    writeFileSync(join(dir, "go"), "");
    const result = await done;
    assert.equal(result.kind, "ended");
    // The prose the task's failure_reason carries is what it was.
    assert.match(result.kind === "ended" ? result.outcome.reason : "", /^app exited final with return code 3$/);
    const end = await readBoth(taskId);
    assert.equal(end.app.sandbox.state, "ended");
    assert.equal(end.app.sandbox.workload_id, queued.app.sandbox.workload_id, "the last sandbox is still named");
    assert.ok(Date.parse(end.app.sandbox.since) > Date.parse(up.app.sandbox.since));
    assert.equal(end.run.placement.workload_id, queued.app.sandbox.workload_id);
    const { error: shown, ...rest } = end.app.outcome;
    assert.deepEqual(rest, { cause: "exited", returncode: 3, final: true });
    assert.ok(typeof shown === "string" && shown.length <= 300, `error is at most 300 characters (${shown?.length})`);
    assert.ok(shown.startsWith("Traceback (most recent call last): RuntimeError: upstream said "), shown);
    assert.match(shown, /<redacted>|\[REDACTED\]/, "the credential's place is marked");
    assert.match(shown, /x(\.\.\.|…)$/, "cut, and says so");
    assert.ok(!shown.includes(LEAKED) && !shown.includes(LEAKED.slice(4, 20)), `no part of the credential is shown: ${shown}`);
    assert.ok(!JSON.stringify(end).includes(LEAKED.slice(4, 20)), "nowhere in either answer");
  });

  test("cause exited with return code 0 is the success", async () => {
    const r = await runToEnd(manifest());
    assert.deepEqual(r.app.outcome, { cause: "exited", returncode: 0, final: true, error: null });
    assert.equal(r.app.sandbox.state, "ended");
  });

  test("cause restarts_exhausted: the application exited without final and no restart was left", async () => {
    const r = await runToEnd(manifest({}, { returncode: 7, error: "worker died" }));
    assert.equal(r.result.kind === "ended" && r.result.outcome.reason, "app run ended: restarts exhausted");
    assert.deepEqual(r.app.outcome, { cause: "restarts_exhausted", returncode: 7, final: false, error: "worker died" });
  });

  test("cause start_failed: the sandbox has no user data directory to put the state in", async () => {
    const r = await runToEnd(manifest(), {});
    assert.match(r.result.kind === "ended" ? r.result.outcome.reason : "", /^app run ended: start failed \(/);
    assert.deepEqual(r.app.outcome, { cause: "start_failed", returncode: null, final: false, error: null });
    assert.equal(r.app.sandbox.state, "ended");
  });

  test("cause deadline: the run reached limits.max_runtime_sec", async () => {
    const taskId = await createRun(manifest({ limits: { max_runtime_sec: 2 } }));
    const { runner } = runnerFor(taskId, { USER_DATA_PATH: fresh() });
    const result = await runner.run(AbortSignal.timeout(30_000));
    assert.equal(result.kind, "ended");
    const { app: a } = await readBoth(taskId);
    assert.deepEqual(a.outcome, { cause: "deadline", returncode: null, final: false, error: null });
  });

  /** A run whose application is up, ended from outside the machine for `cause`. */
  async function endFromOutside(cause: "cancelled" | "row_terminal") {
    const taskId = await createRun(manifest());
    const { runner } = runnerFor(taskId, { USER_DATA_PATH: fresh() });
    const stop = new AbortController();
    const running = runner.run(stop.signal);
    await until("the application running", async () => (await rowState(taskId)) === "running");
    stop.abort();
    await running;
    await runner.finishNow(cause);
    return readBoth(taskId);
  }

  test("cause cancelled: the run was cancelled while the application ran", async () => {
    const { app: a } = await endFromOutside("cancelled");
    assert.deepEqual(a.outcome, { cause: "cancelled", returncode: null, final: false, error: null });
    assert.equal(a.sandbox.state, "ended");
  });

  test("cause task_closed: the task was closed outside the run", async () => {
    const { app: a } = await endFromOutside("row_terminal");
    assert.deepEqual(a.outcome, { cause: "task_closed", returncode: null, final: false, error: null });
  });

  test("cause no_exit_record: a run ended with no exit record on its row", async () => {
    const taskId = await createRun(manifest());
    const { store } = runnerFor(taskId, {});
    await store.patch(taskId, { state: "ended" });
    const { app: a } = await readBoth(taskId);
    assert.deepEqual(a.outcome, { cause: "no_exit_record", returncode: null, final: false, error: null });
    assert.deepEqual({ state: a.sandbox.state, workload_id: a.sandbox.workload_id }, { state: "ended", workload_id: "" });
  });

  test("error: a long one on the row is masked first, then folded onto one line and cut to 300 characters", async () => {
    const taskId = await createRun(manifest());
    const { store } = runnerFor(taskId, {});
    // As the row can hold it (`last_exit` is bounded at 4 KiB, not 300 characters): the
    // credential sits across the 300th character, so a cut made before the mask would leave its head.
    const head = "Error:\n  at step 3\n" + "y".repeat(270) + " key=";
    await store.patch(taskId, {
      state: "ended",
      last_exit: { at: new Date().toISOString(), cause: "exit", final: true, returncode: 1, error: `${head}${LEAKED} ${"z".repeat(3000)}` },
    });
    const { app: a } = await readBoth(taskId);
    assert.deepEqual({ ...a.outcome, error: undefined }, { cause: "exited", returncode: 1, final: true, error: undefined });
    assert.equal(a.outcome.error.length, 300);
    assert.ok(a.outcome.error.startsWith("Error: at step 3 yyy"), a.outcome.error);
    assert.ok(!a.outcome.error.includes("ghp_") && !a.outcome.error.includes(LEAKED.slice(4, 12)), a.outcome.error);
    assert.ok(!/[\n\r]/.test(a.outcome.error));
  });

  test("sandbox_message: the run's own secrets are scrubbed from it when the row is written, as error is", async () => {
    const taskId = await createRun(manifest());
    const { store } = runnerFor(taskId, {});
    const { readAppRunSecrets } = await import("../src/tasks/app-run-state.js");
    const token = (await readAppRunSecrets(taskId))!.mcp_token;
    await store.patch(taskId, {
      state: "ended",
      last_exit: {
        at: new Date().toISOString(), cause: "restarts_exhausted", final: false,
        sandbox_reason: "sandbox_rejected", sandbox_message: `denied: env APP_MCP_TOKEN=${token} is not allowed`,
      },
    });
    const stored = ((await q("SELECT last_exit FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as { last_exit: Json }).last_exit;
    assert.ok(!JSON.stringify(stored).includes(token), JSON.stringify(stored));
    const { app: a } = await readBoth(taskId);
    assert.equal(a.outcome.cause, "sandbox_rejected");
    assert.match(a.outcome.error, /^denied: env APP_MCP_TOKEN=/);
    assert.ok(!a.outcome.error.includes(token));
  });

  test("cause sandbox_rejected: SaFE refused the create; the platform's words, masked, are the error", async () => {
    script = { create: "rejected", poll: "running" };
    const r = await runToEnd(manifest());
    assert.equal(r.result.kind === "ended" && r.result.outcome.reason, "app run ended: restarts exhausted", "the prose is as it was");
    const { error, ...rest } = r.app.outcome;
    assert.deepEqual(rest, { cause: "sandbox_rejected", returncode: null, final: false });
    assert.match(error, /^The platform refused to create the sandbox \(HTTP 400\): admission webhook "vworkload\.kb\.io" denied the request/);
    assert.ok(!error.includes(LEAKED.slice(4, 20)), error);
    assert.ok(error.length <= 300);
    assert.deepEqual({ state: r.app.sandbox.state, workload_id: r.app.sandbox.workload_id }, { state: "ended", workload_id: "" });
    assert.equal(creates, 1);
  });

  test("cause sandbox_unschedulable: no node would take the sandbox", async () => {
    script = { create: "ok", poll: "unschedulable" };
    const r = await runToEnd(manifest());
    const { error, ...rest } = r.app.outcome;
    assert.deepEqual(rest, { cause: "sandbox_unschedulable", returncode: null, final: false });
    assert.match(error, /could not be scheduled|unschedulable/);
    assert.equal(r.app.sandbox.state, "ended");
  });

  test("cause sandbox_failed: the workload failed before it was ready", async () => {
    script = { create: "ok", poll: "admin_failed" };
    const r = await runToEnd(manifest());
    const { error, ...rest } = r.app.outcome;
    assert.deepEqual(rest, { cause: "sandbox_failed", returncode: null, final: false });
    assert.match(error, /exceeded quota: sandbox-quota/);
  });

  test("cause sandbox_create_failed: every create failed until the run's deadline", async () => {
    script = { create: "5xx", poll: "running" };
    const taskId = await createRun(manifest({ limits: { max_runtime_sec: 2 } }));
    const { runner } = runnerFor(taskId, { USER_DATA_PATH: fresh() });
    const result = await runner.run(AbortSignal.timeout(30_000));
    assert.equal(result.kind === "ended" && result.outcome.reason, "app run ended: deadline");
    const { app: a } = await readBoth(taskId);
    const { error, ...rest } = a.outcome;
    assert.deepEqual(rest, { cause: "sandbox_create_failed", returncode: null, final: false });
    assert.match(error, /^Create Hands failed: HTTP 503 upstream connect error/);
    assert.ok(creates >= 2, `the create was retried (${creates})`);
  });

  /**
   * A run stopped while its sandbox is queued, by the run's own signal through the
   * real AppRunner, as the task runner stops it for a cancel or the deadline; then
   * finished as the task runner finishes it. Nothing is patched by hand.
   */
  async function stopWhileQueued(cause: "cancelled" | "deadline") {
    script = { create: "ok", poll: "pending" };
    const taskId = await createRun(manifest());
    const seen: string[] = [];
    const { runner } = runnerFor(taskId, { USER_DATA_PATH: fresh() }, seen);
    const stop = new AbortController();
    const running = runner.run(stop.signal, { reclaimOnAbort: () => true });
    await until("a queued workload", async () => (await readRun(taskId)).app.sandbox.workload_id !== "");
    const queued = (await readRun(taskId)).app.sandbox;
    assert.equal(queued.state, "pending");
    stop.abort();
    assert.equal((await running).kind, "aborted");
    // The interrupted wait wrote nothing: still provisioning, no exit, the queued sandbox as it was.
    const row = (await q("SELECT state, restarts, last_exit FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as Json;
    assert.deepEqual({ state: row.state, restarts: row.restarts, last_exit: row.last_exit }, { state: "provisioning", restarts: 0, last_exit: null });
    const after = (await readBoth(taskId)).app;
    assert.deepEqual(after, { sandbox: queued, outcome: null }, "the stop alone changes nothing a caller sees");
    const outcome = await runner.finishNow(cause);
    assert.equal(outcome.success, false);
    assert.ok(seen.includes("finishing:pending"), `the finish passed through finishing with the sandbox still pending: ${seen}`);
    assert.ok(!seen.some((x) => x.endsWith(":running")), `never running: ${seen}`);
    const end = (await readBoth(taskId)).app;
    assert.equal(end.sandbox.state, "ended");
    assert.equal(end.sandbox.workload_id, queued.workload_id);
    assert.ok([...workloads].some(([id, w]) => id === queued.workload_id && w.stopped), "the queued workload was stopped");
    return end;
  }

  test("F: a run cancelled while its sandbox was queued: never running, and cancelled, not restarts_exhausted", async () => {
    const end = await stopWhileQueued("cancelled");
    assert.deepEqual(end.outcome, { cause: "cancelled", returncode: null, final: false, error: null });
  });

  test("F: a run that reached its deadline while its sandbox was queued ends as deadline", async () => {
    const end = await stopWhileQueued("deadline");
    assert.deepEqual(end.outcome, { cause: "deadline", returncode: null, final: false, error: null });
  });

  test("P: a sandbox lost while the application ran: back to pending for the next one, since moved, then running again", async () => {
    // One restart allowed, so the loss is not the end of the run.
    const taskId = await createRun(manifest({ restart: { max_restarts: 1, backoff_sec: [1] } }));
    const { runner } = runnerFor(taskId, { USER_DATA_PATH: fresh() });
    const done = runner.run(AbortSignal.timeout(60_000));
    await until("the application up", async () => (await rowState(taskId)) === "running");
    const first = (await readBoth(taskId)).app.sandbox;
    assert.equal(first.state, "running");
    assert.notEqual(first.workload_id, "");

    // The next sandbox queues; the platform takes this one away.
    script = { create: "ok", poll: "pending" };
    workloads.delete(first.workload_id);
    await until("a second workload queued", async () => {
      const s = (await readRun(taskId)).app.sandbox;
      return s.workload_id !== "" && s.workload_id !== first.workload_id;
    });
    const again = await readBoth(taskId);
    assert.equal(await rowState(taskId), "provisioning");
    assert.equal(again.app.sandbox.state, "pending", "a run making a new sandbox reads pending, not running");
    assert.ok(Date.parse(again.app.sandbox.since) > Date.parse(first.since), "since moved when the wait for the new sandbox began");
    assert.equal(again.run.placement.workload_id, again.app.sandbox.workload_id, "placement names the new sandbox");
    assert.equal(again.app.outcome, null);

    released = true;
    await until("the second sandbox running", async () => (await readRun(taskId)).app.sandbox.state === "running");
    const up = (await readBoth(taskId)).app.sandbox;
    assert.equal(up.workload_id, again.app.sandbox.workload_id);
    assert.ok(Date.parse(up.since) > Date.parse(again.app.sandbox.since));

    await until("the application up again", async () => (await rowState(taskId)) === "running");
    const dir = ((await q("SELECT state_dir FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as { state_dir: string }).state_dir;
    writeFileSync(join(dir, "go"), "");
    assert.equal((await done).kind, "ended");
    const end = (await readBoth(taskId)).app;
    assert.equal(end.sandbox.state, "ended");
    assert.equal(end.sandbox.workload_id, up.workload_id);
    assert.deepEqual(end.outcome, { cause: "exited", returncode: 0, final: true, error: null });
  });

  test("P: a sandbox lost with no restart left: ended from the move to finishing, not running until the finish is done", async () => {
    const taskId = await createRun(manifest());
    const seen: string[] = [];
    const { runner } = runnerFor(taskId, { USER_DATA_PATH: fresh() }, seen);
    const done = runner.run(AbortSignal.timeout(60_000));
    await until("the application up", async () => (await rowState(taskId)) === "running");
    const up = (await readBoth(taskId)).app.sandbox;
    assert.equal(up.state, "running");
    workloads.delete(up.workload_id);
    assert.equal((await done).kind, "ended");
    // The application in the lost sandbox is not told anything; let it go.
    const dir = ((await q("SELECT state_dir FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as { state_dir: string }).state_dir;
    writeFileSync(join(dir, "go"), "");
    assert.ok(seen.includes("finishing:ended"), `the sandbox reads ended once the run is finishing on its loss: ${seen}`);
    assert.ok(!seen.includes("finishing:running"), `${seen}`);
    const end = (await readBoth(taskId)).app;
    assert.deepEqual({ state: end.sandbox.state, workload_id: end.sandbox.workload_id }, { state: "ended", workload_id: up.workload_id });
    assert.deepEqual(end.outcome, { cause: "restarts_exhausted", returncode: null, final: false, error: null });
  });

  test("R: a refused create, then a sandbox that ran: the refusal leaves the row and the cause is the application's", async () => {
    script = { create: "rejected_once", poll: "running" };
    const r = await runToEnd(manifest({ restart: { max_restarts: 1, backoff_sec: [1] } }, { returncode: 2 }));
    assert.equal(creates, 2);
    const row = (await q("SELECT last_exit FROM claw_app_runs WHERE task_id = $1", [r.taskId])).rows[0] as { last_exit: Json };
    assert.equal(row.last_exit.sandbox_reason, undefined, "the refusal was cleared when the sandbox ran");
    assert.deepEqual(r.app.outcome, { cause: "restarts_exhausted", returncode: 2, final: false, error: null });
  });

  test("D: a database the guard only warns about (APP_RUNS_ENABLED off): without the sandbox columns a run still moves and reads; without the table, no status", async () => {
    const taskId = await createRun(manifest());
    let done: Json = {};
    try {
      await q("ALTER TABLE claw_app_runs RENAME COLUMN sandbox_state TO sandbox_state_gone");
      await q("ALTER TABLE claw_app_runs RENAME COLUMN sandbox_since TO sandbox_since_gone");
      // Every move of the run (provisioning -> starting -> running -> finishing -> ended) is a write.
      const r = await driveToEnd(taskId);
      assert.equal(r.result.kind, "ended");
      done = r.app;
      assert.deepEqual(done, {
        sandbox: { state: "ended", workload_id: done.sandbox.workload_id, since: null },
        outcome: { cause: "exited", returncode: 0, final: true, error: null },
      }, "read from the run's state");
      assert.match(done.sandbox.workload_id, /^claw-\d+-sandbox-/);
      await q("ALTER TABLE claw_app_runs RENAME TO claw_app_runs_gone");
      assert.equal((await readRun(taskId)).app, null);
      assert.equal((await readTask(taskId)).app, null);
    } finally {
      await q("ALTER TABLE IF EXISTS claw_app_runs_gone RENAME TO claw_app_runs");
      await q("ALTER TABLE claw_app_runs RENAME COLUMN sandbox_state_gone TO sandbox_state").catch(() => undefined);
      await q("ALTER TABLE claw_app_runs RENAME COLUMN sandbox_since_gone TO sandbox_since").catch(() => undefined);
    }
    // The columns back: the row moved without them still reads as the ended run it is.
    const back = (await readBoth(taskId)).app;
    assert.deepEqual({ state: back.sandbox.state, workload_id: back.sandbox.workload_id, outcome: back.outcome },
      { state: "ended", workload_id: done.sandbox.workload_id, outcome: done.outcome });
  });

  test("O: a run that is not an app run has app null and its own placement", async () => {
    await q(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, mode, sandbox_workload_id, input)
       VALUES ('ktsk_plain_1', 's1', 't', 'completed', 'script', 'claw-1-sandbox-plain', '{}'::jsonb)`,
    );
    const run = await readRun("ktsk_plain_1");
    assert.equal(run.app, null);
    assert.equal(run.placement.workload_id, "claw-1-sandbox-plain");
    const task = await readTask("ktsk_plain_1");
    assert.equal("app" in task, false);
  });
});
