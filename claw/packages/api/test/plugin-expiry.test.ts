// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Temporary plugins (marketplace/plugin-expiry.ts): a plugin written with
 * `expires_at` or `ttl_seconds` is soft-deleted once that time has passed,
 * unless something still uses it; a public plugin is never temporary and never
 * swept.
 *
 * The bounds are asserted directly; the write paths and the sweep against a
 * real Postgres whose schema `initDb` built (skipped, and printed as skipped,
 * without DATABASE_URL). Each refusal is paired with an admitted request, and
 * each "left alone" with the same row swept once the reason is gone.
 *
 * Coverage:
 *   X1 an expiry request is absent, cleared, a TTL or an instant, and bounded
 *   X2 writes: a TTL makes a private temporary plugin; public + expiry is 400 on create and patch; null clears
 *   X3 a new version inherits the source's expiry unless it names its own; upsert takes one too
 *   X4 the sweep soft-deletes an expired private plugin and nothing else
 *   X5 a plugin in use is left alone, and swept once the use is gone
 *   X6 the sweep's own statement never touches a public plugin, even without the constraint
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { requestedPluginExpiry, sweepExpiredPlugins, PLUGIN_TTL_MIN_SECONDS } from "../src/marketplace/plugin-expiry.js";
import { BadRequestError } from "../src/shared/errors.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const NOW = new Date("2026-11-11T00:00:00Z");

// X1
test("an expiry request is absent, cleared, a TTL or an instant, and bounded", () => {
  assert.equal(requestedPluginExpiry({}, NOW), undefined);
  assert.equal(requestedPluginExpiry({ expires_at: undefined }, NOW), undefined);
  assert.equal(requestedPluginExpiry({ expires_at: null }, NOW), null);
  assert.equal(requestedPluginExpiry({ ttl_seconds: null }, NOW), null);
  assert.deepEqual(requestedPluginExpiry({ ttl_seconds: 3600 }, NOW), new Date("2026-11-11T01:00:00Z"));
  assert.deepEqual(requestedPluginExpiry({ expires_at: "2026-11-12T00:00:00Z" }, NOW), new Date("2026-11-12T00:00:00Z"));
  for (const bad of [
    { ttl_seconds: 3600, expires_at: "2026-11-12T00:00:00Z" },
    { ttl_seconds: "3600" },
    { ttl_seconds: 1.5 },
    { ttl_seconds: PLUGIN_TTL_MIN_SECONDS - 1 },
    { ttl_seconds: -10 },
    { ttl_seconds: 31 * 24 * 3600 },
    { expires_at: "tomorrow" },
    { expires_at: 12345 },
    { expires_at: "2026-11-10T00:00:00Z" },
  ]) {
    assert.throws(() => requestedPluginExpiry(bad, NOW, 30), BadRequestError, JSON.stringify(bad));
  }
  assert.ok(requestedPluginExpiry({ ttl_seconds: 30 * 24 * 3600 }, NOW, 30));
});

const skip = postgresSkipReason();
const OWNER = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "pk-u1", virtualKey: "vk-u1" };

describe("temporary plugins against Postgres", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);
  const row = async (id: number) => (await q("SELECT * FROM plugins WHERE id = $1", [id])).rows[0] as any;
  const addRaw = async (name: string, isPublic: boolean, expires: string | null) =>
    Number(((await q(
      `INSERT INTO plugins (name, version, owner_user_id, is_public, expires_at)
       VALUES ($1, '1', 'u1', $2, $3::timestamptz) RETURNING id`,
      [name, isPublic, expires],
    )).rows[0] as { id: string }).id);
  const send = (method: "POST" | "PATCH", url: string, payload: unknown) =>
    app.inject({ method, url, payload: payload as object });

  before(async () => {
    h = await startAdmissionCluster({});
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as any).user = OWNER; });
    await (await import("../src/routes/plugins.js")).registerPluginRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.stop(); });
  beforeEach(async () => { await q("DELETE FROM plugins"); });

  // X2
  test("writes: TTL makes a private temporary plugin; public plus expiry is refused; null clears", async () => {
    const res = await send("POST", "/v1/plugins", { name: "t1", version: "1", ttl_seconds: 3600 });
    assert.equal(res.statusCode, 201, res.body);
    const d = res.json().data;
    assert.equal(d.is_public, false, "a temporary plugin is private by default");
    const left = Date.parse(d.expires_at) - Date.now();
    assert.ok(left > 3500_000 && left <= 3600_000, `expires in ${left} ms`);

    const permanent = await send("POST", "/v1/plugins", { name: "t0", version: "1" });
    assert.equal(permanent.json().data.expires_at, null);
    assert.equal(permanent.json().data.is_public, true, "without an expiry the default is unchanged");

    const pub = await send("POST", "/v1/plugins", { name: "t2", version: "1", ttl_seconds: 3600, is_public: true });
    assert.equal(pub.statusCode, 400, pub.body);
    assert.match(pub.json().message, /public plugin cannot expire/);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM plugins WHERE name = 't2'")).rows[0].n, 0);

    const toPublic = await send("PATCH", `/v1/plugins/${d.id}`, { is_public: true });
    assert.equal(toPublic.statusCode, 400, toPublic.body);
    assert.equal((await row(d.id)).is_public, false);
    const ttlOnPublic = await send("PATCH", `/v1/plugins/${permanent.json().data.id}`, { ttl_seconds: 3600 });
    assert.equal(ttlOnPublic.statusCode, 400, ttlOnPublic.body);

    const cleared = await send("PATCH", `/v1/plugins/${d.id}`, { expires_at: null });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().data.expires_at, null);
    const nowPublic = await send("PATCH", `/v1/plugins/${d.id}`, { is_public: true });
    assert.equal(nowPublic.statusCode, 200, "once permanent it may be made public");

    const tooLong = await send("POST", "/v1/plugins", { name: "t3", version: "1", ttl_seconds: 400 * 24 * 3600 });
    assert.equal(tooLong.statusCode, 400, tooLong.body);
  });

  // X3
  test("a new version inherits the expiry unless it names its own; upsert takes one", async () => {
    const src = (await send("POST", "/v1/plugins", { name: "nv", version: "1", ttl_seconds: 7200 })).json().data;
    const nv = await send("POST", `/v1/plugins/${src.id}/new-version`, { name: "nv", version: "2" });
    assert.equal(nv.statusCode, 201, nv.body);
    assert.equal(nv.json().data.expires_at, src.expires_at);
    assert.equal(nv.json().data.is_public, false);
    const own = await send("POST", `/v1/plugins/${src.id}/new-version`, { name: "nv", version: "3", expires_at: null });
    assert.equal(own.json().data.expires_at, null);

    const up = await send("POST", "/v1/plugins/upsert", { name: "eval-probe", version: "1", ttl_seconds: 600 });
    assert.equal(up.statusCode, 201, up.body);
    assert.ok(up.json().data.expires_at);
    const again = await send("POST", "/v1/plugins/upsert", { name: "eval-probe", version: "1", ttl_seconds: 1200 });
    assert.equal(again.statusCode, 200, again.body);
    assert.ok(Date.parse(again.json().data.expires_at) > Date.parse(up.json().data.expires_at), "an in-place upsert can extend it");
  });

  // X4
  test("the sweep soft-deletes an expired private plugin and nothing else", async () => {
    const expired = await addRaw("expired", false, "2020-01-01T00:00:00Z");
    const future = await addRaw("future", false, "2999-01-01T00:00:00Z");
    const permanent = await addRaw("permanent", false, null);
    const pub = await addRaw("public", true, null);
    const gone = await addRaw("gone", false, "2020-01-01T00:00:00Z");
    await q("UPDATE plugins SET deleted_at = '2021-01-01' WHERE id = $1", [gone]);
    const swept = await sweepExpiredPlugins(h.app.db.db);
    assert.deepEqual(swept.map((p) => p.id), [expired]);
    assert.ok((await row(expired)).deleted_at);
    for (const id of [future, permanent, pub]) assert.equal((await row(id)).deleted_at, null);
    assert.equal(new Date((await row(gone)).deleted_at).toISOString(), "2021-01-01T00:00:00.000Z", "a deleted row is not touched again");
    assert.deepEqual(await sweepExpiredPlugins(h.app.db.db), [], "a second pass finds nothing");
  });

  // X5
  test("a plugin in use is left alone, and swept once the use is gone", async () => {
    const byDag = await addRaw("by-dag", false, "2020-01-01T00:00:00Z");
    const byMsg = await addRaw("by-msg", false, "2020-01-01T00:00:00Z");
    const byTask = await addRaw("by-task", false, "2020-01-01T00:00:00Z");
    await q("INSERT INTO claw_task_dags (dag_id, name, plugin_id) VALUES ('d1', 'd1', $1)", [byDag]);
    const msg = (await q("INSERT INTO claw_pending_messages (session_id, content, plugin_id) VALUES ('s', 'hi', $1) RETURNING id", [byMsg])).rows[0] as any;
    await q("INSERT INTO claw_tasks (task_id, session_id, name, status, plugin_id) VALUES ('t-x5', 's', 't', 'running', $1)", [byTask]);
    assert.deepEqual(await sweepExpiredPlugins(h.app.db.db), []);
    await q("UPDATE claw_task_dags SET deleted_at = NOW() WHERE dag_id = 'd1'");
    await q("DELETE FROM claw_pending_messages WHERE id = $1", [msg.id]);
    await q("UPDATE claw_tasks SET status = 'completed' WHERE task_id = 't-x5'");
    assert.deepEqual(
      (await sweepExpiredPlugins(h.app.db.db)).map((p) => p.id).sort((a, b) => a - b),
      [byDag, byMsg, byTask].sort((a, b) => a - b),
    );
    await q("DELETE FROM claw_task_dags");
    await q("DELETE FROM claw_tasks");
  });

  // X6
  test("the sweep never touches a public plugin, even without the constraint", async () => {
    await q("ALTER TABLE plugins DROP CONSTRAINT plugins_temporary_not_public");
    try {
      const pub = await addRaw("public-expired", true, "2020-01-01T00:00:00Z");
      const priv = await addRaw("private-expired", false, "2020-01-01T00:00:00Z");
      assert.deepEqual((await sweepExpiredPlugins(h.app.db.db)).map((p) => p.id), [priv]);
      assert.equal((await row(pub)).deleted_at, null);
      await q("DELETE FROM plugins WHERE id = $1", [pub]);
    } finally {
      await q("ALTER TABLE plugins ADD CONSTRAINT plugins_temporary_not_public CHECK (expires_at IS NULL OR is_public = false)");
    }
    await assert.rejects(addRaw("public-temp", true, "2999-01-01T00:00:00Z"), /plugins_temporary_not_public/);
  });
});
