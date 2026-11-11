// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Run-time overrides of a plugin (marketplace/plugin-overrides.ts).
 *
 * A launch may change only what the plugin's author declared overridable, and
 * only to a value the declaration accepts; a plugin that declares nothing
 * refuses every override, so every plugin written before the field existed
 * launches exactly as before. The checks are pure and asserted directly; the
 * write path, the app-run path and the single-task path are asserted against a
 * real Postgres whose schema `initDb` built (skipped, and printed as skipped,
 * without DATABASE_URL).
 *
 * Every refusal is paired with the same request admitted, so a path that refuses
 * everything cannot pass.
 *
 * Coverage:
 *   V1 a declaration is checked when written, and every problem is named
 *   V2 no declaration: every override is refused, none is the empty answer
 *   V3 each key's value is held to its rule (enum, pattern, maxLength, images)
 *   V4 a key that does not apply to the surface is refused, not ignored
 *   V5 the app manifest gets env, model env names, args and image; the original is untouched
 *   V6 a backtracking pattern cannot hold the event loop: its test is cut off and the value refused
 *   W1 plugin writes: an invalid declaration is 400 and stores nothing; a valid one round-trips and a new version keeps it
 *   A1 an app run with overrides stores the effective manifest and an audit record
 *   A2 an app run's undeclared or reserved override is 400 and writes nothing
 *   A3 the Idempotency-Key hash is unchanged for a request without overrides
 *   T1 a single task with overrides gets the model and image, with an audit record
 *   T2 a single task's override without a plugin, or with a DAG, is refused
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA, validateAppManifest } from "@claw/protocol";
import {
  applyAppOverrides,
  checkOverrides,
  normalizeOverridable,
  overridableDeclarationProblems,
  overrideKeys,
  runPatternJobs,
} from "../src/marketplace/plugin-overrides.js";
import { BadRequestError } from "../src/shared/errors.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const IMAGES = [{ repo: "registry.example.invalid/app:1", framework: "sglang" }, { repo: "registry.example.invalid/app:2" }];
const DECL = {
  image: {},
  model: { enum: ["model-a", "model-b"], env: ["APP_MODEL", "APP_MODEL_2"] },
  args: { items: { pattern: "^--[a-z-]+(=[A-Za-z0-9._-]+)?$" }, maxItems: 3 },
  env: {
    SOURCE_SHA: { pattern: "^[0-9a-f]{40}$" },
    MODE: { enum: ["fast", "full"] },
    NOTE: { maxLength: 8 },
  },
};
const PLUGIN = { id: 5, version: "1.0.0", images: IMAGES, overridable: DECL };
const SHA = "0123456789abcdef0123456789abcdef01234567";

// V1
test("a declaration is checked, and every problem is named", () => {
  assert.deepEqual(overridableDeclarationProblems(DECL), []);
  assert.deepEqual(overridableDeclarationProblems(undefined), []);
  assert.deepEqual(overridableDeclarationProblems(null), []);
  assert.deepEqual(normalizeOverridable(null), {});
  const problems = overridableDeclarationProblems({
    image: { enum: [] },
    model: { env: ["1BAD"], pattern: "(" },
    args: { maxItems: 0, type: "string" },
    env: { "BAD-NAME": {}, OK: { maxLength: 999999 }, ALSO: { kind: "x" } },
    secrets: {},
  });
  const fields = problems.map((p) => p.field).sort();
  assert.deepEqual(fields, [
    "overridable.args.maxItems",
    "overridable.args.type",
    "overridable.env.ALSO.kind",
    "overridable.env.BAD-NAME",
    "overridable.env.OK.maxLength",
    "overridable.image.enum",
    "overridable.model.env",
    "overridable.model.pattern",
    "overridable.secrets",
  ]);
  assert.throws(() => normalizeOverridable({ secrets: {} }), (e: unknown) => e instanceof BadRequestError && /overridable\.secrets/.test(e.message));
  assert.throws(() => normalizeOverridable([]), BadRequestError);
});

// V2
test("a plugin that declares nothing refuses every override", () => {
  for (const decl of [undefined, null, {}, "garbage", { image: { enum: [] } }]) {
    const out = checkOverrides({ image: IMAGES[0]!.repo }, { images: IMAGES, overridable: decl }, "task");
    assert.equal(out.ok, false, JSON.stringify(decl));
  }
  // No overrides at all is always fine, declared or not.
  assert.deepEqual(checkOverrides(undefined, { overridable: {} }, "app"), { ok: true, values: {} });
  assert.deepEqual(checkOverrides(null, { overridable: {} }, "task"), { ok: true, values: {} });
  assert.deepEqual(checkOverrides({}, { overridable: {} }, "task"), { ok: true, values: {} });
  assert.equal(checkOverrides("x", PLUGIN, "task").ok, false);
});

// V3
test("each value is held to its rule", () => {
  const ok = checkOverrides({
    image: IMAGES[1]!.repo,
    model: "model-b",
    args: ["--fast", "--seed=7"],
    env: { SOURCE_SHA: SHA, MODE: "full", NOTE: "short" },
  }, PLUGIN, "app");
  assert.deepEqual(ok, {
    ok: true,
    values: {
      image: IMAGES[1]!.repo, model: "model-b", args: ["--fast", "--seed=7"],
      env: { SOURCE_SHA: SHA, MODE: "full", NOTE: "short" },
    },
  });
  const bad = checkOverrides({
    image: "registry.example.invalid/other:1",
    model: "model-z",
    args: ["; rm -rf /"],
    env: { SOURCE_SHA: "HEAD", MODE: "slow", NOTE: "much too long", PATH: "/tmp" },
  }, PLUGIN, "app");
  assert.equal(bad.ok, false);
  assert.deepEqual((bad as { problems: Array<{ field: string }> }).problems.map((p) => p.field).sort(), [
    "overrides.args[0]", "overrides.env.MODE", "overrides.env.NOTE", "overrides.env.PATH",
    "overrides.env.SOURCE_SHA", "overrides.image", "overrides.model",
  ]);
  // The declaration's own enum widens the images list; nothing else does.
  const enumed = { ...PLUGIN, overridable: { image: { enum: ["registry.example.invalid/extra:9"] } } };
  assert.equal(checkOverrides({ image: "registry.example.invalid/extra:9" }, enumed, "task").ok, true);
  assert.equal(checkOverrides({ image: IMAGES[0]!.repo }, enumed, "task").ok, true);
  assert.equal(checkOverrides({ image: "registry.example.invalid/nope:1" }, enumed, "task").ok, false);
  // A value or an enum entry with surrounding whitespace is refused: the app
  // path trims the image, which would run a value the declaration never listed.
  assert.equal(checkOverrides({ image: `${IMAGES[0]!.repo} ` }, PLUGIN, "task").ok, false);
  assert.deepEqual(overridableDeclarationProblems({ image: { enum: ["registry.example.invalid/app:9 "] } }).map((p) => p.field), ["overridable.image.enum"]);
  assert.equal(checkOverrides({ image: "registry.example.invalid/app:9 " }, { images: [], overridable: { image: { enum: ["registry.example.invalid/app:9 "] } } }, "app").ok, false);
  // Too many args, and an inherited property name, are refused.
  assert.equal(checkOverrides({ args: ["--a", "--b", "--c", "--d"] }, PLUGIN, "app").ok, false);
  assert.equal(checkOverrides({ env: { constructor: "x" } }, PLUGIN, "app").ok, false);
  assert.equal(checkOverrides({ env: { toString: "x" } }, PLUGIN, "app").ok, false);
});

// V4
test("a key that does not apply to the surface is refused", () => {
  assert.equal(checkOverrides({ model: "model-a", image: IMAGES[0]!.repo }, PLUGIN, "task").ok, true);
  for (const req of [{ env: { MODE: "fast" } }, { args: ["--fast"] }]) {
    const out = checkOverrides(req, PLUGIN, "task");
    assert.equal(out.ok, false, JSON.stringify(req));
    assert.match(JSON.stringify(out), /does not apply to a task/);
  }
  // A model on an app run needs the env names that carry it.
  const noEnv = { ...PLUGIN, overridable: { model: { enum: ["model-a"] } } };
  assert.equal(checkOverrides({ model: "model-a" }, noEnv, "app").ok, false);
  assert.equal(checkOverrides({ model: "model-a" }, noEnv, "task").ok, true);
});

const MANIFEST = {
  schema: APP_MANIFEST_SCHEMA,
  name: "example-app",
  version: "1.0.0",
  container: { image: IMAGES[0]!.repo, resources: { cpu: "32", memory: "128Gi" } },
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", "exec app run"],
  env: { APP_MODEL: "model-a", MODE: "fast", KEEP: "1" },
  env_map: { run_id: "APP_RUN_ID", mcp_token: "APP_MCP_TOKEN" },
  mcp: { port: 8765, path: "/mcp", token_header: "X-App-Token" },
  sandbox_templates: [
    { name: "runner", provider: "safe-pytorchjob", gpus: 1, data_plane: { mode: "open" } },
  ],
  sandbox_roles: { measurement: ["runner"] },
  limits: { input_max_bytes: 400, max_sandboxes: 2, max_runtime_sec: 7200 },
};

// V5
test("the app manifest gets the overrides; the plugin's own is untouched", () => {
  const before = JSON.stringify(MANIFEST);
  const out = applyAppOverrides(MANIFEST, {
    image: IMAGES[1]!.repo, model: "model-b", args: ["--fast"], env: { MODE: "full", SOURCE_SHA: SHA },
  }, DECL);
  assert.equal(JSON.stringify(MANIFEST), before);
  assert.deepEqual(out.env, { APP_MODEL: "model-b", APP_MODEL_2: "model-b", MODE: "full", KEEP: "1", SOURCE_SHA: SHA });
  assert.deepEqual(out.command, ["sh", "-c", "exec app run", "--fast"]);
  assert.equal(out.container.image, IMAGES[1]!.repo);
  assert.deepEqual(out.container.resources, MANIFEST.container.resources);
  assert.deepEqual(validateAppManifest(out), []);
  assert.equal(applyAppOverrides(MANIFEST, {}, DECL), MANIFEST);
  assert.deepEqual(overrideKeys({ model: "m", env: { A: "1" } }), ["model", "env.A"]);
});

// V6
test("a backtracking pattern is cut off, and its value refused", () => {
  const evil = { ...PLUGIN, overridable: { env: { X: { pattern: "^(a+)+$" }, Y: { pattern: "^ok$" } } } };
  const value = `${"a".repeat(40)}!`;
  const t0 = performance.now();
  const out = checkOverrides({ env: { X: value, Y: "ok" } }, evil, "app");
  const ms = performance.now() - t0;
  assert.equal(out.ok, false);
  assert.match(JSON.stringify(out), /could not be checked against the plugin's pattern in time/);
  assert.ok(ms < 2000, `the check returned after ${ms.toFixed(0)}ms`);
  // The same pattern on a value it settles quickly is an ordinary answer.
  assert.equal(checkOverrides({ env: { X: "aaaa", Y: "ok" } }, evil, "app").ok, true);
  assert.equal(checkOverrides({ env: { X: "aaab", Y: "ok" } }, evil, "app").ok, false);
  assert.deepEqual(runPatternJobs([{ pattern: "^a$", value: "a" }, { pattern: "^a$", value: "b" }]), [true, false]);
  assert.deepEqual(runPatternJobs([]), []);
  assert.equal(runPatternJobs([{ pattern: "^(a+)+$", value }], 20), null);
});

const skip = postgresSkipReason();

const user = (id: string, roles = ["default"]) => ({
  userId: id, userName: id, roles, platformKey: `pk-${id}`, virtualKey: `vk-${id}`,
});
const OWNER = user("u1");

describe("plugin overrides against Postgres", { skip }, () => {
  let h: AdmissionCluster;
  let tasksApp: FastifyInstance;
  let pluginsApp: FastifyInstance;
  let caller = OWNER;
  let declared = 0, undeclared = 0, plainDeclared = 0;
  let ports: any;
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);
  const count = async (table: string) =>
    Number(((await q(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n);
  const GOOD_RES = { gpus: 1, workspace: "ws-ok", grant: { max_sandboxes: 1, max_gpus: 1, gpu_hours: 1, max_runtime_sec: 600 } };

  before(async () => {
    assert.deepEqual(validateAppManifest(MANIFEST), [], "the fixture manifest must be valid, or every refusal below is vacuous");
    process.env.CLAW_DEPLOY_MODE = "safe";
    h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true", APP_GRANT_ISSUE_TIMEOUT_MS: "1000", APP_GRANT_REVOKE_RETRY_MS: "1000" });
    ports = (await import("../src/tasks/app-run.js")).appRunPorts;
    ports.enabled = () => true;
    ports.workspaceAccess = async (_a: unknown, ws: string) => (ws === "ws-ok" ? "ok" : "forbidden");
    const add = async (name: string, resource: unknown, overridable: unknown) =>
      Number(((await q(
        `INSERT INTO plugins (name, version, resource, images, overridable, owner_user_id, is_public)
         VALUES ($1, '1', $2::jsonb, $3::jsonb, $4::jsonb, 'u1', true) RETURNING id`,
        [name, JSON.stringify(resource), JSON.stringify(IMAGES), JSON.stringify(overridable)],
      )).rows[0] as { id: string }).id);
    declared = await add("declared", { app: { manifest: MANIFEST } }, DECL);
    undeclared = await add("undeclared", { app: { manifest: MANIFEST } }, {});
    plainDeclared = await add("plain", {}, { image: {}, model: { enum: ["model-a"] } });
    for (const sid of ["s1", "s2", "s3"]) {
      await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ($1, 't', 'u1', 'claw')", [sid]);
    }
    tasksApp = Fastify();
    tasksApp.addHook("preHandler", async (req) => { (req as any).user = caller; });
    await (await import("../src/routes/tasks.js")).registerTaskCreateRoute(tasksApp);
    await tasksApp.ready();
    pluginsApp = Fastify();
    pluginsApp.addHook("onRequest", async (req) => { (req as any).user = caller; });
    await (await import("../src/routes/plugins.js")).registerPluginRoutes(pluginsApp);
    await pluginsApp.ready();
  });
  after(async () => { await tasksApp?.close(); await pluginsApp?.close(); await h?.stop(); });
  beforeEach(async () => {
    caller = OWNER;
    await q("DELETE FROM claw_app_runs");
    await q("DELETE FROM claw_tasks");
  });

  const post = (sessionId: string, payload: unknown) =>
    tasksApp.inject({ method: "POST", url: `/v1/sessions/${sessionId}/tasks`, payload: payload as object });

  // W1
  test("plugin writes check the declaration and keep it", async () => {
    const before = await count("plugins");
    const bad = await pluginsApp.inject({
      method: "POST", url: "/v1/plugins", payload: { name: "w1", version: "1", overridable: { env: { "NOT-A-NAME": {} } } },
    });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.match(bad.json().message, /overridable\.env\.NOT-A-NAME/);
    assert.equal(await count("plugins"), before);

    const good = await pluginsApp.inject({
      method: "POST", url: "/v1/plugins", payload: { name: "w1", version: "1", images: IMAGES, overridable: DECL },
    });
    assert.equal(good.statusCode, 201, good.body);
    const id = good.json().data.id as number;
    assert.deepEqual(good.json().data.overridable, DECL);
    const got = await pluginsApp.inject({ method: "GET", url: `/v1/plugins/${id}` });
    assert.deepEqual(got.json().data.overridable, DECL);

    const badPatch = await pluginsApp.inject({ method: "PATCH", url: `/v1/plugins/${id}`, payload: { overridable: { nope: 1 } } });
    assert.equal(badPatch.statusCode, 400, badPatch.body);
    const nv = await pluginsApp.inject({ method: "POST", url: `/v1/plugins/${id}/new-version`, payload: { name: "w1", version: "2" } });
    assert.equal(nv.statusCode, 201, nv.body);
    assert.deepEqual(nv.json().data.overridable, DECL, "a new version keeps the declaration");
    const up = await pluginsApp.inject({ method: "POST", url: "/v1/plugins/upsert", payload: { name: "w1", version: "2", overridable: {} } });
    assert.equal(up.statusCode, 200, up.body);
    assert.deepEqual(up.json().data.overridable, {}, "an upsert can clear it");
    // A row without the field (every plugin before it) reads as nothing declared.
    const legacy = await pluginsApp.inject({ method: "POST", url: "/v1/plugins", payload: { name: "w1-legacy", version: "1" } });
    assert.deepEqual(legacy.json().data.overridable, {});
  });

  // A1
  test("an app run with overrides stores the effective manifest and an audit record", async () => {
    const res = await post("s1", {
      mode: "app", plugin_id: declared, input: { x: 1 }, resources: GOOD_RES,
      overrides: { model: "model-b", image: IMAGES[1]!.repo, args: ["--fast"], env: { SOURCE_SHA: SHA } },
    });
    assert.equal(res.statusCode, 200, res.body);
    const taskId = res.json().task_id as string;
    const run = (await q("SELECT manifest FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as any;
    assert.equal(run.manifest.env.APP_MODEL, "model-b");
    assert.equal(run.manifest.env.APP_MODEL_2, "model-b");
    assert.equal(run.manifest.env.SOURCE_SHA, SHA);
    assert.equal(run.manifest.env.KEEP, "1");
    assert.deepEqual(run.manifest.command, [...MANIFEST.command, "--fast"]);
    const t = (await q("SELECT sandbox_spec, metadata FROM claw_tasks WHERE task_id = $1", [taskId])).rows[0] as any;
    assert.equal(t.sandbox_spec.image, IMAGES[1]!.repo, "the overridden image is the run's image");
    assert.deepEqual(t.metadata.plugin_overrides, {
      plugin_id: declared, plugin_version: "1",
      values: { model: "model-b", image: IMAGES[1]!.repo, args: ["--fast"], env: { SOURCE_SHA: SHA } },
    });
    assert.ok(t.metadata.derived, "the derived block is still written");
    // The plugin row is not changed by a launch.
    const p = (await q("SELECT resource FROM plugins WHERE id = $1", [declared])).rows[0] as any;
    assert.deepEqual(p.resource.app.manifest, MANIFEST);

    // The same plugin without overrides runs as declared.
    const plain = await post("s2", { mode: "app", plugin_id: declared, input: { x: 1 }, resources: GOOD_RES });
    assert.equal(plain.statusCode, 200, plain.body);
    const plainRun = (await q("SELECT manifest FROM claw_app_runs WHERE task_id = $1", [plain.json().task_id])).rows[0] as any;
    assert.deepEqual(plainRun.manifest, MANIFEST);
    const plainTask = (await q("SELECT metadata FROM claw_tasks WHERE task_id = $1", [plain.json().task_id])).rows[0] as any;
    assert.equal(plainTask.metadata.plugin_overrides, undefined);
  });

  // A2
  test("an app run's undeclared, invalid or reserved override is refused and writes nothing", async () => {
    const cases: Array<[number, unknown]> = [
      [undeclared, { env: { SOURCE_SHA: SHA } }],
      [declared, { env: { SOURCE_SHA: "HEAD" } }],
      [declared, { image: "registry.example.invalid/elsewhere:1" }],
      [declared, { image: IMAGES[1]!.repo, _resources_image: true }],
    ];
    for (const [pluginId, overrides] of cases) {
      const o = { ...(overrides as Record<string, unknown>) };
      const both = "_resources_image" in o;
      delete o._resources_image;
      const res = await post("s1", {
        mode: "app", plugin_id: pluginId, input: { x: 1 },
        resources: both ? { ...GOOD_RES, image: IMAGES[0]!.repo } : GOOD_RES, overrides: o,
      });
      assert.equal(res.statusCode, 400, `${JSON.stringify(overrides)}: ${res.body}`);
      assert.equal(res.json().error, "plugin_overrides_invalid");
    }
    // A declared variable the platform reserves is refused by the manifest check.
    const reserved = await q("INSERT INTO plugins (name, version, resource, images, overridable, owner_user_id, is_public) VALUES ('reserved', '1', $1::jsonb, '[]'::jsonb, $2::jsonb, 'u1', true) RETURNING id",
      [JSON.stringify({ app: { manifest: MANIFEST } }), JSON.stringify({ env: { LD_PRELOAD: {} } })]);
    const res = await post("s1", {
      mode: "app", plugin_id: Number((reserved.rows[0] as any).id), input: { x: 1 }, resources: GOOD_RES,
      overrides: { env: { LD_PRELOAD: "/tmp/x.so" } },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, "plugin_overrides_invalid");
    assert.ok(Array.isArray(res.json().issues) && res.json().issues.length > 0, "refused by the manifest check, which names the issue");
    assert.equal(await count("claw_tasks"), 0);
    assert.equal(await count("claw_app_runs"), 0);
  });

  // A3
  test("the Idempotency-Key hash of a request without overrides is unchanged", async () => {
    const { appRunRequestHash } = await import("../src/tasks/app-run.js");
    const body = { plugin_id: 1, input: { a: 1 }, resources: { gpus: 1 } };
    assert.equal(appRunRequestHash(body), appRunRequestHash({ ...body, overrides: undefined }));
    assert.equal(appRunRequestHash(body), appRunRequestHash({ ...body, overrides: null }));
    assert.notEqual(appRunRequestHash(body), appRunRequestHash({ ...body, overrides: { model: "m" } }));
    assert.notEqual(appRunRequestHash({ ...body, overrides: { model: "a" } }), appRunRequestHash({ ...body, overrides: { model: "b" } }));
  });

  // T1
  test("a single task gets the model and image, with an audit record", async () => {
    const res = await post("s1", {
      plugin_id: plainDeclared, prompt: "hi", overrides: { model: "model-a", image: IMAGES[1]!.repo },
    });
    assert.equal(res.statusCode, 200, res.body);
    const t = (await q("SELECT model, sandbox_spec, metadata FROM claw_tasks WHERE task_id = $1", [res.json().task_id])).rows[0] as any;
    assert.equal(t.model, "model-a");
    assert.equal(t.sandbox_spec.image, IMAGES[1]!.repo);
    assert.deepEqual(t.metadata.plugin_overrides.values, { model: "model-a", image: IMAGES[1]!.repo });

    const plain = await post("s2", { plugin_id: plainDeclared, prompt: "hi" });
    assert.equal(plain.statusCode, 200, plain.body);
    const pt = (await q("SELECT model, sandbox_spec, metadata FROM claw_tasks WHERE task_id = $1", [plain.json().task_id])).rows[0] as any;
    assert.equal(pt.model, null);
    assert.equal(pt.sandbox_spec.image, IMAGES[0]!.repo, "without an override the plugin's first image");
    assert.equal(pt.metadata.plugin_overrides, undefined);

    const bad = await post("s3", { plugin_id: plainDeclared, prompt: "hi", overrides: { model: "model-z" } });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal(bad.json().error, "plugin_overrides_invalid");
  });

  // T2
  test("a task override without a plugin, or on a DAG, is refused", async () => {
    const res = await post("s1", { prompt: "hi", overrides: { model: "model-a" } });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(JSON.stringify(res.json().problems), /needs a plugin_id/);
    assert.equal(await count("claw_tasks"), 0);
    const { checkTaskOverrides } = await import("../src/routes/tasks.js");
    const plugin = { id: 1, images: IMAGES, overridable: DECL };
    assert.deepEqual(checkTaskOverrides({ overrides: { model: "model-a" } }, { dag: { dag_id: "d" }, plugin }), {
      problems: [{ field: "overrides", reason: "is not supported for a DAG run" }],
    });
    assert.deepEqual(checkTaskOverrides({}, { dag: { dag_id: "d" }, plugin }), { values: {} }, "a DAG without overrides is unaffected");
  });
});
