// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The trigger routes and loop against a real Postgres whose schema `initDb`
 * built with CLAW_TRIGGERS_ENABLED on. The dispatch is a stub that records what
 * it was asked to start, because what matters here is who the run is started as
 * and how often, not Brain.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const user = (id: string, key = `pk-${id}`) => ({
  userId: id, userName: id, roles: ["default"], platformKey: key, virtualKey: `vk-${id}`,
});

describe("scheduled triggers", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let caller = user("u1");
  let sched: typeof import("../src/triggers/scheduler.js");
  let fire: typeof import("../src/triggers/fire.js");
  let crypto: typeof import("../src/crypto/user-env.js");
  const dispatched: any[] = [];
  const interrupts: string[] = [];
  const q = (sql: string, params: unknown[] = []) => h.app.db.db.query(sql, params);

  const create = (over: Record<string, unknown> = {}) => app.inject({
    method: "POST", url: "/v1/triggers",
    payload: { name: "brief", prompt: "summarise my runs", schedule: "0 8 * * *", timezone: "Asia/Shanghai", ...over },
  });
  const makeDue = (id: string, at = "2026-10-27T00:00:00Z") =>
    q("UPDATE claw_triggers SET next_fire_at = $2 WHERE trigger_id = $1", [id, at]);
  const NOW = new Date("2026-10-27T00:00:30Z");

  before(async () => {
    process.env.CLAW_DEPLOY_MODE = "safe";
    h = await startAdmissionCluster({
      CLAW_TRIGGERS_ENABLED: "true", TRIGGER_DAILY_LIMIT_PER_USER: "2", TRIGGER_RUN_TIME_LIMIT_SECONDS: "60",
      TRIGGER_MAX_PER_USER: "4", TRIGGER_MAX_CONSECUTIVE_FAILURES: "2",
    });
    crypto = await import("../src/crypto/user-env.js");
    crypto.initUserEnvCrypto();
    sched = await import("../src/triggers/scheduler.js");
    fire = await import("../src/triggers/fire.js");
    const chat = await import("../src/tasks/chat-run.js");
    chat.chatRunPorts.publishInterrupt = (s: string) => { interrupts.push(s); };
    fire.triggerPorts.dispatch = (async (input: any) => {
      dispatched.push(input);
      return { kind: "dispatched", messageId: input.messageId, sandboxImage: undefined, runId: "run-" + dispatched.length };
    }) as any;
    const routes = await import("../src/routes/triggers.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = caller; });
    await routes.registerTriggerRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.stop(); });
  beforeEach(async () => {
    caller = user("u1");
    dispatched.length = 0; interrupts.length = 0;
    await q("DELETE FROM claw_trigger_fires");
    await q("DELETE FROM claw_triggers");
    await q("DELETE FROM claw_sessions");
  });

  test("creation computes the first firing in the owner's timezone and refuses a too-frequent schedule", async () => {
    const ok = await create();
    assert.equal(ok.statusCode, 200, ok.body);
    const next = new Date(ok.json().data.next_fire_at);
    assert.equal(next.getUTCHours(), 0, "08:00 Shanghai is 00:00 UTC");
    for (const schedule of ["* * * * *", "*/10 * * * *"]) {
      const r = await create({ schedule });
      assert.equal(r.statusCode, 400, schedule);
    }
    assert.equal((await create({ timezone: "Mars/Olympus" })).statusCode, 400);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_triggers")).rows[0].n, 1, "refusals stored nothing");
  });

  test("the stored credential is encrypted, and the API never returns it", async () => {
    const r = await create();
    assert.ok(!JSON.stringify(r.json()).includes("pk-u1"));
    const row = (await q("SELECT credential_enc FROM claw_triggers")).rows[0] as any;
    assert.ok(!row.credential_enc.includes("pk-u1"));
    assert.ok(crypto.decryptUserEnvValue(row.credential_enc).includes("pk-u1"));
  });

  test("a firing runs as the creator, with the creator's stamped credentials and no admin role", async () => {
    caller = user("u1", "pk-creator");
    const id = (await create()).json().data.trigger_id;
    caller = user("u2", "pk-someone-else"); // a different caller must not matter at fire time
    await makeDue(id);
    await sched.tickTriggers(NOW);
    assert.equal(dispatched.length, 1);
    const input = dispatched[0];
    assert.equal(input.userId, "u1");
    assert.equal(input.user.userId, "u1");
    assert.equal(input.user.platformKey, "pk-creator");
    assert.deepEqual(input.user.roles, ["default"]);
    assert.equal(input.content, "summarise my runs");
    assert.equal(input.requestTimeout, 60, "the per-run limit travels with the dispatch");
    const s = (await q("SELECT user_id, config FROM claw_sessions")).rows[0] as any;
    assert.equal(s.user_id, "u1");
    assert.equal(s.config.platform_key, "pk-creator");
    assert.equal(s.config._server_managed_credentials, true);
    assert.equal(s.config.trigger_id, id);
    const f = (await q("SELECT status, session_id FROM claw_trigger_fires")).rows[0] as any;
    assert.equal(f.status, "started");
    const t = (await q("SELECT next_fire_at FROM claw_triggers")).rows[0] as any;
    assert.ok(new Date(t.next_fire_at) > NOW, "scheduled forward");
  });

  test("two replicas ticking at once fire a due trigger once", async () => {
    const id = (await create()).json().data.trigger_id;
    await makeDue(id);
    await Promise.all([sched.tickTriggers(NOW), sched.tickTriggers(NOW), sched.tickTriggers(NOW)]);
    assert.equal(dispatched.length, 1);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_trigger_fires")).rows[0].n, 1);
  });

  test("the per-user daily limit skips firings without pausing anything, does not touch another user, and lifts when the window rolls", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await create({ name: `t${i}` })).json().data.trigger_id);
    caller = user("u2");
    const other = (await create({ name: "other" })).json().data.trigger_id;
    for (const [i, id] of [...ids, other].entries()) await makeDue(id, `2026-10-27T00:00:0${i}Z`);
    await sched.tickTriggers(NOW);
    const fires = (await q("SELECT f.status, t.owner_user_id FROM claw_trigger_fires f JOIN claw_triggers t USING (trigger_id)")).rows as any[];
    const u1 = fires.filter((f) => f.owner_user_id === "u1").map((f) => f.status).sort();
    assert.deepEqual(u1, ["skipped_quota", "started", "started"]);
    assert.deepEqual(fires.filter((f) => f.owner_user_id === "u2").map((f) => f.status), ["started"]);
    assert.equal(dispatched.length, 3);
    const skipped = (await q("SELECT detail FROM claw_trigger_fires WHERE status = 'skipped_quota'")).rows as any[];
    assert.deepEqual(skipped.map((r) => r.detail), ["daily_limit"], "the skip says why");
    const paused = (await q("SELECT trigger_id FROM claw_triggers WHERE paused_reason IS NOT NULL")).rows;
    assert.deepEqual(paused, [], "hitting the limit pauses no trigger");
    // Still inside the window: the next firing of every u1 trigger is skipped again, not run.
    for (const id of ids) await makeDue(id, "2026-10-27T06:00:00Z");
    await sched.tickTriggers(new Date("2026-10-27T06:00:30Z"));
    assert.equal(dispatched.length, 3, "nothing new starts while the count is at the limit");
    assert.deepEqual((await q("SELECT trigger_id FROM claw_triggers WHERE paused_reason IS NOT NULL")).rows, []);
    // A day later the earlier runs have finished and aged out, and the same triggers run again.
    await q("UPDATE claw_sessions SET agent_status = 'idle'");
    for (const id of ids) await makeDue(id, "2026-10-28T08:00:00Z");
    await sched.tickTriggers(new Date("2026-10-28T08:00:30Z"));
    assert.equal(dispatched.length, 5, "two more runs fit under the limit once the window has rolled");
    assert.deepEqual((await q("SELECT trigger_id FROM claw_triggers WHERE paused_reason IS NOT NULL")).rows, []);
  });

  test("a run that outlives its limit is stopped once", async () => {
    const id = (await create()).json().data.trigger_id;
    await makeDue(id);
    await sched.tickTriggers(NOW);
    assert.equal(await sched.enforceRunTimeLimit(new Date(NOW.getTime() + 30_000)), 0, "inside the limit");
    assert.equal(await sched.enforceRunTimeLimit(new Date(NOW.getTime() + 120_000)), 1);
    assert.equal(interrupts.length, 1);
    assert.equal(await sched.enforceRunTimeLimit(new Date(NOW.getTime() + 240_000)), 0, "not stopped twice");
  });

  test("a turn the user starts later in a trigger session is not stopped by the time limit", async () => {
    const id = (await create()).json().data.trigger_id;
    await makeDue(id);
    await sched.tickTriggers(NOW);
    const sid = ((await q("SELECT session_id FROM claw_trigger_fires")).rows[0] as any).session_id;
    // The trigger's own run ended; an hour later the user continues the conversation.
    await q("UPDATE claw_sessions SET agent_status = 'running', agent_gate_message_id = 'claw-user-turn' WHERE session_id = $1", [sid]);
    assert.equal(await sched.enforceRunTimeLimit(new Date(NOW.getTime() + 3600_000)), 0);
    assert.equal(interrupts.length, 0, "the user's own turn is left alone");
  });

  describe("a fire that fails after the session row exists", () => {
    const original = () => fire.triggerPorts.dispatch;
    let saved: any;
    beforeEach(() => { saved = original(); });
    afterEach(() => { fire.triggerPorts.dispatch = saved; });
    const sessions = async () => Number(((await q("SELECT COUNT(*)::int AS n FROM claw_sessions")).rows[0] as any).n);

    test("a dispatch that throws leaves no running session behind, and the next firing is not blocked", async () => {
      const id = (await create()).json().data.trigger_id;
      fire.triggerPorts.dispatch = (async () => { throw new Error("transient"); }) as any;
      await makeDue(id);
      await sched.tickTriggers(NOW);
      assert.equal(await sessions(), 0, "the half-created session is removed");
      assert.equal(((await q("SELECT status FROM claw_trigger_fires")).rows[0] as any).status, "failed_start");
      fire.triggerPorts.dispatch = saved;
      await makeDue(id, "2026-10-28T00:00:00Z");
      await sched.tickTriggers(new Date("2026-10-28T00:00:30Z"));
      const statuses = (await q("SELECT status FROM claw_trigger_fires ORDER BY fired_at")).rows.map((r: any) => r.status);
      assert.deepEqual(statuses, ["failed_start", "started"], "not skipped_overlap");
    });

    test("a failure before dispatch (the env snapshot) is cleaned up too", async () => {
      const id = (await create()).json().data.trigger_id;
      const real = h.app.db.db.query;
      let armed = true;
      const envMod = await import("../src/crypto/user-env.js");
      const spy = (await import("node:test")).mock.method(h.app.db.db, "query", (async (text: string, params?: unknown[]) => {
        if (armed && /claw_user_env_vars/.test(text)) { armed = false; throw new Error("transient db error"); }
        return real.call(h.app.db.db, text, params);
      }) as any);
      void envMod;
      try {
        await makeDue(id);
        await sched.tickTriggers(NOW);
      } finally { spy.mock.restore(); }
      assert.equal(armed, false, "the injected failure was reached");
      assert.equal(await sessions(), 0);
    });

    test("a dispatch that reports failure without running its rollback leaves nothing either", async () => {
      const id = (await create()).json().data.trigger_id;
      fire.triggerPorts.dispatch = (async (input: any) => ({ kind: "publish_failed", messageId: input.messageId, error: new Error("x") })) as any;
      await makeDue(id);
      await sched.tickTriggers(NOW);
      assert.equal(await sessions(), 0);
    });
  });

  test("editing a trigger never replaces its stored credential, and nobody else can rebind it", async () => {
    caller = user("u1", "pk-original");
    const id = (await create()).json().data.trigger_id;
    const stored = async () => ((await q("SELECT credential_enc FROM claw_triggers WHERE trigger_id = $1", [id])).rows[0] as any).credential_enc;
    const before = await stored();
    // The owner edits from a request that carries no platform key.
    caller = user("u1", "");
    const r = await app.inject({ method: "PATCH", url: `/v1/triggers/${id}`, payload: { name: "renamed" } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(await stored(), before, "the working key is still there");
    // Another user, and an admin acting for someone else, get 404 and change nothing.
    for (const other of [user("u2", "pk-other"), { ...user("admin", "pk-admin"), roles: ["system-admin"] }]) {
      caller = other;
      assert.equal((await app.inject({ method: "PATCH", url: `/v1/triggers/${id}`, payload: { name: "hijack" } })).statusCode, 404);
      assert.equal(await stored(), before);
    }
    // And the firing still runs as the original creator.
    await makeDue(id);
    await sched.tickTriggers(NOW);
    assert.equal(dispatched[0].user.platformKey, "pk-original");
  });

  test("a missed firing older than the stale window is skipped, not run late", async () => {
    const id = (await create()).json().data.trigger_id;
    await makeDue(id, "2026-10-26T00:00:00Z");
    await sched.tickTriggers(NOW);
    assert.equal(dispatched.length, 0);
    assert.equal((await q("SELECT status FROM claw_trigger_fires")).rows[0].status, "skipped_stale");
  });

  test("a trigger whose previous run is still open skips the next firing", async () => {
    const id = (await create()).json().data.trigger_id;
    await makeDue(id);
    await sched.tickTriggers(NOW);
    await makeDue(id, "2026-10-27T00:00:10Z");
    await sched.tickTriggers(new Date(NOW.getTime() + 5000));
    const st = (await q("SELECT status FROM claw_trigger_fires ORDER BY fired_at")).rows.map((r: any) => r.status);
    assert.deepEqual(st, ["started", "skipped_overlap"]);
    assert.equal(dispatched.length, 1);
  });

  test("a trigger saved without a platform key does not run and does not fall back to a shared one", async () => {
    const id = (await create()).json().data.trigger_id;
    await q("UPDATE claw_triggers SET credential_enc = $2 WHERE trigger_id = $1",
      [id, crypto.encryptUserEnvValue(JSON.stringify({ platformKey: "", virtualKey: "", userName: "u1" }))]);
    await makeDue(id);
    await sched.tickTriggers(NOW);
    assert.equal(dispatched.length, 0);
    const t = (await q("SELECT paused_reason FROM claw_triggers")).rows[0] as any;
    assert.equal(t.paused_reason, "credential_invalid");
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_sessions")).rows[0].n, 0);
  });

  test("consecutive failed starts pause the trigger", async () => {
    const id = (await create()).json().data.trigger_id;
    const real = fire.triggerPorts.dispatch;
    fire.triggerPorts.dispatch = (async (_i: any, rollback: () => Promise<void>) => { await rollback(); return { kind: "publish_failed", messageId: "m", error: new Error("x") }; }) as any;
    try {
      await makeDue(id, "2026-10-27T00:00:00Z");
      await sched.tickTriggers(NOW);
      await makeDue(id, "2026-10-27T00:00:10Z");
      await sched.tickTriggers(new Date(NOW.getTime() + 5000));
    } finally { fire.triggerPorts.dispatch = real; }
    assert.equal(((await q("SELECT paused_reason FROM claw_triggers")).rows[0] as any).paused_reason, "failures");
  });

  test("only the creator can see or change a trigger, and the cap is enforced", async () => {
    const id = (await create()).json().data.trigger_id;
    caller = user("u2");
    assert.equal((await app.inject({ method: "GET", url: `/v1/triggers/${id}` })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `/v1/triggers/${id}` })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/v1/triggers/${id}/pause` })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/v1/triggers" })).json().data.length, 0);
    caller = user("u1");
    for (let i = 0; i < 3; i++) assert.equal((await create({ name: `n${i}` })).statusCode, 200);
    assert.equal((await create({ name: "over" })).statusCode, 409);
  });

  test("a paused trigger does not fire and resumes from a future time", async () => {
    const id = (await create()).json().data.trigger_id;
    await app.inject({ method: "POST", url: `/v1/triggers/${id}/pause` });
    await makeDue(id);
    await sched.tickTriggers(NOW);
    assert.equal(dispatched.length, 0);
    const r = await app.inject({ method: "POST", url: `/v1/triggers/${id}/resume` });
    assert.equal(r.json().data.paused_reason, null);
    assert.ok(new Date(r.json().data.next_fire_at) > new Date());
  });
});
