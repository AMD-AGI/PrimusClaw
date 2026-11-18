// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/plugins?scope=mine|public|all`: which plugins a listing covers.
 *
 * The default is public plus the caller's own, for an admin as well: an
 * admin's console used to list every user's private plugins by default, which
 * buried the catalogue under other people's test plugins. `all` is an admin's
 * explicit ask and refused for anyone else. Against a real Postgres whose
 * schema `initDb` built; skipped, and printed as skipped, without DATABASE_URL.
 *
 * Coverage:
 *   S1 the default is public plus mine, for a user and for an admin
 *   S2 mine is only the caller's own, public only the public ones
 *   S3 all lists every plugin for an admin, and is 403 for anyone else
 *   S4 an unknown scope is 400
 *   S5 the repository's older rule (no scope) is unchanged for its other caller
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const user = (id: string, roles = ["default"]) => ({
  userId: id, userName: id, roles, platformKey: `pk-${id}`, virtualKey: `vk-${id}`,
});
const U1 = user("u1");
const ADMIN = user("admin", ["system-admin"]);

describe("plugin listing scopes", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let caller = U1;
  const ids: Record<string, number> = {};
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  before(async () => {
    h = await startAdmissionCluster({});
    const add = async (key: string, owner: string, isPublic: boolean) => {
      ids[key] = Number(((await q(
        "INSERT INTO plugins (name, version, owner_user_id, is_public) VALUES ($1, '1', $2, $3) RETURNING id",
        [key, owner, isPublic],
      )).rows[0] as { id: string }).id);
    };
    await add("u1-public", "u1", true);
    await add("u1-private", "u1", false);
    await add("u2-public", "u2", true);
    await add("u2-private", "u2", false);
    await add("admin-private", "admin", false);
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as any).user = caller; });
    await (await import("../src/routes/plugins.js")).registerPluginRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.stop(); });

  const names = async (qs: string) => {
    const res = await app.inject({ method: "GET", url: `/v1/plugins${qs}` });
    assert.equal(res.statusCode, 200, res.body);
    return (res.json().data.plugins as Array<{ name: string }>).map((p) => p.name).sort();
  };

  // S1
  test("the default is public plus mine, for a user and for an admin", async () => {
    caller = U1;
    assert.deepEqual(await names(""), ["u1-private", "u1-public", "u2-public"]);
    assert.deepEqual(await names("?scope=visible"), ["u1-private", "u1-public", "u2-public"]);
    caller = ADMIN;
    assert.deepEqual(await names(""), ["admin-private", "u1-public", "u2-public"]);
  });

  // S2
  test("mine is only the caller's own; public only the public ones", async () => {
    caller = U1;
    assert.deepEqual(await names("?scope=mine"), ["u1-private", "u1-public"]);
    assert.deepEqual(await names("?scope=public"), ["u1-public", "u2-public"]);
    caller = ADMIN;
    assert.deepEqual(await names("?scope=mine"), ["admin-private"]);
    assert.deepEqual(await names("?scope=public"), ["u1-public", "u2-public"]);
  });

  // S3
  test("all is every plugin for an admin, and 403 for anyone else", async () => {
    caller = ADMIN;
    assert.deepEqual(await names("?scope=all"), ["admin-private", "u1-private", "u1-public", "u2-private", "u2-public"]);
    caller = U1;
    const res = await app.inject({ method: "GET", url: "/v1/plugins?scope=all" });
    assert.equal(res.statusCode, 403, res.body);
  });

  // S4
  test("an unknown scope is 400", async () => {
    caller = U1;
    const res = await app.inject({ method: "GET", url: "/v1/plugins?scope=everything" });
    assert.equal(res.statusCode, 400, res.body);
  });

  // S5
  test("without a scope the repository keeps the older rule", async () => {
    const { MarketplaceDb } = h.app.db;
    const list = async (isAdmin: boolean, viewerUserId: string) => (await MarketplaceDb.listPluginsRepo({
      viewerUserId, isAdmin, includeDeleted: false, latestPerName: false,
      sortField: "created_at", sortOrder: "desc", offset: 0, limit: 50,
    })).rows.map((r) => String(r.name)).sort();
    assert.deepEqual(await list(true, "admin"), ["admin-private", "u1-private", "u1-public", "u2-private", "u2-public"]);
    assert.deepEqual(await list(false, "u1"), ["u1-private", "u1-public", "u2-public"]);
    await assert.rejects(MarketplaceDb.listPluginsRepo({
      viewerUserId: "u1", isAdmin: false, scope: "all", includeDeleted: false, latestPerName: false,
      sortField: "created_at", sortOrder: "desc", offset: 0, limit: 50,
    }), /scope=all is for admins/);
  });
});
