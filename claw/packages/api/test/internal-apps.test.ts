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
  container: {},
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", "exec app"],
  restart: { max_restarts: 2, backoff_sec: [5] },
  env_map: { mcp_token: "APP_MCP_TOKEN" },
  mcp: { port: 8765, path: "/mcp", token_header: "X-App-Token" },
};
const INPUT = { note: "the app's own request; Claw does not read it" };
const RESOURCES = { image: "registry.example.invalid/app:1", gpus: 0, workspace: "ws-ok" };

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
  const EPOCH = 3;
const brain = (extra: Record<string, unknown>) => ({ brain_id: "brain-A", claim_count: EPOCH, ...extra });
/** The run's lease as a live worker holds it: brain-A, valid for an hour, at epoch EPOCH. */
const holdLease = (id: string) => q(
  "UPDATE claw_tasks SET lease_owner = 'brain-A', lease_expires_at = NOW() + interval '1 hour', claim_count = $2 WHERE task_id = $1", [id, EPOCH],
);

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
      payload: { mode: "app", plugin_id: plugin, input: INPUT, resources: RESOURCES },
    });
    assert.equal(res.statusCode, 200, res.body);
    const id = res.json().task_id as string;
    await holdLease(id);
    return id;
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
      assert.equal(run.sandbox_spec.image, RESOURCES.image);
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

    test("the fence: the live lease holder at the epoch it quoted, and nobody else", async () => {
      const refused = async (body: Record<string, unknown>, why: string) => {
        const res = await patch(body);
        assert.equal(res.statusCode, 409, `${why}: ${res.body}`);
        assert.equal(res.json().error, "not_holder", why);
        assert.equal((await row()).state, "provisioning", `${why}: the stale writer changed nothing`);
      };
      await refused({ brain_id: "brain-B", claim_count: EPOCH, state: "starting" }, "another brain");
      await refused({ brain_id: "brain-A", claim_count: EPOCH - 1, state: "starting" }, "an earlier attempt of the same brain");
      await refused({ brain_id: "brain-A", claim_count: EPOCH + 1, state: "starting" }, "a later epoch than the row has");
      await q("UPDATE claw_tasks SET lease_expires_at = NOW() - interval '1 second' WHERE task_id = $1", [taskId]);
      await refused(brain({ state: "starting" }), "an expired lease");
      await q("UPDATE claw_tasks SET lease_owner = NULL, lease_expires_at = NOW() + interval '1 hour' WHERE task_id = $1", [taskId]);
      await refused(brain({ state: "starting" }), "a released lease: nobody holds it, so nobody writes");
      await refused({ brain_id: "brain-B", claim_count: EPOCH, state: "running" }, "a released lease, any brain");
      await holdLease(taskId);
      assert.equal((await patch(brain({ state: "starting" }))).statusCode, 200, "the holder, at its epoch, writes");
      assert.equal((await patch({ brain_id: "brain-A", state: "running" })).statusCode, 400, "an epoch must be quoted");
      assert.equal((await patch({ brain_id: "brain-A", state: "running" })).json().error, "claim_count_required");
    });

    test("a takeover that commits while a write waits is seen: the stale holder does not write", async () => {
      const client = await h.app.db.db.pool.connect();
      try {
        // The new claim is in flight: it holds the task row and has not committed.
        await client.query("BEGIN");
        await client.query("UPDATE claw_tasks SET lease_owner = 'brain-B', claim_count = claim_count + 1 WHERE task_id = $1", [taskId]);
        const stale = patch(brain({ state: "starting" })); // brain-A at the old epoch: blocks on the row lock
        await new Promise((r) => setTimeout(r, 300));
        await client.query("COMMIT");
        const res = await stale;
        assert.equal(res.statusCode, 409, res.body);
        assert.equal(res.json().error, "not_holder");
        assert.equal((await row()).state, "provisioning", "the stale write changed nothing");
      } finally {
        client.release();
      }
    });

    test("restarts only move forward, and the answer is the row as written", async () => {
      assert.equal((await patch(brain({ restarts: 2, state: "restarting" }))).statusCode, 200);
      const back = await patch(brain({ restarts: 1, state: "starting" }));
      assert.equal(back.statusCode, 409);
      assert.equal(back.json().error, "state_mismatch");
      const same = await patch(brain({ restarts: 2, state: "starting" }));
      assert.equal(same.statusCode, 200);
      const r = await row();
      assert.equal(r.restarts, 2);
      assert.equal(same.json().run.restarts, 2);
      assert.equal(same.json().run.state, "starting");
      assert.equal(same.json().run.workspace_id, "ws-ok", "the answer carries the joined task fields without a second read");
    });

    test("a secret that cannot be opened does not block a transition: the free text is dropped, the rest is stored", async () => {
      await q("UPDATE claw_app_runs SET mcp_token_enc = 'not-a-sealed-secret' WHERE task_id = $1", [taskId]);
      const plain = await patch(brain({ state: "finishing", last_exit: { at: "t", cause: "exit", final: false, returncode: 4 } }));
      assert.equal(plain.statusCode, 200, "no free text, so nothing needed opening");
      const texty = await patch(brain({ last_exit: { at: "t", cause: "exit", final: false, returncode: 4, stop_reason: "x", error: "rate limit" } }));
      assert.equal(texty.statusCode, 200, texty.body);
      assert.deepEqual((await row()).last_exit, { at: "t", cause: "exit", final: false, returncode: 4 });
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
        ["brain_id_required", { state: "starting", claim_count: EPOCH }],
        ["claim_count_required", { brain_id: "brain-A", state: "starting" }],
        ["claim_count_required", { brain_id: "brain-A", claim_count: -1, state: "starting" }],
        ["claim_count_required", { brain_id: "brain-A", claim_count: 1.5, state: "starting" }],
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
      await q("UPDATE claw_app_runs SET grant_expires_at = '2026-02-01T00:00:00Z' WHERE task_id = $1", [taskId]);
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

    test("a grant's expiry only moves later, and only for a live grant that has an expiry", async () => {
      taskId = await createRun(true);
      const T1 = "2026-03-01T12:00:00.000Z", T2 = "2026-03-02T12:00:00.000Z";
      // A grant with no expiry does not lapse: nothing is set on it.
      assert.equal((await row()).grant_expires_at, null);
      const none = await patch(brain({ grant_expires_at: T1 }));
      assert.equal(none.statusCode, 409, none.body);
      assert.equal(none.json().error, "grant_refused");
      assert.equal((await row()).grant_expires_at, null);
      await q("UPDATE claw_app_runs SET grant_expires_at = $2 WHERE task_id = $1", [taskId, T1]);
      for (const earlier of [T1, "2026-02-01T00:00:00.000Z"]) {
        const res = await patch(brain({ grant_expires_at: earlier }));
        assert.equal(res.statusCode, 409, `${earlier}: ${res.body}`);
        assert.equal(res.json().error, "grant_refused");
      }
      assert.equal(new Date((await row()).grant_expires_at).toISOString(), T1);
      assert.equal((await patch(brain({ grant_expires_at: T2 }))).statusCode, 200);
      assert.equal(new Date((await row()).grant_expires_at).toISOString(), T2);
    });

    test("a run with no grant takes no expiry and records no revoke; a revoke is stamped once", async () => {
      taskId = await createRun(false);
      assert.equal((await row()).grant_id, null);
      for (const body of [{ grant_expires_at: "2027-01-01T00:00:00.000Z" }, { grant_revoked: true }]) {
        const res = await patch(brain(body));
        assert.equal(res.statusCode, 409, JSON.stringify(body));
        assert.equal(res.json().error, "grant_refused");
      }
      taskId = await createRun(true);
      await q("UPDATE claw_app_runs SET grant_expires_at = '2026-03-01T00:00:00Z' WHERE task_id = $1", [taskId]);
      const first = await patch(brain({ grant_revoked: true }));
      assert.equal(first.statusCode, 200, first.body);
      const stamp = (await row()).grant_revoked_at;
      assert.ok(stamp);
      assert.equal(first.json().run.grant_revoked_at, new Date(stamp).toISOString());
      await new Promise((r) => setTimeout(r, 20));
      assert.equal((await patch(brain({ grant_revoked: true }))).statusCode, 200);
      assert.equal(new Date((await row()).grant_revoked_at).getTime(), new Date(stamp).getTime(), "stamped once");
      // And once revoked, the expiry is not moved.
      const later = await patch(brain({ grant_expires_at: "2030-01-01T00:00:00.000Z" }));
      assert.equal(later.statusCode, 409);
      assert.equal(later.json().error, "grant_refused");
      assert.equal((await patch(brain({ grant_revoked: false }))).json().error, "grant_revoked_invalid");
    });

    test("an unknown run is 404", async () => {
      const res = await app.inject({ method: "PATCH", url: "/v1/internal/app-runs/nope", headers: auth, payload: brain({ state: "starting" }) });
      assert.equal(res.statusCode, 404);
    });
  });
});
