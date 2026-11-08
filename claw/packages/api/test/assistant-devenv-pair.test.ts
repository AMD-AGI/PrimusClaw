// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * devenv_pair: "connect my dev environment" with no machine yet answers one command line with a one-time code that is the
 * user's, and only a turn answering their own message gets one. Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const SERVER = "https://claw.example.com/claw-api";

describe("devenv_pair", { skip }, () => {
  let w: World;
  let mcp: typeof import("../src/assistant/mcp.js");
  let pairing: typeof import("../src/remote-agents/pairing.js");
  let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  let InMemoryTransport: typeof import("@modelcontextprotocol/sdk/inMemory.js").InMemoryTransport;

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true", CLAW_ASSISTANT_TOOLS: "on", CLAW_ASSISTANT_ATTENDED_TTL_SEC: "600", CLAW_PUBLIC_URL: SERVER });
    mcp = await import("../src/assistant/mcp.js");
    pairing = await import("../src/remote-agents/pairing.js");
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_remote_pairings, claw_remote_grants, claw_remote_audit, claw_tasks, claw_assistants, claw_sessions,
      claw_assistant_messages CASCADE`);
  });

  async function call(claims: Record<string, unknown>, devenv?: boolean) {
    const server = mcp.createAssistantMcpServer(claims as never, undefined, undefined, undefined, undefined, devenv);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(b);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      if (!names.includes("devenv_pair")) return { offered: false as const };
      const r = await client.callTool({ name: "devenv_pair", arguments: {} }) as { content: Array<{ text: string }>; isError?: boolean };
      return { offered: true as const, isError: r.isError === true, body: JSON.parse(r.content[0].text) };
    } finally {
      await client.close();
    }
  }
  async function userTurn(u: { routerSid: string; userId: string }, content: string): Promise<Claims> {
    const turn = await w.routerTurn(u);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, received_at)
       VALUES ($1, $2, $3, 'Alice A', $4, $5::jsonb, NOW())`,
      [u.routerSid, turn.mid, u.userId, content, JSON.stringify({ kind: "person" })],
    );
    return turn;
  }

  test("DP1 a turn answering the user gets a one-line command whose code is theirs and works once", async () => {
    const alice = await w.user("alice");
    const r = await call(await userTurn(alice, "连接我的开发环境"));
    assert.ok(r.offered && !r.isError, JSON.stringify(r));
    const b = (r as { body: Record<string, any> }).body;
    const m = /^npm install -g --no-update-notifier @primusclaw\/connector@latest && claw-connector pair ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}) --server (\S+)$/.exec(b.command);
    assert.ok(m, b.command);
    assert.equal(m![2], SERVER);
    assert.equal(b.expires_in_minutes, 10);
    assert.equal(b.single_use, true);
    const claimed = await pairing.claimPairing(m![1], "laptop");
    assert.ok(claimed.ok);
    assert.equal(claimed.owner, "alice");
    assert.equal((await pairing.claimPairing(m![1], "laptop")).ok, false);
  });

  test("DP2 a turn that answers no message of the user's, an ended turn, a worker, or remote agents off: no code", async () => {
    const alice = await w.user("alice");
    const report = await w.routerTurn(alice);
    const r1 = await call(report);
    assert.ok(r1.offered && r1.isError);
    assert.match(JSON.stringify(r1), /not_from_user/);
    // A message that came with a key, not signed in: nobody is attending.
    const key = await userTurn(alice, "pair my laptop");
    await w.q("UPDATE claw_assistant_messages SET attended_via = NULL WHERE message_id = $1", [key.mid]);
    const rk = await call(key);
    assert.ok(rk.offered && rk.isError);
    assert.match(JSON.stringify(rk), /not_attended/);
    const ended = await userTurn(alice, "pair my laptop");
    await w.closeRun(ended.task_id);
    const r2 = await call(ended);
    assert.ok(r2.offered && r2.isError);
    assert.equal(Number((await w.q("SELECT COUNT(*) AS n FROM claw_remote_pairings"))[0].n), 0);
    assert.equal((await call(await userTurn(alice, "pair"), false)).offered, false, "off without remote agents");
    const worker = { sid: "s", role: "worker", item_id: "i", gen: 1, mid: "m", task_id: "t", exp: report.exp };
    assert.equal((await call(worker)).offered, false, "a worker is not offered it");
  });

  test("DP3 the router's prompt pairs a machine when there is none, and says the command as given", async () => {
    const prompts = await import("../src/assistant/prompts.js");
    const reads = await import("../src/assistant/read-tools.js");
    const section = prompts.renderRouterDevenvSection({ actions: true, send: true });
    assert.match(section, /No machine: say none is connected\. When connect_a_machine has pairing[^\n]*do not call devenv_pair after it\. Without pairing: devenv_pair/);
    assert.match(section, /exactly as it answered/);
    assert.match(section, /连接我的开发环境 when there is none is devenv_list, whose connect_a_machine then carries the pairing command/);
    assert.equal(prompts.ROUTER_DEVENV_PROMPT_VERSION, "router-devenv-v12");
    assert.ok((reads.AFTER_READ_TOOLS as readonly string[]).includes("devenv_pair"), "after devenv_list finds no machine, it may still pair");
  });

  test("DP4 the router's prompt reads machines in the turn, and says a terminal session as it is (E249, 2026-11-08)", async () => {
    const prompts = await import("../src/assistant/prompts.js");
    for (const section of [prompts.renderRouterDevenvSection({ actions: true, send: true }), prompts.renderRouterDevenvSection({ actions: false })]) {
      // "让 autopilot pod 的 connector 也重连一下" was answered "0 machines" with no read in the turn.
      assert.match(section, /any question about their machines or the sessions on them[^\n]*calls devenv_list in this turn before you answer, even when an earlier turn of this conversation read it/);
      assert.match(section, /one that is not listed is not connected to them/);
      assert.match(section, /You cannot restart or reconnect a connector from here: never say it was done/);
      assert.match(section, /`claw-connector service install`/, "the restart command is written as code, not as the end of the template");
      // "只能看不能发，这正常吗" was answered "watching is normal"; the shared-session ask "the product cannot do that".
      assert.match(section, /One marked typed_into_terminal can be joined from the chat without taking it over: what they send is typed into that terminal/);
      assert.match(section, /One marked read_only can only be watched[^\n]*not running inside tmux, or its connector is too old/);
      assert.match(section, /never call it a missing feature or offer to file a request for it/);
    }
  });
});
