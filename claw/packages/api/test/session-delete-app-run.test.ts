// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a session's delete does to a hosted application run in it, against a real
 * Postgres (skipped without DATABASE_URL, and a skip is not a pass).
 *
 * The case, measured on 2026-11-07: a session with a running app run was deleted;
 * the run's grant stayed live, and the two GPU sandboxes the application had made
 * under it kept their GPUs, because the only revoke was the Brain's finishing step
 * and that waited out the application's 900 s SIGTERM grace first. And the task
 * answered 404 from the moment of the delete, so the caller could not see how the
 * run ended. The delete now revokes the grant itself, with the rest of the
 * session's cleanup; and the task keeps answering, with its outcome only, for a
 * while after the delete.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import type { UserInfo } from "../src/auth/models.js";

const skip = postgresSkipReason();

function user(userId: string, roles: string[] = ["default"]): UserInfo {
  return { userId, userName: userId, roles, platformKey: "", virtualKey: `vk-${userId}` };
}
const OWNER = user("u-1");
const OTHER = user("u-2");

describe("a session's delete ends its app runs' grants and leaves the outcome readable", { skip }, () => {
  let c: AdmissionCluster;
  let teardown: typeof import("../src/sessions/teardown.js");
  const original: Record<string, unknown> = {};
  const revoked: string[] = [];
  let failRevoke: Error | null = null;
  const apps: FastifyInstance[] = [];
  const sql = async (text: string, params: unknown[] = []) => (await c.app.db.db.query(text, params)).rows as any[];

  before(async () => {
    c = await startAdmissionCluster({ APP_RUNS_ENABLED: "true", CLAW_DEPLOY_MODE: "kubernetes", LLM_KEY_SOURCE: "virtualKey" });
    teardown = await import("../src/sessions/teardown.js");
    Object.assign(original, teardown.teardownPorts, { signer: teardown.teardownGrantSigner?.current });
  });
  after(async () => { await c?.stop(); });
  beforeEach(async () => {
    for (const t of ["claw_app_runs", "claw_tasks", "claw_sessions"]) await sql(`DELETE FROM ${t}`);
    revoked.length = 0;
    failRevoke = null;
    // Everything the cleanup does outside this database, except the step under test.
    const p = teardown.teardownPorts;
    p.writeTombstones = async () => "written";
    p.notifyCleanup = () => true;
    p.parkHands = async () => "parked";
    p.deleteGateLocks = async () => true;
    p.purgeSessionEvents = async () => undefined;
    p.deleteWorkspaceObjects = async () => ({ deleted: 0, failed: 0, complete: true });
    p.releaseWorkspaceRefs = async () => "released";
    if (teardown.teardownGrantSigner) teardown.teardownGrantSigner.current = () => ({
      revoke: async (grantId: string) => {
        if (failRevoke) throw failRevoke;
        revoked.push(grantId);
      },
    });
    for (const sid of ["s1", "s2"]) {
      await sql(`INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, config)
                 VALUES ($1, 't', $2, 'claw', 'idle', '{}'::jsonb)`, [sid, sid === "s1" ? OWNER.userId : OTHER.userId]);
    }
    await sql("INSERT INTO claw_plugins (plugin_id, name) VALUES (8, 'p') ON CONFLICT DO NOTHING").catch(() => undefined);
  });
  afterEach(async () => {
    const p = teardown.teardownPorts as Record<string, unknown>;
    for (const k of Object.keys(p)) p[k] = original[k];
    if (teardown.teardownGrantSigner) teardown.teardownGrantSigner.current = original.signer as typeof teardown.teardownGrantSigner.current;
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  /** An app run with a live lease, holding grant `grant`, in `state`. */
  async function seed(taskId: string, sid: string, grant: string | null, state = "running") {
    await sql(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, mode, executor, prompt,
                               lease_owner, lease_expires_at, heartbeat_at, claim_count, callback_url, started_at)
       VALUES ($1, $2, 'app', 'running', 'task', 'app', 'brain', 'the secret prompt',
               'brain-A', NOW() + INTERVAL '30 seconds', NOW(), 1, 'http://api/v1/internal/tasks/x', NOW())`,
      [taskId, sid],
    );
    await sql(
      `INSERT INTO claw_app_runs (task_id, session_id, plugin_id, manifest, state, sandbox_workload_id, mcp_token_enc, grant_id)
       VALUES ($1, $2, 8, '{}'::jsonb, $3, 'claw-0001-sandbox-abcde', 'x', $4)`,
      [taskId, sid, state, grant],
    );
  }
  const runOf = async (taskId: string) => (await sql("SELECT state, grant_revoked_at FROM claw_app_runs WHERE task_id = $1", [taskId]))[0];

  test("the delete revokes the session's live grants, and only those", async () => {
    await seed("app-1", "s1", "gr-live");
    await seed("app-2", "s1", "gr-ended", "ended");
    await seed("app-3", "s1", null);
    await seed("app-4", "s2", "gr-other");

    await teardown.commitSessionDeletion("s1");
    const incomplete = await teardown.runSessionCleanup({ sessionId: "s1", ownerId: OWNER.userId, platformKey: "k" }, { budgetMs: 5_000 });

    assert.deepEqual(incomplete, []);
    assert.deepEqual(revoked, ["gr-live"], "an ended run's grant was revoked by the Brain that ended it; a run with none has nothing");
    assert.ok((await runOf("app-1")).grant_revoked_at, "and the row says so, so no Brain extends or re-signs it");
    assert.equal((await runOf("app-4")).grant_revoked_at, null, "another session's run is not touched");
    assert.equal((await runOf("app-2")).grant_revoked_at, null);
  });

  test("a revoke the service refused leaves the cleanup to be repeated, and the repeat asks again", async () => {
    await seed("app-1", "s1", "gr-live");
    await teardown.commitSessionDeletion("s1");
    failRevoke = new Error("connect ECONNREFUSED");
    const input = { sessionId: "s1", ownerId: OWNER.userId, platformKey: "k" };
    assert.deepEqual(await teardown.runSessionCleanup(input, { budgetMs: 5_000 }), ["app_grants"]);
    assert.ok((await runOf("app-1")).grant_revoked_at, "stamped before the service was asked: never extended again");

    failRevoke = null;
    assert.deepEqual(await teardown.runSessionCleanup(input, { budgetMs: 5_000 }), []);
    assert.deepEqual(revoked, ["gr-live"]);
  });

  test("the run as a Brain reads it says the user cancelled it, through a finish-only reopen and a patch", async () => {
    const state = await import("../src/tasks/app-run-state.js");
    await seed("app-1", "s1", null);
    await seed("app-4", "s2", null);
    let run = (await state.readAppRun("app-1"))!;
    assert.deepEqual({ status: run.task_status, deleted: run.session_deleted }, { status: "running", deleted: false });

    await teardown.commitSessionDeletion("s1");
    run = (await state.readAppRun("app-1"))!;
    assert.deepEqual({ status: run.task_status, deleted: run.session_deleted }, { status: "cancelled", deleted: true });
    const other = (await state.readAppRun("app-4"))!;
    assert.deepEqual({ status: other.task_status, deleted: other.session_deleted }, { status: "running", deleted: false });

    // A finish-only dispatch reopens the task to `preparing`; the user's cancel is what the Brain must see.
    await sql(`UPDATE claw_tasks SET status = 'preparing', lease_owner = 'brain-B', lease_expires_at = NOW() + INTERVAL '30 seconds',
                      metadata = jsonb_build_object('app_finish_prior', jsonb_build_object('status', 'cancelled'))
                WHERE task_id = 'app-1'`);
    await sql("UPDATE claw_sessions SET deleted_at = NULL WHERE session_id = 's1'");
    run = (await state.readAppRun("app-1"))!;
    assert.deepEqual({ status: run.task_status, deleted: run.session_deleted }, { status: "cancelled", deleted: false });
    const patched = await state.patchAppRun("app-1", { brainId: "brain-B", claimCount: 1 }, { state: "finishing" });
    assert.equal(patched.ok, true);
    assert.equal(patched.ok && patched.run.task_status, "cancelled", "a patch answers with the same view");
  });

  async function tasksAs(caller: UserInfo): Promise<FastifyInstance> {
    const { registerTaskRoutes } = await import("../src/routes/tasks.js");
    const app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = caller; });
    await registerTaskRoutes(app);
    await app.ready();
    apps.push(app);
    return app;
  }

  test("a deleted session's task still says how it ended, and nothing it carried", async () => {
    await seed("app-1", "s1", null);
    const owner = await tasksAs(OWNER);
    assert.equal((await owner.inject({ method: "GET", url: "/v1/tasks/app-1" })).statusCode, 200);

    await teardown.commitSessionDeletion("s1");
    const res = await owner.inject({ method: "GET", url: "/v1/tasks/app-1" });
    assert.equal(res.statusCode, 200, res.body);
    const item = res.json().item;
    assert.equal(item.status, "cancelled");
    assert.equal(item.failure_reason, "session_deleted");
    assert.equal(item.session_deleted, true);
    assert.ok(item.completed_at, "the time it ended");
    assert.equal(res.body.includes("the secret prompt"), false, "what the task carried stays behind the delete");
    assert.equal(item.input, undefined);

    const other = await tasksAs(OTHER);
    assert.equal((await other.inject({ method: "GET", url: "/v1/tasks/app-1" })).statusCode, 403, "still only its owner's");
    assert.equal(
      (await owner.inject({ method: "POST", url: "/v1/tasks/app-1/cancel" })).statusCode, 404,
      "readable, not usable",
    );
    assert.equal((await owner.inject({ method: "GET", url: "/v1/tasks/app-1/dag" })).statusCode, 404, "only the task itself");

    const { DELETED_SESSION_TASK_READ_SEC } = await import("../src/config.js");
    await sql("UPDATE claw_sessions SET deleted_at = NOW() - ($1::int * INTERVAL '1 second') WHERE session_id = 's1'", [DELETED_SESSION_TASK_READ_SEC + 5]);
    assert.equal((await owner.inject({ method: "GET", url: "/v1/tasks/app-1" })).statusCode, 404, "and only for a while");
  });
});
