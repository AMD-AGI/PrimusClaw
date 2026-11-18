// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The user's personal skills reaching a turn, over a real Postgres, through the paths production runs: the dispatch of
 * a turn, the read Brain makes when the model uses a skill (`POST /v1/internal/skills/read`), and the completion that
 * keeps what a turn saved. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   M1 the list (`request.user_skills`) holds each current skill that is active and enabled -- never a probation,
 *      disabled or deleted one, never an older enabled row standing in for a newer disabled one, never another user's
 *      -- with name, version, description (cut to 300), invocation, fingerprint and origin and none of its text, most
 *      recently read first; a row stored without a fingerprint gets one, and keeps it
 *   M2 a dispatched turn carries the list (and no `skills`) in the user's own chat, a child session and a work
 *      item's worker; not in a group chat, a router's turn or a session that carried an A2A run, and there
 *      `user_skills_enabled` is false as well
 *   M3 only the user's own conversation is served: not a session someone else owns, one that acts as a user, an
 *      observer's, an application's run, or a deleted session; and a turn that acts as a user loses the list wherever
 *      it was put
 *   M4 the internal read: internal token required; only in a live chat turn; only where the skills serve; SKILL.md
 *      with the list of its files, or one file; a manual skill too; a changed skill is answered with what is current
 *      and nothing of it; the user is the session's owner, never a field of the request; a read sets last_used_at
 *   M5 what a turn saves is kept from the user's own chat and dropped from a group chat
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const INTERNAL = "internal-skills-test-token";

describe("personal skills: what a turn is told, and reads", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let svc: typeof import("../src/marketplace/skill-service.js");
  let access: typeof import("../src/sessions/user-skills.js");
  let dispatch: typeof import("../src/sessions/dispatch.js");

  before(async () => {
    w = await startWorld({
      CLAW_USER_SKILLS_ENABLED: "true", AUTH_INTERNAL_TOKEN: INTERNAL, APP_RUNS_ENABLED: "true",
      CLAW_GITHUB_REVIEW_ENABLED: "true", CLAW_ASSISTANT_OBSERVE: "true",
    });
    svc = await import("../src/marketplace/skill-service.js");
    access = await import("../src/sessions/user-skills.js");
    dispatch = await import("../src/sessions/dispatch.js");
    app = Fastify();
    await (await import("../src/routes/internal-skills.js")).registerInternalSkillRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_skills, claw_skill_files, claw_skill_events, claw_app_runs, claw_work_item_events, claw_work_items,
      claw_assistant_says, claw_assistant_scopes, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions RESTART IDENTITY CASCADE`);
  });

  async function chat(userId: string, opts: { config?: Record<string, unknown>; parent?: string } = {}) {
    const sessionId = `s-${randomUUID().slice(0, 8)}`;
    await w.q(
      "INSERT INTO claw_sessions (session_id, name, user_id, mode, config, parent_session_id) VALUES ($1, 'chat', $2, 'claw', $3, $4)",
      [sessionId, userId, JSON.stringify(opts.config ?? {}), opts.parent ?? null],
    );
    return sessionId;
  }
  async function turn(sessionId: string, opts: { origin?: string; status?: string } = {}) {
    const run = await w.openRun(sessionId, { status: opts.status });
    if (opts.origin) await w.q("UPDATE claw_tasks SET origin = $2 WHERE task_id = $1", [run.taskId, opts.origin]);
    return run;
  }
  /** A skill row as the table holds it; `files` are written beside it with their sizes. */
  async function skill(user: string, name: string, o: {
    version?: number; status?: string; enabled?: boolean; deleted?: boolean; invocation?: string; origin?: string | null;
    description?: string; content?: string; usedAgo?: string | null; files?: Array<{ path: string; content: string }>; sha?: boolean;
  } = {}): Promise<number> {
    const content = o.content ?? `## ${name}\n1. do it`;
    const files = o.files ?? [];
    const [row] = await w.q(
      `INSERT INTO claw_skills (user_id, skill_name, version, content, description, status, enabled, deleted_at, invocation, origin, last_used_at, content_sha, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN NOW() END, $9, $10, NOW() - $11::interval, $12, 'manual') RETURNING id`,
      [user, name, o.version ?? 1, content, o.description ?? `use for ${name}`, o.status ?? "active", o.enabled ?? true, o.deleted ?? false,
        o.invocation ?? "auto", o.origin === undefined ? "api" : o.origin, o.usedAgo ?? null,
        o.sha === false ? null : svc.skillContentSha(content, files)],
    );
    for (const f of files) {
      await w.q(
        "INSERT INTO claw_skill_files (skill_id, user_id, file_path, content, size_bytes) VALUES ($1, $2, $3, $4, $5)",
        [row.id, user, f.path, f.content, Buffer.byteLength(f.content)],
      );
    }
    return row.id;
  }

  test("M1 the list: current, active, enabled, the user's own; names and descriptions, no text; most recently read first", async () => {
    const files = [{ path: "scripts/run.sh", content: "echo hi" }, { path: "references/a.md", content: "notes" }];
    await skill("alice", "weekly-report", { version: 3, origin: "chat", description: "d".repeat(400), usedAgo: "1 hour", files });
    await skill("alice", "deploy-check", { invocation: "manual", usedAgo: "1 minute" });
    await skill("alice", "zeta-legacy", { origin: null, sha: false, content: "legacy body", files: [{ path: "templates/t.md", content: "t" }] });
    await skill("alice", "alpha-plain");
    await skill("alice", "unproven", { status: "probation" });
    await skill("alice", "switched-off", { enabled: false });
    await skill("alice", "removed", { deleted: true });
    await skill("alice", "turned-off-later", { version: 1 });
    await skill("alice", "turned-off-later", { version: 2, enabled: false });
    await skill("alice", "newer-unproven", { version: 1 });
    await skill("alice", "newer-unproven", { version: 2, status: "probation" });
    await skill("bob", "bobs-skill");

    const list = await svc.userSkillManifest("alice");
    assert.deepEqual(list.map((s) => s.name), ["deploy-check", "weekly-report", "alpha-plain", "newer-unproven", "zeta-legacy"]);
    for (const s of list) assert.deepEqual(Object.keys(s).sort(), ["content_sha", "description", "invocation", "name", "origin", "version"]);
    const by = Object.fromEntries(list.map((s) => [s.name, s]));
    assert.deepEqual(
      [by["weekly-report"].version, by["weekly-report"].origin, by["weekly-report"].invocation, by["weekly-report"].description.length],
      [3, "chat", "auto", 300],
    );
    assert.equal(by["weekly-report"].content_sha, svc.skillContentSha("## weekly-report\n1. do it", files));
    assert.equal(by["deploy-check"].invocation, "manual", "a manual skill is on the list, marked, for when the user names it");
    assert.equal(by["newer-unproven"].version, 1, "the probation row never loads; the active one is current");
    assert.equal(by["zeta-legacy"].origin, null);
    const legacySha = svc.skillContentSha("legacy body", [{ path: "templates/t.md", content: "t" }]);
    assert.equal(by["zeta-legacy"].content_sha, legacySha);
    const [stored] = await w.q("SELECT content_sha FROM claw_skills WHERE skill_name = 'zeta-legacy'");
    assert.equal(stored.content_sha, legacySha, "the fingerprint computed for an old row is kept");
    assert.ok(!JSON.stringify(list).includes("do it"), "no skill's text is on the list");

    assert.deepEqual((await svc.userSkillManifest("bob")).map((s) => s.name), ["bobs-skill"]);
    assert.deepEqual(await svc.userSkillManifest("carol"), []);
  });

  /** One dispatched turn, as Brain would receive it. */
  async function dispatched(sessionId: string, userId = "alice"): Promise<Record<string, any>> {
    const p = dispatch.sessionDispatchPorts as any;
    const pristine = { ...p };
    const published: string[] = [];
    try {
      p.doorbellDispatch = () => null;
      p.publishSse = () => {};
      p.admit = async () => ({ kind: "admit" });
      p.publishTask = async (_s: string, payload: string) => { published.push(payload); return published.length; };
      const result = await dispatch.dispatchTaskToBrain({
        sessionId, userId, user: { userId, userName: userId, roles: ["default"], platformKey: `pk-${userId}`, virtualKey: `vk-${userId}` },
        content: "write my weekly report", messageType: "text", toolIds: [], pluginId: undefined, requestImage: undefined,
        requestResource: undefined, requestTimeout: undefined, workspaceId: undefined, mcpServers: undefined,
        capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
      } as never, async () => {});
      assert.equal((result as any).kind, "dispatched", JSON.stringify(result));
    } finally {
      Object.assign(p, pristine);
      await w.q("UPDATE claw_tasks SET status = 'completed' WHERE status <> 'completed'");
      await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL");
    }
    return JSON.parse(published[0]);
  }

  test("M2 a dispatched turn carries the list in the user's own conversations, and nowhere else", async () => {
    await skill("alice", "weekly-report", { description: "Write the weekly report" });
    const u = await w.user("alice");
    const item = await w.createItem(u, "Fix the build");
    const own = await chat("alice");
    const child = await chat("alice", { parent: own });
    const group = await chat("alice", { config: { memory: "off" } });
    const peer = await chat("alice");
    await turn(peer, { origin: "a2a", status: "completed" });
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL");

    for (const [what, sid] of [["own chat", own], ["child session", child], ["worker", item.workerSid]] as const) {
      const task = await dispatched(sid);
      assert.deepEqual(task.user_skills, [{
        name: "weekly-report", version: 1, description: "Write the weekly report", invocation: "auto",
        content_sha: svc.skillContentSha("## weekly-report\n1. do it", []), origin: "api",
      }], what);
      assert.equal(task.user_skills_enabled, true, what);
      assert.equal("skills" in task, false, `${what}: nothing is inlined`);
    }
    for (const [what, sid] of [["group chat", group], ["router", u.routerSid], ["session with an A2A run", peer]] as const) {
      const task = await dispatched(sid);
      assert.equal("user_skills" in task, false, what);
      assert.equal(task.user_skills_enabled, false, what);
      assert.equal("skills" in task, false, what);
    }
  });

  test("M3 only the user's own conversation is served", async () => {
    const own = await chat("alice");
    assert.equal(await access.userSkillsServe(own, "alice"), true);
    assert.equal(await access.userSkillsServe(own, "bob"), false, "someone else's session");
    assert.equal(await access.userSkillsServe(await chat("alice", { config: { acting_as: "u-bob" } }), "alice"), false, "acts as a user");
    assert.equal(await access.userSkillsServe(await chat("alice", { config: { acting_as: "u-bob", requested_by: { user_id: "bob" } } }), "alice"), false, "review profile");
    const observer = await chat("alice");
    await w.q("INSERT INTO claw_assistant_scopes (user_id, scope, session_id) VALUES ('alice', 'teams:group-1', $1)", [observer]);
    assert.equal(await access.userSkillsServe(observer, "alice"), false, "an observer of a group");
    const appRun = await chat("alice");
    const t = await turn(appRun);
    await w.q(`INSERT INTO claw_app_runs (task_id, session_id, plugin_id, manifest, state, mcp_token_enc) VALUES ($1, $2, 1, '{}', 'running', 'x')`, [t.taskId, appRun]);
    assert.equal(await access.userSkillsServe(appRun, "alice"), false, "an application's run");
    const deleted = await chat("alice");
    await w.q("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = $1", [deleted]);
    assert.equal(await access.userSkillsServe(deleted, "alice"), false, "a deleted session");
    assert.equal(await access.userSkillsServe("no-such-session", "alice"), false);

    // A turn that acts as a user is stripped of the list and the tools, whatever put them on it.
    const acting = await chat("alice", { config: { acting_as: "u-bob" } });
    const { applySandboxKeyPolicyToTask } = await import("../src/github-review/session-tools.js");
    const task: Record<string, unknown> = { user_skills: [{ name: "x" }], user_skills_enabled: true };
    await applySandboxKeyPolicyToTask(task, acting);
    assert.deepEqual([task.withhold_sandbox_keys, "user_skills" in task, task.user_skills_enabled], [true, false, false]);
  });

  async function read(body: Record<string, unknown>, token: string | null = INTERNAL) {
    const res = await app.inject({
      method: "POST", url: "/v1/internal/skills/read", payload: body,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() as any };
  }

  test("M4 the internal read: a live turn of the user's own chat, the current skill only, the owner's never the caller's", async () => {
    const files = [{ path: "scripts/run.sh", content: "echo hi" }];
    await skill("alice", "weekly-report", { files, content: "## Steps\n1. list PRs" });
    await skill("alice", "deploy-check", { invocation: "manual" });
    await skill("alice", "switched-off", { enabled: false });
    await skill("alice", "unproven", { status: "probation" });
    await skill("alice", "removed", { deleted: true });
    await skill("bob", "bobs-skill");
    const own = await chat("alice");
    const t = await turn(own);
    const ask = (extra: Record<string, unknown>) => read({ session_id: own, message_id: t.messageId, ...extra });
    const sha = svc.skillContentSha("## Steps\n1. list PRs", files);

    assert.equal((await read({ session_id: own, message_id: t.messageId, name: "weekly-report" }, null)).status, 401);
    assert.equal((await read({ session_id: own, message_id: t.messageId, name: "weekly-report" }, "wrong")).status, 401);
    assert.equal((await ask({})).status, 400);
    assert.equal((await ask({ name: "weekly-report", path: "" })).status, 400);

    const doc = await ask({ name: "weekly-report", content_sha: sha });
    assert.equal(doc.status, 200, JSON.stringify(doc.body));
    assert.deepEqual(doc.body, {
      ok: true, name: "weekly-report", version: 1, description: "use for weekly-report", invocation: "auto", content_sha: sha, origin: "api",
      content: "## Steps\n1. list PRs", files: [{ path: "scripts/run.sh", size_bytes: 7, is_binary: false }],
    });
    const [used] = await w.q("SELECT last_used_at FROM claw_skills WHERE skill_name = 'weekly-report'");
    assert.ok(used.last_used_at, "a read is a use");

    const file = await ask({ name: "weekly-report", path: "scripts/run.sh", content_sha: sha });
    assert.equal(file.status, 200);
    assert.deepEqual(file.body, { ok: true, name: "weekly-report", version: 1, content_sha: sha, path: "scripts/run.sh", content: "echo hi", is_binary: false, size_bytes: 7 });
    assert.equal((await ask({ name: "weekly-report", path: "scripts/missing.sh" })).status, 404);
    assert.equal((await ask({ name: "deploy-check" })).status, 200, "a manual skill is read when the user names it");

    for (const name of ["switched-off", "unproven", "removed", "bobs-skill", "no-such-skill"]) {
      const r = await ask({ name });
      assert.deepEqual([r.status, r.body.error], [404, "not_found"], name);
      assert.ok(!JSON.stringify(r.body).includes("do it"), name);
    }
    const asBob = await ask({ name: "bobs-skill", user_id: "bob" });
    assert.equal(asBob.status, 404, "the user is the session's owner, whatever the request says");

    // Changed since the turn was told of it: what is current, and nothing of it.
    await w.q("UPDATE claw_skills SET content = 'v2 body', version = 2, content_sha = 'new' WHERE skill_name = 'weekly-report'");
    const changed = await ask({ name: "weekly-report", content_sha: sha });
    assert.equal(changed.status, 409);
    assert.deepEqual(changed.body, { ok: false, error: "changed", version: 2, content_sha: svc.skillContentSha("v2 body", files) });
    assert.equal((await ask({ name: "weekly-report", path: "scripts/run.sh", content_sha: sha })).status, 409);

    // Only in a live chat turn.
    const doneSid = await chat("alice");
    const done = await turn(doneSid, { status: "completed" });
    assert.equal((await read({ session_id: doneSid, message_id: done.messageId, name: "weekly-report" })).status, 409);
    assert.equal((await ask({ name: "weekly-report", message_id: "not-this-turn" })).status, 409);

    // Only where the user's skills serve.
    for (const [what, sid] of [
      ["group chat", await chat("alice", { config: { memory: "off" } })],
      ["acts as a user", await chat("alice", { config: { acting_as: "u-bob" } })],
      ["router", (await w.user("alice")).routerSid],
    ] as const) {
      const live = await turn(sid);
      const r = await read({ session_id: sid, message_id: live.messageId, name: "deploy-check" });
      assert.deepEqual([r.status, r.body.error], [403, "not_served"], what);
    }
  });

  test("M5 what a turn saves is kept from the user's own chat and dropped from a group chat", async () => {
    const consumer = await import("../src/events/consumer.js");
    const { sc } = await import("../src/infra/nats.js");
    const original = { ...consumer.completionPorts };
    Object.assign(consumer.completionPorts, {
      maybeSummarize: async () => {}, maybeRecordTaskPattern: async () => {}, enqueueEvolutionJob: async () => {},
      recordSkillFeedback: async () => {}, checkProbationGraduation: async () => {},
    });
    const tombstone = consumer.tombstoneReader.has;
    consumer.tombstoneReader.has = async () => false;
    const complete = async (sessionId: string, name: string, file: string) => {
      const run = await turn(sessionId);
      let acks = 0;
      await consumer.consumeEventDelivery({
        subject: `events.${sessionId}`, seq: 1, ack: () => { acks++; }, nak: () => { throw new Error("nak"); },
        data: sc.encode(JSON.stringify({
          type: "exec_complete", session_id: sessionId, task_id: run.taskId, user_id: "alice", message_id: run.messageId,
          prompt: "save it as a skill", final_text: "saved", failed: false, error_count: 0,
          // The user's own request, quoted: saved at once (without it, a draft: assistant-skill-save.test.ts).
          skills_to_save: [{ skill_name: name, content: "## Steps\n1. check", description: "Deployment checklist", request_quote: "save it as a skill" }],
          skill_file_mutations: [{ action: "add", skill_name: "kept-skill", file_path: file, content: "notes" }],
        })),
      } as any);
      assert.equal(acks, 1);
    };
    try {
      await complete(await chat("alice"), "kept-skill", "references/notes.md");
      await complete(await chat("alice", { config: { memory: "off" } }), "group-skill", "references/group.md");
    } finally {
      Object.assign(consumer.completionPorts, original);
      consumer.tombstoneReader.has = tombstone;
    }
    assert.deepEqual((await w.q("SELECT skill_name FROM claw_skills ORDER BY skill_name")).map((r) => r.skill_name), ["kept-skill"]);
    assert.deepEqual((await w.q("SELECT file_path FROM claw_skill_files")).map((r) => r.file_path), ["references/notes.md"],
      "the group chat's file write to the same skill is dropped too");
  });
});
