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
  // No default image: a run has to name one.
  container: { resources: { cpu: "32", memory: "128Gi" } },
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", "exec app run"],
  env_map: { run_id: "APP_RUN_ID", mcp_token: "APP_MCP_TOKEN" },
  mcp: { port: 8765, path: "/mcp", token_header: "X-App-Token" },
  sandbox_templates: [
    { name: "runner", provider: "safe-pytorchjob", gpus: 1, data_plane: { mode: "open" } },
  ],
  sandbox_roles: { measurement: ["runner"] },
  limits: { input_max_bytes: 400, max_sandboxes: 2, max_runtime_sec: 7200 },
};

/**
 * The app's own request. It carries every name that used to be a pointer
 * target, set to values that would be wrong or refused if anything read them:
 * Claw hands this to the app and does not look inside.
 */
const GOOD_INPUT = {
  framework: { image: "attacker.example.invalid/other:1" },
  placement: { gpus: 99, app_workspace: "ws-denied", gpu_workspace: "ws-missing", runner_workspace: "ws-denied", cpu: 1000, memory_gi: 9999 },
  budget: { max_gpu_hours: 1e9, max_hours: 1e6 },
  resources: { image: "attacker.example.invalid/nested:1" },
  note: "campaign",
};
/** What the submitter asks for. */
const GOOD_RES = {
  image: "registry.example.invalid/fw:1", gpus: 8, workspace: "ws-ok", cpu: 4, memory_gi: 16,
  grant: { max_sandboxes: 1, max_gpus: 8, gpu_hours: 10, max_runtime_sec: 600 },
};

/** A grant hook that signs nothing but records the limits it was asked for, as the grant's limits. */
const LIMITS_HOOK = { issue: async (_r: unknown, _m: unknown, req: any) => ({ limits: req.resources.grant }) };

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
    post(sessionId, { mode: "app", plugin_id: goodPlugin, input: GOOD_INPUT, resources: GOOD_RES, ...over }, headers);

  before(async () => {
    assert.deepEqual(validateAppManifest(MANIFEST), [], "the fixture manifest must be valid, or every refusal below is vacuous");
    process.env.CLAW_DEPLOY_MODE = "safe";
    ctx.h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true", APP_GRANT_ISSUE_TIMEOUT_MS: "1000", APP_GRANT_REVOKE_RETRY_MS: "1000" });
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
  const asked: string[] = [];
  beforeEach(async () => {
    caller = OWNER;
    original.enabled ??= ctx.ports.enabled;
    original.access ??= ctx.ports.workspaceAccess;
    original.caps ??= ctx.ports.caps;
    original.grant ??= ctx.ports.grant;
    ctx.ports.enabled = () => true;
    ctx.ports.caps = original.caps;
    original.containerCaps ??= ctx.ports.containerCaps;
    ctx.ports.containerCaps = original.containerCaps;
    asked.length = 0;
    ctx.ports.workspaceAccess = async (_a: unknown, ws: string) => (asked.push(ws), ws === "ws-ok") ? "ok" : ws === "ws-missing" ? "not_found" : "forbidden";
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
    assert.equal(r.grant_limits, null, "no grant was signed, so there are no grant limits to store");
    assert.equal(r.created_by, "u1");
    assert.match(r.request_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(asked, ["ws-ok"], "only the requested workspace is asked about, never one found inside the input");
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
      const a = await create("s1", { resources: { ...GOOD_RES, workspace: "ws-denied" } }, { "idempotency-key": "key-8" });
      assert.equal(a.statusCode, 403);
      const b = await create("s1", {}, { "idempotency-key": "key-8" });
      assert.equal(b.statusCode, 200, b.body);
    });
  });

  test("the schema refuses a second run for one (session, key) even without the lock, and only then", async () => {
    const mk = async (taskId: string, session: string, key: string | null) => {
      await q(`INSERT INTO claw_tasks (task_id, session_id, name, status, mode) VALUES ($1, $2, 't', 'queued', 'app')`, [taskId, session]);
      await q(
        `INSERT INTO claw_app_runs (task_id, session_id, plugin_id, manifest, idempotency_key, state, mcp_token_enc)
         VALUES ($1, $2, 1, '{}'::jsonb, $3, 'provisioning', 'x')`,
        [taskId, session, key],
      );
    };
    await mk("kt-1", "s1", "dup");
    await assert.rejects(mk("kt-2", "s1", "dup"), (e: any) => e.code === "23505");
    await mk("kt-3", "s2", "dup");
    await mk("kt-4", "s1", null);
    await mk("kt-5", "s1", null);
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
      const res = await create("s1", { resources: { ...GOOD_RES, workspace: "ws-denied" } });
      await refused(res, 403, "workspace_access_denied");
      assert.equal(res.json().workspace, "ws-denied");
    });
    test("a workspace that does not exist", async () => {
      await refused(await create("s1", { resources: { ...GOOD_RES, workspace: "ws-missing" } }), 404, "workspace_not_found");
    });
    test("the sandbox workspace is checked too", async () => {
      await refused(await create("s1", { resources: { ...GOOD_RES, sandbox_workspace: "ws-denied" } }), 403, "workspace_access_denied");
      assert.equal((await create("s1", { resources: { ...GOOD_RES, sandbox_workspace: "ws-ok" } })).statusCode, 200);
    });
    test("the workspace check uses resources.workspace, not anything in the input", async () => {
      // The input names a workspace nobody may use, in every place a pointer once read.
      const res = await create("s1");
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(asked, ["ws-ok"]);
      await q("DELETE FROM claw_app_runs"); await q("DELETE FROM claw_tasks"); asked.length = 0;
      await refused(await create("s1", { resources: { ...GOOD_RES, workspace: "ws-denied" }, input: { note: "clean" } }), 403, "workspace_access_denied");
      assert.deepEqual(asked, ["ws-denied"]);
    });
    describe("resources", () => {
      const problems = (res: any) => res.json().problems.map((p: any) => p.field);
      test("a non-string workspace", async () => {
        const res = await create("s1", { resources: { ...GOOD_RES, workspace: 7 } });
        await refused(res, 400, "app_resources_invalid");
        assert.deepEqual(problems(res), ["resources.workspace"]);
      });
      test("no image anywhere (none requested, no manifest default) is a specific refusal", async () => {
        const { image: _i, ...noImage } = GOOD_RES;
        const res = await create("s1", { resources: noImage });
        await refused(res, 400, "app_resources_invalid");
        assert.deepEqual(problems(res), ["resources.image"]);
        assert.match(res.json().problems[0].reason, /no image/);
        // The image in the input does not stand in for it.
        assert.ok(!JSON.stringify(GOOD_INPUT).includes("fw:1"));
      });
      test("no resources at all lists what is missing, writes nothing", async () => {
        const res = await create("s1", { resources: undefined });
        await refused(res, 400, "app_resources_invalid");
        assert.deepEqual(problems(res).sort(), ["resources.gpus", "resources.image", "resources.workspace"]);
        await refused(await create("s1", { resources: [1] }), 400, "app_resources_invalid");
      });
      test("a request still carrying grant.roles is refused as an unknown field", async () => {
        const res = await create("s1", { resources: { ...GOOD_RES, grant: { roles: { measurement: { max_sandboxes: 1 } } } } });
        await refused(res, 400, "app_resources_invalid");
        assert.deepEqual(problems(res), ["resources.grant.roles"]);
      });
      test("negative and mistyped items are refused", async () => {
        const bad = await create("s1", { resources: { ...GOOD_RES, gpus: -1, grant: { gpu_hours: -5 } } });
        await refused(bad, 400, "app_resources_invalid");
        assert.deepEqual(problems(bad).sort(), ["resources.gpus", "resources.grant.gpu_hours"]);
      });
      test("a request above the platform cap gets the cap, item by item, and the cap is what is stored", async () => {
        ctx.ports.caps = () => ({ max_sandboxes: 3, max_gpus: 4, gpu_hours: 5, max_runtime_sec: 7200 });
        ctx.ports.grant = LIMITS_HOOK;
        const res = await create("s1", { resources: { ...GOOD_RES, grant: { max_sandboxes: 50, max_gpus: 2, gpu_hours: 1e6, max_runtime_sec: 99999 } } });
        assert.equal(res.statusCode, 200, res.body);
        const r = (await q("SELECT grant_limits FROM claw_app_runs")).rows[0] as any;
        assert.deepEqual(r.grant_limits, {
          max_sandboxes: 2, max_gpus: 2, gpu_hours: 5, max_runtime_sec: 7200,
        }, "max_sandboxes = min(request 50, manifest 2, cap 3); gpu_hours clamped, max_gpus below its cap kept, runtime = min(request, manifest 7200, cap 7200)");
      });
      test("absent items take the manifest defaults", async () => {
        ctx.ports.grant = LIMITS_HOOK;
        const res = await create("s1", { resources: { image: "i:1", gpus: 0, workspace: "ws-ok" } });
        assert.equal(res.statusCode, 200, res.body);
        const r = (await q("SELECT grant_limits FROM claw_app_runs")).rows[0] as any;
        assert.deepEqual(r.grant_limits, { max_sandboxes: 2, max_runtime_sec: 7200 });
        const t = (await q("SELECT sandbox_spec FROM claw_tasks")).rows[0] as any;
        assert.deepEqual(t.sandbox_spec, { handle: "app", image: "i:1", namespace: "ws-ok", resources: { cpu: "32", memory: "128Gi" } });
      });
      test("the input does not affect the resources: same request, different input, same run shape", async () => {
        ctx.ports.grant = LIMITS_HOOK;
        const shapes: unknown[] = [];
        for (const input of [GOOD_INPUT, { note: "clean" }, { placement: { gpus: 0 }, framework: { image: "x" }, resources: { gpus: 1 } }, {}]) {
          await q("DELETE FROM claw_app_runs"); await q("DELETE FROM claw_tasks");
          const res = await create("s1", { input });
          assert.equal(res.statusCode, 200, res.body);
          const t = (await q("SELECT sandbox_spec, workspace_id FROM claw_tasks")).rows[0] as any;
          const r = (await q("SELECT grant_limits FROM claw_app_runs")).rows[0] as any;
          shapes.push({ spec: t.sandbox_spec, ws: t.workspace_id, grant: r.grant_limits });
        }
        for (const x of shapes) assert.deepEqual(x, shapes[0]);
      });
    });
    test("every workspace is asked at once, and the refusal follows the order they were named in", async () => {
      const started: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      ctx.ports.workspaceAccess = async (_a: unknown, ws: string) => {
        started.push(ws);
        if (started.length === 2) release();
        await gate; // returns only once both calls are in flight: serial asking would never get here
        return ws === "ws-ok" ? "ok" : "forbidden";
      };
      const res = await create("s1", { resources: { ...GOOD_RES, sandbox_workspace: "ws-denied" } });
      assert.equal(res.statusCode, 403, res.body);
      assert.deepEqual(started.sort(), ["ws-denied", "ws-ok"]);
      assert.equal(res.json().workspace, "ws-denied");
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

  describe("replay", () => {
    test("the same key and the same request replay, whatever order its keys were written in", async () => {
      const a = await create("s1", { input: { a: 1, b: { c: 2, d: 3 } } }, { "idempotency-key": "r-1" });
      const b = await create("s1", { input: { b: { d: 3, c: 2 }, a: 1 } }, { "idempotency-key": "r-1" });
      assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
      assert.equal(b.json().task_id, a.json().task_id);
    });
    for (const cache of ["cached", "cache lost"]) {
      test(`the same key with a different input is refused (${cache})`, async () => {
        const a = await create("s1", { input: { n: 1 } }, { "idempotency-key": "r-2" });
        assert.equal(a.statusCode, 200);
        if (cache === "cache lost") await q("DELETE FROM claw_idempotency_keys");
        const b = await create("s1", { input: { n: 2 } }, { "idempotency-key": "r-2" });
        assert.equal(b.statusCode, 422, b.body);
        assert.equal(b.json().error, "idempotency_key_reused");
        assert.deepEqual(await counts(), { tasks: 1, runs: 1 });
      });
    }
    test("the same key with different resources is refused", async () => {
      await create("s1", {}, { "idempotency-key": "r-3" });
      const b = await create("s1", { resources: { ...GOOD_RES, gpus: 4 } }, { "idempotency-key": "r-3" });
      assert.equal(b.statusCode, 422, b.body);
    });
    test("a key that another principal created is refused, cached or not", async () => {
      // The route's session-ownership check already turns other users away at the
      // door (403), so this row can only be reached through shared access to a
      // session; the replay refuses it anyway rather than rely on that.
      const a = await create("s1", {}, { "idempotency-key": "r-4" });
      assert.equal(a.statusCode, 200);
      await q("UPDATE claw_app_runs SET created_by = 'u2'");
      for (const lose of [false, true]) {
        if (lose) await q("DELETE FROM claw_idempotency_keys");
        const b = await create("s1", {}, { "idempotency-key": "r-4" });
        assert.equal(b.statusCode, 409, b.body);
        assert.equal(b.json().error, "idempotency_key_conflict");
        assert.ok(!b.body.includes(a.json().task_id), "the other run's id is not disclosed");
      }
      assert.deepEqual(await counts(), { tasks: 1, runs: 1 });
    });
  });

  describe("replay of rows that cannot be attributed", () => {
    for (const col of ["created_by", "request_hash"]) {
      test(`a row with NULL ${col} is not replayed to anyone, cached or not`, async () => {
        const a = await create("s1", {}, { "idempotency-key": "r-null" });
        assert.equal(a.statusCode, 200);
        await q(`UPDATE claw_app_runs SET ${col} = NULL`);
        for (const lose of [false, true]) {
          if (lose) await q("DELETE FROM claw_idempotency_keys");
          const b = await create("s1", {}, { "idempotency-key": "r-null" });
          assert.equal(b.statusCode, 409, b.body);
          assert.ok(!b.body.includes(a.json().task_id));
        }
      });
    }
  });

  describe("container caps", () => {
    const problems = (res: any) => res.json().problems.map((p: any) => p.field);
    test("gpus above one node is a 400 naming the field, and nothing is written", async () => {
      const res = await create("s1", { resources: { ...GOOD_RES, gpus: 100000 } });
      assert.equal(res.statusCode, 400, res.body);
      assert.deepEqual(problems(res), ["resources.gpus"]);
      assert.deepEqual(await counts(), { tasks: 0, runs: 0 });
    });
    test("cpu and memory above the caps, and exponent forms, are 400s", async () => {
      for (const [k, v] of [["cpu", 1e21], ["cpu", 100000], ["memory_gi", 1e-7], ["memory_gi", 100000]] as const) {
        const res = await create("s1", { resources: { ...GOOD_RES, [k]: v, grant: undefined } });
        assert.equal(res.statusCode, 400, `${k}=${v}: ${res.body}`);
        assert.deepEqual([...new Set(problems(res))], [`resources.${k}`]);
      }
    });
    test("configured caps replace the defaults", async () => {
      ctx.ports.containerCaps = () => ({ gpus: 16, cpu: 256, memory_gi: 4096 });
      assert.equal((await create("s1", { resources: { ...GOOD_RES, gpus: 16 } })).statusCode, 200);
    });
  });

  describe("grant timeouts are validated at start-up", () => {
    test("below one second, above five minutes or not a whole number stops start-up; unset is the default", async () => {
      const { parseAppGrantTimeoutMs } = await import("../src/config.js");
      for (const bad of ["0", "-5", "999", "300001", "1.5", "abc", "1e9"]) {
        assert.throws(() => parseAppGrantTimeoutMs(bad, 10_000, "APP_GRANT_ISSUE_TIMEOUT_MS"), /APP_GRANT_ISSUE_TIMEOUT_MS must be/, bad);
      }
      assert.equal(parseAppGrantTimeoutMs(undefined, 10_000, "X"), 10_000);
      assert.equal(parseAppGrantTimeoutMs(" ", 10_000, "X"), 10_000);
      assert.equal(parseAppGrantTimeoutMs("1000", 10_000, "X"), 1000);
      assert.equal(parseAppGrantTimeoutMs("300000", 10_000, "X"), 300000);
    });
  });

  describe("caller credential", () => {
    test("the forwarded credential is the one the middleware accepts, in its order", async () => {
      const { callerAuthOf } = await import("../src/routes/app-run-create.js");
      const req = (headers: Record<string, unknown>, cookies: Record<string, string> = {}) => ({ headers, cookies }) as any;
      assert.deepEqual(callerAuthOf(req({ authorization: "Bearer gateway-token", "x-api-key": "ak-user" })), { authorization: "Bearer ak-user" });
      assert.deepEqual(callerAuthOf(req({ authorization: "Bearer ak-b", "x-api-key": "ak-x" })), { authorization: "Bearer ak-b" });
      assert.deepEqual(callerAuthOf(req({ "x-api-key": ["ak-first", "ak-second"] })), { authorization: "Bearer ak-first" });
      assert.deepEqual(callerAuthOf(req({ cookie: "Token=t; userType=default", authorization: "Bearer ak-b" }, { Token: "t" })), { cookie: "Token=t; userType=default" });
      assert.deepEqual(callerAuthOf(req({ authorization: "Bearer gateway-token" })), {});
      assert.deepEqual(callerAuthOf(req({})), {});
    });
  });

  describe("grant lifecycle", () => {
    const hook = (over: Record<string, unknown> = {}) => {
      const log: Array<{ op: string; run: any; during?: any }> = [];
      ctx.ports.grant = {
        issue: async (run: any) => {
          // Not inside the admission transaction: no task row yet, no open
          // transaction on this database holding the admission lock.
          const t = (await q("SELECT 1 FROM claw_tasks WHERE task_id = $1", [run.taskId])).rowCount;
          const idle = (await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'")).rows[0] as any;
          log.push({ op: "issue", run, during: { task: t, openTransactions: idle.n } });
          return { limits: { x: 1 } };
        },
        revoke: async (run: any) => { log.push({ op: "revoke", run }); },
        ...over,
      };
      return log;
    };
    test("issue runs before the task exists and outside any open transaction; the task takes the id it was given", async () => {
      const log = hook();
      const res = await create("s1");
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(log.map((l) => l.op), ["issue"], "nothing is revoked on success");
      assert.deepEqual(log[0]!.during, { task: 0, openTransactions: 0 });
      assert.equal(log[0]!.run.taskId, res.json().task_id);
    });
    test("a transaction that fails after the grant was signed revokes it", async () => {
      // Make the transaction fail for real: a second run for the session appears while this one is signing.
      const log = hook();
      const inner = ctx.ports.grant;
      ctx.ports.grant = {
        ...inner,
        issue: async (run: any, m: unknown, r: unknown) => {
          const out = await inner.issue(run, m, r);
          ctx.ports.grant = original.grant;
          await create("s1", {}, { "idempotency-key": "k-inner" });
          ctx.ports.grant = { ...inner, issue: inner.issue };
          return out;
        },
      };
      const res = await create("s1");
      assert.equal(res.statusCode, 409, res.body);
      assert.deepEqual(log.map((l) => l.op), ["issue", "revoke"]);
      assert.equal(log[1]!.run.grantId, log[0]!.run.grantId);
    });
    test("every attempt signs its own id, and a refused attempt revokes only that id", async () => {
      const issued: string[] = [], revoked: string[] = [];
      ctx.ports.grant = {
        issue: async (run: any) => {
          issued.push(run.grantId);
          if (issued.length === 1) {
            // Another attempt for the same session wins while this one is signing.
            const other = ctx.ports.grant;
            ctx.ports.grant = { issue: async (r: any) => { issued.push(r.grantId); return { limits: {} }; }, revoke: async (r: any) => { revoked.push(r.grantId); } };
            assert.equal((await create("s1", {}, { "idempotency-key": "k-other" })).statusCode, 200);
            ctx.ports.grant = other;
          }
          return { limits: {} };
        },
        revoke: async (run: any) => { revoked.push(run.grantId); },
      };
      const loser = await create("s1", {}, { "idempotency-key": "k-loser" });
      assert.equal(loser.statusCode, 409, loser.body);
      assert.equal(issued.length, 2);
      assert.notEqual(issued[0], issued[1]);
      assert.deepEqual(revoked, [issued[0]], "the loser revoked its own id and not the winner's");
      const rows = (await q("SELECT grant_id FROM claw_app_runs")).rows as any[];
      assert.deepEqual(rows.map((r) => r.grant_id), [issued[1]], "the winner's grant is the recorded one");
    });
    test("a retry after a refusal never re-issues the revoked id", async () => {
      const issued: string[] = [], revoked: string[] = [];
      let occupy = true;
      ctx.ports.grant = {
        issue: async (run: any) => {
          issued.push(run.grantId);
          if (occupy) {
            occupy = false;
            const hold = ctx.ports.grant;
            ctx.ports.grant = original.grant;
            assert.equal((await create("s1", {}, { "idempotency-key": "k-holder" })).statusCode, 200);
            ctx.ports.grant = hold;
          }
          return { limits: {} };
        },
        revoke: async (run: any) => { revoked.push(run.grantId); },
      };
      const first = await create("s1", {}, { "idempotency-key": "k-retry" });
      assert.equal(first.statusCode, 409);
      await q("DELETE FROM claw_app_runs"); await q("DELETE FROM claw_tasks");
      const second = await create("s1", {}, { "idempotency-key": "k-retry" });
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(issued.length, 2);
      assert.ok(!issued.slice(1).some((id) => revoked.includes(id)), "no id is issued after it was revoked");
    });
    test("a grant service that hangs is cut off: 503, aborted, revoked", async () => {
      let aborted = false;
      const revoked: string[] = [];
      ctx.ports.grant = {
        issue: (run: any, _m: unknown, _r: unknown, signal: AbortSignal) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }),
        revoke: async (run: any) => { revoked.push(run.grantId); },
      };
      const t0 = Date.now();
      const res = await create("s1");
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(res.json().error, "grant_issue_failed");
      assert.ok(Date.now() - t0 < 5000, "the request did not wait for ever");
      assert.equal(aborted, true);
      assert.equal(revoked.length, 1, "revoked at once");
      // The service may finish signing after the attempt gave up: the revoke is tried once more.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(revoked.length, 2, "and once more later");
      assert.equal(revoked[0], revoked[1], "the same attempt id both times");
      assert.deepEqual(await counts(), { tasks: 0, runs: 0 });
    });
    test("a caller with no platform key is refused before any grant is signed", async () => {
      const log = hook();
      caller = { ...OWNER, platformKey: "", virtualKey: "" } as typeof caller;
      const res = await create("s1");
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(res.json().error, "missing_platform_key");
      assert.deepEqual(log, [], "no issue, no revoke");
    });
    test("a revoke that throws does not change the answer", async () => {
      const log = hook({ revoke: async () => { throw new Error("revoke down"); } });
      const inner = ctx.ports.grant;
      ctx.ports.grant = {
        ...inner,
        issue: async (run: any, m: unknown, r: unknown) => {
          const out = await inner.issue(run, m, r);
          const keep = ctx.ports.grant;
          ctx.ports.grant = original.grant;
          await create("s1", {}, { "idempotency-key": "k-inner2" });
          ctx.ports.grant = keep;
          return out;
        },
      };
      const res = await create("s1");
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(log.length, 1);
    });
    test("a run already active is refused before any grant is signed", async () => {
      const log = hook();
      assert.equal((await create("s1")).statusCode, 200);
      log.length = 0;
      const again = await create("s1");
      assert.equal(again.statusCode, 409, again.body);
      assert.deepEqual(log, [], "no issue, no revoke");
    });
    test("an issue that throws answers 503, writes nothing and asks for a revoke of whatever it signed", async () => {
      const log = hook({ issue: async (run: any) => { log.push({ op: "issue", run }); throw new Error("boom"); } });
      const res = await create("s1");
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(res.json().error, "grant_issue_failed");
      assert.deepEqual(await counts(), { tasks: 0, runs: 0 });
      assert.deepEqual(log.map((l) => l.op), ["issue", "revoke"]);
    });
    test("grant_limits is written exactly when a grant was signed", async () => {
      ctx.ports.grant = original.grant;
      assert.equal((await create("s1")).statusCode, 200);
      const none = (await q("SELECT grant_id, grant_limits FROM claw_app_runs")).rows[0] as any;
      assert.deepEqual([none.grant_id, none.grant_limits], [null, null]);
      await q("DELETE FROM claw_app_runs"); await q("DELETE FROM claw_tasks");
      hook();
      assert.equal((await create("s1")).statusCode, 200);
      const some = (await q("SELECT grant_id, grant_limits FROM claw_app_runs")).rows[0] as any;
      assert.ok(some.grant_id);
      assert.deepEqual(some.grant_limits, { x: 1 });
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

    test("a retry under the same key signs a new grant; the committed one is recorded sealed", async () => {
      const seen: any[] = [];
      let fail = true;
      ctx.ports.grant = {
        issue: async (run: any, manifest: any, request: any) => {
          seen.push({ run, manifest, request });
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
      assert.notEqual(seen[0].run.grantId, seen[1].run.grantId, "an attempt never re-issues an id an earlier attempt used");
      assert.match(seen[1].run.grantId, /^grt_[0-9a-z]{26}$/);
      assert.deepEqual(seen[1].manifest, MANIFEST);
      assert.ok(!JSON.stringify(seen[1]).includes("attacker.example"), "the grant hook is never given the input");
      assert.equal(seen[1].request.resources.image, GOOD_RES.image);
      assert.deepEqual(seen[1].request.resources.grant, GOOD_RES.grant);
      assert.deepEqual(seen[1].request.templates, [{
        name: "runner", provider: "safe-pytorchjob", gpus: 1, data_plane: { mode: "open" },
        image: GOOD_RES.image, workspace: "ws-ok",
      }], "a template that sets no image or workspace inherits the run's");
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
