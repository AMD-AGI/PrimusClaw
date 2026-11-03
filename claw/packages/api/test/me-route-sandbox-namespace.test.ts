// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/me` with SANDBOX_NAMESPACE set: what the console is told to start a
 * sandbox in is the deployment's own default workspace, not the first workspace
 * SaFE lists.
 *
 * The console sends `sandbox.defaultWorkspaceId` as `workspaceId` with every turn
 * (web/src/stores/workspace.ts), and a workspace a request names wins over
 * Brain's SANDBOX_NAMESPACE. So a deployment that moved its sandboxes to another
 * workspace (here crusoe-spur-vk -> global-cpu) moved nothing for console users
 * until this document said so too.
 *
 * Its own file because SANDBOX_NAMESPACE is read when the config module is imported.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { FakeUpstream } from "./support/fake-upstream.js";
import { AUTH_INTERNAL_TOKEN, startFakePlatform, type Account } from "./support/fake-platform.js";

const CLUSTERS = { totalCount: 2, items: [{ clusterId: "crusoe", phase: "Ready" }, { clusterId: "global", phase: "Ready" }] };

/** Has both workspaces; crusoe-spur-vk is first in SaFE's order, as live. */
const ALICE: Account = {
  id: "u-alice",
  name: "Alice",
  roles: ["default"],
  workspaces: {
    totalCount: 2,
    items: [
      { workspaceId: "crusoe-spur-vk", workspaceName: "spur-vk", clusterId: "crusoe", flavorId: "vk-mi355x", scopes: ["Train", "Sandbox"], isDefault: true, gpuProduct: "MI355X" },
      { workspaceId: "global-cpu", workspaceName: "cpu", clusterId: "global", flavorId: "cpu-vm2", scopes: ["Authoring", "Sandbox"] },
    ],
  },
  clusters: CLUSTERS,
  self: { id: "u-alice", name: "Alice", managedWorkspaces: [], workspaces: [] },
};

/** Has only crusoe-spur-vk: the deployment default is not theirs to use. */
const BOB: Account = {
  id: "u-bob",
  name: "Bob",
  roles: ["default"],
  workspaces: {
    totalCount: 1,
    items: [{ workspaceId: "crusoe-spur-vk", workspaceName: "spur-vk", clusterId: "crusoe", flavorId: "vk-mi355x", scopes: ["Train", "Sandbox"], gpuProduct: "MI355X" }],
  },
  clusters: CLUSTERS,
  self: { id: "u-bob", name: "Bob", managedWorkspaces: [], workspaces: [] },
};

let platform: FakeUpstream;
let app: FastifyInstance;

before(async () => {
  platform = await startFakePlatform({ alice: ALICE, bob: BOB });
  process.env.APP_ENV = "dev";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "safe";
  process.env.SAFE_API_URL = platform.url;
  process.env.AUTH_INTERNAL_TOKEN = AUTH_INTERNAL_TOKEN;
  process.env.SANDBOX_NAMESPACE = "global-cpu";

  const { authMiddleware } = await import("../src/auth/middleware.js");
  const { registerMeRoutes } = await import("../src/routes/me.js");
  app = Fastify();
  await app.register(cookie);
  app.addHook("preHandler", authMiddleware);
  await registerMeRoutes(app);
  await app.ready();
});

after(async () => {
  delete process.env.SANDBOX_NAMESPACE;
  await app?.close();
  await platform?.close();
});

const me = async (headers: Record<string, string>) => {
  const res = await app.inject({ method: "GET", url: "/v1/me", headers });
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body) as { sandbox: { available: boolean; defaultWorkspaceId?: string; gpuProduct?: string }; workspaces: { id: string }[] };
};

test("the console is told to start sandboxes in the deployment's default workspace, not the first one listed", async () => {
  const doc = await me({ cookie: "Token=tok-alice; userType=default" });
  // Listed first, and what the answer was before the deployment's default counted.
  assert.equal(doc.workspaces[0]!.id, "crusoe-spur-vk");
  assert.deepEqual(doc.sandbox, { available: true, defaultWorkspaceId: "global-cpu" });
});

test("a caller who does not have that workspace keeps the first Sandbox workspace they do have", async () => {
  const doc = await me({ cookie: "Token=tok-bob; userType=default" });
  assert.deepEqual(doc.sandbox, { available: true, defaultWorkspaceId: "crusoe-spur-vk", gpuProduct: "MI355X" });
});
