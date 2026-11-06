// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router answers a question itself when a read-only tool can, its worker runs with the assistant's plugin, an answer closes its
 * item with nothing to accept, and a router turn's request keeps what comes before the message the same from turn to turn, over a
 * real Postgres. Skipped without DATABASE_URL, and a skip is not a pass. The deployment's assistant plugin is 9, as on the site.
 *
 *   RT1 of a plugin, a router gets only the MCP servers listed as read-only, cut to their read tools, and the reply-style rule; no
 *       skill, other rule or write tool
 *   RT2 a router turn of the user asking "autopilot现在有几台节点": offered the autopilot read tools, told to answer itself, and given
 *       neither the deployment's defaults (no skill list after the message) nor a skill of the plugin
 *   RT3 the system prompt and the history before the message are the same on two turns between which an item was made; the item
 *       list, which did change, goes with the message
 *   RT4 only the deployment's plugin gives the router read tools: not one the message named, nor one the user cannot see
 *   RT5 work_create records the plugin and every message to the worker carries it; drained, the worker's turn has the whole plugin
 *   RT6 a worker's answer closes its item as answered, wakes the router with it, and leaves nothing to accept
 *   RT7 a router's history is its last 40 to 59 turns, from a start that moves every 20 turns and is always the user's turn
 *   RT8 an answer the router never said is said by the silent sweep, whole; one the router said with its item is not said again
 *   RT9 a router turn diagnoses a failure itself: SaFE's logs, events and capacity are offered, and its log reads go to Brain as
 *       `log_reads` (bounded to their last lines, masked); the board's notifications and milestones are offered too
 *   RT10 a router turn keeps the turn's own scheduled-tasks server and may only list with it; a `schedules` entry the request carried
 *       otherwise (another address, a bearer for another turn) is dropped
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const PLUGIN = 9;
const QUESTION = "autopilot现在有几台节点";

/** What the deployment's plugin 9 holds, in shape: skills, a rule, and five MCP servers with read and write tools. */
const TOOL_ROWS: Array<{ id: number; type: string; name: string; config: Record<string, unknown> }> = [
  { id: 2, type: "skill", name: "primus-platform", config: { s3_key: "plugins/2/", is_prefix: true } },
  { id: 8, type: "skill", name: "autopilot", config: { s3_key: "plugins/8/", is_prefix: true } },
  { id: 17, type: "rule", name: "teams-reply-style", config: { s3_key: "plugins/17/", is_prefix: true } },
  { id: 21, type: "rule", name: "some-other-rule", config: { s3_key: "plugins/21/", is_prefix: true } },
  { id: 3, type: "mcp", name: "safe-mcp", config: { mcpServers: { safe: { type: "http", url: "https://safe.example/mcp", token: "<SAFE_API_KEY>", requires_approval: ["node_cordon"] } } } },
  { id: 26, type: "mcp", name: "autopilot-mcp", config: { mcpServers: { autopilot: { type: "http", url: "https://autopilot.example/mcp", token: "<SAFE_API_KEY>", auto_approve: ["get_*"], requires_approval: true } } } },
  { id: 18, type: "mcp", name: "dispatron-mcp", config: { mcpServers: { dispatron: { type: "http", url: "https://dispatron.example/mcp", token: "<SAFE_API_KEY>" } } } },
  { id: 40, type: "mcp", name: "unlisted-mcp", config: { mcpServers: { scratchpad: { type: "http", url: "https://scratch.example/mcp" } }, bash_approval: { rules: [] } } },
];

/** Brain's matching (`tools/allowlist.ts`): an exact name, or a prefix before a trailing `*`. */
const allows = (list: string[], name: string) => list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

describe("assistant router read tools", { skip }, () => {
  let w: World;
  let dispatch: typeof import("../src/sessions/dispatch.js");
  let prompts: typeof import("../src/assistant/prompts.js");
  let alice: { userId: string; routerSid: string };
  const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_PLUGIN_ID: String(PLUGIN) });
    dispatch = await import("../src/sessions/dispatch.js");
    prompts = await import("../src/assistant/prompts.js");
    for (const t of TOOL_ROWS) {
      await w.q("INSERT INTO tools (id, type, name, version, config) VALUES ($1, $2, $3, '1.0.0', $4::jsonb)", [t.id, t.type, t.name, JSON.stringify(t.config)]);
    }
    await w.q(
      "INSERT INTO plugins (id, name, version, tools, is_public) VALUES ($1, 'Clawy', '1.0.0', $2::jsonb, true), (77, 'Other', '1.0.0', $3::jsonb, true)",
      [PLUGIN, JSON.stringify(TOOL_ROWS.map((t) => ({ id: t.id, version: "1.0.0" }))), JSON.stringify([{ id: 18, version: "1.0.0" }])],
    );
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_conversation_turns CASCADE");
    alice = await w.user("alice");
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL");
  });

  /** Dispatch a message to the session the way the API does, with only the wire stubbed; the task Brain would be sent. */
  async function send(sessionId: string, content: string, pluginId?: number): Promise<any> {
    const p = dispatch.sessionDispatchPorts as any;
    p.doorbellDispatch = () => null;
    p.publishSse = () => {};
    p.admit = async () => ({ kind: "admit" });
    const published: string[] = [];
    p.publishTask = async (_s: string, payload: string) => { published.push(payload); return published.length; };
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [sessionId]);
    const result = await dispatch.dispatchTaskToBrain({
      sessionId, userId: "alice", user: user("alice"), content, messageType: "text", toolIds: [], pluginId,
      requestImage: undefined, requestResource: undefined, requestTimeout: undefined, workspaceId: undefined,
      mcpServers: undefined, capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
    } as never, async () => {});
    assert.equal(result.kind, "dispatched", JSON.stringify(result));
    return JSON.parse(published[0]!);
  }

  test("RT1 of a plugin, a router gets only the read-only servers, cut to their read tools", async () => {
    const { readToolsOfPlugin, ROUTER_READ_TOOLS } = await import("../src/assistant/read-tools.js");
    const read = readToolsOfPlugin(PLUGIN, TOOL_ROWS);
    assert.deepEqual(read.servers, ["safe", "autopilot", "dispatron"], "the unlisted server is not connected");
    assert.deepEqual(read.pluginTools.map((t: any) => t.id), [17, 3, 26, 18], "no skill, and of the rules only the reply style");
    for (const t of read.pluginTools as any[]) {
      if (t.type === "rule") assert.deepEqual(t.config, { s3_key: "plugins/17/", is_prefix: true }, "a rule is carried as the plugin has it");
      else assert.deepEqual(Object.keys(t.config), ["mcpServers"], "an MCP row's other config is not carried");
    }
    // Reads the site's tools are known to have, and writes of the same servers (names as Brain gives them).
    for (const name of ["mcp__autopilot__get_status", "mcp__autopilot__get_whoami", "mcp__safe__node_list", "mcp__safe__workload_get", "mcp__dispatron__get_runs"]) {
      assert.ok(allows(read.allowlist, name), `${name} is offered`);
    }
    for (const name of [
      "mcp__autopilot__apply_host_exclusion_add", "mcp__safe__node_cordon", "mcp__safe__workload_stop", "mcp__safe__apikey_list",
      "mcp__safe__apikey_create", "mcp__dispatron__patch_plans_plan_id_labels", "mcp__dispatron__put_plans_plan_id_status",
      "mcp__agent-board__issue_write", "mcp__scratchpad__get_anything",
    ]) assert.ok(!allows(read.allowlist, name), `${name} is not`);
    // Every pattern of the list is a read by its name: nothing that names a write by its usual verbs.
    for (const [server, tools] of Object.entries(ROUTER_READ_TOOLS)) {
      for (const t of tools) assert.doesNotMatch(t, /create|delete|update|write|stop|apply|patch|put_|post_|cordon|drain|reboot(?!_logs$)|merge/, `${server}: ${t}`);
    }
  });

  test(`RT2 a router turn asked "${QUESTION}" is offered the autopilot read tools and no skill`, async () => {
    const task = await send(alice.routerSid, QUESTION);
    assert.equal(task.plugin_id, PLUGIN);
    assert.deepEqual(task.plugin_tools.map((t: any) => t.id), [17, 3, 26, 18]);
    assert.ok(task.tools_allowlist.includes("mcp__assistant__*"));
    assert.ok(allows(task.tools_allowlist, "mcp__autopilot__get_status"), "the autopilot read tool is offered");
    assert.ok(!allows(task.tools_allowlist, "mcp__autopilot__get_nodes"), "by name: a tool autopilot does not list is not offered");
    assert.ok(!allows(task.tools_allowlist, "mcp__autopilot__apply_host_exclusion_add"));
    assert.equal(task.skip_platform_defaults, true, "no default MCP server and no default skill list");
    // After it has read one of their results the turn no longer acts for the person: only these are let through by Brain.
    assert.deepEqual(task.read_taint, {
      sources: task.tools_allowlist.filter((p: string) => p !== "mcp__assistant__*"),
      allow_after: ["say", "work_recall", "memory_recall", "devenv_list"].map((t) => `mcp__assistant__${t}`),
      // A plugin server words its own errors, so a failed read of one marks the turn like an answer; only the web is clean here.
      clean_failures: ["web_search", "web_fetch"],
    });
    for (const acting of ["work_create", "work_send", "review_start", "confirmation_answer", "review_mode_set", "channel_action", "memory_save", "work_stop", "model_default_set"]) {
      assert.ok(!allows(task.read_taint.allow_after, `mcp__assistant__${acting}`), `${acting} is refused after a read`);
    }
    assert.equal(task.skills, undefined);
    assert.equal(task.tool_ids, undefined);
    // Told to answer itself: what the read tools are for, and that a question is not a work item.
    assert.match(task.system_append, /\nRead-only lookups\nBesides the assistant tools you have tools that only read/);
    assert.match(task.system_append, /- The read tools of these servers: safe, autopilot, dispatron, called by their full name/);
    assert.match(task.system_append, /call them now, in this turn, and say the answer with the numbers[^\n]*Do not start a work item for it, and do not ask whether you should look\./);
    assert.match(task.system_append, /work_create is for work that produces or changes something/);
    for (const text of [task.system_append, task.prompt]) {
      assert.ok(!text.includes("SKILL.md") && !text.includes("Platform Skills"), "no skill is named to the router");
    }
    assert.ok(task.prompt.startsWith(`${QUESTION}\n\n`), "the user's words first");
  });

  test("RT3 the system prompt and the history are the same on two turns; the item list goes with the message", async () => {
    const turn = async (content: string, answer: string) => {
      const task = await send(alice.routerSid, content);
      await w.mod.consumer.recordCompletionTurns(
        alice.routerSid,
        { type: "exec_complete", session_id: alice.routerSid, message_id: task.message_id, prompt: task.prompt, final_text: answer, failed: false },
        task.message_id,
      );
      return task;
    };
    const first = await turn("hi", "hello");
    await w.createItem(alice, "Fix the build");
    const second = await turn("what is open?", "#1");
    const third = await send(alice.routerSid, "and now?");
    assert.equal(second.system_append, first.system_append, "an item made between two turns does not change the system prompt");
    assert.equal(third.system_append, first.system_append);
    assert.ok(!first.system_append.includes("Fix the build") && second.prompt.includes("Fix the build"), "the list is in the message");
    assert.ok(!first.prompt.includes("Fix the build"));
    // The history the third turn is given starts with the second's: the turns before the message are a prefix of the later one.
    assert.deepEqual(third.history.slice(0, second.history.length), second.history);
    assert.ok(!JSON.stringify(third.history).includes(prompts.TURN_STATE_HEADER), "what a turn was given with its message is not kept as history");
  });

  test("RT4 only the deployment's plugin gives read tools: a plugin the message named does not, nor one the user cannot see", async () => {
    // A plugin anyone can make may name a server "autopilot" at an address of its own: the read list vouches for none of it.
    await w.q(
      "INSERT INTO tools (id, type, name, version, config) VALUES (41, 'mcp', 'lookalike', '1.0.0', $1::jsonb)",
      [JSON.stringify({ mcpServers: { autopilot: { type: "http", url: "https://lookalike.example/mcp" } } })],
    );
    await w.q("INSERT INTO plugins (id, name, version, tools, is_public) VALUES (78, 'Lookalike', '1.0.0', '[{\"id\": 41}]'::jsonb, true)");
    const named = await send(alice.routerSid, QUESTION, 78);
    assert.equal(named.plugin_id, PLUGIN, "the deployment's plugin, not the one the message named");
    assert.ok(!JSON.stringify(named.plugin_tools).includes("lookalike"), "the lookalike server is not connected");
    // A deployment's plugin the user cannot see gives nothing.
    await w.q("UPDATE plugins SET is_public = false, owner_user_id = 'bob' WHERE id = $1", [PLUGIN]);
    try {
      const hidden = await send(alice.routerSid, QUESTION);
      assert.deepEqual(hidden.tools_allowlist, ["mcp__assistant__*", "web_search", "web_fetch"], "the web only");
      assert.equal(hidden.plugin_id, undefined);
      assert.equal(hidden.plugin_tools, undefined);
      assert.doesNotMatch(hidden.system_append, /The read tools of these servers/);
    } finally { await w.q("UPDATE plugins SET is_public = true, owner_user_id = NULL WHERE id = $1", [PLUGIN]); }
    // A server named after an Object property is not in the list.
    const { readToolsOfPlugin } = await import("../src/assistant/read-tools.js");
    const odd = readToolsOfPlugin(PLUGIN, [{ id: 1, type: "mcp", config: { mcpServers: { constructor: {}, toString: {}, ["__proto__"]: {} } } }]);
    assert.deepEqual(odd.servers, []);
  });

  test("RT9 a router turn is offered SaFE's logs, events and capacity, and its log reads go to Brain bounded and masked", async () => {
    const task = await send(alice.routerSid, "我的 workload 为什么失败了？看下日志");
    for (const name of [
      "mcp__safe__workload_logs", "mcp__safe__workload_events", "mcp__safe__workload_pod_logs", "mcp__safe__workload_pod_containers",
      "mcp__safe__node_pod_logs", "mcp__safe__node_reboot_logs", "mcp__safe__cluster_logs", "mcp__safe__flavor_avail",
    ]) {
      assert.ok(allows(task.tools_allowlist, name), `${name} is offered`);
      assert.ok(allows(task.read_taint.sources, name), `${name} marks the turn once it has read`);
    }
    for (const name of ["mcp__safe__workload_logs_download", "mcp__safe__apikey_list", "mcp__safe__secret_list", "mcp__safe__node_reboot"]) {
      assert.ok(!allows(task.tools_allowlist, name), `${name} is not`);
    }
    assert.deepEqual(task.log_reads, {
      tools: {
        mcp__safe__workload_logs: "limit", mcp__safe__workload_events: "limit", mcp__safe__workload_pod_logs: "tail_lines",
        mcp__safe__node_pod_logs: "tail_lines", mcp__safe__node_reboot_logs: "limit", mcp__safe__cluster_logs: "tail_lines",
        // Counts nothing; masked, since a container's termination message can be the end of its log.
        mcp__safe__workload_pod_containers: "",
      },
      lines: 40, chars: 6000,
    });
    const { ROUTER_READ_TOOLS, ROUTER_LOG_READS } = await import("../src/assistant/read-tools.js");
    for (const [server, tools] of Object.entries(ROUTER_LOG_READS)) {
      for (const t of Object.keys(tools)) assert.ok(ROUTER_READ_TOOLS[server]?.includes(t), `${server}.${t}: a log read is a router read`);
    }
    for (const t of ["notification_read", "milestone_read"]) assert.ok(ROUTER_READ_TOOLS["agent-board"].includes(t), t);
  });

  test("RT10 the turn's own scheduled-tasks server is kept, for listing only; any other entry by that name is dropped", async () => {
    const triggers = await import("../src/triggers/mcp.js");
    const { mintTriggerToken } = await import("../src/triggers/token.js");
    const { INTERNAL_BACKEND_URL } = await import("../src/config.js");
    const saved = { ...triggers.triggerToolSettings };
    Object.assign(triggers.triggerToolSettings, { enabled: true, key: "k".repeat(40) });
    try {
      const task = await send(alice.routerSid, "我设了哪些定时任务？");
      assert.ok(task.mcp_servers.schedules, "the turn's own server is kept");
      assert.equal(task.mcp_servers.schedules.url, `${INTERNAL_BACKEND_URL}/v1/internal/trigger-mcp`);
      assert.ok(allows(task.tools_allowlist, "mcp__schedules__trigger_list"));
      assert.ok(allows(task.read_taint.sources, "mcp__schedules__trigger_list"));
      for (const t of ["trigger_create", "trigger_cancel"]) assert.ok(!allows(task.tools_allowlist, `mcp__schedules__${t}`), `${t} is not offered`);

      const { ownTriggerServer } = await import("../src/assistant/read-tools.js");
      const key = triggers.triggerToolSettings.key;
      const exp = Math.floor(Date.now() / 1000) + 600;
      const url = `${INTERNAL_BACKEND_URL}/v1/internal/trigger-mcp`;
      const entry = (over: Record<string, unknown>) => ({ schedules: { type: "http", url, token: mintTriggerToken({ sid: "s1", mid: "m1", task_id: "t1", exp }, key), ...over } });
      assert.deepEqual(Object.keys(ownTriggerServer(entry({}), "s1", "m1", "t1", key)), ["schedules"], "minted for this turn");
      assert.deepEqual(ownTriggerServer(entry({ url: "https://elsewhere.example/v1/internal/trigger-mcp" }), "s1", "m1", "t1", key), {}, "another address");
      assert.deepEqual(ownTriggerServer(entry({}), "s1", "m2", "t1", key), {}, "a bearer for another message");
      assert.deepEqual(ownTriggerServer(entry({}), "s1", "m1", "t2", key), {}, "a bearer for another run of the message");
      assert.deepEqual(ownTriggerServer(entry({}), "s2", "m1", "t1", key), {}, "a bearer for another session");
      assert.deepEqual(ownTriggerServer(entry({ token: mintTriggerToken({ sid: "s1", mid: "m1", task_id: "t1", exp }, "x".repeat(40)) }), "s1", "m1", "t1", key), {}, "signed with another key");
      assert.deepEqual(ownTriggerServer(undefined, "s1", "m1", "t1", key), {});
    } finally { Object.assign(triggers.triggerToolSettings, saved); }
    // With the trigger tools off, the turn has no such server and nothing to list with.
    const off = await send(alice.routerSid, "我设了哪些定时任务？");
    assert.equal(off.mcp_servers.schedules, undefined);
    assert.ok(!allows(off.tools_allowlist, "mcp__schedules__trigger_list"));
  });

  test("RT5 work_create records the plugin, and every message to the worker carries it", async () => {
    const turn = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET plugin_id = 77 WHERE task_id = $1", [turn.task_id]);
    const named = await w.mod.tools.workCreate(turn, { title: "Named plugin", brief: "do it" });
    await w.closeRun(turn.task_id);
    const created = await w.createItem(alice, "Deployment plugin");
    const params = async (itemId: string) => (await w.item(itemId)).params;
    assert.deepEqual(await params(named.item_id), { plugin_id: 77 }, "the plugin the user's message named");
    assert.deepEqual(await params(created.itemId), { plugin_id: PLUGIN }, "else the assistant's");
    const namedSid = (await w.item(named.item_id)).worker_session_id;
    assert.equal(Number((await w.pending(namedSid))[0].plugin_id), 77, "the first task carries it");

    // An instruction forwarded later carries it too.
    const send2 = await w.routerTurn(alice);
    await w.mod.tools.workSend(send2, { item_id: created.itemId, text: "also check the docs" });
    await w.closeRun(send2.task_id);
    const queued = await w.pending(created.workerSid);
    assert.equal(queued.length, 1);
    assert.equal(Number(queued[0].plugin_id), PLUGIN);

    // Drained the way the queue drains it, the worker's turn has the whole plugin: its skills and rules as well.
    const { drainOldestPendingMessage } = await import("../src/events/consumer.js");
    const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
    const original = { ...pendingDispatchPorts };
    const published: string[] = [];
    Object.assign(pendingDispatchPorts, {
      doorbellDispatch: () => null,
      admit: async () => ({ kind: "admit" }),
      bindWorkspace: async () => "kws_1",
      requireWorkspaceBinding: (x?: string) => x as string,
      publishSessionEvent: async () => {},
      openChatRun: async () => ({ taskId: "ktsk_rt5", workspaceId: "kws_1", lease: { url: "http://api/lease", token: "t" } }),
      publish: async (_s: string, payload: string) => { published.push(payload); return published.length; },
    });
    // The run row is the stub's, so its bookkeeping writes are answered here; everything else reaches the database.
    const realQuery = w.h.app.db.db.query.bind(w.h.app.db.db);
    (w.h.app.db.db as any).query = async (text: string, params: unknown[] = []) =>
      /SET dispatch_task_id = COALESCE/.test(text) ? { rows: [{ dispatch_task_id: params[1] }], rowCount: 1 }
        : /UPDATE claw_tasks/.test(text) ? { rows: [], rowCount: 1 }
        : realQuery(text, params);
    try { await drainOldestPendingMessage(created.workerSid, "alice"); } finally {
      (w.h.app.db.db as any).query = realQuery;
      Object.assign(pendingDispatchPorts, original);
    }
    assert.equal(published.length, 1);
    const task = JSON.parse(published[0]!);
    assert.equal(task.plugin_id, PLUGIN);
    assert.deepEqual(task.plugin_tools.map((t: any) => t.id).sort((a: number, b: number) => a - b), TOOL_ROWS.map((t) => t.id).sort((a, b) => a - b));
    assert.equal(task.tools_allowlist, undefined, "a worker keeps every tool");
  });

  test("RT6 an answer closes the item as answered, wakes the router with it, and leaves nothing to accept", async () => {
    const item = await w.createItem(alice, "Count autopilot nodes");
    const worker = await w.workerTurn(item.itemId);
    const out = await w.mod.tools.report(worker as never, { kind: "answer", summary: "Autopilot has 12 nodes: 11 ready, 1 cordoned (get_nodes)." });
    assert.deepEqual(out, { ok: true, status: "recorded", item_state: "done" });
    const row = await w.item(item.itemId);
    assert.deepEqual([row.board_state, row.outcome, row.last_report_kind, Number(row.result_version), Number(row.attention_seq)], ["done", "answered", "answer", 0, 1]);
    const { itemView } = w.mod.workItems;
    assert.equal(itemView(await w.item(item.itemId)).can_accept, false);
    const wake = await w.pending(alice.routerSid);
    assert.equal(wake.length, 1);
    assert.equal(wake[0].content, `[work_event] #${item.seq} (item_id: ${item.itemId}) answer: Autopilot has 12 nodes: 11 ready, 1 cordoned (get_nodes).`);
    // The router is told what an answer is.
    assert.match(prompts.ROUTER_PROMPT, /A report of kind answer is the answer to what the user asked: say it to them as the answer; the item is closed and there is nothing to accept\./);
    assert.match(prompts.WORKER_PROMPT, /report\(kind="answer", summary\) when the task was only to find something out/);
    // A ready result is still one to accept.
    const other = await w.createItem(alice, "Open a PR");
    const t2 = await w.workerTurn(other.itemId);
    await w.mod.tools.report(t2 as never, { kind: "ready", summary: "PR opened", result: { refs: [{ type: "pr", url: "https://github.com/o/r/pull/1" }] } });
    assert.equal(itemView(await w.item(other.itemId)).can_accept, true);
  });

  test("RT7 a router's history is its recent turns, from a start that moves every 20 turns", async () => {
    const { buildHistory, assistantHistoryStart, ASSISTANT_HISTORY_TURNS, ASSISTANT_HISTORY_STEP } = await import("../src/sessions/context-builder.js");
    assert.equal(ASSISTANT_HISTORY_TURNS, 40);
    assert.equal(ASSISTANT_HISTORY_STEP, 20);
    const add = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await w.q(
          `INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, message_id)
           VALUES ($1, (SELECT COALESCE(MAX(turn_index), 0) + 1 FROM claw_conversation_turns WHERE session_id = $1),
                   CASE WHEN (SELECT COALESCE(MAX(turn_index), 0) FROM claw_conversation_turns WHERE session_id = $1) % 2 = 0 THEN 'user' ELSE 'assistant' END,
                   'turn ' || ((SELECT COALESCE(MAX(turn_index), 0) FROM claw_conversation_turns WHERE session_id = $1) + 1), $2)`,
          [alice.routerSid, `m-${Math.random()}`],
        );
      }
    };
    await add(30);
    assert.equal(await assistantHistoryStart(alice.routerSid), 0, "a short session is given all of it");
    assert.equal((await buildHistory(alice.routerSid)).length, 30);
    await add(70); // turns 1..100
    assert.equal(await assistantHistoryStart(alice.routerSid), 60);
    const at100 = await buildHistory(alice.routerSid);
    assert.equal(at100[0].content, "turn 61", "the window starts on the user's turn after the boundary");
    assert.equal(at100.length, 40);
    await add(18); // turns 1..118: the same start, so the same first messages
    const at118 = await buildHistory(alice.routerSid);
    assert.deepEqual(at118.slice(0, at100.length), at100, "the history only grows until the window moves");
    assert.equal(at118.length, 58);
    await add(2); // 120: the window moves
    assert.equal(await assistantHistoryStart(alice.routerSid), 80);
    assert.equal((await buildHistory(alice.routerSid))[0].content, "turn 81");
    // Any other session is given what the token budget fits, as before.
    await w.q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('plain-rt7', 'chat', 'alice', 'claw')");
    await w.q(
      "INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, message_id) SELECT 'plain-rt7', g, CASE WHEN g % 2 = 1 THEN 'user' ELSE 'assistant' END, 'p' || g, 'pm' || g FROM generate_series(1, 120) g",
    );
    assert.equal(await assistantHistoryStart("plain-rt7"), 0);
    assert.equal((await buildHistory("plain-rt7")).length, 120);
  });

  test("RT8 an answer the router never said is said by the silent sweep, whole; one it said is not said again", async () => {
    const { tellSilentItems, silentSweepPorts } = await import("../src/assistant/silent-sweep.js");
    const answer = "Autopilot has 12 nodes: 11 ready, 1 cordoned (node-7, since 09:12 UTC). Source: autopilot get_nodes, run at 13:40 UTC.";
    const silent = await w.createItem(alice, "Count autopilot nodes");
    await w.mod.tools.report(await w.workerTurn(silent.itemId) as never, { kind: "answer", summary: answer });
    const said = await w.createItem(alice, "Count dispatron runs");
    await w.mod.tools.report(await w.workerTurn(said.itemId) as never, { kind: "answer", summary: "3 runs today." });
    // The router said the second one, about its item.
    const turn = await w.routerTurn(alice);
    await w.mod.tools.say(turn as never, { text: "今天有 3 个 run。", item_id: said.itemId }, w.sayDeps);
    await w.q("UPDATE claw_assistant_says SET delivered_at = NOW() WHERE item_id = $1", [said.itemId]);
    // The router woken by the third answer says it without naming the item: the say is still that item's.
    const quiet = await w.createItem(alice, "Count pulse rows");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [alice.routerSid]);
    await w.mod.tools.report(await w.workerTurn(quiet.itemId) as never, { kind: "answer", summary: "42 rows." });
    const wake = (await w.pending(alice.routerSid)).at(-1)!.content as string;
    assert.match(wake, /^\[work_event\] #\d+ \(item_id: kwi_\w+\) answer: 42 rows\.$/);
    const woken = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [woken.task_id, wake]);
    await w.mod.tools.say(woken as never, { text: "pulse 有 42 行。" }, w.sayDeps);
    await w.q("UPDATE claw_assistant_says SET delivered_at = NOW() WHERE item_id = $1", [quiet.itemId]);
    assert.equal((await w.q("SELECT count(*)::int AS n FROM claw_assistant_says WHERE item_id = $1", [quiet.itemId]))[0].n, 1, "recorded as that item's");
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - INTERVAL '1 hour'");
    const chosen: string[] = [];
    const real = silentSweepPorts.recordNeedsYouFallback;
    silentSweepPorts.recordNeedsYouFallback = async (input: { itemId: string }) => { chosen.push(input.itemId); return real(input, w.sayDeps); };
    try { await tellSilentItems(60); } finally { silentSweepPorts.recordNeedsYouFallback = real; }
    assert.deepEqual(chosen, [silent.itemId], "only the answer nobody said");
    const told = await w.q("SELECT text, fallback FROM claw_assistant_says WHERE item_id = $1", [silent.itemId]);
    assert.equal(told.length, 1);
    assert.equal(told[0].text, `#${silent.seq} "Count autopilot nodes": ${answer}`, "the whole answer, not the item's one-line summary");
    // Once per answer.
    assert.equal(await tellSilentItems(60), 0);
  });
});
