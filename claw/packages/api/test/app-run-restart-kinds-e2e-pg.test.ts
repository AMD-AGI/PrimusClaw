// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two kinds of restart an app run has, told apart on the task and run APIs,
 * and the longest time limit admission takes, end to end.
 *
 * `app.restarts` counted only the restarts spent of `restart.max_restarts` (the
 * application's own failures); a sandbox the platform took away and replaced was in
 * no count at all. Now `app.crash_restarts` is the first, `app.platform_losses` the
 * second, and `app.restarts` their total. Both come from the Brain's own accounting:
 * the run row's `restarts` and `last_exit.platform_losses`, which the Brain now keeps
 * on every `last_exit` it writes, the run's end included.
 *
 * And a run's time limit is at most 2147483 seconds: the Brain stops the run with a
 * timer, and Node fires a timer longer than 2^31 - 1 ms after 1 ms.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const WORKSPACE = "ws-app-restart-kinds";
const OWNER_KEY = "pk-owner-app-restart-kinds";
/** Marks every application shell this file starts, so `after` can look for any left. */
const MARK = `claw-restart-kinds-e2e-${process.pid}`;

const workloads = new Map<string, { runId: string; stopped: boolean }>();
const wid = () => `claw-${Date.now()}-sandbox-${Math.random().toString(36).slice(2, 7)}`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

/**
 * SaFE's workload API as these runs need it: every create is Running at once. A
 * workload the test removes from `workloads` is one the platform took away: SaFE
 * answers 404 for it, as for a sandbox whose node was lost.
 */
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
 * An application whose starts take turns: it counts them in its state directory.
 * Start 1 and start 3 crash at once (`exit.json` with return code 10 + the start,
 * no `final`). Every other start waits for `go-<start>` (or for the directory to go);
 * start 5 then ends with `final`, and any other (one whose sandbox the platform took
 * away, and that nothing will look at again) just exits.
 */
const TAKES_TURNS = `: ${MARK}; trap '' TERM; n=$(cat "$APP_STATE_DIR/starts" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$APP_STATE_DIR/starts"; `
  + `case "$n" in 1|3) printf '{"returncode": %d}' $((10 + n)) > "$APP_STATE_DIR/exit.json"; exit 1;; esac; `
  + `while [ ! -f "$APP_STATE_DIR/go-$n" ]; do [ -d "$APP_STATE_DIR" ] || exit 0; sleep 0.1; done; `
  + `if [ "$n" = 5 ]; then printf '{"final": true, "returncode": 0}' > "$APP_STATE_DIR/exit.json"; fi; exit 0`;

function manifest(command: string, over: Record<string, unknown> = {}) {
  return {
    schema: APP_MANIFEST_SCHEMA,
    name: "example-app",
    version: "1.0.0",
    container: {},
    state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
    command: ["sh", "-c", command],
    env_map: { state_dir: "APP_STATE_DIR" },
    restart: { max_restarts: 3, backoff_sec: [1] },
    stop_grace_sec: 1,
    ...over,
  };
}

type Json = Record<string, any>;

describe("an app run's crash restarts and platform losses, and the longest time limit admission takes", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let safe: Server;
  let base = "";
  const dirs: string[] = [];
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), "claw-app-restart-kinds-")); dirs.push(d); return d; };
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

  /** POST /v1/sessions/:id/tasks for an app run of `m`, in a session of its own. */
  async function submit(m: Record<string, unknown>, resources: Record<string, unknown> = {}) {
    const sessionId = `s-app-restart-kinds-${++sessions}`;
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
    return { res, sessionId };
  }
  /** A run created through the task route. Not claimed yet. */
  async function admit(m: Record<string, unknown>, resources: Record<string, unknown> = {}) {
    const { res, sessionId } = await submit(m, resources);
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

  function runnerFor(taskId: string, env: Record<string, string>) {
    const store = brain.httpAppRunStore({
      baseUrl: () => base,
      headers: (hasBody) => ({ authorization: `Bearer ${INTERNAL}`, ...(hasBody ? { "content-type": "application/json" } : {}) }),
      brainId: "brain-A",
      claimCount: EPOCH,
    });
    const cwd = fresh();
    const sandbox = { ...brain.realAppSandbox(store), exec: async (_i: unknown, command: string, _t: string, o?: { env?: Record<string, string> }) => sh(command, cwd, { ...env, ...(o?.env ?? {}) }) };
    return new brain.AppRunner(taskId, OWNER_KEY, { store, sandbox: sandbox as never, tickMs: 100, claimCount: EPOCH });
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
  /** `app` as both routes show it (they must agree). */
  async function appOf(taskId: string): Promise<Json> {
    const [task, run] = [await readTask(taskId), await readRun(taskId)];
    assert.deepEqual(task.app, run.app, "GET /v1/tasks/:id and GET /v1/runs say the same");
    return run.app;
  }
  const counts = (a: Json) => ({ restarts: a.restarts, crash_restarts: a.crash_restarts, platform_losses: a.platform_losses });
  async function until(what: string, check: () => Promise<boolean>, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
  }
  const runRow = async (taskId: string) =>
    (await q("SELECT state, restarts, last_exit, state_dir, sandbox_workload_id, created_at FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as Json;
  const starts = (dir: string) => { try { return Number(readFileSync(join(dir, "starts"), "utf8").trim()); } catch { return 0; } };

  test("crashes and platform losses, each counted on its own, their total as restarts, kept to the run's end", async () => {
    const taskId = await admit(manifest(TAKES_TURNS));
    await claim(taskId);
    const runner = runnerFor(taskId, { USER_DATA_PATH: fresh() });
    const done = runner.run(AbortSignal.timeout(90_000));
    let dir = "";
    /** The run's application is up for its `n`th start. */
    const upFor = async (n: number) => {
      await until(`start ${n} running`, async () => {
        const row = await runRow(taskId);
        dir = row.state_dir ?? dir;
        return row.state === "running" && dir !== "" && starts(dir) === n;
      });
    };
    /** The platform takes the run's sandbox away; wait for the run to be running in a new one. */
    const lose = async (next: number) => {
      const gone = (await runRow(taskId)).sandbox_workload_id as string;
      assert.ok(workloads.delete(gone), "the platform took the sandbox away");
      await upFor(next);
      assert.notEqual((await runRow(taskId)).sandbox_workload_id, gone, "a new sandbox was made");
    };
    try {
      // Start 1 crashed and was restarted: one crash restart, nothing lost.
      await upFor(2);
      let a = await appOf(taskId);
      assert.deepEqual(counts(a), { restarts: 1, crash_restarts: 1, platform_losses: 0 });
      assert.deepEqual({ cause: a.last_exit.cause, returncode: a.last_exit.returncode }, { cause: "exited", returncode: 11 });

      // The platform takes start 2's sandbox away; a new one is made. Not a crash.
      await lose(3 + 1); // start 3 crashes at once, so the run is up again on start 4
      a = await appOf(taskId);
      assert.deepEqual(counts(a), { restarts: 3, crash_restarts: 2, platform_losses: 1 }, "one loss, then start 3's crash");
      assert.deepEqual({ cause: a.last_exit.cause, returncode: a.last_exit.returncode }, { cause: "exited", returncode: 13 });
      assert.equal(a.outcome, null);
      assert.equal((await readTask(taskId)).status, "running", "the task reads running throughout");
      const row = await runRow(taskId);
      assert.deepEqual({ restarts: row.restarts, platform_losses: row.last_exit.platform_losses }, { restarts: 2, platform_losses: 1 },
        "what the API says is what the Brain's accounting on the row says");

      // And start 4's sandbox: a second loss, the crash count unchanged.
      await lose(5);
      a = await appOf(taskId);
      assert.deepEqual(counts(a), { restarts: 4, crash_restarts: 2, platform_losses: 2 });
      assert.deepEqual({ cause: a.last_exit.cause, returncode: a.last_exit.returncode }, { cause: "sandbox_lost", returncode: null });

      // Start 5 ends with final: the run ends as exited, and the counts stay as they were.
      writeFileSync(join(dir, "go-5"), "");
      const result = await done;
      assert.equal(result.kind, "ended");
      const end = await appOf(taskId);
      assert.deepEqual(end.outcome, { cause: "exited", returncode: 0, final: true, error: null });
      assert.deepEqual(counts(end), { restarts: 4, crash_restarts: 2, platform_losses: 2 }, "an ended run still says what it went through");
      assert.equal((await runRow(taskId)).last_exit.platform_losses, 2, "kept on the final exit's record");
      assert.equal(starts(dir), 5);
    } finally {
      // The applications in the lost sandboxes were told nothing; let them go.
      if (dir) for (const n of [2, 4, 5]) { try { writeFileSync(join(dir, `go-${n}`), ""); } catch { /* gone */ } }
      await done.catch(() => undefined);
    }
  });

  test("a platform loss with no restart allowed is the run's end, as before, and counted as neither", async () => {
    const taskId = await admit(manifest(TAKES_TURNS, { restart: { max_restarts: 0, backoff_sec: [1] } }));
    await claim(taskId);
    const runner = runnerFor(taskId, { USER_DATA_PATH: fresh() });
    const done = runner.run(AbortSignal.timeout(60_000));
    let dir = "";
    try {
      // Start 1 crashes with no restart left: the run ends on it.
      assert.equal((await done).kind, "ended");
      dir = (await runRow(taskId)).state_dir;
      const end = await appOf(taskId);
      assert.deepEqual(counts(end), { restarts: 0, crash_restarts: 0, platform_losses: 0 });
      assert.equal(end.outcome.cause, "restarts_exhausted");
    } finally {
      if (dir) { try { writeFileSync(join(dir, "go-1"), ""); } catch { /* gone */ } }
    }
    // A second run whose first start does not crash: the platform takes its sandbox away while it runs.
    const second = await admit(manifest(TAKES_TURNS.replace("1|3)", "3)"), { restart: { max_restarts: 0, backoff_sec: [1] } }));
    await claim(second);
    const r2 = runnerFor(second, { USER_DATA_PATH: fresh() });
    const d2 = r2.run(AbortSignal.timeout(60_000));
    let dir2 = "";
    try {
      await until("start 1 running", async () => { const row = await runRow(second); dir2 = row.state_dir ?? ""; return row.state === "running" && dir2 !== "" && starts(dir2) === 1; });
      assert.ok(workloads.delete((await runRow(second)).sandbox_workload_id));
      assert.equal((await d2).kind, "ended");
      const end = await appOf(second);
      assert.deepEqual(counts(end), { restarts: 0, crash_restarts: 0, platform_losses: 0 }, "no new sandbox was made");
      assert.equal(end.outcome.cause, "restarts_exhausted");
    } finally {
      if (dir2) { try { writeFileSync(join(dir2, "go-1"), ""); } catch { /* gone */ } }
      await d2.catch(() => undefined);
    }
  });

  test("admission: a time limit of 2147483 s is taken and is the task's deadline; 2147484 s is refused, from the request or the manifest", async () => {
    const EXITS = `: ${MARK}; exit 0`;
    // The request's grant.
    const fromRequest = await admit(manifest(EXITS), { grant: { max_runtime_sec: 2_147_483 } });
    const row = await runRow(fromRequest);
    const task = (await q("SELECT deadline_at, metadata FROM claw_tasks WHERE task_id = $1", [fromRequest])).rows[0] as Json;
    assert.equal((task.deadline_at as Date).getTime(), (row.created_at as Date).getTime() + 2_147_483_000);
    assert.equal(task.metadata.app_max_runtime_sec, 2_147_483);
    const refusedRequest = await submit(manifest(EXITS), { grant: { max_runtime_sec: 2_147_484 } });
    assert.equal(refusedRequest.res.statusCode, 400, refusedRequest.res.body);
    assert.equal(refusedRequest.res.json().error, "app_resources_invalid");
    assert.deepEqual(refusedRequest.res.json().problems, [
      { field: "resources.grant.max_runtime_sec", reason: "must be a whole number of seconds >= 1 and <= 2147483" },
    ]);

    // The manifest's limits.
    const fromManifest = await admit(manifest(EXITS, { limits: { max_runtime_sec: 2_147_483 } }));
    const mrow = await runRow(fromManifest);
    const mtask = (await q("SELECT deadline_at FROM claw_tasks WHERE task_id = $1", [fromManifest])).rows[0] as Json;
    assert.equal((mtask.deadline_at as Date).getTime(), (mrow.created_at as Date).getTime() + 2_147_483_000);
    const refusedManifest = await submit(manifest(EXITS, { limits: { max_runtime_sec: 2_147_484 } }), { grant: { max_runtime_sec: 60 } });
    assert.equal(refusedManifest.res.statusCode, 400, refusedManifest.res.body);
    assert.equal(refusedManifest.res.json().error, "app_resources_invalid");
    assert.deepEqual(refusedManifest.res.json().problems, [
      { field: "manifest.limits.max_runtime_sec", reason: "must be a whole number of seconds >= 1 and <= 2147483" },
    ]);
    // Nothing was made for a refusal.
    const made = (await q("SELECT count(*)::int AS n FROM claw_app_runs r JOIN claw_tasks t ON t.task_id = r.task_id WHERE t.session_id = ANY($1::text[])",
      [[refusedRequest.sessionId, refusedManifest.sessionId]])).rows[0] as Json;
    assert.equal(made.n, 0);
  });
});
