// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox template's read-only host directories (`host_mounts`) are admitted
 * only under a directory the template's workspace already mounts for sandboxes,
 * read from SaFE as the caller: a plugin never reaches a host path its
 * workspace does not grant.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.CLAW_DEPLOY_MODE = "safe";
process.env.SAFE_API_URL = "http://safe.example.invalid";

const { db } = await import("../src/infra/db.js");
const { checkAppRunRequest, appRunPorts, safeWorkspaceVolumes, WorkspaceCheckUnavailableError } = await import("../src/tasks/app-run.js");
const { APP_MANIFEST_SCHEMA } = await import("@claw/protocol");

const originalQuery = db.query;
const originalFetch = globalThis.fetch;
after(() => {
  db.query = originalQuery;
  globalThis.fetch = originalFetch;
});

const CACHE = "/shared/team/cache";
const user = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
const manifestWith = (templates: Array<Record<string, unknown>>) => ({
  schema: APP_MANIFEST_SCHEMA, name: "example-app", version: "1.0.0", container: {},
  state_dir: "/state/${run_id}", command: ["run"],
  sandbox_templates: templates,
  sandbox_roles: { measurement: templates.map((t) => t.name as string) },
});
const measurement = (over: Record<string, unknown> = {}) => ({ name: "measurement", fromImage: "registry.example.invalid/m:1", per_gpu_count: [1], ...over });

function servePlugin(manifest: unknown): void {
  db.query = (async (text: string) => {
    if (/acting_as/.test(text)) return { rows: [{ acting_as: null }], rowCount: 1 };
    if (/FROM plugins/.test(text)) {
      return { rows: [{ id: 7, version: "1", resource: { app: { manifest } }, images: null, overridable: null, owner_user_id: "u-1", is_public: false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

const RESOURCES = { image: "registry.example.invalid/app:1", gpus: 0, workspace: "ws-app", sandbox_workspace: "ws-sbx" };
const SHARED = [{ id: 1, type: "hostpath", hostPath: "/shared", mountPath: "/shared" }];

async function check(manifest: unknown, volumes: (ws: string) => Promise<unknown>) {
  servePlugin(manifest);
  const asked: string[] = [];
  const ports = {
    ...appRunPorts,
    enabled: () => true,
    workspaceAccess: async () => "ok" as const,
    workspaceVolumes: async (_auth: unknown, ws: string) => { asked.push(ws); return volumes(ws) as never; },
  };
  const out = await checkAppRunRequest({
    sessionId: "s-1", user, auth: { authorization: "Bearer k" },
    body: { plugin_id: 7, input: {}, resources: RESOURCES }, idemKey: null, requestHash: "h",
  } as never, ports);
  return { out: out as Record<string, any>, asked };
}

test("a mount under a hostpath volume of the template's workspace is admitted, and that workspace is the one read", async () => {
  const { out, asked } = await check(manifestWith([measurement({ host_mounts: [{ hostPath: CACHE, readOnly: true }] })]), async () => ({ volumes: SHARED }));
  assert.equal(out.statusCode, undefined, JSON.stringify(out));
  assert.deepEqual(asked, ["ws-sbx"]);
});

test("a template naming its own workspace is checked against that workspace, each workspace read once", async () => {
  const templates = [
    measurement({ host_mounts: [{ hostPath: CACHE, readOnly: true }], workspace: "ws-own" }),
    { name: "runner", fromImage: "img:1", workspace: "ws-own", host_mounts: [{ hostPath: "/shared/x", readOnly: true }] },
  ];
  const { out, asked } = await check(manifestWith(templates), async () => ({ volumes: SHARED }));
  assert.equal(out.statusCode, undefined, JSON.stringify(out));
  assert.deepEqual(asked, ["ws-own"]);
});

test("a mount outside every directory the workspace mounts is refused with the field, and nothing is read for a manifest without mounts", async () => {
  const { out } = await check(manifestWith([measurement({ host_mounts: [{ hostPath: "/other/cache", readOnly: true }] })]), async () => ({ volumes: SHARED }));
  assert.equal(out.statusCode, 403);
  assert.equal(out.response.error, "sandbox_template_mount_not_granted");
  assert.deepEqual(out.response.problems.map((p: { field: string }) => p.field), ["sandbox_templates.measurement.host_mounts[0].hostPath"]);
  const none = await check(manifestWith([measurement()]), async () => { throw new Error("not asked"); });
  assert.equal(none.out.statusCode, undefined, JSON.stringify(none.out));
  assert.deepEqual(none.asked, []);
});

test("a read-write mount or a raw hostPath volume never reaches the workspace check: the manifest is invalid", async () => {
  for (const t of [
    measurement({ host_mounts: [{ hostPath: CACHE, readOnly: false }] }),
    measurement({ volumes: [{ name: "v", hostPath: { path: "/" } }], volumeMounts: [{ name: "v", mountPath: "/host", readOnly: false }] }),
  ]) {
    const { out, asked } = await check(manifestWith([t]), async () => ({ volumes: SHARED }));
    assert.equal(out.statusCode, 422, JSON.stringify(out));
    assert.equal(out.response.error, "app_manifest_invalid");
    assert.deepEqual(asked, []);
  }
});

test("a workspace the caller cannot read, or SaFE not answering, refuses the run", async () => {
  const m = manifestWith([measurement({ host_mounts: [{ hostPath: CACHE, readOnly: true }] })]);
  assert.equal((await check(m, async () => ({ verdict: "forbidden" }))).out.statusCode, 403);
  assert.equal((await check(m, async () => ({ verdict: "not_found" }))).out.statusCode, 404);
  const down = await check(m, async () => { throw new WorkspaceCheckUnavailableError("SaFE answered 502"); });
  assert.deepEqual([down.out.statusCode, down.out.response.error], [503, "workspace_check_unavailable"]);
});

test("safeWorkspaceVolumes reads the workspace detail's volumes as the caller", async () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), auth: (init.headers as Record<string, string>).authorization });
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as typeof fetch;
  };
  answer(200, { workspaceId: "ws-a", volumes: SHARED });
  assert.deepEqual(await safeWorkspaceVolumes({ authorization: "Bearer k" }, "ws-a"), { volumes: SHARED });
  assert.deepEqual(seen.at(-1), { url: "http://safe.example.invalid/api/v1/workspaces/ws-a", auth: "Bearer k" });
  answer(200, { workspaceId: "ws-a" });
  assert.deepEqual(await safeWorkspaceVolumes({ authorization: "Bearer k" }, "ws-a"), { volumes: [] });
  answer(403, undefined);
  assert.deepEqual(await safeWorkspaceVolumes({ authorization: "Bearer k" }, "ws-a"), { verdict: "forbidden" });
  answer(404, undefined);
  assert.deepEqual(await safeWorkspaceVolumes({ authorization: "Bearer k" }, "ws-a"), { verdict: "not_found" });
  answer(500, undefined);
  await assert.rejects(safeWorkspaceVolumes({ authorization: "Bearer k" }, "ws-a"), WorkspaceCheckUnavailableError);
  answer(200, { volumes: "x" });
  await assert.rejects(safeWorkspaceVolumes({ authorization: "Bearer k" }, "ws-a"), WorkspaceCheckUnavailableError);
  assert.deepEqual(await safeWorkspaceVolumes({}, "ws-a"), { verdict: "forbidden" }, "no credential, no read");
});
