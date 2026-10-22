// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `POST /v1/sessions/:sessionId/tasks` with `mode: "app"`, against a real
 * Postgres whose schema `initDb` built.
 *
 * Each refusal is asserted with its own error code AND with the row counts that
 * say nothing was written, and each is paired with the same request admitted,
 * because a route that refuses everything would otherwise pass. The suite is
 * skipped without DATABASE_URL; a skip is not a pass and prints as one.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA, validateAppManifest } from "@claw/protocol";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

const user = (id: string) => ({
  userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}`,
});
const OWNER = user("u1");
const OTHER = user("u2");

const MANIFEST = {
  schema: APP_MANIFEST_SCHEMA,
  name: "example-app",
  version: "1.0.0",
  container: {
    image_from_input: "/framework/image",
    gpus_from_input: "/placement/gpus",
    workspace_from_input: ["/placement/app_workspace", "/placement/gpu_workspace"],
    resources_from_input: { cpu: "/placement/cpu", memory_gi: "/placement/memory_gi" },
    resources: { cpu: "32", memory: "128Gi" },
  },
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", "exec app run"],
  env_map: { run_id: "APP_RUN_ID", mcp_token: "APP_MCP_TOKEN" },
  mcp: { port: 8765, path: "/mcp", token_header: "X-App-Token" },
  sandbox_templates: [
    {
      name: "runner", provider: "safe-pytorchjob", gpus: 1,
      image_from_input: "/framework/image", workspace_from_input: "/placement/runner_workspace",
      data_plane: { mode: "open" },
    },
  ],
  sandbox_roles: { measurement: ["runner"] },
  limits: { input_max_bytes: 400 },
};

const GOOD_INPUT = {
  framework: { image: "registry.example.invalid/fw:1" },
  placement: { gpus: 8, app_workspace: "ws-ok", cpu: 4, memory_gi: 16 },
  note: "campaign",
};

interface Ctx { h: AdmissionCluster; app: FastifyInstance; ports: any; secrets: any; send: (o: any) => Promise<any> }

describe("mode=app task creation", { skip }, () => {
  const ctx = {} as Ctx;
  let caller = OWNER;
  let goodPlugin = 0, privatePlugin = 0, badManifestPlugin = 0, noAppPlugin = 0;
  const q = (text: string, params: unknown[] = []) => ctx.h.app.db.db.query(text, params);
  const count = async (table: string) =>
    Number(((await q(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n);
  const counts = async () => ({ tasks: await count("claw_tasks"), runs: await count("claw_app_runs") });

  const post = (sessionId: string, payload: unknown, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/tasks`, payload: payload as object, headers });
  const create = (sessionId: string, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    post(sessionId, { mode: "app", plugin_id: goodPlugin, input: GOOD_INPUT, ...over }, headers);

  before(async () => {
    assert.deepEqual(validateAppManifest(MANIFEST), [], "the fixture manifest must be valid, or every refusal below is vacuous");
    process.env.CLAW_DEPLOY_MODE = "safe";
    ctx.h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    ctx.ports = (await import("../src/tasks/app-run.js")).appRunPorts;
    ctx.secrets = await import("../src/crypto/app-run-secrets.js");
    const addPlugin = async (name: string, resource: unknown, owner: string, isPublic: boolean) =>
      Number(((await q(
        `INSERT INTO plugins (name, version, resource, owner_user_id, is_public)
         VALUES ($1, '1', $2::jsonb, $3, $4) RETURNING id`,
        [name, JSON.stringify(resource), owner, isPublic],
      )).rows[0] as { id: string }).id);
    goodPlugin = await addPlugin("good", { app: { manifest: MANIFEST } }, "u1", true);
    privatePlugin = await addPlugin("private", { app: { manifest: MANIFEST } }, "u2", false);
    badManifestPlugin = await addPlugin("bad", { app: { manifest: { ...MANIFEST, command: [] } } }, "u1", true);
    noAppPlugin = await addPlugin("plain", {}, "u1", true);
    for (const [sid, uid] of [["s1", "u1"], ["s2", "u1"], ["s3", "u1"], ["s4", "u1"], ["s-other", "u2"]]) {
      await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ($1, 't', $2, 'claw')", [sid, uid]);
    }
    ctx.app = Fastify();
    ctx.app.addHook("preHandler", async (req) => { (req as any).user = caller; });
    const tasks = await import("../src/routes/tasks.js");
    await tasks.registerTaskCreateRoute(ctx.app);
    await ctx.app.ready();
  });
  after(async () => { await ctx.app?.close(); await ctx.h?.stop(); });

  const original = {} as Record<string, unknown>;
  beforeEach(async () => {
    caller = OWNER;
    original.enabled ??= ctx.ports.enabled;
    original.access ??= ctx.ports.workspaceAccess;
    original.grant ??= ctx.ports.grant;
    ctx.ports.enabled = () => true;
    ctx.ports.workspaceAccess = async (_a: unknown, ws: string) =>
      ws === "ws-ok" ? "ok" : ws === "ws-missing" ? "not_found" : "forbidden";
    ctx.ports.grant = original.grant;
    await q("DELETE FROM claw_app_runs");
    await q("DELETE FROM claw_tasks");
    await q("DELETE FROM claw_idempotency_keys");
  });

  test("creates one task and one run, with the token sealed and the manifest frozen", async () => {
    const res = await create("s1");
    assert.equal(res.statusCode, 200, res.body);
    const { ok, task_id } = res.json();
    assert.equal(ok, true);
    assert.deepEqual(await counts(), { tasks: 1, runs: 1 });

    const t = (await q("SELECT * FROM claw_tasks WHERE task_id = $1", [task_id])).rows[0] as any;
    assert.equal(t.mode, "app");
    assert.equal(t.status, "queued");
    assert.equal(t.session_id, "s1");
    assert.equal(Number(t.plugin_id), goodPlugin);
    assert.equal(t.workspace_id, "ws-ok");
    assert.deepEqual(t.input, GOOD_INPUT);
    assert.deepEqual(t.sandbox_spec, {
      handle: "app", image: "registry.example.invalid/fw:1", namespace: "ws-ok",
      resources: { cpu: "4", memory: "16Gi", "amd.com/gpu": "8" },
    });

    const r = (await q("SELECT * FROM claw_app_runs WHERE task_id = $1", [task_id])).rows[0] as any;
    assert.equal(r.session_id, "s1");
    assert.equal(r.state, "provisioning");
    assert.deepEqual(r.manifest, MANIFEST);
    assert.equal(r.grant_id, null, "the default hook issues nothing, so no grant is recorded");
    assert.equal(r.grant_keys_enc, null);

    // The token: stored sealed, never in the clear anywhere in the row, and it
    // opens back to a value of the documented shape under its own AAD only.
    const token = ctx.secrets.openAppRunSecret(r.mcp_token_enc, task_id, "mcp_token");
    assert.match(token, /^cmt_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(r.mcp_token_enc, token);
    const dump = JSON.stringify((await q("SELECT r::text AS t FROM claw_app_runs r")).rows)
      + JSON.stringify((await q("SELECT t::text AS x FROM claw_tasks t")).rows);
    assert.ok(!dump.includes(token), "the token is nowhere in the clear");
    assert.throws(() => ctx.secrets.openAppRunSecret(r.mcp_token_enc, "ktsk_other", "mcp_token"));
    assert.throws(() => ctx.secrets.openAppRunSecret(r.mcp_token_enc, task_id, "grant_keys"));
  });

  test("an ordinary task creation is unchanged and writes no run", async () => {
    const res = await post("s1", { plugin_id: goodPlugin, input: { x: 1 }, prompt: "hello" });
    assert.equal(res.statusCode, 200, res.body);
    const t = (await q("SELECT mode, workspace_id, input FROM claw_tasks WHERE task_id = $1", [res.json().task_id])).rows[0] as any;
    assert.equal(t.mode, "llm");
    assert.equal(t.workspace_id, null);
    assert.deepEqual(t.input, { x: 1 });
    assert.equal(await count("claw_app_runs"), 0);
    // And with the key header an app run would honour: still two runs, no dedupe.
    const a = await post("s1", { plugin_id: goodPlugin, input: {}, prompt: "p" }, { "idempotency-key": "k" });
    const b = await post("s1", { plugin_id: goodPlugin, input: {}, prompt: "p" }, { "idempotency-key": "k" });
    assert.notEqual(a.json().task_id, b.json().task_id);
  });

  describe("idempotency", () => {
    test("the same key returns the same run and writes nothing more", async () => {
      const a = await create("s1", {}, { "idempotency-key": "key-1" });
      const b = await create("s1", {}, { "idempotency-key": "key-1" });
      assert.equal(a.statusCode, 200);
      assert.equal(b.statusCode, 200);
      assert.equal(b.json().task_id, a.json().task_id);
      assert.deepEqual(await counts(), { tasks: 1, runs: 1 });
    });

    test("it still holds after the response cache is gone", async () => {
      const a = await create("s1", {}, { "idempotency-key": "key-2" });
      await q("DELETE FROM claw_idempotency_keys");
      const b = await create("s1", {}, { "idempotency-key": "key-2" });
      assert.equal(b.statusCode, 200, b.body);
      assert.equal(b.json().task_id, a.json().task_id);
      assert.deepEqual(await counts(), { tasks: 1, runs: 1 });
    });

    test("a replay does not run the admission checks again", async () => {
      const a = await create("s1", {}, { "idempotency-key": "key-3" });
      ctx.ports.workspaceAccess = async () => { throw new Error("must not be asked"); };
      const b = await create("s1", {}, { "idempotency-key": "key-3" });
      assert.equal(b.statusCode, 200, b.body);
      assert.equal(b.json().task_id, a.json().task_id);
    });

    test("concurrent requests with one key make one run", async () => {
      const all = await Promise.all(Array.from({ length: 6 }, () => create("s1", {}, { "idempotency-key": "key-4" })));
      assert.deepEqual(new Set(all.map((r) => r.statusCode)), new Set([200]));
      assert.equal(new Set(all.map((r) => r.json().task_id)).size, 1);
      assert.deepEqual(await counts(), { tasks: 1, runs: 1 });
    });

    test("a different key on the same session is a second run and is refused while the first is open", async () => {
      await create("s1", {}, { "idempotency-key": "key-5" });
      const b = await create("s1", {}, { "idempotency-key": "key-6" });
      assert.equal(b.statusCode, 409);
      assert.equal(b.json().error, "app_run_active");
    });

    test("the same key in another session is another run", async () => {
      const a = await create("s1", {}, { "idempotency-key": "key-7" });
      const b = await create("s2", {}, { "idempotency-key": "key-7" });
      assert.equal(b.statusCode, 200);
      assert.notEqual(b.json().task_id, a.json().task_id);
    });

    test("a refusal is not cached: the retry with that key runs the checks again", async () => {
      const a = await create("s1", { input: { ...GOOD_INPUT, placement: { ...GOOD_INPUT.placement, app_workspace: "ws-denied" } } }, { "idempotency-key": "key-8" });
      assert.equal(a.statusCode, 403);
      const b = await create("s1", {}, { "idempotency-key": "key-8" });
      assert.equal(b.statusCode, 200, b.body);
    });
  });

  describe("one unfinished run per session", () => {
    test("a second run is refused, naming the first, and writes nothing", async () => {
      const first = await create("s1");
      const second = await create("s1");
      assert.equal(second.statusCode, 409);
      assert.deepEqual(second.json(), { ok: false, error: "app_run_active", task_id: first.json().task_id });
      assert.deepEqual(await counts(), { tasks: 1, runs: 1 });
    });

    test("another session is unaffected", async () => {
      await create("s1");
      assert.equal((await create("s2")).statusCode, 200);
    });

    test("a finished run frees the session", async () => {
      const first = await create("s1");
      await q("UPDATE claw_tasks SET status = 'failed' WHERE task_id = $1", [first.json().task_id]);
      assert.equal((await create("s1")).statusCode, 200);
      await q("UPDATE claw_tasks SET status = 'running'");
      await q("UPDATE claw_app_runs SET state = 'ended' WHERE session_id = 's1'");
      assert.equal((await create("s1")).statusCode, 200, "an ended app run frees it whatever the task row says");
    });

    test("concurrent creates for one session admit exactly one", async () => {
      const all = await Promise.all(Array.from({ length: 6 }, () => create("s3")));
      const codes = all.map((r) => r.statusCode).sort();
      assert.deepEqual(codes, [200, 409, 409, 409, 409, 409]);
      assert.deepEqual(await counts(), { tasks: 1, runs: 1 });
    });
  });

  describe("admission refusals", () => {
    const refused = async (res: any, status: number, error: string) => {
      assert.equal(res.statusCode, status, res.body);
      assert.equal(res.json().error, error);
      assert.deepEqual(await counts(), { tasks: 0, runs: 0 }, "a refusal writes nothing");
    };

    test("the feature is off", async () => {
      ctx.ports.enabled = () => false;
      await refused(await create("s1"), 501, "app_runs_disabled");
    });
    test("no plugin id", async () => {
      await refused(await create("s1", { plugin_id: undefined }), 400, "plugin_id_required");
    });
    test("unknown plugin", async () => {
      await refused(await create("s1", { plugin_id: 999999 }), 404, "plugin_not_found");
    });
    test("another tenant's private plugin", async () => {
      await refused(await create("s1", { plugin_id: privatePlugin }), 403, "plugin_access_denied");
      caller = OTHER; // positive control: its owner may use it, on a session of their own
      assert.equal((await create("s-other", { plugin_id: privatePlugin })).statusCode, 200);
    });
    test("a plugin whose manifest does not validate", async () => {
      const res = await create("s1", { plugin_id: badManifestPlugin });
      await refused(res, 422, "app_manifest_invalid");
      assert.ok(res.json().issues.length > 0);
    });
    test("a plugin that is not an app", async () => {
      await refused(await create("s1", { plugin_id: noAppPlugin }), 422, "app_manifest_invalid");
    });
    test("input that is not an object", async () => {
      for (const input of [[1], "x", 3, null, undefined]) {
        await refused(await create("s1", { input }), 400, "input_must_be_object");
      }
    });
    test("input over the manifest's limit", async () => {
      const big = { ...GOOD_INPUT, pad: "x".repeat(400) };
      await refused(await create("s1", { input: big }), 413, "input_too_large");
      assert.equal((await create("s1")).statusCode, 200, "the same request within the limit is admitted");
    });
    test("a workspace the caller may not use", async () => {
      const input = { ...GOOD_INPUT, placement: { ...GOOD_INPUT.placement, app_workspace: "ws-denied" } };
      const res = await create("s1", { input });
      await refused(res, 403, "workspace_access_denied");
      assert.equal(res.json().workspace, "ws-denied");
    });
    test("a workspace that does not exist", async () => {
      const input = { ...GOOD_INPUT, placement: { ...GOOD_INPUT.placement, app_workspace: "ws-missing" } };
      await refused(await create("s1", { input }), 404, "workspace_not_found");
    });
    test("a workspace named only by a template pointer is checked too", async () => {
      const input = { ...GOOD_INPUT, placement: { ...GOOD_INPUT.placement, runner_workspace: "ws-denied" } };
      await refused(await create("s1", { input }), 403, "workspace_access_denied");
      const ok = { ...GOOD_INPUT, placement: { ...GOOD_INPUT.placement, runner_workspace: "ws-ok" } };
      assert.equal((await create("s1", { input: ok })).statusCode, 200);
    });
    test("a pointer that names a non-string workspace", async () => {
      const input = { ...GOOD_INPUT, placement: { ...GOOD_INPUT.placement, app_workspace: 7 } };
      await refused(await create("s1", { input }), 400, "app_input_invalid");
    });
    test("an input without the container image", async () => {
      await refused(await create("s1", { input: { placement: GOOD_INPUT.placement } }), 400, "app_input_invalid");
    });
    test("SaFE cannot be asked", async () => {
      ctx.ports.workspaceAccess = async () => { throw new (await import("../src/tasks/app-run.js")).WorkspaceCheckUnavailableError("x"); };
      const res = await create("s1");
      await refused(res, 503, "workspace_check_unavailable");
    });
    test("a session that is not the caller's", async () => {
      const res = await create("s-other");
      assert.equal(res.statusCode, 403);
      assert.deepEqual(await counts(), { tasks: 0, runs: 0 });
      assert.equal((await create("no-such-session")).statusCode, 404);
    });
  });

  describe("grant hook", () => {
    test("a failing issue rolls both rows back and answers 503", async () => {
      ctx.ports.grant = { issue: async () => { throw new Error("grant service down"); } };
      const res = await create("s1");
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error, "grant_issue_failed");
      assert.ok(!res.body.includes("grant service down"), "the cause is logged, not returned");
      assert.deepEqual(await counts(), { tasks: 0, runs: 0 });
    });

    test("a retry under the same key reuses the grant id; the grant is recorded sealed", async () => {
      const seen: any[] = [];
      let fail = true;
      ctx.ports.grant = {
        issue: async (run: any, manifest: any, input: any) => {
          seen.push({ run, manifest, input });
          if (fail) throw new Error("down");
          return {
            keys: { measurement: "e2b_aaaa", subrun: "e2b_bbbb" },
            limits: { "measurement.max_sandboxes": 4 },
            expiresAt: "2030-01-01T00:00:00Z",
          };
        },
      };
      const a = await create("s1", {}, { "idempotency-key": "grant-key" });
      assert.equal(a.statusCode, 503);
      fail = false;
      const b = await create("s1", {}, { "idempotency-key": "grant-key" });
      assert.equal(b.statusCode, 200, b.body);
      assert.equal(seen.length, 2);
      assert.equal(seen[0].run.grantId, seen[1].run.grantId);
      assert.match(seen[1].run.grantId, /^grt_[0-9a-f]{32}$/);
      assert.deepEqual(seen[1].manifest, MANIFEST);
      assert.deepEqual(seen[1].input, GOOD_INPUT);
      assert.equal(seen[1].run.taskId, b.json().task_id);

      const r = (await q("SELECT * FROM claw_app_runs")).rows[0] as any;
      assert.equal(r.grant_id, seen[1].run.grantId);
      assert.deepEqual(r.grant_limits, { "measurement.max_sandboxes": 4 });
      assert.equal(new Date(r.grant_expires_at).toISOString(), "2030-01-01T00:00:00.000Z");
      assert.equal(r.grant_revoked_at, null);
      assert.ok(!r.grant_keys_enc.includes("e2b_aaaa"));
      assert.deepEqual(
        JSON.parse(ctx.secrets.openAppRunSecret(r.grant_keys_enc, b.json().task_id, "grant_keys")),
        { measurement: "e2b_aaaa", subrun: "e2b_bbbb" },
      );
    });

    test("without a key each create gets its own grant id", async () => {
      const ids: string[] = [];
      ctx.ports.grant = { issue: async (run: any) => { ids.push(run.grantId); return undefined; } };
      await create("s1");
      await create("s2");
      assert.equal(new Set(ids).size, 2);
    });
  });
});
