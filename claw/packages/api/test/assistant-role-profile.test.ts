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
 *   A5  a session that is not an assistant's gets the working guideline and nothing else, whatever route its turn takes
 *   A6  a server named assistant in a request cannot stand in for ours, and a router drops every other server
 *   A7  a router turn does not select skills; a worker's and an ordinary session's do
 *   A8  a turn whose profile cannot be applied does not run
 *   A9  a router turn's message carries the reply-language line on every route, and what is stored is the user's words
 *   A9c the same turn once it has completed: the conversation holds the user's words, not the request Brain ran
 *   A10 a worker's report that wakes the router carries the language the user last wrote in, and nothing when none is known
 *   A11 the router's item list names each item by its id and its number, and a report's header does as well
 *
 * With the working guideline on (`CLAW_AGENT_GUIDELINE_ENABLED`): a worker's system text starts with it and a
 * router's never holds it (A1, A4).
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type World } from "./support/assistant-world.js";
import { AGENT_GUIDELINE } from "../src/sessions/agent-guideline.js";

const skip = postgresSkipReason();

describe("assistant role profile", { skip }, () => {
  let w: World;
  let dispatch: typeof import("../src/sessions/dispatch.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };
  let item: { itemId: string; seq: number; workerSid: string };
  const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });

  before(async () => {
    w = await startWorld({ CLAW_SKILL_EVOLUTION_ENABLED: "true", MAX_SELECTED_SKILLS: "1", CLAW_AGENT_GUIDELINE_ENABLED: "true" });
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
  async function send(sessionId: string, userId: string, opts: { doorbell: boolean; mcpServers?: Record<string, Record<string, unknown>>; toolIds?: number[]; content?: string }) {
    const p = dispatch.sessionDispatchPorts as any;
    Object.assign(p, pristineDispatch());
    p.doorbellDispatch = opts.doorbell ? () => ({ release() {} }) : () => null;
    p.publishSse = () => {};
    p.admit = async () => ({ kind: "admit" });
    const published: string[] = [];
    p.publishTask = async (_s: string, payload: string) => { published.push(payload); return published.length; };
    await w.q("DELETE FROM claw_tasks WHERE session_id = $1", [sessionId]);
    const result = await dispatch.dispatchTaskToBrain({
      sessionId, userId, user: user(userId), content: opts.content ?? "hello", messageType: "text", toolIds: opts.toolIds ?? [], pluginId: undefined,
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
    assert.ok(!task.system_append.includes(AGENT_GUIDELINE), "a router only dispatches: the working guideline is not its");
    assert.match(task.system_append, new RegExp(`Work items \\(open ones[^)]*\\):\\n.*\\n<untrusted_data>\\n#1 \\(item_id: ${item.itemId}\\) \\[in_progress\\] title: "Fix the build"`));
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
    assert.match(request.system_append, /#2 \(item_id: kwi_\w+\) \[in_progress\] title: "Added while it waited"/);
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
    assert.ok(first.system_append.startsWith(`${AGENT_GUIDELINE}\n\n`), "a worker does the user's work, under the working guideline");
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

  test("A5 a session that is not an assistant's gets the working guideline and nothing else", async () => {
    const mine = { mine: { type: "http", url: "http://m/mcp", token: "t" } };
    for (const doorbell of [false, true]) {
      const { published } = await send("plain", "alice", { doorbell, mcpServers: mine });
      const task = doorbell ? await claim() : JSON.parse(published[0]);
      for (const key of ["tools_allowlist", "max_turns"]) assert.equal(task[key], undefined, `${key} (doorbell=${doorbell})`);
      assert.equal(task.system_append, AGENT_GUIDELINE, `doorbell=${doorbell}`);
      assert.deepEqual(Object.keys(task.mcp_servers ?? {}), ["mine"]);
      await w.q("DELETE FROM claw_tasks");
    }
    const { task } = await replayed("plain", "alice", mine);
    assert.equal(task.tools_allowlist, undefined);
    assert.equal(task.system_append, AGENT_GUIDELINE);
    assert.deepEqual(Object.keys(task.mcp_servers), ["mine"]);
    const bare: Record<string, unknown> = { task_id: "ktsk_1", message_id: "m" };
    await w.mod.role.applySessionRoleToTask(bare, "plain");
    assert.deepEqual(bare, { task_id: "ktsk_1", message_id: "m", system_append: AGENT_GUIDELINE });
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

  test("A9 the router's message carries the reply-language line on every route, and what is stored is the user's words", async () => {
    const english = "Can you check why the nightly build is red?";
    const chinese = "帮我看一下 staging 为什么一直重启";
    const line = (language: string) => `\n\n[Reply language: ${language}]`;

    // The fat dispatch: the line is on the request, and the run row and the history keep the words as they were sent.
    for (const [content, language] of [[english, "English"], [chinese, "Chinese"]] as const) {
      const { result, published } = await send(alice.routerSid, "alice", { doorbell: false, content });
      const task = JSON.parse(published[0]);
      assert.equal(task.prompt, `${content}${line(language)}`);
      const [row] = await w.q("SELECT prompt, input FROM claw_tasks WHERE task_id = $1", [result.runId]);
      assert.equal(row.prompt, content, "the run row holds the user's words");
      assert.ok(!JSON.stringify(row.input).includes("Reply language"));
      assert.equal(task.history.at(-1).content, content, "and so does the history Brain is given");
    }

    // The doorbell claim.
    const { result } = await send(alice.routerSid, "alice", { doorbell: true, content: chinese });
    const [stored] = await w.q("SELECT prompt, input FROM claw_tasks WHERE task_id = $1", [result.runId]);
    assert.ok(!JSON.stringify(stored).includes("Reply language"), "the row holds none of it");
    assert.equal((await claim()).prompt, `${chinese}${line("Chinese")}`);
    await w.q("DELETE FROM claw_tasks");

    // The queue's replay.
    const { dispatchPendingMessage } = await import("../src/tasks/pending-dispatch.js");
    const stub = await stubPending();
    try {
      await dispatchPendingMessage({
        sessionId: alice.routerSid, pendingId: 1, userId: "alice", messageId: "claw-pending-1", prompt: english,
        task: { session_id: alice.routerSid, message_id: "claw-pending-1", prompt: english },
      });
    } finally { stub.restore(); }
    assert.equal(JSON.parse(stub.published[0]!).prompt, `${english}${line("English")}`);
  });

  test("A9c when the turn completes, the conversation holds the user's words and none of the reply-language line, on every route", async () => {
    const english = "Can you check why the nightly build is red?";
    const chinese = "帮我看一下 staging 为什么一直重启";
    const line = /\[Reply language/;
    // What Brain does with the request it was given: runs it, and echoes its prompt in the completion event.
    const completeAsBrain = async (request: { prompt: string; message_id: string }, answer: string) => {
      assert.match(request.prompt, line, "the request Brain ran does carry the line");
      await w.mod.consumer.recordCompletionTurns(
        alice.routerSid,
        { type: "exec_complete", session_id: alice.routerSid, message_id: request.message_id, prompt: request.prompt, final_text: answer, failed: false },
        request.message_id,
      );
    };
    const stored = async () => (await w.q(
      "SELECT role, content FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL ORDER BY turn_index", [alice.routerSid],
    )).map((r) => [r.role, r.content]);
    const reset = async () => { await w.q("DELETE FROM claw_conversation_turns"); await w.q("DELETE FROM claw_tasks"); };

    // The fat dispatch, then the next message: the history Brain is given for it is the user's words as sent.
    for (const [content, language] of [[english, "English"], [chinese, "Chinese"]] as const) {
      await reset();
      const { published } = await send(alice.routerSid, "alice", { doorbell: false, content });
      const request = JSON.parse(published[0]);
      assert.ok(request.prompt.endsWith(`[Reply language: ${language}]`));
      await completeAsBrain(request, "On it.");
      assert.deepEqual(await stored(), [["user", content], ["assistant", "On it."]], `fat dispatch, ${language}`);
      const next = JSON.parse((await send(alice.routerSid, "alice", { doorbell: false, content: "ok" })).published[0]);
      assert.deepEqual(next.history.map((m: any) => [m.role, m.content]), [["user", content], ["assistant", "On it."], ["user", "ok"]], "what Brain is given as history");
      assert.ok(!JSON.stringify(next.history).match(line));
    }

    // The doorbell claim.
    await reset();
    await send(alice.routerSid, "alice", { doorbell: true, content: chinese });
    await completeAsBrain(await claim(), "好的");
    assert.deepEqual(await stored(), [["user", chinese], ["assistant", "好的"]], "doorbell claim");

    // The queue's replay, with its run row opened as it is in production, and the row of an earlier turn beside it:
    // the words are those of the turn that completed.
    await reset();
    await w.q(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, prompt, metadata)
       VALUES ('ktsk_earlier', $1, 'earlier', 'succeeded', 'chat', 'an earlier question', '{"message_id": "claw-earlier-1"}'::jsonb)`,
      [alice.routerSid],
    );
    const { dispatchPendingMessage, pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
    const { openChatRun } = await import("../src/tasks/chat-run.js");
    const stub = await stubPending();
    let request: any;
    try {
      pendingDispatchPorts.openChatRun = ((input: Parameters<typeof openChatRun>[0]) => openChatRun({ ...input, recordWorkspaceUse: false })) as never;
      await dispatchPendingMessage({
        sessionId: alice.routerSid, pendingId: 1, userId: "alice", messageId: "claw-pending-2", prompt: english,
        task: { session_id: alice.routerSid, message_id: "claw-pending-2", prompt: english },
      });
      request = JSON.parse(stub.published[0]!);
    } finally { stub.restore(); }
    const [row] = await w.q("SELECT prompt FROM claw_tasks WHERE session_id = $1 AND metadata->>'message_id' = 'claw-pending-2'", [alice.routerSid]);
    assert.equal(row?.prompt, english, "the replayed turn has its run row, holding the user's words");
    await completeAsBrain(request, "On it.");
    assert.deepEqual(await stored(), [["user", english], ["assistant", "On it."]], "queue replay");

    // A run with no row has only the event's copy of the prompt, which is then what is stored.
    await reset();
    await w.mod.consumer.recordCompletionTurns(
      alice.routerSid, { type: "exec_complete", message_id: "no-row", prompt: "no row for this one", final_text: "fine", failed: false }, "no-row",
    );
    assert.deepEqual(await stored(), [["user", "no row for this one"], ["assistant", "fine"]]);
  });

  test("A9b a message that shows no language gets no line of its own; a worker's and a plain session's get none", async () => {
    const task = JSON.parse((await send(alice.routerSid, "alice", { doorbell: false, content: "#1" })).published[0]);
    assert.equal(task.prompt, "#1", "nothing to go on, and nobody wrote before");
    for (const sessionId of [item.workerSid, "plain"]) {
      const sent = JSON.parse((await send(sessionId, "alice", { doorbell: false, content: "Can you check why the nightly build is red?" })).published[0]);
      assert.equal(sent.prompt, "Can you check why the nightly build is red?", sessionId);
    }
  });

  test("A10 a report that wakes the router carries the language the user last wrote in", async () => {
    const turn = async (content: string, prompt: string) => {
      await w.q("INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, message_id) VALUES ($1, (SELECT COALESCE(MAX(turn_index), 0) + 1 FROM claw_conversation_turns WHERE session_id = $1), $2, $3, $4)", [alice.routerSid, prompt, content, `m-${Math.random()}`]);
    };
    const report = `[work_event] #1 (item_id: ${item.itemId}) ready v1: Opened PR 12 for the build, and it is ready to review`;
    const prompt = async () => JSON.parse((await send(alice.routerSid, "alice", { doorbell: false, content: report })).published[0]).prompt;

    assert.equal(await prompt(), report, "a user who has written nothing has no language to name");

    await turn("帮我把 CI 修好", "user");
    await turn("[work_event] #1 (item_id: x) blocked: which org should the runners be in?", "user");
    await turn("Sure, thanks!", "assistant");
    assert.equal(await prompt(), `${report}\n\n[Reply language: Chinese]`, "the report is English, the user's words are not");

    await turn("ok", "user");
    assert.equal(await prompt(), `${report}\n\n[Reply language: Chinese]`, "a message that shows nothing is passed over");

    await turn("Please keep going", "user");
    assert.equal(await prompt(), `${report}\n\n[Reply language: English]`, "the newest of the user's words that has one");

    await turn("Bonjour, peux-tu corriger le build s'il te plaît ?", "user");
    assert.equal(await prompt(), report, "words in a language that cannot be named are the newest words: no line, not the English before them");

    await turn("ok", "user");
    assert.equal(await prompt(), report, "and a message that shows nothing does not look past them");
  });

  test("A11 the item list names each item by its id and its number", async () => {
    const second = await w.createItem(alice, "Second item");
    const task = JSON.parse((await send(alice.routerSid, "alice", { doorbell: false })).published[0]);
    for (const i of [item, second]) {
      assert.ok(task.system_append.includes(`#${i.seq} (item_id: ${i.itemId}) [in_progress]`), `#${i.seq} with its id`);
    }
    assert.match(task.system_append, /Wherever a tool takes item_id, pass the item_id shown beside the item/);
    assert.match(task.system_append, /without a say in the same step, wait for their results, and only then call say/);
  });

  test("A8 a turn whose profile cannot be applied does not run", async () => {
    // A router turn without the run it belongs to would run with every tool Brain has: refuse, never skip.
    await assert.rejects(w.mod.role.applySessionRoleToTask({ message_id: "m" }, alice.routerSid), /without_run_identity/);
    await assert.rejects(w.mod.role.applySessionRoleToTask({ task_id: "t" }, alice.routerSid), /without_run_identity/);
    await assert.rejects(w.mod.role.applySessionRoleToTask({ task_id: "t" }, item.workerSid), /without_run_identity/);
  });
});
