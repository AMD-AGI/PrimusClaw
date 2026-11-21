// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a caller reads about an app run while it is alive, and the deadline its
 * task carries, end to end.
 *
 * An application that crash-loops is restarted by the Brain, and its task reads
 * `running` throughout: `app.restarts` and `app.last_exit` say so while the run is
 * still going. And an app task's `deadline_at` used to be the generic task budget
 * (72 hours from its start) while the Brain stops the run at its own time limit,
 * counted from its creation: now it is that limit, and the deadline backstop waits
 * out the application's stop grace past it rather than closing a run the Brain is
 * still stopping.
 *
 * The run is created through the API's task route and driven by Brain's real
 * AppRunner through the API's internal routes, against a real Postgres (skipped
 * without DATABASE_URL, and a skip is not a pass). The sandbox is made by Brain's
 * real `ensureAppSandbox` and SaFE provider against a stand-in SaFE over HTTP; the
 * application runs in a real `sh` and writes its own `exit.json`.
 *
 * Every application here exits on its own (or once told to); `after` checks that
 * none of their shells is left.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA } from "@claw/protocol";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const INTERNAL = "internal-test-token-8e2a4c6b1d";
const EPOCH = 3;
const WORKSPACE = "ws-app-restarts";
const OWNER_KEY = "pk-owner-app-restarts";
/** Marks every application shell this file starts, so `after` can look for any left. */
const MARK = `claw-restarts-e2e-${process.pid}`;

/** What the stand-in SaFE does with a create. */
let createMode: "ok" | "5xx" = "ok";
const workloads = new Map<string, { runId: string; stopped: boolean }>();
const wid = () => `claw-${Date.now()}-sandbox-${Math.random().toString(36).slice(2, 7)}`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

/** SaFE's workload API as these runs need it: every create is Running at once (or every create fails). */
function startFakeSafe(): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === `/api/v1/workspaces/${WORKSPACE}`) return send(200, { workspaceId: WORKSPACE });
    if (req.method === "GET" && url.pathname === "/api/v1/workloads") {
      const runId = url.searchParams.get("envValue");
      const items = [...workloads].filter(([, w]) => w.runId === runId && !w.stopped)
        .map(([id]) => ({ workloadId: id, phase: "Running", groupVersionKind: { kind: "Sandbox" } }));
      return send(200, { items, totalCount: items.length });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/workloads") {
      if (createMode === "5xx") {
        res.writeHead(503, { "content-type": "text/plain" });
        return res.end("upstream connect error or disconnect/reset before headers. reset reason: overflow");
      }
      const body = JSON.parse(raw) as { env?: Record<string, string> };
      const id = wid();
      workloads.set(id, { runId: String(body.env?.CLAW_APP_RUN_ID ?? ""), stopped: false });
      return send(200, { workloadId: id });
    }
    const one = /^\/api\/v1\/workloads\/([^/]+)(\/stop)?$/.exec(url.pathname);
    if (one) {
      const w = workloads.get(decodeURIComponent(one[1]!));
      if (!w) return send(404, { errorMessage: "not found" });
      if (req.method !== "GET") { w.stopped = true; return send(200, {}); }
      return send(200, w.stopped ? { phase: "Stopped" } : { phase: "Running", pods: [{ adminNodeName: "node-a1" }] });
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

/** The application shells this file started that are still there (their command line carries {@link MARK}). */
function leftoverShells(): string[] {
  const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return out.split("\n").filter((line) => line.includes(MARK) && !line.includes("ps -eo"));
}

/**
 * An application that crashes at once, every time: it counts its starts in its
 * state directory and writes `exit.json` with return code 10 + that count, without
 * `final`.
 */
const CRASHER = `: ${MARK}; n=$(cat "$APP_STATE_DIR/starts" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP_STATE_DIR/starts"; `
  + `printf '{"returncode": %d, "error": "crash %d"}' $((10 + n)) "$n" > "$APP_STATE_DIR/exit.json"; exit 1`;

/** An application that waits for `go` in its state directory (or for the directory to go), then ends with `final`. */
const WAITER = `: ${MARK}; trap '' TERM; while [ ! -f "$APP_STATE_DIR/go" ]; do [ -d "$APP_STATE_DIR" ] || exit 0; sleep 0.1; done; `
  + `printf '{"final": true, "returncode": 0}' > "$APP_STATE_DIR/exit.json"; exit 0`;

function manifest(command: string, over: Record<string, unknown> = {}) {
  return {
    schema: APP_MANIFEST_SCHEMA,
    name: "example-app",
    version: "1.0.0",
    container: {},
    state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
    command: ["sh", "-c", command],
    env_map: { state_dir: "APP_STATE_DIR" },
    restart: { max_restarts: 0, backoff_sec: [1] },
    stop_grace_sec: 1,
    ...over,
  };
}

type Json = Record<string, any>;

describe("an app run's restarts and last exit while it is alive, and its task's deadline", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let safe: Server;
  let base = "";
  const dirs: string[] = [];
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), "claw-app-restarts-")); dirs.push(d); return d; };
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
    Object.assign(process.env, { SAFE_API_URL: fake.url, SANDBOX_PENDING_TIMEOUT_SECONDS: "600" });
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
    // A waiting application goes once its state directory is gone.
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    const end = Date.now() + 5_000;
    while (leftoverShells().length > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(leftoverShells(), [], "no application shell outlives the suite");
  });

  const sessionOf = new Map<string, string>();
  let sessions = 0;

  /** A run created through the task route, in a session of its own. Not claimed yet. */
  async function admit(m: Record<string, unknown>, resources: Record<string, unknown> = {}) {
    const sessionId = `s-app-restarts-${++sessions}`;
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ($1, 't', 'u1', 'claw')", [sessionId]);
    const plugin = Number(((await q(
      `INSERT INTO plugins (name, version, resource, owner_user_id, is_public)
       VALUES ('p-' || md5(random()::text), '1', $1::jsonb, 'u1', true) RETURNING id`,
      [JSON.stringify({ app: { manifest: m } })],
    )).rows[0] as { id: string }).id);
    const res = await app.inject({
      method: "POST", url: `/v1/sessions/${sessionId}/tasks`,
      payload: {
        mode: "app", plugin_id: plugin, input: { note: "x" },
        resources: { image: "registry.example.invalid/app:1", gpus: 0, workspace: WORKSPACE, cpu: 4, memory_gi: 16, ...resources },
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const taskId = res.json().task_id as string;
    sessionOf.set(taskId, sessionId);
    return taskId;
  }
  /** As a claim leaves the row: through the status writer (which stamps the deadline), held by brain-A. */
  async function claim(taskId: string) {
    const { transitionStatus } = await import("../src/tasks/db.js");
    assert.ok(await transitionStatus(taskId, ["queued"], "preparing"), "queued -> preparing");
    assert.ok(await transitionStatus(taskId, ["preparing"], "running"), "preparing -> running");
    await q("UPDATE claw_tasks SET lease_owner = 'brain-A', lease_expires_at = NOW() + interval '1 hour', claim_count = $2 WHERE task_id = $1", [taskId, EPOCH]);
  }

  function runnerFor(taskId: string, env: Record<string, string>, opts: { now?: () => number; afterWrite?: () => Promise<void> } = {}) {
    const store = brain.httpAppRunStore({
      baseUrl: () => base,
      headers: (hasBody) => ({ authorization: `Bearer ${INTERNAL}`, ...(hasBody ? { "content-type": "application/json" } : {}) }),
      brainId: "brain-A",
      claimCount: EPOCH,
    });
    if (opts.afterWrite) {
      const write = store.patch.bind(store);
      const hook = opts.afterWrite;
      store.patch = async (...a: Parameters<typeof write>) => {
        const rec = await write(...a);
        await hook();
        return rec;
      };
    }
    const cwd = fresh();
    const sandbox = { ...brain.realAppSandbox(store), exec: async (_i: unknown, command: string, _t: string, o?: { env?: Record<string, string> }) => sh(command, cwd, { ...env, ...(o?.env ?? {}) }) };
    return new brain.AppRunner(taskId, OWNER_KEY, { store, sandbox: sandbox as never, tickMs: 100, claimCount: EPOCH, ...(opts.now ? { now: opts.now } : {}) });
  }

  async function readTask(taskId: string): Promise<Json> {
    const res = await app.inject({ method: "GET", url: `/v1/tasks/${taskId}` });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().item;
  }
  async function readRun(taskId: string): Promise<Json> {
    const res = await app.inject({ method: "GET", url: `/v1/runs?session_ids=${sessionOf.get(taskId)}` });
    assert.equal(res.statusCode, 200, res.body);
    const run = (res.json().runs as Json[]).find((r) => r.run_id === taskId);
    assert.ok(run, `run ${taskId} is in the session's runs`);
    return run!;
  }
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
  const runRow = async (taskId: string) =>
    (await q("SELECT state, restarts, last_exit, state_dir, manifest, created_at FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as Json;
  const taskRow = async (taskId: string) =>
    (await q("SELECT status, deadline_at, started_at, metadata, origin FROM claw_tasks WHERE task_id = $1", [taskId])).rows[0] as Json;

  test("a crash loop: restarts counted and last_exit moved on every exit, while the task reads running", async () => {
    const taskId = await admit(manifest(CRASHER, { restart: { max_restarts: 4, backoff_sec: [1] } }));
    await claim(taskId);
    // After every write the runner makes, what a caller reads.
    const seen: Array<{ state: string; status: string; app: Json }> = [];
    const runner = runnerFor(taskId, { USER_DATA_PATH: fresh() }, {
      afterWrite: async () => {
        const { task, app: a } = await readBoth(taskId);
        seen.push({ state: (await runRow(taskId)).state, status: task.status, app: a });
      },
    });
    const before = Date.now();
    const result = await runner.run(AbortSignal.timeout(60_000));
    assert.equal(result.kind, "ended");

    // While the run was alive: the task read running, there was no outcome, and the
    // restarts and the last exit followed every crash.
    const alive = seen.filter((s) => s.state !== "finishing" && s.state !== "ended");
    assert.ok(alive.length > 0);
    for (const s of alive) {
      assert.equal(s.status, "running", "the task reads running throughout the crash loop");
      assert.equal(s.app.outcome, null, "no outcome while the run is alive");
    }
    const firstUp = alive.find((s) => s.state === "starting")!;
    assert.deepEqual({ restarts: firstUp.app.restarts, last_exit: firstUp.app.last_exit }, { restarts: 0, last_exit: null }, "nothing has stopped yet");
    const restarting = alive.filter((s) => s.state === "restarting");
    assert.deepEqual(
      restarting.map((s) => [s.app.restarts, s.app.last_exit?.cause, s.app.last_exit?.returncode]),
      [[1, "exited", 11], [2, "exited", 12], [3, "exited", 13], [4, "exited", 14]],
      "one restart counted and one exit recorded per crash, each with the application's own return code",
    );
    // `at` moves with every exit, and is when the Brain saw it.
    const ats = restarting.map((s) => Date.parse(s.app.last_exit.at));
    for (let i = 1; i < ats.length; i++) assert.ok(ats[i]! > ats[i - 1]!, `last_exit.at moved: ${restarting.map((s) => s.app.last_exit.at)}`);
    assert.ok(ats[0]! >= before && ats.at(-1)! <= Date.now());
    for (const s of restarting) assert.deepEqual(Object.keys(s.app.last_exit).sort(), ["at", "cause", "returncode"], "no free text in last_exit");

    // The fifth crash had no restart left: the run ended on it, and still says so.
    const end = await readBoth(taskId);
    assert.equal(end.app.restarts, 4);
    assert.deepEqual({ ...end.app.last_exit, at: undefined }, { returncode: 15, at: undefined, cause: "restarts_exhausted" });
    assert.ok(Date.parse(end.app.last_exit.at) >= ats.at(-1)!);
    assert.deepEqual(end.app.outcome, { cause: "restarts_exhausted", returncode: 15, final: false, error: "crash 5" });
    const row = await runRow(taskId);
    assert.equal(row.restarts, 4, "the API says what the row the Brain wrote says");
  });

  test("a sandbox create that keeps failing: no restart and no last_exit, since nothing has stopped", async () => {
    createMode = "5xx";
    try {
      const taskId = await admit(manifest(CRASHER));
      await claim(taskId);
      const runner = runnerFor(taskId, { USER_DATA_PATH: fresh() });
      const stop = new AbortController();
      const running = runner.run(stop.signal, { reclaimOnAbort: () => true });
      await until("the failing create recorded", async () => (await runRow(taskId)).last_exit?.sandbox_reason === "sandbox_create_failed");
      const { task, app: a } = await readBoth(taskId);
      assert.equal(task.status, "running");
      assert.deepEqual({ restarts: a.restarts, last_exit: a.last_exit, outcome: a.outcome }, { restarts: 0, last_exit: null, outcome: null });
      stop.abort();
      await running;
      await runner.finishNow("cancelled");
      const end = (await readBoth(taskId)).app;
      assert.equal(end.last_exit.cause, "cancelled");
      assert.equal(end.outcome.cause, "cancelled");
    } finally {
      createMode = "ok";
    }
  });

  /**
   * A run admitted with `limits` in its manifest and `grant` in its request: its
   * task's deadline, and the moment the real AppRunner stops it, on a clock the test
   * moves (`now`).
   */
  async function deadlineCase(manifestSec: number | undefined, requestSec: number | undefined) {
    const m = manifest(WAITER, manifestSec === undefined ? {} : { limits: { max_runtime_sec: manifestSec } });
    const taskId = await admit(m, requestSec === undefined ? {} : { grant: { max_runtime_sec: requestSec } });
    const admitted = await taskRow(taskId);
    await claim(taskId);
    return { taskId, admitted, claimed: await taskRow(taskId), run: await runRow(taskId) };
  }

  /** The real AppRunner on the run with its clock at `deadline + offsetMs`; the run's state after it had time to move. */
  async function stopsAt(taskId: string, deadlineMs: number) {
    let offset = deadlineMs - 60_000 - Date.now();
    const now = () => Date.now() + offset;
    const runner = runnerFor(taskId, { USER_DATA_PATH: fresh() }, { now });
    const done = runner.run(AbortSignal.timeout(60_000));
    try {
      await until("the application up", async () => (await runRow(taskId)).state === "running");
      // A second before the deadline the run goes on.
      offset = deadlineMs - 1_000 - Date.now();
      await new Promise((r) => setTimeout(r, 600));
      assert.equal((await runRow(taskId)).state, "running", "not stopped before the deadline");
      // At the deadline it is stopped, as `deadline`.
      offset = deadlineMs - Date.now();
      const result = await done;
      assert.equal(result.kind, "ended");
      const { app: a } = await readBoth(taskId);
      assert.equal(a.outcome.cause, "deadline");
      assert.equal(a.last_exit.cause, "deadline");
      const at = Date.parse(a.last_exit.at);
      assert.ok(at >= deadlineMs && at < deadlineMs + 1_000, `stopped at the deadline (${a.last_exit.at} vs ${new Date(deadlineMs).toISOString()})`);
    } finally {
      // Let the application go whatever happened above, so no shell outlives the test.
      const dir = (await runRow(taskId)).state_dir as string | null;
      if (dir) { try { writeFileSync(join(dir, "go"), ""); } catch { /* gone */ } }
      await done.catch(() => undefined);
    }
  }

  test("deadline_at: the manifest's limit when it is below the request's, counted from the run's creation; the Brain stops it then", async () => {
    const c = await deadlineCase(3_600, 7_200);
    const created = (c.run.created_at as Date).getTime();
    assert.equal((c.admitted.deadline_at as Date).getTime(), created + 3_600_000, "set at admission");
    assert.equal((c.claimed.deadline_at as Date).getTime(), created + 3_600_000, "kept by the claim's stamp");
    assert.equal(c.claimed.metadata.app_max_runtime_sec, 3_600, "recorded for the Brain, which reads it with the run");
    assert.deepEqual(c.run.manifest.limits, { max_runtime_sec: 3_600 }, "the manifest is stored as the plugin has it");
    assert.equal(c.claimed.metadata.app_stop_grace_sec, 1);
    assert.equal(new Date((await readTask(c.taskId)).deadline_at).getTime(), created + 3_600_000, "GET /v1/tasks/:id says the same");
    await stopsAt(c.taskId, created + 3_600_000);
  });

  test("deadline_at: the request's grant when it is below the manifest's limit; the Brain stops it then", async () => {
    const c = await deadlineCase(7_200, 1_800);
    const created = (c.run.created_at as Date).getTime();
    assert.equal((c.claimed.deadline_at as Date).getTime(), created + 1_800_000);
    assert.equal(c.claimed.metadata.app_max_runtime_sec, 1_800, "the smaller one is the run's limit");
    assert.deepEqual(c.run.manifest.limits, { max_runtime_sec: 7_200 }, "the manifest is stored as the plugin has it");
    await stopsAt(c.taskId, created + 1_800_000);
  });

  test("deadline_at: a request's grant alone sets it; with neither, the generic budget from the start, as before", async () => {
    const only = await deadlineCase(undefined, 900);
    assert.equal((only.claimed.deadline_at as Date).getTime(), (only.run.created_at as Date).getTime() + 900_000);
    assert.equal(only.claimed.metadata.app_max_runtime_sec, 900);
    assert.equal(only.run.manifest.limits, undefined, "the manifest is stored as the plugin has it");

    const none = await deadlineCase(undefined, undefined);
    assert.equal(none.admitted.deadline_at, null, "no limit: nothing set at admission");
    assert.equal(none.run.manifest.limits, undefined, "the stored manifest is the plugin's");
    assert.equal(none.claimed.metadata.app_max_runtime_sec, undefined, "no limit recorded");
    const { RUN_BUDGET_DEFAULT_SEC } = await import("../src/tasks/run-budget.js");
    assert.equal(none.claimed.origin, "task");
    assert.equal(
      (none.claimed.deadline_at as Date).getTime() - (none.claimed.started_at as Date).getTime(),
      RUN_BUDGET_DEFAULT_SEC.dag_node * 1000,
      "the task budget from the start, as for any task",
    );
    assert.equal(none.claimed.metadata.app_stop_grace_sec, 1);
  });

  test("a task that is not an app run: its deadline is the generic budget from its start, unchanged", async () => {
    const { insertTask, transitionStatus } = await import("../src/tasks/db.js");
    const { RUN_BUDGET_DEFAULT_SEC } = await import("../src/tasks/run-budget.js");
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s-plain', 't', 'u1', 'claw') ON CONFLICT DO NOTHING");
    await insertTask({ task_id: "ktsk_plain_deadline", session_id: "s-plain", name: "t", mode: "script", status: "queued", origin: "task", script: [] });
    assert.equal((await taskRow("ktsk_plain_deadline")).deadline_at, null);
    await transitionStatus("ktsk_plain_deadline", ["queued"], "preparing");
    const row = await taskRow("ktsk_plain_deadline");
    assert.equal((row.deadline_at as Date).getTime() - (row.started_at as Date).getTime(), RUN_BUDGET_DEFAULT_SEC.dag_node * 1000);
    assert.equal(row.metadata?.app_stop_grace_sec, undefined);
  });

  test("the deadline backstop: an app run is closed only after its stop grace past the grace; any other task as before", async () => {
    const sweeper = await import("../src/tasks/sweeper.js");
    const { RUN_BUDGET_BACKSTOP_GRACE_SEC } = await import("../src/tasks/run-budget.js");
    Object.assign(sweeper.interruptPublisher, { available: () => false });
    const grace = RUN_BUDGET_BACKSTOP_GRACE_SEC;
    const appRun = await deadlineCase(3_600, undefined);
    await q("UPDATE claw_tasks SET metadata = metadata || '{\"app_stop_grace_sec\": 600}'::jsonb WHERE task_id = $1", [appRun.taskId]);
    await q("UPDATE claw_tasks SET status = 'running', started_at = NOW() WHERE task_id = 'ktsk_plain_deadline'");
    const pastBy = async (taskId: string, sec: number) =>
      q("UPDATE claw_tasks SET deadline_at = NOW() - ($2::int * INTERVAL '1 second') WHERE task_id = $1", [taskId, sec]);
    const statusOf = async (taskId: string) => (await taskRow(taskId)).status as string;

    // Past the grace by 10 s: the plain task is closed; the app run is still in its stop grace.
    await pastBy("ktsk_plain_deadline", grace + 10);
    await pastBy(appRun.taskId, grace + 10);
    await sweeper.reapStaleTasks();
    assert.equal(await statusOf("ktsk_plain_deadline"), "failed", "a task that is not an app run: as before");
    assert.equal(await statusOf(appRun.taskId), "running", "the Brain is still stopping the app run");

    // Ten seconds short of grace + stop grace: still the Brain's.
    await pastBy(appRun.taskId, grace + 600 - 10);
    await sweeper.reapStaleTasks();
    assert.equal(await statusOf(appRun.taskId), "running");

    // Past grace + stop grace: the backstop closes it, as a budget exhausted.
    await pastBy(appRun.taskId, grace + 600 + 10);
    await sweeper.reapStaleTasks();
    const closed = await taskRow(appRun.taskId);
    assert.equal(closed.status, "failed");
    const reason = (await q("SELECT failure_reason FROM claw_tasks WHERE task_id = $1", [appRun.taskId])).rows[0] as Json;
    assert.equal(reason.failure_reason, "run_budget_exhausted");

    // A run admitted before the stop grace was recorded waits the ceiling.
    const old = await deadlineCase(3_600, undefined);
    await q("UPDATE claw_tasks SET metadata = metadata - 'app_stop_grace_sec' WHERE task_id = $1", [old.taskId]);
    await pastBy(old.taskId, grace + 3_600 - 10);
    await sweeper.reapStaleTasks();
    assert.equal(await statusOf(old.taskId), "running");
    await pastBy(old.taskId, grace + 3_600 + 10);
    await sweeper.reapStaleTasks();
    assert.equal(await statusOf(old.taskId), "failed");

    // An app run no worker ever took (no lease, started long ago, deadline ahead) is
    // still closed by the never-claimed arm: the stop grace is only a deadline's.
    const unclaimed = await deadlineCase(3_600, undefined);
    await q(
      `UPDATE claw_tasks SET lease_owner = NULL, lease_expires_at = NULL, started_at = NOW() - interval '7 days',
              deadline_at = NOW() + interval '1 hour' WHERE task_id = $1`,
      [unclaimed.taskId],
    );
    await sweeper.reapStaleTasks();
    const never = (await q("SELECT status, failure_reason FROM claw_tasks WHERE task_id = $1", [unclaimed.taskId])).rows[0] as Json;
    assert.deepEqual({ status: never.status, failure_reason: never.failure_reason }, { status: "failed", failure_reason: "brain_timeout" });
  });
});
