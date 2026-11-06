// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The user's brief (`assistant/brief.ts`) on a real Postgres with the assistant, notifications, triggers, GitHub events and job
 * watches on; SaFE is a stand-in. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   B1  every section is there, built from what Claw holds: items that need the user, pull request events, runs and approvals
 *       Claw told them about, writes waiting for their confirmation, watched jobs, and SaFE (failed, stuck, running; only theirs)
 *   B2  a source that cannot be read says "could not check" and the rest of the brief stands
 *   B3  GET /v1/assistant/brief answers the caller's own brief, read with the caller's key, in their language
 *   B4  a trigger whose action is brief says the brief through the user's assistant when it fires: no run, one message per planned
 *       time, recorded as delivered; one whose owner has no assistant fails with the reason
 *   B5  the router's brief tool answers the same brief in the user's language, read with the key their messages gave, and the turn
 *       no longer acts for them after it; a worker has no such tool
 *   B6  a brief starts no run, so a user at their daily run limit still gets it, while a run of theirs due at the same time is
 *       skipped for the limit
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant brief", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let alice: { userId: string; routerSid: string };
  let brief: typeof import("../src/assistant/brief.js");
  const now = new Date();
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  let workloads: import("../src/assistant/brief.js").WorkloadSeen[] = [];
  let safeError: Error | null = null;
  const keys: string[] = [];
  const dispatched: unknown[] = [];

  before(async () => {
    w = await startWorld({
      CLAW_TRIGGERS_ENABLED: "true", CLAW_ASSISTANT_GITHUB_EVENTS: "true", CLAW_ASSISTANT_JOB_EVENTS: "true",
      CLAW_GITHUB_REVIEW_ENABLED: "true", SAFE_API_URL: "https://safe.example.invalid",
    });
    brief = await import("../src/assistant/brief.js");
    brief.briefPorts.listWorkloads = async (_userId, key) => {
      keys.push(key);
      if (safeError) throw safeError;
      return workloads;
    };
    const fire = await import("../src/triggers/fire.js");
    fire.triggerPorts.dispatch = (async (input: unknown) => { dispatched.push(input); return { kind: "dispatched" }; }) as never;
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      (req as any).user = { userId: id, userName: id, platformKey: `pk-req-${id}`, virtualKey: `vk-req-${id}`, roles: ["default"] };
    });
    await (await import("../src/routes/assistant-proactive.js")).registerAssistantProactiveRoutes(app);
    await (await import("../src/routes/triggers.js")).registerTriggerRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_triggers, claw_trigger_fires, claw_assistant_confirmations, claw_assistant_says, claw_assistant_messages,
      claw_notification_outbox, claw_notification_subscriptions, claw_work_item_events, claw_work_items, claw_work_item_subscriptions,
      claw_work_item_github_events, claw_assistant_job_watches, claw_assistant_job_events, claw_github_confirmations, claw_pending_messages,
      claw_tasks, claw_assistants, claw_sessions CASCADE`);
    workloads = [];
    safeError = null;
    keys.length = 0;
    dispatched.length = 0;
    alice = await w.user("alice");
  });

  async function item(seq: number, title: string, state: string, extra: Record<string, unknown> = {}) {
    await w.q(
      `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id, last_report_kind, pending_question, outcome, closed_at)
       VALUES ($1, 'alice', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [`kwi_${seq}`, seq, title, state, `ws_${seq}`, extra.kind ?? null, extra.question ?? null, extra.outcome ?? null, extra.closedAt ?? null],
    );
  }

  async function world() {
    await item(1, "修复登录超时", "needs_you", { kind: "waiting", question: "要不要回滚？" });
    await item(2, "Bump deps", "needs_you", { kind: "ready" });
    await item(3, "Long refactor", "in_progress");
    await item(4, "Old thing", "done", { outcome: "accepted", closedAt: ago(60) });
    await item(5, "Ancient", "done", { outcome: "accepted", closedAt: ago(3 * 24 * 60) });
    const [sub] = await w.q(
      `INSERT INTO claw_work_item_subscriptions (item_id, user_id, owner, repo, number, since, cursor_at)
       VALUES ('kwi_3', 'alice', 'AMD-AGI', 'PrimusClaw', 291, NOW(), NOW()) RETURNING id`,
    );
    for (const [i, kind, dropped] of [[1, "issue_comment", false], [2, "review_comment", false], [3, "check_failed", false], [4, "issue_comment", true]] as const) {
      await w.q(
        `INSERT INTO claw_work_item_github_events (event_id, sub_id, item_id, kind, github_id, dropped_at) VALUES ($1, $2, 'kwi_3', $3, $4, $5)`,
        [`gh:${sub.id}:${i}`, sub.id, kind, String(i), dropped ? new Date() : null],
      );
    }
    const subId = await w.subscribe("alice", ["run.completed", "run.failed", "approval.requested"]);
    const run = (type: string, title: string, id: string) => w.q(
      "INSERT INTO claw_notification_outbox (event_id, subscription_id, payload) VALUES ($1, $2, $3::jsonb)",
      [id, subId, JSON.stringify({ type, title, event_id: id })],
    );
    await run("run.completed", "Daily build", "e1");
    await run("run.completed", "Nightly eval", "e2");
    await run("run.failed", "Nightly eval on mi355", "e3");
    await run("approval.requested", "Approve workload delete", "e4");
    await w.q(
      `INSERT INTO claw_github_confirmations (confirmation_id, session_id, requester_user_id, actor_user_id, repo, pr, head_sha, status, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000001', 'rs', 'alice', 'alice', 'AMD-AGI/PrimusClaw', 300, 'abc', 'pending', NOW() + INTERVAL '1 hour')`,
    );
    await w.q(
      `INSERT INTO claw_assistant_confirmations (confirmation_id, user_id, session_id, message_id, kind, params, dedupe_key, expires_at)
       VALUES ('c1', 'alice', $1, 'm', 'trigger_create', '{"name":"PR 早报","schedule":"0 9 * * *"}', 'd1', NOW() + INTERVAL '1 hour')`,
      [alice.routerSid],
    );
    const [watch] = await w.q(
      `INSERT INTO claw_assistant_job_watches (user_id, source, target, label, last_state) VALUES ('alice', 'workload', 'wl-1', 'train-7b', 'Running') RETURNING id`,
    );
    await w.q("INSERT INTO claw_assistant_job_events (event_id, watch_id, user_id, from_state, to_state) VALUES ('job:1:1', $1, 'alice', 'Pending', 'Running')", [watch.id]);
    workloads = [
      { id: "w-f", name: "eval-failed", phase: "Failed", createdAt: ago(120), kind: "PyTorchJob", userId: "alice" },
      { id: "w-old", name: "old-failure", phase: "Failed", createdAt: ago(3 * 24 * 60), kind: "PyTorchJob", userId: "alice" },
      { id: "w-p", name: "queued-long", phase: "Pending", createdAt: ago(45), kind: "PyTorchJob", userId: "alice" },
      { id: "w-q", name: "queued-now", phase: "Pending", createdAt: ago(5), kind: "PyTorchJob", userId: "alice" },
      { id: "w-r", name: "running-1", phase: "Running", createdAt: ago(300), kind: "PyTorchJob", userId: "alice" },
      { id: "w-s", name: "sandbox", phase: "Failed", createdAt: ago(10), kind: "Sandbox", userId: "alice" },
      { id: "w-b", name: "bobs", phase: "Failed", createdAt: ago(10), kind: "PyTorchJob", userId: "bob" },
    ];
  }

  test("B1 every section is there, built from what Claw holds and what SaFE says of the user's own workloads", async () => {
    await world();
    const b = await brief.composeBrief("alice", { apiKey: "pk-alice", lang: "en", timezone: "Asia/Shanghai", now });
    assert.deepEqual(b.sections.map((s) => s.key), ["items", "pull_requests", "notifications", "jobs", "safe"]);
    assert.ok(b.sections.every((s) => s.checked), JSON.stringify(b.sections));
    const s = Object.fromEntries(b.sections.map((x) => [x.key, x]));
    assert.equal(s.items.summary, "2 need you, 1 in progress, 1 ended in the last day");
    assert.deepEqual(s.items.lines, ["#1 修复登录超时: waiting for your answer: 要不要回滚？", "#2 Bump deps: a result waits for you to accept"]);
    assert.equal(s.pull_requests.summary, "1 watched, 3 new events in the last day", "a dropped event is not news");
    assert.deepEqual(s.pull_requests.lines, ["AMD-AGI/PrimusClaw#291: 2 comments, CI failed"]);
    assert.equal(s.notifications.summary, "2 runs finished, 1 failed, 1 approvals asked; 2 writes wait for your confirmation");
    assert.deepEqual(s.notifications.lines, [
      "failed: Nightly eval on mi355", "waits for you: merge AMD-AGI/PrimusClaw#300", 'waits for you: schedule "PR 早报"',
    ]);
    assert.equal(s.jobs.summary, "1 watched, 1 changes in the last day");
    assert.deepEqual(s.jobs.lines, ["train-7b: Running"]);
    assert.equal(s.safe.summary, "1 failed in the last day, 1 pending for over 30 minutes, 1 running");
    assert.deepEqual(s.safe.lines, ["failed: eval-failed", "pending too long: queued-long"]);
    assert.deepEqual(keys, ["pk-alice"]);
    assert.equal(b.needs_you.length, 3, "at most three, most urgent first");
    assert.equal(b.needs_you[0], "#1 修复登录超时: waiting for your answer: 要不要回滚？");
    const lines = b.text.split("\n");
    assert.match(lines[0], /^Daily brief, \d{4}-\d{2}-\d{2}$/);
    for (const title of ["Items:", "Pull requests:", "Notifications:", "Jobs:", "SaFE:", "Needs you:"]) {
      assert.ok(lines.some((l) => l.startsWith(title)), `${title} in\n${b.text}`);
    }
    const zh = await brief.composeBrief("alice", { apiKey: "pk-alice", lang: "zh", now });
    assert.match(zh.text, /^每日简报 /);
    assert.match(zh.text, /事项：2 个等你，1 个进行中，过去一天结束 1 个/);
  });

  test("B2 a source that cannot be read says so, and the rest stands", async () => {
    await world();
    safeError = new Error("safe_http_502");
    const b = await brief.composeBrief("alice", { apiKey: "pk-alice", lang: "en", now });
    const safe = b.sections.find((x) => x.key === "safe")!;
    assert.equal(safe.checked, false);
    assert.equal(safe.summary, "could not check (SaFE did not answer: safe_http_502)");
    assert.ok(b.sections.filter((x) => x.key !== "safe").every((x) => x.checked));
    const noKey = await brief.composeBrief("alice", { apiKey: null, lang: "en", now });
    assert.equal(noKey.sections.find((x) => x.key === "safe")!.summary, "could not check (no SaFE key of yours)");
    // Claw's own data failing to read is no different: the section whose query fails (its table is gone here) says so, the rest stand.
    safeError = null;
    await w.q("ALTER TABLE claw_assistant_job_watches RENAME TO claw_assistant_job_watches_away");
    try {
      const broken = await brief.composeBrief("alice", { apiKey: "pk-alice", lang: "en", now });
      const jobs = broken.sections.find((x) => x.key === "jobs")!;
      assert.deepEqual([jobs.checked, jobs.summary, jobs.lines], [false, "could not check (error)", []]);
      assert.ok(broken.sections.filter((x) => x.key !== "jobs").every((x) => x.checked), JSON.stringify(broken.sections));
      assert.match(broken.text, /^Jobs: could not check \(error\)$/m);
    } finally {
      await w.q("ALTER TABLE claw_assistant_job_watches_away RENAME TO claw_assistant_job_watches");
    }
    // Nothing anywhere: the brief says so in one line rather than inventing work.
    await w.q("TRUNCATE claw_work_items, claw_work_item_subscriptions, claw_work_item_github_events, claw_notification_outbox, claw_github_confirmations, claw_assistant_confirmations, claw_assistant_job_watches, claw_assistant_job_events CASCADE");
    workloads = [];
    safeError = null;
    const quiet = await brief.composeBrief("alice", { apiKey: "pk-alice", lang: "en", now });
    assert.deepEqual(quiet.needs_you, []);
    assert.equal(quiet.text.split("\n").at(-1), "Nothing needs you today.");
  });

  test("B3 GET /v1/assistant/brief answers the caller's own brief, with their key, in their language", async () => {
    await world();
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, channel_context) VALUES ($1, 'm1', 'alice', '今天怎么样', '{}'::jsonb)`,
      [alice.routerSid],
    );
    const started = Date.now();
    const r = await app.inject({ method: "GET", url: "/v1/assistant/brief", headers: { "x-test-user": "alice" } });
    assert.equal(r.statusCode, 200);
    const data = r.json().data;
    assert.equal(data.lang, "zh", "the language of the user's latest message");
    assert.equal(data.sections.length, 5);
    assert.ok(Date.now() - started < 20_000, "well inside the 20 s a brief may take");
    assert.deepEqual(keys, ["pk-req-alice"], "SaFE is read with the caller's own key");
    const en = await app.inject({ method: "GET", url: "/v1/assistant/brief?lang=en", headers: { "x-test-user": "alice" } });
    assert.equal(en.json().data.lang, "en");
    const bob = await app.inject({ method: "GET", url: "/v1/assistant/brief?lang=en", headers: { "x-test-user": "bob" } });
    assert.equal(bob.json().data.sections[0].summary, "0 need you, 0 in progress, 0 ended in the last day", "bob sees none of alice's");
    assert.equal((await app.inject({ method: "GET", url: "/v1/assistant/brief" })).statusCode, 403);
  });

  test("B5 the router's brief tool answers the brief, and the turn no longer acts for the user after it", async () => {
    await world();
    const turn = await w.routerTurn(alice);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, channel_context) VALUES ($1, $2, 'alice', '给我一份今天的简报', '{}'::jsonb)`,
      [alice.routerSid, turn.mid],
    );
    const out = await brief.briefTool(turn) as Record<string, any>;
    assert.equal(out.lang, "zh");
    assert.equal(out.sections.length, 5);
    assert.match(out.text, /^每日简报 /);
    assert.deepEqual(keys, ["pk-alice"], "SaFE read with the key the user's messages gave the assistant");
    const [m] = await w.q("SELECT untrusted_read_at FROM claw_assistant_messages WHERE message_id = $1", [turn.mid]);
    assert.ok(m.untrusted_read_at, "what others wrote was read: the turn no longer acts for the user");
    await w.q("INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id) VALUES ('kwi_w', 'alice', 9, 'w', 'in_progress', 'ws_w')");
    const worker = { ...turn, role: "worker", item_id: "kwi_w", gen: 1 };
    await assert.rejects(brief.briefTool(worker as never), (err: Error & { code?: string }) => err.code === "not_allowed");
  });

  test("B4 a brief trigger says the brief through the assistant when it fires, once per planned time, with no run", async () => {
    await world();
    await w.subscribe("alice");
    const created = await app.inject({
      method: "POST", url: "/v1/triggers", headers: { "x-test-user": "alice" },
      payload: { name: "Daily brief", action: "brief", schedule: "30 8 * * 1-5", timezone: "Asia/Shanghai" },
    });
    assert.equal(created.statusCode, 200, created.body);
    const t = created.json().data;
    assert.equal(t.action, "brief");
    assert.match(t.prompt, /daily brief/i, "a brief needs no prompt of its own");
    assert.equal((await app.inject({
      method: "POST", url: "/v1/triggers", headers: { "x-test-user": "alice" },
      payload: { name: "x", action: "dance", schedule: "30 8 * * 1-5", timezone: "Asia/Shanghai" },
    })).statusCode, 400);
    // Someone with no assistant: a brief would reach nobody.
    const noAssistant = await app.inject({
      method: "POST", url: "/v1/triggers", headers: { "x-test-user": "carol" },
      payload: { name: "Daily brief", action: "brief", schedule: "30 8 * * 1-5", timezone: "Asia/Shanghai" },
    });
    assert.deepEqual([noAssistant.statusCode, noAssistant.json().error], [400, "brief_needs_assistant"]);

    const planned = new Date(Date.now() - 30_000);
    await w.q("UPDATE claw_triggers SET next_fire_at = $2 WHERE trigger_id = $1", [t.trigger_id, planned]);
    const sched = await import("../src/triggers/scheduler.js");
    await sched.tickTriggers(new Date());
    assert.equal(dispatched.length, 0, "no run is started for a brief");
    const said = await w.q("SELECT text, fallback FROM claw_assistant_says WHERE user_id = 'alice'");
    assert.equal(said.length, 1);
    assert.equal(said[0].fallback, true);
    assert.match(said[0].text, /^Daily brief, /);
    assert.match(said[0].text, /Items: 2 need you/);
    assert.deepEqual(keys, ["pk-req-alice"], "SaFE read with the key the trigger keeps");
    const [fired] = await w.q("SELECT status, session_id FROM claw_trigger_fires WHERE trigger_id = $1", [t.trigger_id]);
    assert.deepEqual(fired, { status: "delivered", session_id: null });
    const [after] = await w.q("SELECT runs, consecutive_failures, paused_reason FROM claw_triggers WHERE trigger_id = $1", [t.trigger_id]);
    assert.deepEqual(after, { runs: 1, consecutive_failures: 0, paused_reason: null });
    const outbox = await w.q("SELECT payload FROM claw_notification_outbox WHERE payload->>'type' = 'assistant.say'");
    assert.equal(outbox.length, 1, "it goes out to the user's channel");

    // The same planned time again (a replica that lost the race): nothing more is said.
    const fire = await import("../src/triggers/fire.js");
    const row = (await w.q("SELECT * FROM claw_triggers WHERE trigger_id = $1", [t.trigger_id]))[0];
    assert.deepEqual(await fire.fireBriefTrigger(row as never, planned), { status: "delivered" });
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_says"))[0].n, 1);

    // An owner with no assistant: nothing to say it through.
    await w.q("DELETE FROM claw_assistants WHERE user_id = 'alice'");
    const out = await fire.fireBriefTrigger(row as never, new Date());
    assert.deepEqual(out, { status: "failed_start", detail: "no_assistant", credentialInvalid: false });
  });

  test("B6 a user at their daily run limit still gets the brief: it starts no run", async () => {
    await world();
    await w.subscribe("alice");
    const make = async (payload: Record<string, unknown>) => {
      const r = await app.inject({ method: "POST", url: "/v1/triggers", headers: { "x-test-user": "alice" }, payload });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().data.trigger_id as string;
    };
    const briefId = await make({ name: "Daily brief", action: "brief", schedule: "30 8 * * 1-5", timezone: "Asia/Shanghai" });
    const runId = await make({ name: "Daily check", prompt: "Check my open pull requests.", schedule: "0 9 * * *", timezone: "UTC" });
    // As many runs in the last day as a user may have.
    const { TRIGGER_DAILY_LIMIT_PER_USER } = await import("../src/config.js");
    await w.q(
      `INSERT INTO claw_trigger_fires (trigger_id, fire_key, owner_user_id, session_id, status, fired_at)
       SELECT 'earlier', 'k' || i, 'alice', 'sess-' || i, 'started', NOW() - INTERVAL '1 hour' FROM generate_series(1, $1) AS i`,
      [TRIGGER_DAILY_LIMIT_PER_USER],
    );
    await w.q("UPDATE claw_triggers SET next_fire_at = $1", [new Date(Date.now() - 30_000)]);
    const sched = await import("../src/triggers/scheduler.js");
    await sched.tickTriggers(new Date());
    const fired = Object.fromEntries((await w.q(
      "SELECT trigger_id, status, detail FROM claw_trigger_fires WHERE trigger_id = ANY($1)", [[briefId, runId]],
    )).map((r) => [r.trigger_id, [r.status, r.detail]]));
    assert.deepEqual(fired[runId], ["skipped_quota", "daily_limit"], "the limit is reached for a run");
    assert.deepEqual(fired[briefId], ["delivered", null], "the brief is said all the same");
    assert.equal(dispatched.length, 0);
    const said = await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice'");
    assert.equal(said.length, 1);
    assert.match(said[0].text, /^Daily brief, /);
  });
});
