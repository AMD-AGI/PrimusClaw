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
 *   X7 admission refuses a plugin past its expiry, and the sweep waits a grace after it
 *   X8 the schema guard requires the plugin columns every write names
 *   X9 a task cannot name another user's private plugin (temporary plugins are private), and the answer is the not-found one
 *   X10 an admission in flight holds its plugin against the sweep; a DAG whose plugin is gone is refused
 *   X11 a DAG cannot hand its runner a private plugin its own owner may not see
 *   X12 a queued message and a DAG template hold the plugin they name while they are written
 *   X13 a new session turn and a retry may not name a gone, expired or foreign plugin
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { BadRequestError } from "../src/shared/errors.js";

// Imported once the cluster is up: the module reads config.ts, which captures
// DATABASE_URL at import, and the database must be this file's own.
type Expiry = typeof import("../src/marketplace/plugin-expiry.js");
let expiry: Expiry;
const loadExpiry = async (): Promise<Expiry> => (expiry ??= await import("../src/marketplace/plugin-expiry.js"));
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const NOW = new Date("2026-11-11T00:00:00Z");



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

  let tasksApp: FastifyInstance;
  before(async () => {
    h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
    await loadExpiry();
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as any).user = OWNER; });
    await (await import("../src/routes/plugins.js")).registerPluginRoutes(app);
    await app.ready();
    tasksApp = Fastify();
    tasksApp.addHook("preHandler", async (req) => { (req as any).user = OWNER; });
    await (await import("../src/routes/tasks.js")).registerTaskCreateRoute(tasksApp);
    await tasksApp.ready();
    (await import("../src/tasks/app-run.js")).appRunPorts.enabled = () => true;
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('sx', 't', 'u1', 'claw')");
  });
  after(async () => { await app?.close(); await tasksApp?.close(); await h?.stop(); });
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
    const swept = await expiry.sweepExpiredPlugins(h.app.db.db.pool);
    assert.deepEqual(swept.map((p) => p.id), [expired]);
    assert.ok((await row(expired)).deleted_at);
    for (const id of [future, permanent, pub]) assert.equal((await row(id)).deleted_at, null);
    assert.equal(new Date((await row(gone)).deleted_at).toISOString(), "2021-01-01T00:00:00.000Z", "a deleted row is not touched again");
    assert.deepEqual(await expiry.sweepExpiredPlugins(h.app.db.db.pool), [], "a second pass finds nothing");
  });

  // X5
  test("a plugin in use is left alone, and swept once the use is gone", async () => {
    const byDag = await addRaw("by-dag", false, "2020-01-01T00:00:00Z");
    const byMsg = await addRaw("by-msg", false, "2020-01-01T00:00:00Z");
    const byTask = await addRaw("by-task", false, "2020-01-01T00:00:00Z");
    await q("INSERT INTO claw_task_dags (dag_id, name, plugin_id) VALUES ('d1', 'd1', $1)", [byDag]);
    const msg = (await q("INSERT INTO claw_pending_messages (session_id, content, plugin_id) VALUES ('s', 'hi', $1) RETURNING id", [byMsg])).rows[0] as any;
    await q("INSERT INTO claw_tasks (task_id, session_id, name, status, plugin_id) VALUES ('t-x5', 's', 't', 'running', $1)", [byTask]);
    assert.deepEqual(await expiry.sweepExpiredPlugins(h.app.db.db.pool), []);
    await q("UPDATE claw_task_dags SET deleted_at = NOW() WHERE dag_id = 'd1'");
    await q("DELETE FROM claw_pending_messages WHERE id = $1", [msg.id]);
    await q("UPDATE claw_tasks SET status = 'completed' WHERE task_id = 't-x5'");
    assert.deepEqual(
      (await expiry.sweepExpiredPlugins(h.app.db.db.pool)).map((p) => p.id).sort((a, b) => a - b),
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
      assert.deepEqual((await expiry.sweepExpiredPlugins(h.app.db.db.pool)).map((p) => p.id), [priv]);
      assert.equal((await row(pub)).deleted_at, null);
      await q("DELETE FROM plugins WHERE id = $1", [pub]);
    } finally {
      await q("ALTER TABLE plugins ADD CONSTRAINT plugins_temporary_not_public CHECK (expires_at IS NULL OR is_public = false)");
    }
    await assert.rejects(addRaw("public-temp", true, "2999-01-01T00:00:00Z"), /plugins_temporary_not_public/);
  });

  // X7
  test("admission refuses a plugin past its expiry; the sweep waits a grace after it", async () => {
    const live = await addRaw("live", false, "2999-01-01T00:00:00Z");
    const past = await addRaw("past", false, new Date(Date.now() - 60_000).toISOString());
    const post = (payload: unknown) => tasksApp.inject({ method: "POST", url: "/v1/sessions/sx/tasks", payload: payload as object });
    const ok = await post({ plugin_id: live, prompt: "hi" });
    assert.equal(ok.statusCode, 200, ok.body);
    const refused = await post({ plugin_id: past, prompt: "hi" });
    assert.equal(refused.statusCode, 404, refused.body);
    assert.equal(refused.json().error, "plugin_not_found");
    const app = await post({ mode: "app", plugin_id: past, input: {}, resources: {} });
    assert.equal(app.statusCode, 404, app.body);
    assert.equal(app.json().error, "plugin_not_found");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_tasks WHERE plugin_id = $1", [past])).rows[0].n, 0);

    // A minute past its expiry it is inside the grace: not swept yet.
    assert.deepEqual(await expiry.sweepExpiredPlugins(h.app.db.db.pool), []);
    await q("UPDATE plugins SET expires_at = NOW() - make_interval(secs => $2) WHERE id = $1", [past, expiry.PLUGIN_EXPIRY_GRACE_SEC + 1]);
    assert.deepEqual((await expiry.sweepExpiredPlugins(h.app.db.db.pool)).map((p) => p.id), [past]);
    await q("DELETE FROM claw_tasks");
  });

  // X9
  test("a task cannot name another user's private plugin", async () => {
    const theirs = Number(((await q(
      "INSERT INTO plugins (name, version, owner_user_id, is_public, expires_at) VALUES ('theirs', '1', 'u2', false, '2999-01-01') RETURNING id",
    )).rows[0] as { id: string }).id);
    const mine = await addRaw("mine", false, "2999-01-01T00:00:00Z");
    const post = (payload: unknown) => tasksApp.inject({ method: "POST", url: "/v1/sessions/sx/tasks", payload: payload as object });
    const refused = await post({ plugin_id: theirs, prompt: "hi" });
    assert.equal(refused.statusCode, 404, refused.body);
    assert.equal(refused.json().error, "plugin_not_found", "the same answer as a plugin that does not exist");
    const missing = await post({ plugin_id: 987654, prompt: "hi" });
    assert.deepEqual(missing.json(), refused.json());
    const ok = await post({ plugin_id: mine, prompt: "hi" });
    assert.equal(ok.statusCode, 200, ok.body);
    await q("DELETE FROM claw_tasks");
  });

  // X10
  test("an admission in flight holds its plugin against the sweep", async () => {
    const id = await addRaw("held", false, "2020-01-01T00:00:00Z");
    const live = await addRaw("held-live", false, "2999-01-01T00:00:00Z");
    const admission = await h.app.db.db.pool.connect();
    try {
      await admission.query("BEGIN");
      // What holdPluginForAdmission takes, on a plugin that expired while the
      // admission was in flight (the helper itself refuses an expired one).
      await admission.query("SELECT 1 FROM plugins WHERE id = $1 FOR SHARE", [id]);
      assert.equal(await expiry.holdPluginForAdmission(admission, live), true);
      assert.deepEqual(await expiry.sweepExpiredPlugins(h.app.db.db.pool), [], "a held plugin is skipped");
      await admission.query("INSERT INTO claw_tasks (task_id, session_id, name, status, plugin_id) VALUES ('t-x10', 'sx', 't', 'queued', $1)", [id]);
      await admission.query("COMMIT");
    } finally {
      admission.release();
    }
    assert.deepEqual(await expiry.sweepExpiredPlugins(h.app.db.db.pool), [], "its committed task keeps it");
    await q("UPDATE claw_tasks SET status = 'completed' WHERE task_id = 't-x10'");
    assert.deepEqual((await expiry.sweepExpiredPlugins(h.app.db.db.pool)).map((p) => p.id), [id]);
    // Gone, a later admission cannot hold it.
    const late = await h.app.db.db.pool.connect();
    try {
      await late.query("BEGIN");
      assert.equal(await expiry.holdPluginForAdmission(late, id), false);
      await late.query("ROLLBACK");
    } finally {
      late.release();
    }
    await q("DELETE FROM claw_tasks");
  });

  test("a DAG whose plugin is gone is refused, not run without it", async () => {
    const past = await addRaw("dag-plugin", false, new Date(Date.now() - 60_000).toISOString());
    await q("INSERT INTO claw_task_dags (dag_id, name, plugin_id, owner_user_id) VALUES ('d-x10', 'd', $1, 'u1')", [past]);
    const res = await tasksApp.inject({ method: "POST", url: "/v1/sessions/sx/tasks", payload: { dag_id: "d-x10", input: {} } });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, "plugin_not_found");
    await q("DELETE FROM claw_task_dags");
  });
  // X11
  test("a DAG cannot hand its runner a private plugin its owner may not see", async () => {
    const theirs = Number(((await q(
      "INSERT INTO plugins (name, version, owner_user_id, is_public) VALUES ('dag-theirs', '1', 'u2', false) RETURNING id",
    )).rows[0] as { id: string }).id);
    await q("INSERT INTO claw_task_dags (dag_id, name, plugin_id, owner_user_id) VALUES ('d-x11', 'd', $1, 'u1')", [theirs]);
    const res = await tasksApp.inject({ method: "POST", url: "/v1/sessions/sx/tasks", payload: { dag_id: "d-x11", input: {} } });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, "plugin_not_found");
    await q("DELETE FROM claw_task_dags");
  });

  // X12
  test("a DAG template write holds the plugin it names", async () => {
    const id = await addRaw("dag-held", false, "2020-01-01T00:00:00Z");
    const { holdPluginReference } = expiry;
    const writer = await h.app.db.db.pool.connect();
    try {
      await writer.query("BEGIN");
      // The lock a reference write takes (holdPluginReference also refuses an
      // already-expired plugin, so it is taken here directly).
      await writer.query("SELECT 1 FROM plugins WHERE id = $1 FOR SHARE", [id]);
      assert.deepEqual(await expiry.sweepExpiredPlugins(h.app.db.db.pool), [], "held while the write is in flight");
      await writer.query("INSERT INTO claw_task_dags (dag_id, name, plugin_id) VALUES ('d-x12', 'd', $1)", [id]);
      await writer.query("COMMIT");
    } finally {
      writer.release();
    }
    assert.deepEqual(await expiry.sweepExpiredPlugins(h.app.db.db.pool), [], "and kept by the template once written");
    assert.equal(await holdPluginReference({ query: (t: string, p?: unknown[]) => q(t, p) }, null), true, "no plugin, nothing to hold");
    await q("DELETE FROM claw_task_dags");
    const { insertTaskDag } = await import("../src/tasks/dags/db.js");
    const live = await addRaw("dag-live", false, "2999-01-01T00:00:00Z");
    const row = await insertTaskDag({ dag_id: "d-x12b", name: "d", plugin_id: live, nodes: [] } as any, {} as any, "u1", false);
    assert.equal(Number(row!.plugin_id), live, "insertTaskDag still writes through its transaction");
    // A template naming an expired plugin is refused rather than stored.
    await assert.rejects(
      insertTaskDag({ dag_id: "d-x12c", name: "d", plugin_id: id, nodes: [] } as any, {} as any, "u1", false),
      /plugin that does not exist or has expired/,
    );
    await q("DELETE FROM claw_task_dags");
  });
  // X13
  test("a session turn and a retry may not name a gone, expired or foreign plugin", async () => {
    const { pluginLaunchable } = await import("../src/marketplace/plugins.js");
    const live = await addRaw("turn-live", false, "2999-01-01T00:00:00Z");
    const expired = await addRaw("turn-expired", false, new Date(Date.now() - 1000).toISOString());
    const permanent = await addRaw("turn-permanent", true, null);
    const foreign = Number(((await q(
      "INSERT INTO plugins (name, version, owner_user_id, is_public) VALUES ('turn-foreign', '1', 'u2', false) RETURNING id",
    )).rows[0] as { id: string }).id);
    assert.equal(await pluginLaunchable(live, "u1", false), true);
    assert.equal(await pluginLaunchable(permanent, "u1", false), true);
    assert.equal(await pluginLaunchable(expired, "u1", false), false);
    assert.equal(await pluginLaunchable(foreign, "u1", false), false);
    assert.equal(await pluginLaunchable(foreign, "admin", true), true);
    assert.equal(await pluginLaunchable(987654, "u1", true), false);

    const { retryTask } = await import("../src/tasks/lifecycle.js");
    await q("INSERT INTO claw_tasks (task_id, session_id, name, status, plugin_id, executor, mode) VALUES ('t-x13a', 'sx', 't', 'failed', $1, 'brain', 'llm'), ('t-x13b', 'sx', 't', 'failed', $2, 'brain', 'llm')", [expired, live]);
    assert.deepEqual(await retryTask("t-x13a"), { ok: false }, "a retry may not bring back an expired plugin");
    const again = await retryTask("t-x13b") as { ok?: boolean; task_id?: string };
    assert.equal(again.ok, true, JSON.stringify(again));
    await q("DELETE FROM claw_tasks");
  });
});

// After the Postgres suite: these import config.ts too (see loadExpiry).
// X1
test("an expiry request is absent, cleared, a TTL or an instant, and bounded", async () => {
  const { requestedPluginExpiry, PLUGIN_TTL_MIN_SECONDS } = await loadExpiry();
  assert.equal(requestedPluginExpiry({}, NOW), undefined);
  assert.equal(requestedPluginExpiry({ expires_at: undefined }, NOW), undefined);
  assert.equal(requestedPluginExpiry({ expires_at: null }, NOW), null);
  assert.equal(requestedPluginExpiry({ ttl_seconds: null }, NOW), null);
  assert.deepEqual(requestedPluginExpiry({ ttl_seconds: 3600 }, NOW), new Date("2026-11-11T01:00:00Z"));
  assert.deepEqual(requestedPluginExpiry({ expires_at: "2026-11-12T00:00:00Z" }, NOW), new Date("2026-11-12T00:00:00Z"));
  assert.deepEqual(requestedPluginExpiry({ expires_at: "2026-11-12T08:00:00.5+08:00" }, NOW), new Date("2026-11-12T00:00:00.5Z"));
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
    { ttl_seconds: Number.MAX_SAFE_INTEGER },
    { expires_at: "Nov 12 2026" },
    { expires_at: "2026-11-12" },
    { expires_at: "2026-11-12T00:00:00" },
  ]) {
    assert.throws(() => requestedPluginExpiry(bad, NOW, 30), BadRequestError, JSON.stringify(bad));
  }
  assert.ok(requestedPluginExpiry({ ttl_seconds: 30 * 24 * 3600 }, NOW, 30));
});

// X8
test("the schema guard requires the plugin columns every write names", async () => {
  const { REQUIRED_SCHEMA } = await import("../src/infra/schema-guard.js");
  const plugins = REQUIRED_SCHEMA.find((r) => r.table === "plugins");
  assert.ok(plugins, "plugins is in REQUIRED_SCHEMA");
  for (const c of ["overridable", "expires_at"]) assert.ok(plugins.columns.includes(c), c);
});
