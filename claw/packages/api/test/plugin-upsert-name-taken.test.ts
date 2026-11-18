// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Upserting a plugin whose name another user already registered is refused,
 * and the refusal has to say why.
 *
 * It used to come back as `403 {"error":"forbidden","message":""}`, which reads
 * as "you lack a permission" -- a caller (an agent hosting a session, in the
 * case that surfaced this) went looking for a grant it was never going to get,
 * when the only fix was a different name. The refusal is now a name collision
 * that names the plugin and the remedy.
 *
 * The other refusals keep their shape: a tool name owned by someone else and a
 * plugin the caller may not modify are still `403 forbidden`.
 *
 * Coverage:
 *   N1 a plugin name owned by another user is 409 plugin_name_taken, with the name in the message
 *   N2 an admin is not refused, and nothing is refused for the owner
 *   N3 a tool name owned by another user is still 403 forbidden
 *   N4 patching a plugin the caller does not own is still 403 forbidden
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { MarketplaceDb, type JsonObject } from "../src/infra/db.js";
import { registerPluginRoutes } from "../src/routes/plugins.js";
import type { UserInfo } from "../src/auth/models.js";

const OWNER = "owner-user";
const CALLER: UserInfo = { userId: "caller-user", userName: "caller", roles: [], platformKey: "", virtualKey: "" };
const ADMIN: UserInfo = { ...CALLER, userId: "admin-user", roles: ["system-admin"] };

function pluginRow(over: JsonObject = {}): JsonObject {
  return {
    id: 7, name: "taken-plugin", version: "1.0.0", description: "", images: [], tools: [], resource: {},
    owner_user_id: OWNER, author: "owner", is_public: true, status: "active",
    created_at: new Date(0), updated_at: new Date(0), ...over,
  };
}

describe("plugin upsert onto a name another user owns", () => {
  let app: FastifyInstance;
  let user: UserInfo = CALLER;
  const saved: Partial<typeof MarketplaceDb> = {};
  const stub = <K extends keyof typeof MarketplaceDb>(k: K, f: unknown) => {
    if (!(k in saved)) (saved as Record<string, unknown>)[k] = MarketplaceDb[k];
    (MarketplaceDb as Record<string, unknown>)[k] = f;
  };

  before(async () => {
    stub("pluginsActiveByName", async (name: string) => (name === "taken-plugin" ? [pluginRow()] : []));
    stub("pluginUpdate", async (id: number, patch: JsonObject) => pluginRow({ id, ...patch }));
    stub("pluginInsert", async (payload: JsonObject) => pluginRow({ ...payload, id: 8 }));
    stub("pluginGetById", async (id: number) => (id === 7 ? pluginRow() : null));
    stub("toolsActiveByName", async (name: string) => (
      name === "taken-tool"
        ? [{ id: 3, name, type: "prompt", version: "1.0.0", owner_user_id: OWNER, status: "active" }]
        : []
    ));
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = user; });
    await registerPluginRoutes(app);
    await app.ready();
  });
  after(async () => {
    Object.assign(MarketplaceDb, saved);
    await app?.close();
  });

  // N1
  test("is 409 plugin_name_taken, naming the plugin and the remedy", async () => {
    user = CALLER;
    const res = await app.inject({
      method: "POST", url: "/v1/plugins/upsert", payload: { name: "taken-plugin", version: "2.0.0" },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json(), {
      ok: false,
      error: "plugin_name_taken",
      message: "plugin name 'taken-plugin' belongs to another user; pick another name",
    });
  });

  // N2
  test("is not a refusal for an admin or for a name nobody holds", async () => {
    user = ADMIN;
    const asAdmin = await app.inject({
      method: "POST", url: "/v1/plugins/upsert", payload: { name: "taken-plugin", version: "1.0.0" },
    });
    assert.equal(asAdmin.statusCode, 200, asAdmin.body);
    user = CALLER;
    const fresh = await app.inject({
      method: "POST", url: "/v1/plugins/upsert", payload: { name: "free-plugin", version: "1.0.0" },
    });
    assert.equal(fresh.statusCode, 201, fresh.body);
  });

  // N3
  test("leaves a tool name owned by another user as 403 forbidden", async () => {
    user = CALLER;
    const res = await app.inject({
      method: "POST", url: "/v1/tools/upsert",
      payload: { name: "taken-tool", type: "prompt", version: "2.0.0" },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error, "forbidden");
  });

  // N4
  test("leaves patching a plugin the caller does not own as 403 forbidden", async () => {
    user = CALLER;
    const res = await app.inject({ method: "PATCH", url: "/v1/plugins/7", payload: { description: "x" } });
    assert.equal(res.statusCode, 403, res.body);
    assert.deepEqual(res.json(), { ok: false, error: "forbidden", message: "not allowed to modify this plugin" });
  });
});
