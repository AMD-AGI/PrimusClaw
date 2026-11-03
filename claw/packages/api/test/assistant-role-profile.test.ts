// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn of an assistant session as Brain receives it, through the three places a turn's request is finished
 * (the fat dispatch, a queued message replayed, and a doorbell claimed), over a real Postgres. Skipped without
 * DATABASE_URL, and a skip is not a pass.
 *
 *   A1  a router turn is cut to the assistant tools, kept short, and carries a bearer naming its own run
 *   A2  a doorbell router turn is given all of that at the claim, and the row holds none of it
 *   A3  a queued router message replayed on the wire is given it after its run exists, so the bearer names that run
 *   A4  a worker turn gets its prompt, its item and the generation it started under, and keeps what the request brought
 *   A5  a session that is not an assistant's is left exactly as it was, whatever route its turn takes
 *   A6  a server named assistant in a request cannot stand in for ours, and a router drops every other server
 *   A7  a router turn does not select skills; a worker's and an ordinary session's do
 *   A8  a turn whose profile cannot be applied does not run
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant role profile", { skip }, () => {
  let w: World;
  let dispatch: typeof import("../src/sessions/dispatch.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };
  let item: { itemId: string; seq: number; workerSid: string };
  const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });

  before(async () => {
    w = await startWorld({ CLAW_SKILL_EVOLUTION_ENABLED: "true", MAX_SELECTED_SKILLS: "1" });
    dispatch = await import("../src/sessions/dispatch.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_skills CASCADE");
    alice = await w.user("alice");
    bob = await w.user("bob");
    item = await w.createItem(alice, "Fix the build");
    await w.q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('plain', 'a chat', 'alice', 'claw')");
    await w.q("DELETE FROM claw_tasks");
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL");
  });

  const verify = (task: any) => {
    const server = task.mcp_servers?.assistant;
    assert.ok(server, "the assistant server is configured");
    assert.equal(server.type, "http");
    assert.match(server.url, /\/v1\/internal\/assistant-mcp$/);
    const verdict = w.mod.token.verifyAssistantToken(server.token, TOKEN_KEY);
    assert.ok(verdict.ok, JSON.stringify(verdict));
    return (verdict as { ok: true; claims: any }).claims;
  };

  const pristineDispatch = (() => { let p: any = null; return () => (p ??= { ...dispatch.sessionDispatchPorts }); })();
  async function send(sessionId: string, userId: string, opts: { doorbell: boolean; mcpServers?: Record<string, Record<string, unknown>>; toolIds?: number[] }) {
    const p = dispatch.sessionDispatchPorts as any;
    Object.assign(p, pristineDispatch());
    p.doorbellDispatch = opts.doorbell ? () => ({ release() {} }) : () => null;
    p.publishSse = () => {};
    p.admit = async () => ({ kind: "admit" });
    const published: string[] = [];
    p.publishTask = async (_s: string, payload: string) => { published.push(payload); return published.length; };
    await w.q("DELETE FROM claw_tasks WHERE session_id = $1", [sessionId]);
    const result = await dispatch.dispatchTaskToBrain({
      sessionId, userId, user: user(userId), content: "hello", messageType: "text", toolIds: opts.toolIds ?? [], pluginId: undefined,
      requestImage: undefined, requestResource: undefined, requestTimeout: undefined, workspaceId: undefined,
      mcpServers: opts.mcpServers, capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
    } as never, async () => {});
    assert.equal(result.kind, "dispatched", JSON.stringify(result));
    return { result: result as { runId: string }, published };
  }
  async function claim(): Promise<any> {
    const runClaim = await import("../src/tasks/run-claim.js");
    runClaim.runClaimPorts.buildHistory = async () => [];
    const { DOORBELL_SEMANTICS_VERSION } = await import("@claw/protocol");
    const claimed = await runClaim.claimNextRun("brain-claim", DOORBELL_SEMANTICS_VERSION);
    assert.ok(claimed, "a queued doorbell row was claimed");
    return claimed!.request;
  }
  /** The queue's replay with everything that leaves the process stubbed; `restore` puts it back. */
  async function stubPending() {
    const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
    const original = { ...pendingDispatchPorts };
    const realQuery = w.h.app.db.db.query.bind(w.h.app.db.db);
    const published: string[] = [];
    const runId = `ktsk_replay_${Math.random().toString(36).slice(2, 8)}`;
    Object.assign(pendingDispatchPorts, {
      doorbellDispatch: () => null,
      admit: async () => ({ kind: "admit" }),
      bindWorkspace: async () => "kws_1",
      requireWorkspaceBinding: (x?: string) => x as string,
      publishSessionEvent: async () => {},
      openChatRun: async () => ({ taskId: runId, workspaceId: "kws_1", lease: { url: "http://api/lease", token: "t" } }),
      publish: async (_s: string, payload: string) => { published.push(payload); return published.length; },
    });
    const statements: string[] = [];
    (w.h.app.db.db as any).query = async (text: string, params: unknown[] = []) => {
      statements.push(text);
      return /SET dispatch_task_id = COALESCE/.test(text) ? { rows: [{ dispatch_task_id: params[1] }], rowCount: 1 }
        : /UPDATE claw_tasks/.test(text) ? { rows: [], rowCount: 1 }
        : realQuery(text, params);
    };
    return {
      published, runId, statements,
      restore() { (w.h.app.db.db as any).query = realQuery; Object.assign(pendingDispatchPorts, original); },
    };
  }
  async function replayed(sessionId: string, userId: string, mcpServers?: Record<string, Record<string, unknown>>) {
    const { dispatchPendingMessage } = await import("../src/tasks/pending-dispatch.js");
    const stub = await stubPending();
    try {
      await dispatchPendingMessage({
        sessionId, pendingId: 1, userId, messageId: "claw-pending-1", prompt: "later",
        task: { session_id: sessionId, message_id: "claw-pending-1", prompt: "later", mcp_servers: mcpServers },
      });
    } finally { stub.restore(); }
    assert.equal(stub.published.length, 1);
    return { task: JSON.parse(stub.published[0]!), runId: stub.runId };
  }

  test("A1 a router turn is cut to the assistant tools and carries a bearer naming its own run", async () => {
    const { published, result } = await send(alice.routerSid, "alice", { doorbell: false });
    const task = JSON.parse(published[0]);
    assert.deepEqual(task.tools_allowlist, ["mcp__assistant__*"]);
    assert.equal(task.max_turns, 8);
    assert.deepEqual(Object.keys(task.mcp_servers), ["assistant"]);
    const claims = verify(task);
    assert.deepEqual({ sid: claims.sid, role: claims.role, task_id: claims.task_id, mid: claims.mid }, {
      sid: alice.routerSid, role: "router", task_id: result.runId, mid: task.message_id,
    });
    assert.equal(task.task_id, result.runId);
    assert.ok(claims.exp > Math.floor(Date.now() / 1000) + 3600, "outlives the longest turn the row allows");
    assert.ok(task.system_append.startsWith("You are the user's personal assistant."));
    assert.match(task.system_append, /Work items \(open ones[^)]*\):\n#1 \[in_progress\] Fix the build/);
    assert.equal(task.skills, undefined);
  });

  test("A1c marketplace tools a message named are not resolved for a router, and are for a worker", async () => {
    const router = JSON.parse((await send(alice.routerSid, "alice", { doorbell: false, toolIds: [7] })).published[0]);
    assert.equal(router.tool_ids, undefined);
    const worker = JSON.parse((await send(item.workerSid, "alice", { doorbell: false, toolIds: [7] })).published[0]);
    assert.deepEqual(worker.tool_ids, [7]);
  });

  test("A1b the item list is the user's own", async () => {
    await w.createItem(bob, "Bob's secret project");
    const task = JSON.parse((await send(alice.routerSid, "alice", { doorbell: false })).published[0]);
    assert.match(task.system_append, /Fix the build/);
    assert.doesNotMatch(task.system_append, /Bob's secret/);
  });

  test("A2 a doorbell router turn is given its profile at the claim, and the row holds none of it", async () => {
    const { result } = await send(alice.routerSid, "alice", { doorbell: true });
    const row = (await w.q("SELECT input FROM claw_tasks WHERE task_id = $1", [result.runId]))[0].input;
    const stored = JSON.stringify(row);
    for (const absent of ["tools_allowlist", "assistant-mcp", "personal assistant", '"max_turns"']) {
      assert.ok(!stored.includes(absent), `the row must not hold ${absent}`);
    }
    // An item made after the send and before the claim is in the list the turn is given: the list is the claim's.
    await w.createItem(alice, "Added while it waited");
    const request = await claim();
    assert.deepEqual(request.tools_allowlist, ["mcp__assistant__*"]);
    assert.equal(request.max_turns, 8);
    const claims = verify(request);
    assert.equal(claims.task_id, result.runId, "the bearer names the claimed run");
    assert.equal(claims.task_id, request.task_id);
    assert.match(request.system_append, /#2 \[in_progress\] Added while it waited/);
  });

  test("A3 a queued router message replayed on the wire is profiled after its run is opened", async () => {
    const { task, runId } = await replayed(alice.routerSid, "alice");
    assert.deepEqual(task.tools_allowlist, ["mcp__assistant__*"]);
    assert.equal(verify(task).task_id, runId, "the run opened for the replay, not the absence of one");
    assert.equal(verify(task).mid, "claw-pending-1");
  });

  test("A4 a worker turn is given its prompt, its item and the generation it started under", async () => {
    const first = JSON.parse((await send(item.workerSid, "alice", { doorbell: false, mcpServers: { mine: { type: "http", url: "http://m/mcp", token: "t" } } })).published[0]);
    const claims = verify(first);
    assert.deepEqual({ role: claims.role, item: claims.item_id, gen: claims.gen, sid: claims.sid }, { role: "worker", item: item.itemId, gen: 1, sid: item.workerSid });
    assert.equal(first.tools_allowlist, undefined, "a worker keeps every tool");
    assert.equal(first.max_turns, undefined);
    assert.deepEqual(Object.keys(first.mcp_servers).sort(), ["assistant", "mine"]);
    assert.match(first.system_append, /You are a worker on one work item/);
    assert.match(first.system_append, /item #1: Fix the build$/);
    assert.equal((await w.item(item.itemId)).generation, 1);

    await w.q("UPDATE claw_tasks SET status = 'completed' WHERE session_id = $1", [item.workerSid]);
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [item.workerSid]);
    const second = JSON.parse((await send(item.workerSid, "alice", { doorbell: false })).published[0]);
    assert.equal(verify(second).gen, 2, "a new run is a new generation");
    const viaReplay = await replayed(item.workerSid, "alice");
    assert.equal(verify(viaReplay.task).gen, 3);
    const done = await w.item(item.itemId);
    assert.equal(done.generation, 3);
  });

  test("A4b a doorbell worker turn fixes its generation at the claim, and a re-claim of the run keeps it", async () => {
    const { result } = await send(item.workerSid, "alice", { doorbell: true });
    assert.equal((await w.item(item.itemId)).generation, 0, "nothing runs until the claim");
    const request = await claim();
    assert.equal(verify(request).gen, 1);
    assert.equal(verify(request).task_id, result.runId);
    await w.mod.runStarted.startWorkerRun(item.workerSid, result.runId);
    assert.equal((await w.item(item.itemId)).generation, 1, "the same run again is the same generation");
  });

  test("A5 a session that is not an assistant's is left as it was", async () => {
    const mine = { mine: { type: "http", url: "http://m/mcp", token: "t" } };
    for (const doorbell of [false, true]) {
      const { published } = await send("plain", "alice", { doorbell, mcpServers: mine });
      const task = doorbell ? await claim() : JSON.parse(published[0]);
      for (const key of ["tools_allowlist", "max_turns", "system_append"]) assert.equal(task[key], undefined, `${key} (doorbell=${doorbell})`);
      assert.deepEqual(Object.keys(task.mcp_servers ?? {}), ["mine"]);
      await w.q("DELETE FROM claw_tasks");
    }
    const { task } = await replayed("plain", "alice", mine);
    assert.equal(task.tools_allowlist, undefined);
    assert.deepEqual(Object.keys(task.mcp_servers), ["mine"]);
    const bare: Record<string, unknown> = { task_id: "ktsk_1", message_id: "m" };
    await w.mod.role.applySessionRoleToTask(bare, "plain");
    assert.deepEqual(bare, { task_id: "ktsk_1", message_id: "m" });
  });

  test("A6 a server named assistant in the request cannot stand in for ours, and a router drops the rest", async () => {
    const hostile = { assistant: { type: "http", url: "http://evil.example/mcp", token: "t" }, other: { type: "sse", url: "http://o/sse" } };
    const router = JSON.parse((await send(alice.routerSid, "alice", { doorbell: false, mcpServers: hostile })).published[0]);
    assert.deepEqual(Object.keys(router.mcp_servers), ["assistant"]);
    assert.match(router.mcp_servers.assistant.url, /\/v1\/internal\/assistant-mcp$/);
    const worker = JSON.parse((await send(item.workerSid, "alice", { doorbell: false, mcpServers: hostile })).published[0]);
    assert.deepEqual(Object.keys(worker.mcp_servers).sort(), ["assistant", "other"]);
    assert.match(worker.mcp_servers.assistant.url, /\/v1\/internal\/assistant-mcp$/);
    assert.doesNotMatch(JSON.stringify(worker), /evil\.example/);
  });

  test("A7 a router turn does not select skills; a worker's and an ordinary session's do", async () => {
    await w.q(
      `INSERT INTO claw_skills (user_id, skill_name, version, content, status)
       VALUES ('alice', 'skill-a', 1, 'c', 'active'), ('alice', 'skill-b', 1, 'c', 'active')`,
    );
    const realQuery = w.h.app.db.db.query.bind(w.h.app.db.db);
    const seen: string[] = [];
    (w.h.app.db.db as any).query = async (text: string, params?: unknown[]) => { seen.push(text); return realQuery(text, params); };
    const asked = async (sessionId: string) => {
      seen.length = 0;
      await send(sessionId, "alice", { doorbell: false });
      return seen.some((s) => /FROM claw_skills/.test(s));
    };
    try {
      assert.equal(await asked(alice.routerSid), false, "the router never asks for skills");
      assert.equal(await asked(item.workerSid), true);
      assert.equal(await asked("plain"), true);
    } finally { (w.h.app.db.db as any).query = realQuery; }
    assert.equal(await w.mod.role.skipsSkillSelection(alice.routerSid), true);
    assert.equal(await w.mod.role.skipsSkillSelection(item.workerSid), false);
    assert.equal(await w.mod.role.skipsSkillSelection("plain"), false);
  });

  test("A7b the queue's drain makes the same choice for a message that waited", async () => {
    await w.q(
      `INSERT INTO claw_skills (user_id, skill_name, version, content, status)
       VALUES ('alice', 'skill-a', 1, 'c', 'active'), ('alice', 'skill-b', 1, 'c', 'active')`,
    );
    const { drainOldestPendingMessage } = await import("../src/events/consumer.js");
    const drained = async (sessionId: string) => {
      await w.q("DELETE FROM claw_pending_messages");
      await w.q(
        "INSERT INTO claw_pending_messages (session_id, user_id, content, platform_key, llm_api_key) VALUES ($1, 'alice', 'what is the status?', 'pk-alice', 'vk-alice')",
        [sessionId],
      );
      const stub = await stubPending();
      try { await drainOldestPendingMessage(sessionId, "alice"); } finally { stub.restore(); }
      return { askedForSkills: stub.statements.some((s) => /FROM claw_skills/.test(s)), published: stub.published.map((p) => JSON.parse(p)) };
    };
    const router = await drained(alice.routerSid);
    assert.equal(router.askedForSkills, false);
    assert.equal(router.published.length, 1);
    assert.deepEqual(router.published[0].tools_allowlist, ["mcp__assistant__*"]);
    assert.equal((await drained("plain")).askedForSkills, true);
  });

  test("A8 a turn whose profile cannot be applied does not run", async () => {
    // A router turn without the run it belongs to would run with every tool Brain has: refuse, never skip.
    await assert.rejects(w.mod.role.applySessionRoleToTask({ message_id: "m" }, alice.routerSid), /without_run_identity/);
    await assert.rejects(w.mod.role.applySessionRoleToTask({ task_id: "t" }, alice.routerSid), /without_run_identity/);
    await assert.rejects(w.mod.role.applySessionRoleToTask({ task_id: "t" }, item.workerSid), /without_run_identity/);
  });
});
