// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/plugins` lists one entry per name: the latest active version the
 * caller may see. Every version stays addressable by id, and the versions of a
 * name are listed on demand at `GET /v1/plugins/:id/versions`.
 *
 * "Latest" is the version order `upsertPlugin` uses (major.minor.patch by
 * leading digits), not the row most recently touched: re-saving an old version
 * must not make it the one the listing shows. Against a real Postgres whose
 * schema `initDb` built; skipped, and printed as skipped, without DATABASE_URL.
 *
 * Coverage:
 *   C1 the default listing has one entry per name, the highest version, with version_count
 *   C2 a disabled newer version does not hide the active one; an explicit status filter still works
 *   C3 latest_per_name=false lists every row, as before
 *   C4 /versions lists the name's versions newest first, only those the caller may see
 *   C5 /versions answers 404/403 exactly as GET /v1/plugins/:id does
 *   C6 another user's private version neither shows nor counts
 *   C7 names are not owned: another user's higher version of the same name is a separate entry, never one of these versions
 *   C8 with include_deleted (admins), a deleted newer version does not win over a live one
 *   C9 latest_per_name is parsed strictly
 *   C10 the upsert's version pick breaks a tie by time, not by the date's string form
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
const U2 = user("u2");
const ADMIN = user("admin", ["system-admin"]);

describe("plugin listing collapses versions", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let caller = U1;
  const ids: Record<string, number> = {};
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  before(async () => {
    h = await startAdmissionCluster({});
    // Inserted oldest version last and touched most recently, so an order by
    // update time would pick it: the listing must not.
    const add = async (key: string, name: string, version: string, owner: string, isPublic: boolean, status = "active", updated = "2026-01-01") => {
      ids[key] = Number(((await q(
        `INSERT INTO plugins (name, version, owner_user_id, is_public, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz) RETURNING id`,
        [name, version, owner, isPublic, status, updated],
      )).rows[0] as { id: string }).id);
    };
    await add("a10", "alpha", "1.10.0", "u1", true, "active", "2026-01-02");
    await add("a9", "alpha", "1.9.0", "u1", true, "active", "2026-01-05");
    await add("a2", "alpha", "2.0.0", "u1", true, "disabled", "2026-01-06");
    await add("a1", "alpha", "1.0.0", "u1", true, "active", "2026-01-09");
    await add("bpub", "beta", "1.0.0", "u2", true);
    await add("bpriv", "beta", "3.0.0", "u2", false);
    await add("gone", "gamma", "1.0.0", "u1", true);
    await q("UPDATE plugins SET deleted_at = NOW() WHERE id = $1", [ids.gone]);
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as any).user = caller; });
    await (await import("../src/routes/plugins.js")).registerPluginRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.stop(); });

  const list = async (qs = "") => {
    const res = await app.inject({ method: "GET", url: `/v1/plugins${qs}` });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data as { plugins: Array<Record<string, any>>; total: number };
  };

  // C1
  test("one entry per name, the highest active version", async () => {
    caller = U1;
    const d = await list();
    const byName = Object.fromEntries(d.plugins.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(byName).sort(), ["alpha", "beta"]);
    assert.equal(d.total, 2);
    assert.equal(byName.alpha.id, ids.a10, "1.10.0 is newer than 1.9.0 and than the recently touched 1.0.0");
    assert.equal(byName.alpha.version_count, 3, "three active versions of alpha");
    assert.equal(byName.beta.id, ids.bpub);
    // The same with the parameter spelled out, which is what the web console sends.
    assert.deepEqual((await list("?latest_per_name=true")).plugins.map((p) => p.id).sort(), [ids.a10, ids.bpub].sort());
  });

  // C2
  test("a disabled newer version does not hide the active one; a status filter still selects", async () => {
    caller = U1;
    const d = await list("?status=disabled");
    assert.deepEqual(d.plugins.map((p) => p.id), [ids.a2]);
  });

  // C3
  test("latest_per_name=false lists every row", async () => {
    caller = U1;
    const d = await list("?latest_per_name=false");
    assert.deepEqual(d.plugins.map((p) => p.id).sort((a, b) => a - b), [ids.a10, ids.a9, ids.a2, ids.a1, ids.bpub].sort((a, b) => a - b));
    assert.ok(d.plugins.every((p) => p.version_count === undefined), "version_count belongs to collapsed rows only");
  });

  // C4
  test("versions are listed newest first, and each is addressable by id", async () => {
    caller = U1;
    const res = await app.inject({ method: "GET", url: `/v1/plugins/${ids.a1}/versions` });
    assert.equal(res.statusCode, 200, res.body);
    const v = res.json().data;
    assert.equal(v.name, "alpha");
    assert.deepEqual(v.versions.map((x: any) => x.version), ["2.0.0", "1.10.0", "1.9.0", "1.0.0"]);
    assert.deepEqual(v.versions.map((x: any) => x.status), ["disabled", "active", "active", "active"]);
    for (const x of v.versions) {
      const one = await app.inject({ method: "GET", url: `/v1/plugins/${x.id}` });
      assert.equal(one.statusCode, 200, one.body);
      assert.equal(one.json().data.version, x.version);
    }
  });

  // C5
  test("/versions refuses as GET /v1/plugins/:id does", async () => {
    caller = U1;
    for (const [id, code] of [[ids.gone, 404], [999999, 404], [ids.bpriv, 403]] as const) {
      const one = await app.inject({ method: "GET", url: `/v1/plugins/${id}` });
      const vs = await app.inject({ method: "GET", url: `/v1/plugins/${id}/versions` });
      assert.equal(one.statusCode, code, one.body);
      assert.equal(vs.statusCode, code, vs.body);
    }
    const bad = await app.inject({ method: "GET", url: "/v1/plugins/abc/versions" });
    assert.equal(bad.statusCode, 400);
  });

  // C6
  test("another user's private version neither shows nor counts", async () => {
    caller = U1;
    const vs = await app.inject({ method: "GET", url: `/v1/plugins/${ids.bpub}/versions` });
    assert.deepEqual(vs.json().data.versions.map((x: any) => x.id), [ids.bpub]);
    const d = await list();
    assert.equal(d.plugins.find((p) => p.name === "beta")!.version_count, 1);
    caller = U2;
    const own = await list();
    const beta = own.plugins.find((p) => p.name === "beta")!;
    assert.equal(beta.id, ids.bpriv, "its owner sees 3.0.0 as the latest");
    assert.equal(beta.version_count, 2);
  });

  // C7
  test("another user's version of the same name is its own entry, not one of these versions", async () => {
    const r = await q(
      "INSERT INTO plugins (name, version, owner_user_id, is_public) VALUES ('alpha', '99.0.0', 'u2', true) RETURNING id",
    );
    const squat = Number((r.rows[0] as { id: string }).id);
    try {
      caller = U1;
      const d = await list();
      const alphas = d.plugins.filter((p) => p.name === "alpha").map((p) => [p.id, p.owner_user_id, p.version_count]);
      assert.deepEqual(alphas.sort((a, b) => Number(a[0]) - Number(b[0])), [[ids.a10, "u1", 3], [squat, "u2", 1]].sort((a, b) => Number(a[0]) - Number(b[0])));
      const vs = await app.inject({ method: "GET", url: `/v1/plugins/${ids.a1}/versions` });
      assert.ok(!vs.json().data.versions.some((x: any) => x.id === squat), "u2's alpha is not a version of u1's");
      const theirs = await app.inject({ method: "GET", url: `/v1/plugins/${squat}/versions` });
      assert.deepEqual(theirs.json().data.versions.map((x: any) => x.id), [squat]);
    } finally {
      await q("DELETE FROM plugins WHERE id = $1", [squat]);
    }
  });

  // C8
  test("with include_deleted a deleted newer version does not win", async () => {
    const r = await q(
      "INSERT INTO plugins (name, version, owner_user_id, is_public, deleted_at) VALUES ('alpha', '5.0.0', 'u1', true, NOW()) RETURNING id",
    );
    const deleted = Number((r.rows[0] as { id: string }).id);
    try {
      caller = ADMIN;
      const d = await list("?include_deleted=true");
      const alpha = d.plugins.find((p) => p.name === "alpha" && p.owner_user_id === "u1")!;
      assert.equal(alpha.id, ids.a10, "the live 1.10.0, not the deleted 5.0.0");
      const vs = await app.inject({ method: "GET", url: `/v1/plugins/${ids.a1}/versions?include_deleted=true` });
      assert.ok(vs.json().data.versions.some((x: any) => x.id === deleted), "but /versions shows it to an admin who asks");
    } finally {
      await q("DELETE FROM plugins WHERE id = $1", [deleted]);
    }
  });

  // C9
  test("latest_per_name is parsed strictly", async () => {
    caller = U1;
    for (const off of ["false", "FALSE", "0", "no"]) {
      assert.equal((await list(`?latest_per_name=${off}`)).total, 5, off);
    }
    for (const on of ["true", "1", "yes", ""]) {
      assert.equal((await list(`?latest_per_name=${on}`)).total, 2, on);
    }
    const bad = await app.inject({ method: "GET", url: "/v1/plugins?latest_per_name=maybe" });
    assert.equal(bad.statusCode, 400, bad.body);
  });

  // C10
  test("the upsert's version pick breaks a tie by time", async () => {
    const { latestRowByVersion } = await import("../src/marketplace/plugins.js");
    // Thursday then the next Monday: as strings "Thu ..." sorts after "Mon ...".
    const thu = { id: 1, version: "1.0.0", updated_at: new Date("2026-11-12T00:00:00Z") };
    const mon = { id: 2, version: "1.0.0", updated_at: new Date("2026-11-16T00:00:00Z") };
    assert.equal(String(thu.updated_at) > String(mon.updated_at), true, "the fixture separates the two orders");
    assert.equal(latestRowByVersion([thu, mon]).id, 2);
    assert.equal(latestRowByVersion([mon, thu]).id, 2);
    assert.equal(latestRowByVersion([mon, { id: 3, version: "1.0.1", updated_at: new Date(0) }]).id, 3);
  });
});
