// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A plugin write runs the app manifest's static checks, so a manifest an app
 * run would refuse (422 app_manifest_invalid) is never stored.
 *
 * The template host mounts and keys used to be checked only when an app run
 * was created: `POST /v1/plugins/upsert` stored a template with
 * `readOnly: false`, its own hostPath `volumes`, `hostPath: /etc` or a `..`
 * segment and answered 201. Whether a mount lies under a directory the
 * sandbox's workspace grants is still checked at app run, because the
 * workspace is only known then.
 *
 * Coverage:
 *   M1 a valid manifest with a read-only host mount is 201 and stored as sent
 *   M2 readOnly false, a template hostPath volume, /etc and a .. segment are each
 *      422 app_manifest_invalid naming the field, and nothing is written
 *   M3 a mount outside any workspace directory is stored (refused at app run)
 *   M4 an in-place upsert of an existing version is refused the same way
 *   M5 POST /v1/plugins, PATCH and new-version refuse it too; a PATCH without
 *      `resource` and a plugin without an app are not checked
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { MarketplaceDb, type JsonObject } from "../src/infra/db.js";
import { registerPluginRoutes } from "../src/routes/plugins.js";
import type { UserInfo } from "../src/auth/models.js";

const OWNER: UserInfo = { userId: "owner-user", userName: "owner", roles: [], platformKey: "", virtualKey: "" };
const IMAGE = "registry.example.invalid/probe@sha256:" + "0".repeat(64);

function template(over: JsonObject = {}): JsonObject {
  return {
    name: "probe",
    fromImage: IMAGE,
    resources: { requests: { cpu: "1", memory: "8Gi" }, limits: { cpu: "1", memory: "8Gi" } },
    workspaceStorage: "off",
    host_mounts: [{ hostPath: "/shared/team/jit-cache", readOnly: true }],
    ...over,
  };
}

function manifest(t: JsonObject = template()): JsonObject {
  return {
    schema: "claw.app-manifest/v1",
    name: "mount-probe",
    version: "0.1.0",
    container: { image: IMAGE, resources: { cpu: "2", memory: "8Gi" } },
    state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
    command: ["python3", "-c", "print(1)"],
    env_map: { run_id: "APP_RUN_ID", sandbox_templates: "APP_SANDBOX_TEMPLATES", sandbox_keys: { measurement: "APP_SANDBOX_KEY" } },
    sandbox_templates: [t],
    sandbox_roles: { measurement: ["probe"] },
  };
}

const resourceOf = (m: JsonObject): JsonObject => ({ app: { manifest: m } });

/** The probes of the registration evidence, each with the field its refusal names. */
const REFUSED: Array<[string, JsonObject, string]> = [
  ["readOnly false", template({ host_mounts: [{ hostPath: "/shared/team/jit-cache", readOnly: false }] }),
    "sandbox_templates[0].host_mounts[0].readOnly"],
  ["a template hostPath volume", template({ volumes: [{ name: "x", hostPath: { path: "/shared/team/jit-cache" } }] }),
    "sandbox_templates[0].volumes[0]"],
  ["hostPath /etc", template({ host_mounts: [{ hostPath: "/etc", readOnly: true }] }),
    "sandbox_templates[0].host_mounts[0].hostPath"],
  ["a .. segment", template({ host_mounts: [{ hostPath: "/shared/team/../team/jit-cache", readOnly: true }] }),
    "sandbox_templates[0].host_mounts[0].hostPath"],
  ["the workspace's storage left on", Object.fromEntries(Object.entries(template()).filter(([k]) => k !== "workspaceStorage")),
    "sandbox_templates[0].workspaceStorage"],
];

function pluginRow(over: JsonObject = {}): JsonObject {
  return {
    id: 7, name: "mount-probe", version: "1.0.0", description: "", images: [], tools: [], resource: resourceOf(manifest()),
    owner_user_id: OWNER.userId, author: "owner", is_public: false, status: "active",
    created_at: new Date(0), updated_at: new Date(0), ...over,
  };
}

describe("plugin writes check the app manifest before storing it", () => {
  let app: FastifyInstance;
  const writes: Array<{ op: string; payload: JsonObject }> = [];
  const saved: Partial<typeof MarketplaceDb> = {};
  const stub = <K extends keyof typeof MarketplaceDb>(k: K, f: unknown) => {
    if (!(k in saved)) (saved as Record<string, unknown>)[k] = MarketplaceDb[k];
    (MarketplaceDb as Record<string, unknown>)[k] = f;
  };

  before(async () => {
    stub("pluginsActiveByName", async (name: string) => (name === "mount-probe" ? [pluginRow()] : []));
    stub("pluginUpdate", async (id: number, patch: JsonObject) => {
      writes.push({ op: "update", payload: patch });
      return pluginRow({ id, ...patch });
    });
    stub("pluginInsert", async (payload: JsonObject) => {
      writes.push({ op: "insert", payload });
      return pluginRow({ ...payload, id: 8 });
    });
    stub("pluginGetById", async (id: number) => (id === 7 ? pluginRow() : null));
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = OWNER; });
    await registerPluginRoutes(app);
    await app.ready();
  });
  after(async () => {
    Object.assign(MarketplaceDb, saved);
    await app?.close();
  });
  beforeEach(() => { writes.length = 0; });

  const upsert = (name: string, version: string, m: JsonObject) => app.inject({
    method: "POST", url: "/v1/plugins/upsert", payload: { name, version, resource: resourceOf(m) },
  });

  function assertRefused(res: { statusCode: number; body: string; json: () => JsonObject }, field: string): void {
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "app_manifest_invalid");
    const paths = (body.issues as Array<{ path: string }>).map((i) => i.path);
    assert.ok(paths.includes(field), `expected an issue at ${field}, got ${JSON.stringify(paths)}`);
    assert.deepEqual(writes, [], "nothing is written");
  }

  // M1
  test("stores a valid manifest with a read-only host mount", async () => {
    const res = await upsert("fresh-probe", "0.1.0", manifest());
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].payload.resource, resourceOf(manifest()));
  });

  // M2
  for (const [what, t, field] of REFUSED) {
    test(`refuses ${what} at upsert with 422`, async () => {
      assertRefused(await upsert("fresh-probe", "0.1.0", manifest(t)), field);
    });
  }

  // M3
  test("stores a mount outside the workspace: that is refused at app run", async () => {
    const t = template({ host_mounts: [{ hostPath: "/data/hosting-probe", readOnly: true }] });
    const res = await upsert("fresh-probe", "0.1.0", manifest(t));
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(writes.length, 1);
  });

  // M4
  test("refuses an in-place upsert and a new version of an existing plugin", async () => {
    const [, t, field] = REFUSED[0];
    assertRefused(await upsert("mount-probe", "1.0.0", manifest(t)), field);
    assertRefused(await upsert("mount-probe", "2.0.0", manifest(t)), field);
  });

  // M5
  test("refuses it on POST /v1/plugins, PATCH and new-version", async () => {
    const [, t, field] = REFUSED[2];
    const resource = resourceOf(manifest(t));
    assertRefused(await app.inject({
      method: "POST", url: "/v1/plugins", payload: { name: "fresh-probe", version: "0.1.0", resource },
    }), field);
    assertRefused(await app.inject({ method: "PATCH", url: "/v1/plugins/7", payload: { resource } }), field);
    assertRefused(await app.inject({ method: "PUT", url: "/v1/plugins/7", payload: { resource } }), field);
    assertRefused(await app.inject({
      method: "POST", url: "/v1/plugins/7/new-version", payload: { name: "mount-probe", version: "3.0.0", resource },
    }), field);
  });

  test("does not check a PATCH without resource or a plugin without an app", async () => {
    const patched = await app.inject({ method: "PATCH", url: "/v1/plugins/7", payload: { description: "x" } });
    assert.equal(patched.statusCode, 200, patched.body);
    const noApp = await app.inject({
      method: "POST", url: "/v1/plugins/upsert", payload: { name: "tools-only", version: "1.0.0", resource: { mcp: {} } },
    });
    assert.equal(noApp.statusCode, 201, noApp.body);
    const appWithoutManifest = await app.inject({
      method: "POST", url: "/v1/plugins/upsert", payload: { name: "tools-only", version: "1.0.0", resource: { app: {} } },
    });
    assert.equal(appWithoutManifest.statusCode, 422, appWithoutManifest.body);
  });
});
