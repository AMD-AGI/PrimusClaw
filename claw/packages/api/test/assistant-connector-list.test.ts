// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `connector_list` (`assistant/connector-tools.ts`): a router turn reads the user's own remote connectors, against a real Postgres
 * with the production schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   C1  through the assistant's MCP, a router turn lists the user's connectors that are not revoked, oldest first, which are online,
 *       and each one's agents; another user's connector and a revoked one are not listed, and the counts say so
 *   C2  a worker turn is not offered it, and a deployment without remote agents does not offer it to a router either
 *   C3  a router turn that is no longer live is refused, and reads nothing
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("connector_list", { skip }, () => {
  let w: World;
  let mcp: typeof import("../src/assistant/mcp.js");
  let store: typeof import("../src/remote-agents/store.js");
  let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  let InMemoryTransport: typeof import("@modelcontextprotocol/sdk/inMemory.js").InMemoryTransport;

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true" });
    mcp = await import("../src/assistant/mcp.js");
    store = await import("../src/remote-agents/store.js");
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_remote_agents, claw_remote_connectors, claw_tasks, claw_assistants, claw_sessions CASCADE");
  });

  async function connect(claims: Record<string, unknown>, connectors?: boolean) {
    const server = mcp.createAssistantMcpServer(claims as never, undefined, undefined, undefined, undefined, connectors);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(b);
    return client;
  }
  async function call(claims: Record<string, unknown>) {
    const client = await connect(claims);
    try {
      const r = await client.callTool({ name: "connector_list", arguments: {} }) as { content: Array<{ text: string }>; isError?: boolean };
      return { isError: r.isError === true, body: JSON.parse(r.content[0].text) };
    } finally {
      await client.close();
    }
  }
  async function names(claims: Record<string, unknown>, connectors?: boolean) {
    const client = await connect(claims, connectors);
    try { return (await client.listTools()).tools.map((t) => t.name); } finally { await client.close(); }
  }
  async function connector(owner: string, name: string, opts: { online?: boolean; agents?: Array<{ kind: string; name: string }> } = {}) {
    const row = await store.registerConnector(owner, name, "1.2.3", null, 10);
    assert.ok(row);
    if (opts.agents) {
      await store.recordHeartbeat(row.connector_id, owner, {
        version: "1.2.4", agents: opts.agents.map((a, i) => ({ agent_id: `a${i}`, kind: a.kind, name: a.name, capabilities: {} })),
      } as never);
    }
    if (opts.online) await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [row.connector_id]);
    else await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '1 hour' WHERE connector_id = $1", [row.connector_id]);
    return row.connector_id as string;
  }

  test("C1 a router turn lists the user's own live connectors, which are online, and their agents", async () => {
    const alice = await w.user("alice");
    await connector("alice", "laptop", { online: true, agents: [{ kind: "claude-code", name: "Claude Code" }, { kind: "codex", name: "Codex" }] });
    await connector("alice", "desktop");
    const gone = await connector("alice", "old box", { online: true });
    assert.equal(await store.revokeConnector("alice", gone, null), true);
    await connector("bob", "bob's laptop", { online: true });

    const r = await call(await w.routerTurn(alice));
    assert.equal(r.isError, false);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.total, 2);
    assert.equal(r.body.online, 1);
    assert.deepEqual(r.body.connectors.map((c: any) => [c.name, c.online, c.version]), [["laptop", true, "1.2.4"], ["desktop", false, "1.2.3"]]);
    assert.deepEqual(r.body.connectors[0].agents, [{ kind: "claude-code", name: "Claude Code" }, { kind: "codex", name: "Codex" }]);
    assert.deepEqual(r.body.connectors[1].agents, []);
    assert.ok(!Number.isNaN(Date.parse(r.body.connectors[0].last_seen)), "when it was last seen");
    assert.ok(!JSON.stringify(r.body).includes("bob"), "another user's connector is not read");
    assert.ok(!JSON.stringify(r.body).includes("old box"), "a revoked connector is not listed");
  });

  test("C2 only a router is offered it, and only where remote agents are on", async () => {
    const alice = await w.user("alice");
    const router = await w.routerTurn(alice);
    assert.ok((await names(router)).includes("connector_list"));
    assert.ok(!(await names(router, false)).includes("connector_list"), "off without remote agents");
    const worker = { sid: "s", role: "worker", item_id: "i", gen: 1, mid: "m", task_id: "t", exp: router.exp };
    assert.ok(!(await names(worker)).includes("connector_list"), "a worker is not offered it");
  });

  test("C3 a router turn that has ended is refused", async () => {
    const alice = await w.user("alice");
    await connector("alice", "laptop", { online: true });
    const turn = await w.routerTurn(alice);
    await w.closeRun(turn.task_id);
    const r = await call(turn);
    assert.equal(r.isError, true);
    assert.ok(!JSON.stringify(r.body).includes("laptop"));
  });
});
