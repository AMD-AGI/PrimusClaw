// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * claw_capabilities on a real Postgres, through the assistant's MCP route as Brain reaches it (`assistant/capabilities.ts`, `mcp.ts`;
 * the list itself is tested in assistant-capabilities.test.ts).
 *
 *   KD1 a router turn's system prompt tells it to call claw_capabilities first; the router is offered the tool, a worker is not
 *   KD2 the tool answers the list for this user and this turn: exactly the tools the router's server offers, the deployment's switches
 *       (pull request watching on, jobs off), the user's review mode as stored, read again on every call, and the turn's chat app
 *   KD3 GET /v1/assistant/capabilities serves the same list to the user it is about, and nothing to a caller without a user; not
 *       knowing the Brain's web tools, it lists look_up as not known, never off, while a turn whose Brain names web_search has it on
 *   KD4 a router turn that reads the list and answers from it says nothing the list contradicts; the 2026-11-23 answer does
 *   KD5 the web tools are the ones the Brain names on its call (none named: not claimed), and memory is what the user's own setting and
 *       the conversation keep, read from the store
 *   KD6 reviews, pull request watching and GitHub comments follow the user's GitHub as those tools find it: a GH_TOKEN in their
 *       settings (read by the watch's own token lookup) for watching and comments, the review service's binding for reviews; without
 *       them the entries are off, say what to connect, and their tools are under off_here
 *
 * Skipped without DATABASE_URL, and a skip is not a pass. The source is imported only once the world has set the configuration.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type World } from "./support/assistant-world.js";

describe("claw_capabilities on a database", { skip: postgresSkipReason() }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let self: typeof import("./e2e/self-knowledge.js");
  let reviewPorts: typeof import("../src/assistant/review-items.js")["reviewItemPorts"];
  let savedDelegation: typeof reviewPorts.delegationOf = null;
  /** What the review service says of a user's own GitHub binding (`delegationOf`, asked of them for themselves). */
  let binding: "on" | "not_bound" = "on";
  /** A GH_TOKEN kept in `user`'s settings, as the watch's token lookup reads it. */
  const keepToken = (user: string) => w.q(
    "INSERT INTO claw_user_env_vars (user_id, key_name, key_value_enc) VALUES ($1, 'GH_TOKEN', $2) ON CONFLICT DO NOTHING",
    [user, w.mod.crypto.encryptUserEnvValue(`gho_${user}_token`)],
  );

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_GITHUB_EVENTS: "true", CLAW_ASSISTANT_TOOLS: "on", CLAW_GITHUB_REVIEW_ENABLED: "true", CLAW_ASSISTANT_REVIEW_ITEMS: "true" });
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      (req as any).user = { userId: id, userName: `Name ${id}`, platformKey: `pk-${id}`, virtualKey: `vk-${id}`, roles: ["default"] };
    });
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await (await import("../src/routes/assistant.js")).registerAssistantRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    self = await import("./e2e/self-knowledge.js");
    reviewPorts = (await import("../src/assistant/review-items.js")).reviewItemPorts;
    savedDelegation = reviewPorts.delegationOf;
    reviewPorts.delegationOf = async () => binding;
  });
  after(async () => {
    if (reviewPorts) reviewPorts.delegationOf = savedDelegation;
    await app?.close();
    await w?.stop();
  });

  async function connect(claims: object, extra: Record<string, string> = {}): Promise<Client> {
    const token = w.mod.token.mintAssistantToken(claims as never, TOKEN_KEY);
    const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/assistant-mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...extra } } }));
    return client;
  }
  const parsed = (res: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> => JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
  /** A router turn answering the user's message, which came through `channel`. */
  async function turnFrom(u: { routerSid: string; userId: string }, content: string, channel?: string) {
    const turn = await w.routerTurn(u);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, 'Alice A', $4, '{"kind":"person"}'::jsonb, $5::jsonb, NOW())`,
      [u.routerSid, turn.mid, u.userId, content, JSON.stringify(channel ? { channel } : {})],
    );
    return turn;
  }

  test("KD1 the router turn is told to read claw_capabilities first, and only the router has it", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions CASCADE");
    const alice = await w.user("alice");
    const run = await w.openRun(alice.routerSid);
    const task: Record<string, unknown> = { task_id: run.taskId, message_id: run.messageId, prompt: "你有什么做不到的？" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    assert.match(String(task.system_append), /call claw_capabilities first, before you say anything, and answer from what it returns alone/);
    await w.closeRun(run.taskId);

    const router = await connect(await w.routerTurn(alice));
    const item = await w.createItem(alice, "Fix the build");
    const worker = await connect(await w.workerTurn(item.itemId));
    try {
      assert.ok((await router.listTools()).tools.some((t) => t.name === "claw_capabilities"));
      assert.ok(!(await worker.listTools()).tools.some((t) => t.name === "claw_capabilities"));
    } finally {
      await router.close();
      await worker.close();
    }
  });

  test("KD2 the list of this user and turn: the router's own tools, the switches, the stored review mode and the chat app", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions, claw_github_review_settings CASCADE");
    const alice = await w.user("alice");
    await keepToken("alice");
    binding = "on";
    const router = await connect(await turnFrom(alice, "你能做什么", "slack"));
    try {
      const offered = (await router.listTools()).tools.map((t) => t.name).sort();
      const res = await router.callTool({ name: "claw_capabilities", arguments: {} });
      assert.equal(res.isError, undefined);
      const list = parsed(res);
      assert.equal(list.ok, true);
      assert.match(list.rule, /^This list is generated from the tools and settings you have now\./);
      // Every tool the router is offered is in the list once, by how it acts; nothing else is.
      assert.deepEqual([...list.acts_at_once, ...list.asks_first, ...list.reads, ...(list.off_here ?? []), "say", "deliver_text"].sort(), offered);
      assert.equal(list.unclassified, undefined);
      const ability = (id: string) => list.abilities.find((a: { id: string }) => a.id === id);
      assert.equal(ability("watch_pull_requests").on, true, "CLAW_ASSISTANT_GITHUB_EVENTS is on");
      assert.deepEqual(ability("watch_pull_requests").tools, ["work_subscribe"]);
      assert.equal(ability("watch_jobs").on, false, "CLAW_ASSISTANT_JOB_EVENTS is off");
      assert.equal(ability("see_images").on, true);
      assert.equal(ability("check_work").on, true);
      assert.equal(ability("reviews").on, true);
      assert.deepEqual(list.review_mode.mode, "high_risk_confirm", "never set: the default");
      assert.deepEqual(list.channels, ["slack", "teams"], "the turn's message came through slack");
      assert.equal(list.lookups.github, false, "alice has not connected GitHub");
      // Changed in the store, read again on the next call.
      await w.q("INSERT INTO claw_github_review_settings (user_id, review_mode) VALUES ('alice', 'fully_auto')");
      const again = parsed(await router.callTool({ name: "claw_capabilities", arguments: {} }));
      assert.equal(again.review_mode.mode, "fully_auto");
      assert.match(again.abilities.find((a: { id: string }) => a.id === "reviews").what, /fully_auto: a merge asked for happens once the review approves, without asking them/);
    } finally {
      await router.close();
    }
  });

  test("KD3 GET /v1/assistant/capabilities serves the same list to its user", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions, claw_github_review_settings CASCADE");
    const alice = await w.user("alice");
    await w.q("INSERT INTO claw_github_review_settings (user_id, review_mode) VALUES ('alice', 'fully_auto')");
    const router = await connect(await turnFrom(alice, "你能做什么"));
    let fromTool: Record<string, any>;
    try {
      fromTool = parsed(await router.callTool({ name: "claw_capabilities", arguments: {} }));
    } finally {
      await router.close();
    }
    const r = await app.inject({ method: "GET", url: "/v1/assistant/capabilities", headers: { "x-test-user": "alice" } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    const { ok: _ok, rule: _rule, ...tool } = fromTool;
    assert.deepEqual(r.json().data, tool);
    // A user without an assistant yet gets the list too (no GitHub, which only a session reads).
    const bob = await app.inject({ method: "GET", url: "/v1/assistant/capabilities", headers: { "x-test-user": "bob" } });
    assert.equal(bob.statusCode, 200);
    assert.equal(bob.json().data.review_mode.mode, "high_risk_confirm");
    assert.equal((await app.inject({ method: "GET", url: "/v1/assistant/capabilities" })).statusCode, 403);
    // No GitHub and no other systems here: the API's list cannot tell whether the turn can look anything up (its Brain's web tools are
    // named only to the turn's server), so look_up is not known, while the turn of a Brain with web_search has it on (2026-11-23).
    const lookUp = (list: Record<string, any>) => list.abilities.find((a: { id: string }) => a.id === "look_up");
    assert.equal(lookUp(r.json().data).on, null);
    assert.equal(lookUp(bob.json().data).on, null);
    const searching = await connect(await turnFrom(alice, "你能上网查吗"), { "x-claw-web-tools": "web_search" });
    try {
      const turn = parsed(await searching.callTool({ name: "claw_capabilities", arguments: {} }));
      assert.equal(lookUp(turn).on, true);
      assert.deepEqual(lookUp(turn).tools, ["web_search"]);
    } finally {
      await searching.close();
    }
  });

  test("KD4 a router turn that reads the list and answers from it says nothing it contradicts; the 2026-11-23 answer does", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions, claw_github_review_settings CASCADE");
    const alice = await w.user("alice");
    const router = await connect(await turnFrom(alice, "你有什么做不到的？"));
    try {
      const list = parsed(await router.callTool({ name: "claw_capabilities", arguments: {} }));
      // The answer a turn writes from the list: what is on, then what is off.
      const answer = [
        ...list.abilities.filter((a: { on: boolean }) => a.on).map((a: { what: string }) => a.what),
        ...list.limits.filter((l: { on: boolean }) => !l.on).map((l: { what: string }) => l.what),
      ].join("\n");
      assert.deepEqual(self.contradictedClaims(answer, list), []);
      const guessed = "我没有后台监控能力，只有在你发消息的时候才会工作。我看不到你发的图片。所有写操作都需要开 worker 并经过你的确认。我无法检查 worker 的结论对不对。";
      assert.deepEqual(self.contradictedClaims(guessed, list).map((c) => c.detector).sort(),
        ["denies acting directly", "denies background", "denies check_work", "denies see_images"]);
    } finally {
      await router.close();
    }
  });

  test("KD5 the web tools the Brain names, and the memory the user's setting and the conversation keep", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions, claw_github_review_settings CASCADE");
    const alice = await w.user("alice");
    const lookUp = (list: Record<string, any>) => list.abilities.find((a: { id: string }) => a.id === "look_up");
    for (const [header, web, tools] of [
      [undefined, null, []], ["none", { search: false, fetch: false }, []], ["web_fetch", { search: false, fetch: true }, ["web_fetch"]],
      ["web_search,web_fetch", { search: true, fetch: true }, ["web_search", "web_fetch"]],
    ] as const) {
      const router = await connect(await turnFrom(alice, "你能上网查吗"), header === undefined ? {} : { "x-claw-web-tools": header });
      try {
        const list = parsed(await router.callTool({ name: "claw_capabilities", arguments: {} }));
        assert.deepEqual(list.lookups.web, web, `header ${header}`);
        assert.deepEqual((lookUp(list)?.tools ?? []).filter((t: string) => t.startsWith("web_")), tools, `header ${header}`);
        // Not named: not known, neither claimed nor denied (no GitHub, no other systems here); named as none: off; named: on.
        assert.equal(lookUp(list).on, header === undefined ? null : tools.length > 0, `header ${header}`);
        if (header !== "web_search,web_fetch") assert.doesNotMatch(lookUp(list).what, /search the web \(web_search\)/, `header ${header}`);
      } finally {
        await router.close();
      }
    }

    // Memory, from the store, as the memory tools decide it (the deployment's switch given on).
    const { capabilityInputs, capabilityList, deploymentFeatures } = await import("../src/assistant/capabilities.js");
    const { db } = await import("../src/infra/db.js");
    const memoryOf = async (sid: string | null) => {
      const inputs = await capabilityInputs((t, p) => db.query(t, p), "alice", sid, ["memory_save", "memory_recall"], undefined,
        { features: { ...deploymentFeatures(), memory: true }, systems: async () => [], github: async () => false });
      return { memory: inputs.userMemory, on: capabilityList(inputs).abilities.find((a) => a.id === "memory")!.on };
    };
    await w.q("INSERT INTO claw_user_memory_prefs (user_id, enabled) VALUES ('alice', true) ON CONFLICT (user_id) DO UPDATE SET enabled = true");
    assert.deepEqual(await memoryOf(alice.routerSid), { memory: { enabled: true, here: true }, on: true });
    await w.q("UPDATE claw_user_memory_prefs SET enabled = false WHERE user_id = 'alice'");
    assert.deepEqual(await memoryOf(alice.routerSid), { memory: { enabled: false, here: true }, on: false }, "the user turned memory off");
    await w.q("UPDATE claw_user_memory_prefs SET enabled = true WHERE user_id = 'alice'");
    await w.q(`UPDATE claw_sessions SET config = config || '{"memory":"off"}'::jsonb WHERE session_id = $1`, [alice.routerSid]);
    assert.deepEqual(await memoryOf(alice.routerSid), { memory: { enabled: true, here: false }, on: false }, "a conversation that keeps none");
    assert.deepEqual(await memoryOf(null), { memory: { enabled: true, here: false }, on: false }, "no session yet");
    await w.q("DELETE FROM claw_user_memory_prefs WHERE user_id = 'alice'");
  });

  test("KD6 reviews, pull request watching and GitHub comments follow the user's GitHub as those tools find it", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions, claw_github_review_settings CASCADE");
    await w.q("DELETE FROM claw_user_env_vars WHERE user_id = 'carol'");
    const carol = await w.user("carol");
    const ability = (list: Record<string, any>, id: string) => list.abilities.find((a: { id: string }) => a.id === id);
    const listNow = async () => {
      const router = await connect(await turnFrom(carol, "你会盯我的 PR 吗？能帮我评审吗？"));
      try {
        return { list: parsed(await router.callTool({ name: "claw_capabilities", arguments: {} })), offered: (await router.listTools()).tools.map((t) => t.name).sort() };
      } finally {
        await router.close();
      }
    };
    try {
      // A new user: no GH_TOKEN, no binding.
      binding = "not_bound";
      const fresh = await listNow();
      // (github_comment is registered with the triggers, off in this world: off either way; its wording is K9's.)
      assert.equal(fresh.offered.includes("github_comment"), false);
      assert.equal(ability(fresh.list, "github_comment").on, false);
      for (const id of ["watch_pull_requests", "reviews"]) {
        assert.equal(ability(fresh.list, id).on, false, id);
        assert.match(ability(fresh.list, id).what, /needs the user's GitHub account first, and they have not connected one: they connect it once with \/github bind/, id);
      }
      assert.equal(fresh.list.review_mode, null);
      assert.ok(["review_restart", "review_start", "work_subscribe"].every((t) => fresh.list.off_here.includes(t)), fresh.list.off_here.join(","));
      assert.ok(!fresh.list.acts_at_once.includes("review_start") && !fresh.list.acts_at_once.includes("work_subscribe"));
      assert.deepEqual([...fresh.list.acts_at_once, ...fresh.list.asks_first, ...fresh.list.reads, ...fresh.list.off_here, "say", "deliver_text"].sort(), fresh.offered);
      // "I can watch your PRs" is now a claim the list contradicts.
      assert.deepEqual(self.contradictedClaims("我可以帮你在后台盯着 PR。", fresh.list as never).map((c) => c.detector), ["claims watch_pull_requests"]);

      // A GH_TOKEN in their settings: watching and comments work; reviews still need the binding.
      await keepToken("carol");
      const token = await listNow();
      assert.equal(ability(token.list, "watch_pull_requests").on, true);
      assert.equal(ability(token.list, "reviews").on, false);
      assert.match(ability(token.list, "reviews").what, /a GH_TOKEN does not count for reviews/);
      assert.deepEqual(token.list.off_here, ["review_restart", "review_start"]);

      // Bound: reviews too, and the API's own list says the same.
      binding = "on";
      const bound = await listNow();
      assert.equal(ability(bound.list, "reviews").on, true);
      assert.equal(bound.list.off_here, undefined);
      assert.equal(bound.list.review_mode.mode, "high_risk_confirm");
      const r = await app.inject({ method: "GET", url: "/v1/assistant/capabilities", headers: { "x-test-user": "carol" } });
      assert.equal(r.json().data.abilities.find((a: { id: string }) => a.id === "watch_pull_requests").on, true);
      assert.equal(r.json().data.abilities.find((a: { id: string }) => a.id === "reviews").on, true);
    } finally {
      binding = "on";
      await w.q("DELETE FROM claw_user_env_vars WHERE user_id = 'carol'");
    }
  });
});
