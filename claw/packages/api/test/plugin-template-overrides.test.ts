// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Run-time overrides of an app manifest's sandbox templates
 * (`overridable.sandbox_templates`, marketplace/plugin-overrides.ts).
 *
 * A plugin declares, per template, which of `fromImage`, `per_gpu_count` and
 * `resources` a launch may set and within what bounds; an app run names its
 * values in `overrides.sandbox_templates`. The launch path is asserted end to
 * end on a real Postgres (skipped, and printed as skipped, without
 * DATABASE_URL): the plugin is declared through `POST /v1/plugins`, the run is
 * created through `POST /v1/sessions/:id/tasks`, and the grant is issued by the
 * API's own grant hooks to a fake Agent Sandbox over HTTP, which records the
 * templates it was asked to register.
 *
 * Every refusal is paired with the same plugin admitting a valid launch, so a
 * path that refuses everything cannot pass.
 *
 * Coverage:
 *   D1 a declaration is checked when written, and every problem is named
 *   D2 the values land where Agent Sandbox reads them, in both template forms; the input is untouched
 *   P1 plugin writes: an invalid declaration is 400 and stores nothing; a valid one round-trips
 *   P2 an app run stores the effective manifest and the audit, and the grant carries the effective templates
 *   P3 every refusal is 400 plugin_overrides_invalid, names the field, and creates nothing
 *   P4 a plugin without the declaration launches exactly as before and refuses the override
 *   P5 the overrides are part of what an Idempotency-Key is bound to
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA, SandboxGrantClient, appGrantTemplates, loadGrantSigner, validateAppManifest } from "@claw/protocol";
import {
  applyAppOverrides,
  applyTemplateOverride,
  checkOverrides,
  overridableDeclarationProblems,
  overrideKeys,
} from "../src/marketplace/plugin-overrides.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const IMG1 = "registry.example.invalid/runner:1";
const IMG2 = "registry.example.invalid/runner:2";
const APP_IMAGE = "registry.example.invalid/app:1";

const MANIFEST = {
  schema: APP_MANIFEST_SCHEMA,
  name: "example-app",
  version: "1.0.0",
  container: { image: APP_IMAGE, resources: { cpu: "8", memory: "32Gi" } },
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", "exec app run"],
  env: { MODE: "fast" },
  env_map: { run_id: "APP_RUN_ID", sandbox_templates: "APP_SANDBOX_TEMPLATES" },
  sandbox_templates: [
    {
      name: "runner", per_gpu_count: [1, 8], fromImage: IMG1,
      resources: { requests: { cpu: "8" }, limits: { cpu: "16" } }, data_plane: { mode: "open" },
    },
    { name: "wrapped", per_gpu_count: [2], template: { fromImage: IMG1, steps: [] } },
    { name: "helper", fromImage: "registry.example.invalid/helper:1" },
    { name: "probe", fromImage: "registry.example.invalid/probe:1" },
  ],
  sandbox_roles: { measurement: ["runner", "wrapped"], dev: ["helper"], subrun: ["probe"] },
  limits: { input_max_bytes: 4000, max_sandboxes: 4, max_runtime_sec: 7200 },
};

const DECL = {
  sandbox_templates: {
    runner: {
      fromImage: { enum: [IMG1, IMG2] },
      per_gpu_count: { enum: [2, 4, 8] },
      resources: {
        cpu: { max: "64" }, memory: { max: "2048Gi" }, ephemeralStorage: { max: "1500Gi" }, sharedMemory: { max: "1000Gi" },
      },
    },
    wrapped: {
      fromImage: { pattern: "^registry\\.example\\.invalid/runner:[0-9]+$" },
      per_gpu_count: { minimum: 1, maximum: 8 },
      resources: { cpu: { max: "64" }, memory: { max: "2048Gi" } },
    },
    probe: { fromImage: { enum: ["registry.example.invalid/probe:1", "registry.example.invalid/probe:2"] }, resources: { cpu: { max: "4" }, sharedMemory: { max: "8Gi" } } },
    // Declared, but the manifest has no such template.
    ghost: { per_gpu_count: { enum: [1] } },
  },
  env: { MODE: { enum: ["fast", "full"] } },
};

const GOOD = {
  runner: {
    fromImage: IMG2,
    per_gpu_count: 4,
    resources: {
      requests: { cpu: "24", memory: "1400Gi" },
      limits: { cpu: "32", memory: "1400Gi", "ephemeral-storage": "750Gi" },
      sharedMemory: "512Gi",
    },
  },
  wrapped: { fromImage: "registry.example.invalid/runner:7", per_gpu_count: 8 },
};

const PLUGIN = { id: 9, version: "1", images: [], overridable: DECL, resource: { app: { manifest: MANIFEST } } };

// D1
test("a template declaration is checked, and every problem is named", () => {
  assert.deepEqual(overridableDeclarationProblems(DECL), []);
  const problems = overridableDeclarationProblems({
    sandbox_templates: {
      "Bad Name": { per_gpu_count: { enum: [1] } },
      a: {},
      b: { fromImage: {}, per_gpu_count: { minimum: 1 }, size: 1 },
      c: { per_gpu_count: { enum: [0, 2, 2] }, resources: { gpu: { max: "1" }, cpu: { max: "-1" }, memory: { max: "lots" } } },
      d: { per_gpu_count: { minimum: 8, maximum: 2, type: "number" }, resources: {} },
      e: { fromImage: { pattern: "(" }, resources: { sharedMemory: { max: "0" }, cpu: "64" } },
    },
  });
  assert.deepEqual(problems.map((p) => p.field).sort(), [
    "overridable.sandbox_templates.Bad Name",
    "overridable.sandbox_templates.a",
    "overridable.sandbox_templates.b.fromImage",
    "overridable.sandbox_templates.b.per_gpu_count",
    "overridable.sandbox_templates.b.size",
    "overridable.sandbox_templates.c.per_gpu_count.enum",
    "overridable.sandbox_templates.c.resources.cpu.max",
    "overridable.sandbox_templates.c.resources.gpu",
    "overridable.sandbox_templates.c.resources.memory.max",
    "overridable.sandbox_templates.d.per_gpu_count.minimum",
    "overridable.sandbox_templates.d.per_gpu_count.type",
    "overridable.sandbox_templates.d.resources",
    "overridable.sandbox_templates.e.fromImage.pattern",
    "overridable.sandbox_templates.e.resources.cpu",
    "overridable.sandbox_templates.e.resources.sharedMemory.max",
  ].sort(), JSON.stringify(problems));
  assert.deepEqual(overridableDeclarationProblems({ sandbox_templates: {} }).map((p) => p.field), ["overridable.sandbox_templates"]);
  assert.deepEqual(overridableDeclarationProblems({ sandbox_templates: [] }).map((p) => p.field), ["overridable.sandbox_templates"]);
});

// D2
test("the values land where Agent Sandbox reads them, in both template forms", () => {
  const before = JSON.stringify(MANIFEST);
  const checked = checkOverrides({ sandbox_templates: GOOD }, PLUGIN, "app");
  assert.ok(checked.ok, JSON.stringify(checked));
  const out = applyAppOverrides(MANIFEST, checked.values, DECL);
  assert.equal(JSON.stringify(MANIFEST), before, "the plugin's manifest is not changed");
  assert.deepEqual(validateAppManifest(out), []);
  const [runner, wrapped, helper, probe] = out.sandbox_templates as Array<Record<string, any>>;
  assert.deepEqual(runner, {
    name: "runner", per_gpu_count: [4], fromImage: IMG2,
    resources: {
      requests: { cpu: "24", memory: "1400Gi" },
      limits: { cpu: "32", memory: "1400Gi", "ephemeral-storage": "750Gi" },
    },
    gpu: { sharedMemory: "512Gi" },
    data_plane: { mode: "open" },
  });
  assert.deepEqual(wrapped, { name: "wrapped", per_gpu_count: [8], template: { fromImage: "registry.example.invalid/runner:7", steps: [] } });
  assert.equal(helper, MANIFEST.sandbox_templates[2], "a template the launch does not name is the manifest's own");
  assert.equal(probe, MANIFEST.sandbox_templates[3]);
  // One entry replaces that entry only; the rest of the template's resources stay.
  assert.deepEqual(
    applyTemplateOverride(MANIFEST.sandbox_templates[0]!, { resources: { limits: { memory: "64Gi" } } }).resources,
    { requests: { cpu: "8" }, limits: { cpu: "16", memory: "64Gi" } },
  );
  assert.deepEqual(overrideKeys(checked.values), [
    "sandbox_templates.runner.fromImage", "sandbox_templates.runner.per_gpu_count", "sandbox_templates.runner.resources",
    "sandbox_templates.wrapped.fromImage", "sandbox_templates.wrapped.per_gpu_count",
  ]);
  // Not a task's to set.
  const task = checkOverrides({ sandbox_templates: GOOD }, PLUGIN, "task");
  assert.equal(task.ok, false);
  assert.match(JSON.stringify(task), /does not apply to a task/);
});

/** Each refused launch: the overrides, and the field the refusal must name. */
const REFUSALS: Array<[string, unknown, string]> = [
  ["undeclared template", { helper: { fromImage: IMG1 } }, "overrides.sandbox_templates.helper"],
  ["undeclared key of a template", { probe: { per_gpu_count: 1 } }, "overrides.sandbox_templates.probe.per_gpu_count"],
  ["undeclared resource of a template", { probe: { resources: { requests: { memory: "1Gi" } } } }, "overrides.sandbox_templates.probe.resources.requests.memory"],
  ["shared memory on a template without card counts", { probe: { resources: { sharedMemory: "1Gi" } } }, "overrides.sandbox_templates.probe.resources.sharedMemory"],
  ["unknown key of a template", { runner: { gpus: 4 } }, "overrides.sandbox_templates.runner.gpus"],
  ["unknown template", { ghost: { per_gpu_count: 1 } }, "overrides.sandbox_templates.ghost"],
  ["image outside the enum", { runner: { fromImage: "registry.example.invalid/other:1" } }, "overrides.sandbox_templates.runner.fromImage"],
  ["image outside the pattern", { wrapped: { fromImage: "registry.example.invalid/runner:latest" } }, "overrides.sandbox_templates.wrapped.fromImage"],
  ["card count outside the enum", { runner: { per_gpu_count: 3 } }, "overrides.sandbox_templates.runner.per_gpu_count"],
  ["card count another template of the role takes", { runner: { per_gpu_count: 2 } }, "overrides.sandbox_templates.runner.per_gpu_count"],
  ["card count above the maximum", { wrapped: { per_gpu_count: 9 } }, "overrides.sandbox_templates.wrapped.per_gpu_count"],
  ["card count not an integer", { wrapped: { per_gpu_count: 2.5 } }, "overrides.sandbox_templates.wrapped.per_gpu_count"],
  ["cpu above the maximum", { runner: { resources: { limits: { cpu: "65" } } } }, "overrides.sandbox_templates.runner.resources.limits.cpu"],
  ["memory above the maximum", { runner: { resources: { requests: { memory: "2049Gi" } } } }, "overrides.sandbox_templates.runner.resources.requests.memory"],
  ["shared memory above the maximum", { runner: { resources: { sharedMemory: "1001Gi" } } }, "overrides.sandbox_templates.runner.resources.sharedMemory"],
  ["a resource that is not sized here", { runner: { resources: { limits: { "amd.com/gpu": "8" } } } }, "overrides.sandbox_templates.runner.resources.limits.amd.com/gpu"],
  ["not a quantity", { runner: { resources: { requests: { cpu: 24 } } } }, "overrides.sandbox_templates.runner.resources.requests.cpu"],
  ["requests above limits in the launch", { runner: { resources: { requests: { memory: "1500Gi" }, limits: { memory: "1400Gi" } } } }, "overrides.sandbox_templates.runner.resources.requests.memory"],
  ["request above the template's own limit", { runner: { resources: { requests: { cpu: "24" } } } }, "overrides.sandbox_templates.runner.resources.requests.cpu"],
  ["limit below the template's own request", { runner: { resources: { limits: { cpu: "4" } } } }, "overrides.sandbox_templates.runner.resources.limits.cpu"],
  ["shared memory above the memory limit", { runner: { resources: { limits: { memory: "256Gi" }, sharedMemory: "512Gi" } } }, "overrides.sandbox_templates.runner.resources.sharedMemory"],
  ["no template named", {}, "overrides.sandbox_templates"],
  ["nothing named for a template", { runner: {} }, "overrides.sandbox_templates.runner"],
];

const skip = postgresSkipReason();

const OWNER = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "pk-u1", virtualKey: "vk-u1" };

/** A fake Agent Sandbox grant endpoint: records each issue body and answers as the service does. */
function fakeAgentSandbox(): { server: Server; issued: any[]; url: () => string } {
  const issued: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method === "DELETE") { res.writeHead(200).end("{}"); return; }
      const body = JSON.parse(raw);
      issued.push(body);
      const names: Record<string, string[]> = {};
      for (const [role, r] of Object.entries(body.roles as Record<string, { templates: string[] }>)) {
        names[role] = r.templates.flatMap((name) => {
          const t = (body.templates as Array<{ name: string; perGpuCount?: number[] }>).find((x) => x.name === name)!;
          const base = `ar-${body.issuer.appRunId.toLowerCase()}-${name}`;
          return t.perGpuCount ? t.perGpuCount.map((n) => `${base}-g${n}`) : [base];
        });
      }
      const keys = Object.fromEntries(Object.keys(body.roles).map((r) => [r, `key-${r}`]));
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ keys, maxSandboxes: body.maxSandboxes, maxGpus: body.maxGpus, templates: names }));
    });
  });
  return { server, issued, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}/internal/v1/grants` };
}

describe("sandbox template overrides against Postgres", { skip }, () => {
  let h: AdmissionCluster;
  let tasksApp: FastifyInstance;
  let pluginsApp: FastifyInstance;
  let declared = 0, undeclared = 0;
  let ports: any;
  let savedGrant: any;
  const sandbox = fakeAgentSandbox();
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);
  const count = async (table: string) =>
    Number(((await q(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0] as { n: number }).n);
  const RES = { gpus: 1, workspace: "ws-ok", grant: { max_sandboxes: 2, max_gpus: 8, gpu_hours: 1, max_runtime_sec: 600 } };

  before(async () => {
    assert.deepEqual(validateAppManifest(MANIFEST), [], "the fixture manifest must be valid, or every refusal below is vacuous");
    await new Promise<void>((resolve) => sandbox.server.listen(0, "127.0.0.1", resolve));
    process.env.CLAW_DEPLOY_MODE = "safe";
    h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true", APP_GRANT_ISSUE_TIMEOUT_MS: "5000", APP_GRANT_REVOKE_RETRY_MS: "1000" });
    ports = (await import("../src/tasks/app-run.js")).appRunPorts;
    ports.enabled = () => true;
    ports.workspaceAccess = async (_a: unknown, ws: string) => (ws === "ws-ok" ? "ok" : "forbidden");
    // The API's own grant hooks, signing with a throwaway key, against the fake service.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signer = loadGrantSigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const { apiGrantHooks } = await import("../src/grants/app-grant.js");
    savedGrant = ports.grant;
    ports.grant = apiGrantHooks(new SandboxGrantClient({ signer, token: () => "tok", baseUrl: sandbox.url() }));
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s1', 't', 'u1', 'claw'), ('s2', 't', 'u1', 'claw')");
    tasksApp = Fastify();
    tasksApp.addHook("preHandler", async (req) => { (req as any).user = OWNER; });
    await (await import("../src/routes/tasks.js")).registerTaskCreateRoute(tasksApp);
    await tasksApp.ready();
    pluginsApp = Fastify();
    pluginsApp.addHook("onRequest", async (req) => { (req as any).user = OWNER; });
    await (await import("../src/routes/plugins.js")).registerPluginRoutes(pluginsApp);
    await pluginsApp.ready();
  });
  after(async () => {
    if (ports && savedGrant) ports.grant = savedGrant;
    await tasksApp?.close();
    await pluginsApp?.close();
    await h?.stop();
    await new Promise<void>((resolve) => sandbox.server.close(() => resolve()));
  });
  beforeEach(async () => {
    sandbox.issued.length = 0;
    await q("DELETE FROM claw_app_runs");
    await q("DELETE FROM claw_tasks");
  });

  const launch = (sessionId: string, overrides?: unknown, headers: Record<string, string> = {}) => tasksApp.inject({
    method: "POST", url: `/v1/sessions/${sessionId}/tasks`, headers,
    payload: { mode: "app", plugin_id: declared, input: { x: 1 }, resources: RES, ...(overrides === undefined ? {} : { overrides }) },
  });

  // P1
  test("plugin writes check a template declaration and keep it", async () => {
    const before = await count("plugins");
    const bad = await pluginsApp.inject({
      method: "POST", url: "/v1/plugins",
      payload: { name: "tpl-bad", version: "1", resource: { app: { manifest: MANIFEST } }, overridable: { sandbox_templates: { runner: { resources: { cpu: { max: "lots" } } } } } },
    });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.match(bad.json().message, /overridable\.sandbox_templates\.runner\.resources\.cpu\.max/);
    assert.equal(await count("plugins"), before, "nothing is written");

    const good = await pluginsApp.inject({
      method: "POST", url: "/v1/plugins",
      payload: { name: "tpl-declared", version: "1", is_public: true, resource: { app: { manifest: MANIFEST } }, overridable: DECL },
    });
    assert.equal(good.statusCode, 201, good.body);
    declared = good.json().data.id as number;
    assert.deepEqual(good.json().data.overridable, DECL);
    const got = await pluginsApp.inject({ method: "GET", url: `/v1/plugins/${declared}` });
    assert.deepEqual(got.json().data.overridable, DECL);

    const plain = await pluginsApp.inject({
      method: "POST", url: "/v1/plugins",
      payload: { name: "tpl-undeclared", version: "1", is_public: true, resource: { app: { manifest: MANIFEST } } },
    });
    assert.equal(plain.statusCode, 201, plain.body);
    undeclared = plain.json().data.id as number;
    assert.deepEqual(plain.json().data.overridable, {});
  });

  // P2
  test("an app run gets the effective templates: stored, audited and sent to Agent Sandbox", async () => {
    assert.ok(declared > 0, "P1 registered the plugin");
    const res = await launch("s1", { sandbox_templates: GOOD, env: { MODE: "full" } });
    assert.equal(res.statusCode, 200, res.body);
    const taskId = res.json().task_id as string;

    const run = (await q("SELECT manifest, grant_templates FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as any;
    const [runner, wrapped, helper] = run.manifest.sandbox_templates;
    assert.deepEqual(runner.per_gpu_count, [4]);
    assert.equal(runner.fromImage, IMG2);
    assert.deepEqual(runner.resources, {
      requests: { cpu: "24", memory: "1400Gi" }, limits: { cpu: "32", memory: "1400Gi", "ephemeral-storage": "750Gi" },
    });
    assert.deepEqual(runner.gpu, { sharedMemory: "512Gi" });
    assert.deepEqual(wrapped.template.fromImage, "registry.example.invalid/runner:7");
    assert.deepEqual(wrapped.per_gpu_count, [8]);
    assert.deepEqual(helper, MANIFEST.sandbox_templates[2]);
    assert.equal(run.manifest.env.MODE, "full", "the other keys still apply");
    // The template names the app is handed are those of the effective card counts.
    assert.deepEqual(Object.keys(run.grant_templates.measurement).sort(), ["4", "8"]);

    const t = (await q("SELECT metadata FROM claw_tasks WHERE task_id = $1", [taskId])).rows[0] as any;
    assert.deepEqual(t.metadata.plugin_overrides, {
      plugin_id: declared, plugin_version: "1", values: { sandbox_templates: GOOD, env: { MODE: "full" } },
    });

    // What reached Agent Sandbox.
    assert.equal(sandbox.issued.length, 1);
    const sent = Object.fromEntries((sandbox.issued[0].templates as any[]).map((x) => [x.name, x]));
    assert.deepEqual(sent.runner.perGpuCount, [4]);
    assert.equal(sent.runner.spec.fromImage, IMG2);
    assert.deepEqual(sent.runner.spec.resources, run.manifest.sandbox_templates[0].resources);
    assert.deepEqual(sent.runner.spec.gpu, { sharedMemory: "512Gi" });
    assert.deepEqual(sent.wrapped.perGpuCount, [8]);
    assert.equal(sent.wrapped.spec.template.fromImage, "registry.example.invalid/runner:7");
    assert.equal(sent.helper.spec.fromImage, "registry.example.invalid/helper:1");

    // The plugin row is not changed by a launch.
    const p = (await q("SELECT resource FROM plugins WHERE id = $1", [declared])).rows[0] as any;
    assert.deepEqual(p.resource.app.manifest, MANIFEST);
  });

  // P3
  for (const [what, overrides, field] of REFUSALS) {
    test(`refused: ${what}`, async () => {
      const res = await launch("s1", { sandbox_templates: overrides });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error, "plugin_overrides_invalid");
      const fields = (res.json().problems as Array<{ field: string }>).map((p) => p.field);
      assert.ok(fields.includes(field), `${field} in ${JSON.stringify(res.json().problems)}`);
      assert.equal(await count("claw_tasks"), 0);
      assert.equal(await count("claw_app_runs"), 0);
      assert.equal(sandbox.issued.length, 0, "nothing is asked of Agent Sandbox");
      // The same plugin admits a valid launch, so the refusal is about the value.
      const ok = await launch("s2", { sandbox_templates: { runner: { per_gpu_count: 4 } } });
      assert.equal(ok.statusCode, 200, ok.body);
    });
  }

  // P4
  test("a plugin without the declaration launches as before and refuses the override", async () => {
    const res = await tasksApp.inject({
      method: "POST", url: "/v1/sessions/s1/tasks",
      payload: { mode: "app", plugin_id: undeclared, input: { x: 1 }, resources: RES },
    });
    assert.equal(res.statusCode, 200, res.body);
    const taskId = res.json().task_id as string;
    const run = (await q("SELECT manifest FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as any;
    assert.deepEqual(run.manifest, MANIFEST);
    const t = (await q("SELECT metadata FROM claw_tasks WHERE task_id = $1", [taskId])).rows[0] as any;
    assert.equal(t.metadata.plugin_overrides, undefined);
    const sent = sandbox.issued[0].templates as any[];
    const expected = appGrantTemplates(MANIFEST as any, { image: APP_IMAGE, sandboxWorkspace: "ws-ok" });
    assert.deepEqual(sent.map((x) => x.name), expected.map((x) => x.name));
    assert.deepEqual(sent[0].perGpuCount, [1, 8]);
    assert.deepEqual(sent[0].spec.resources, MANIFEST.sandbox_templates[0]!.resources);

    const refused = await tasksApp.inject({
      method: "POST", url: "/v1/sessions/s2/tasks",
      payload: { mode: "app", plugin_id: undeclared, input: { x: 1 }, resources: RES, overrides: { sandbox_templates: { runner: { per_gpu_count: 2 } } } },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error, "plugin_overrides_invalid");
    assert.match(JSON.stringify(refused.json().problems), /the plugin does not declare this overridable/);
  });

  // P5
  test("an Idempotency-Key is bound to the template overrides", async () => {
    const key = { "idempotency-key": "tpl-key-1" };
    const first = await launch("s1", { sandbox_templates: { runner: { per_gpu_count: 4 } } }, key);
    assert.equal(first.statusCode, 200, first.body);
    const again = await launch("s1", { sandbox_templates: { runner: { per_gpu_count: 4 } } }, key);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().task_id, first.json().task_id, "the same request replays");
    const changed = await launch("s1", { sandbox_templates: { runner: { per_gpu_count: 8 } } }, key);
    assert.equal(changed.statusCode, 422, changed.body);
    assert.equal(changed.json().error, "idempotency_key_reused");
  });
});
