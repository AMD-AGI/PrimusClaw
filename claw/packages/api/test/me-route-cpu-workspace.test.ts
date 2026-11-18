// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/me` with SANDBOX_CPU_NAMESPACE set: the document says whether the
 * caller can have a sandbox in the CPU workspace, which is where every turn that
 * names no workspace -- an assistant item, a Teams message -- starts one.
 *
 * `sandbox.available` alone could not say it: an account SaFE lists only
 * crusoe-spur-vk for is `available: true` (that workspace has the Sandbox scope)
 * and still has its first Teams sandbox refused in global-cpu.
 *
 * Its own file because SANDBOX_CPU_NAMESPACE is read when the config module is imported.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { FakeUpstream } from "./support/fake-upstream.js";
import { AUTH_INTERNAL_TOKEN, startFakePlatform, type Account } from "./support/fake-platform.js";

const CLUSTERS = { totalCount: 2, items: [{ clusterId: "crusoe", phase: "Ready" }, { clusterId: "global", phase: "Ready" }] };
const VK = { workspaceId: "crusoe-spur-vk", workspaceName: "spur-vk", clusterId: "crusoe", scopes: ["Train", "Sandbox"], isDefault: true, gpuProduct: "MI355X" };
const CPU = { workspaceId: "global-cpu", workspaceName: "cpu", clusterId: "global", scopes: ["Authoring", "Sandbox"] };

const account = (id: string, items: unknown[]): Account => ({
  id,
  name: id,
  roles: ["default"],
  workspaces: { totalCount: items.length, items },
  clusters: CLUSTERS,
  self: { id, name: id, managedWorkspaces: [], workspaces: [] },
});

let platform: FakeUpstream;
let app: FastifyInstance;

before(async () => {
  platform = await startFakePlatform({ member: account("u-member", [VK, CPU]), outsider: account("u-outsider", [VK]) });
  process.env.APP_ENV = "dev";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "safe";
  process.env.SAFE_API_URL = platform.url;
  process.env.AUTH_INTERNAL_TOKEN = AUTH_INTERNAL_TOKEN;
  process.env.SANDBOX_NAMESPACE = "crusoe-spur-vk";
  process.env.SANDBOX_CPU_NAMESPACE = "global-cpu";

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
  delete process.env.SANDBOX_CPU_NAMESPACE;
  await app?.close();
  await platform?.close();
});

const me = async (token: string) => {
  const res = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: `Token=${token}; userType=default` } });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as { sandbox: Record<string, unknown> };
};

test("an account without the CPU workspace is told it has no CPU sandbox workspace", async () => {
  const doc = await me("tok-outsider");
  assert.deepEqual(doc.sandbox, {
    available: true,
    defaultWorkspaceId: "crusoe-spur-vk",
    gpuProduct: "MI355X",
    cpu: { workspaceId: "global-cpu", available: false, reason: "no_access" },
  });
});

test("a member of the CPU workspace has one, and it is the default", async () => {
  const doc = await me("tok-member");
  assert.deepEqual(doc.sandbox, {
    available: true,
    defaultWorkspaceId: "global-cpu",
    cpu: { workspaceId: "global-cpu", available: true },
  });
});
