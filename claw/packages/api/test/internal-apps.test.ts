// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/v1/internal/app-runs/*`: the AppRunner's reads and writes of its row, over
 * the real routes against a real Postgres whose schema `initDb` built.
 *
 * Each refusal is paired with the same request accepted, and asserts that the
 * row did not change, because a route that refuses everything would pass the
 * refusals alone. Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA } from "@claw/protocol";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const INTERNAL = "internal-test-token-0123456789";
const KEY = "e2b_measurementKEY0123456789abcdef";

const MANIFEST = {
  schema: APP_MANIFEST_SCHEMA,
  name: "example-app",
  version: "1.0.0",
  container: { image_from_input: "/image", workspace_from_input: "/ws" },
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", "exec app"],
  restart: { max_restarts: 2, backoff_sec: [5] },
  env_map: { mcp_token: "APP_MCP_TOKEN" },
  mcp: { port: 8765, path: "/mcp", token_header: "X-App-Token" },
};
const INPUT = { image: "registry.example.invalid/app:1", ws: "ws-ok" };

describe("internal app-run routes", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let secrets: typeof import("../src/crypto/app-run-secrets.js");
  let ports: any;
  let plugin = 0;
  let taskId = "";
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);
  const row = async () => (await q("SELECT * FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as any;
  const auth = { authorization: `Bearer ${INTERNAL}` };
  const get = (url: string, headers: Record<string, string> = auth) => app.inject({ method: "GET", url, headers });
  const patch = (body: unknown, headers: Record<string, string> = auth) =>
    app.inject({ method: "PATCH", url: `/v1/internal/app-runs/${taskId}`, payload: body as object, headers });
  const brain = (extra: Record<string, unknown>) => ({ brain_id: "brain-A", ...extra });

  before(async () => {
    process.env.CLAW_DEPLOY_MODE = "safe";
    process.env.AUTH_INTERNAL_TOKEN = INTERNAL;
    h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    secrets = await import("../src/crypto/app-run-secrets.js");
    ports = (await import("../src/tasks/app-run.js")).appRunPorts;
    ports.workspaceAccess = async () => "ok";
    plugin = Number(((await q(
      `INSERT INTO plugins (name, version, resource, owner_user_id, is_public)
       VALUES ('p', '1', $1::jsonb, 'u1', true) RETURNING id`,
      [JSON.stringify({ app: { manifest: MANIFEST } })],
    )).rows[0] as { id: string }).id);
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s1', 't', 'u1', 'claw')");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      if (req.url.startsWith("/v1/internal/")) return;
      (req as any).user = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
    });
    await (await import("../src/routes/tasks.js")).registerTaskCreateRoute(app);
    await (await import("../src/routes/internal-apps.js")).registerInternalAppRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.stop(); });

  async function createRun(grant?: boolean): Promise<string> {
    await q("DELETE FROM claw_app_runs");
    await q("DELETE FROM claw_tasks");
    ports.grant = grant
      ? { issue: async () => ({ keys: { measurement: KEY }, limits: { max_hours: 4 } }) }
      : { issue: async () => undefined };
    const res = await app.inject({
      method: "POST", url: "/v1/sessions/s1/tasks",
      payload: { mode: "app", plugin_id: plugin, input: INPUT },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().task_id as string;
  }
  beforeEach(async () => { taskId = await createRun(); });

  describe("auth", () => {
    const calls = (): Array<[string, string, unknown]> => [
      ["GET", `/v1/internal/app-runs/${taskId}`, undefined],
      ["GET", `/v1/internal/app-runs/${taskId}/secrets`, undefined],
      ["PATCH", `/v1/internal/app-runs/${taskId}`, brain({ state: "starting" })],
    ];
    const bearer = (t: string | undefined) => (t === undefined ? {} : { authorization: `Bearer ${t}` });

    test("a request without the internal token is refused, and nothing is read or written", async () => {
      for (const [method, url, payload] of calls()) {
        for (const headers of [bearer(undefined), bearer("wrong"), bearer(""), { authorization: INTERNAL.slice(0, 5) }]) {
          const res = await app.inject({ method: method as "GET", url, headers, payload: payload as object });
          assert.equal(res.statusCode, 401, `${method} ${url} with ${JSON.stringify(headers)}`);
          assert.ok(!res.body.includes("cmt_"), "a refusal never carries a secret");
        }
      }
      assert.equal((await row()).state, "provisioning");
    });

    test("the same requests with the token are answered", async () => {
      assert.equal((await get(`/v1/internal/app-runs/${taskId}`)).statusCode, 200);
      assert.equal((await get(`/v1/internal/app-runs/${taskId}/secrets`)).statusCode, 200);
      assert.equal((await patch(brain({ state: "starting" }))).statusCode, 200);
    });

    test("a run token, which is a different credential, is not accepted", async () => {
      await q("UPDATE claw_tasks SET internal_token_hash = 'x' WHERE task_id = $1", [taskId]);
      assert.equal((await get(`/v1/internal/app-runs/${taskId}`, bearer("a-per-run-token"))).statusCode, 401);
    });
  });

  describe("reads", () => {
    test("the run row comes with what it was asked to do, and with no secret in it", async () => {
      const res = await get(`/v1/internal/app-runs/${taskId}`);
      assert.equal(res.statusCode, 200);
      const { run } = res.json();
      assert.equal(run.run_id, taskId);
      assert.equal(run.state, "provisioning");
      assert.equal(run.restarts, 0);
      assert.equal(run.state_dir, null);
      assert.equal(run.sandbox_workload_id, null);
      assert.deepEqual(run.manifest, MANIFEST);
      assert.deepEqual(run.input, INPUT);
      assert.equal(run.workspace_id, "ws-ok");
      assert.equal(run.sandbox_spec.image, INPUT.image);
      assert.ok(typeof run.created_at === "string" && !Number.isNaN(Date.parse(run.created_at)));
      const token = secrets.openAppRunSecret((await row()).mcp_token_enc, taskId, "mcp_token");
      assert.ok(!res.body.includes(token), "the state read never carries the token");
      assert.ok(!res.body.includes("mcp_token_enc") && !res.body.includes("grant_keys"));
    });

    test("an unknown run is 404", async () => {
      assert.equal((await get("/v1/internal/app-runs/nope")).statusCode, 404);
      assert.equal((await get("/v1/internal/app-runs/nope/secrets")).statusCode, 404);
    });

    test("the secrets route opens the token; keys when a grant was issued", async () => {
      const plain = (await get(`/v1/internal/app-runs/${taskId}/secrets`)).json();
      assert.equal(plain.ok, true);
      assert.equal(plain.mcp_token, secrets.openAppRunSecret((await row()).mcp_token_enc, taskId, "mcp_token"));
      assert.match(plain.mcp_token, /^cmt_/);
      assert.equal(plain.grant_keys, null);

      taskId = await createRun(true);
      const granted = (await get(`/v1/internal/app-runs/${taskId}/secrets`)).json();
      assert.deepEqual(granted.grant_keys, { measurement: KEY });
      assert.deepEqual((await get(`/v1/internal/app-runs/${taskId}`)).json().run.grant_limits, { max_hours: 4 });
    });
  });

  describe("writes", () => {
    test("a transition and its fields land together", async () => {
      const res = await patch(brain({
        expect_state: "provisioning", state: "starting", sandbox_workload_id: "wl-1", state_dir: "/data/.claw-apps/x",
      }));
      assert.equal(res.statusCode, 200, res.body);
      const r = await row();
      assert.equal(r.state, "starting");
      assert.equal(r.sandbox_workload_id, "wl-1");
      assert.equal(r.state_dir, "/data/.claw-apps/x");
      assert.equal(res.json().run.state, "starting");
    });

    test("restarts, last_exit and a cleared workload id", async () => {
      await patch(brain({ sandbox_workload_id: "wl-1" }));
      const res = await patch(brain({
        state: "provisioning", restarts: 2, sandbox_workload_id: null,
        last_exit: { at: "2026-01-01T00:00:00Z", cause: "sandbox_lost", final: false },
      }));
      assert.equal(res.statusCode, 200, res.body);
      const r = await row();
      assert.equal(r.restarts, 2);
      assert.equal(r.sandbox_workload_id, null);
      assert.deepEqual(r.last_exit, { at: "2026-01-01T00:00:00Z", cause: "sandbox_lost", final: false });
    });

    test("expect_state is a compare-and-set: a stale expectation changes nothing", async () => {
      const stale = await patch(brain({ expect_state: "running", state: "finishing" }));
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error, "state_mismatch");
      assert.equal(stale.json().current_state, "provisioning");
      assert.equal((await row()).state, "provisioning");
      assert.equal((await patch(brain({ expect_state: "provisioning", state: "starting" }))).statusCode, 200);
    });

    test("the fence: only the lease holder writes; with nobody holding it anyone may", async () => {
      await q("UPDATE claw_tasks SET lease_owner = 'brain-A' WHERE task_id = $1", [taskId]);
      const other = await patch({ brain_id: "brain-B", state: "starting" });
      assert.equal(other.statusCode, 409);
      assert.equal(other.json().error, "not_holder");
      assert.equal((await row()).state, "provisioning", "the stale writer changed nothing");
      assert.equal((await patch(brain({ state: "starting" }))).statusCode, 200);

      await q("UPDATE claw_tasks SET lease_owner = NULL WHERE task_id = $1", [taskId]);
      assert.equal((await patch({ brain_id: "brain-B", state: "running" })).statusCode, 200);
    });

    test("ended is final: nothing moves a run out of it", async () => {
      assert.equal((await patch(brain({ state: "ended", last_exit: { at: "t", cause: "exit", final: true, returncode: 0 } }))).statusCode, 200);
      for (const body of [{ state: "starting" }, { restarts: 9 }, { last_exit: null }, { state: "ended" }]) {
        const res = await patch(brain(body));
        assert.equal(res.statusCode, 409, JSON.stringify(body));
        assert.equal(res.json().error, "ended");
      }
      const r = await row();
      assert.equal(r.state, "ended");
      assert.equal(r.restarts, 0);
      assert.equal(r.last_exit.cause, "exit");
    });

    test("a secret the application put into last_exit is not stored", async () => {
      taskId = await createRun(true);
      const token = secrets.openAppRunSecret((await row()).mcp_token_enc, taskId, "mcp_token");
      const res = await patch(brain({
        last_exit: { at: "t", cause: "exit", final: true, returncode: 3, stop_reason: `held ${token}`, error: `key ${KEY} rejected, token="${token}"` },
      }));
      assert.equal(res.statusCode, 200, res.body);
      const stored = JSON.stringify((await row()).last_exit);
      assert.ok(!stored.includes(token), "the token");
      assert.ok(!stored.includes(KEY), "the grant key");
      assert.ok(stored.includes("[redacted]"));
      assert.ok(!res.body.includes(token) && !res.body.includes(KEY), "nor in the answer");
    });

    test("malformed patches are refused with a reason, and change nothing", async () => {
      const bad: Array<[string, unknown]> = [
        ["brain_id_required", { state: "starting" }],
        ["state_invalid", brain({ state: "exploded" })],
        ["expect_state_invalid", brain({ expect_state: 3, state: "starting" })],
        ["restarts_invalid", brain({ restarts: -1 })],
        ["restarts_invalid", brain({ restarts: 1.5 })],
        ["state_dir_invalid", brain({ state_dir: "relative/dir" })],
        ["state_dir_invalid", brain({ state_dir: "/a\nb" })],
        ["sandbox_workload_id_invalid", brain({ sandbox_workload_id: "" })],
        ["last_exit_invalid", brain({ last_exit: "text" })],
        ["last_exit_too_large", brain({ last_exit: { blob: "x".repeat(5000) } })],
        ["unknown_field:mcp_token_enc", brain({ mcp_token_enc: "x" })],
        ["empty_patch", brain({})],
      ];
      for (const [error, body] of bad) {
        const res = await patch(body);
        assert.equal(res.statusCode, 400, `${error}: ${res.body}`);
        assert.equal(res.json().error, error);
      }
      const r = await row();
      assert.equal(r.state, "provisioning");
      assert.equal(r.restarts, 0);
      assert.equal(r.last_exit, null);
    });

    test("grant_expires_at is stored and read back; a bad value is refused and changes nothing", async () => {
      taskId = await createRun(true);
      const before = await get(`/v1/internal/app-runs/${taskId}`);
      assert.equal(before.json().run.grant_revoked_at, null);
      const T = "2026-03-01T12:00:00.000Z";
      const ok = await patch(brain({ grant_expires_at: T }));
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().run.grant_expires_at, T);
      assert.equal(new Date((await row()).grant_expires_at).toISOString(), T);
      for (const bad of ["tomorrow", "2026-13-45T00:00:00Z", 12345, null, ""]) {
        const res = await patch(brain({ grant_expires_at: bad }));
        assert.equal(res.statusCode, 400, `${JSON.stringify(bad)}: ${res.body}`);
        assert.equal(res.json().error, "grant_expires_at_invalid");
      }
      assert.equal(new Date((await row()).grant_expires_at).toISOString(), T, "refusals changed nothing");
      await q("UPDATE claw_app_runs SET grant_revoked_at = '2026-03-01T13:00:00Z' WHERE task_id = $1", [taskId]);
      const rev = await get(`/v1/internal/app-runs/${taskId}`);
      assert.equal(rev.json().run.grant_revoked_at, "2026-03-01T13:00:00.000Z");
    });

    test("an unknown run is 404", async () => {
      const res = await app.inject({ method: "PATCH", url: "/v1/internal/app-runs/nope", headers: auth, payload: brain({ state: "starting" }) });
      assert.equal(res.statusCode, 404);
    });
  });
});
