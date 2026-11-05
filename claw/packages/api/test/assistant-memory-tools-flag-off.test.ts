// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `CLAW_ASSISTANT_MEMORY_TOOLS` off, with the assistant and memory on: a router is offered its five tools and a worker
 * the one it reports through, as before, and no turn reads anything of the user's memory to be shown it.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.CLAW_ASSISTANT_ENABLED = "true";
process.env.CLAW_ASSISTANT_TOKEN_KEY = "assistant-test-token-key-0123456789abcdef";
process.env.CLAW_MEMORY_ENABLED = "true";
delete process.env.CLAW_ASSISTANT_MEMORY_TOOLS;

test("no memory tools are offered and no turn reads the user's memory", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
  const mt = await import("../src/assistant/memory-tools.js");
  const { db } = await import("../src/infra/db.js");

  const tools = async (claims: Record<string, unknown>): Promise<string[]> => {
    const server = createAssistantMcpServer(claims as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(b);
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    await client.close();
    return names;
  };
  const exp = Math.floor(Date.now() / 1000) + 600;
  assert.deepEqual(await tools({ sid: "s", role: "router", mid: "m", task_id: "t", exp }), ["say", "work_create", "work_recall", "work_send", "work_stop"]);
  assert.deepEqual(await tools({ sid: "s", role: "worker", item_id: "i", gen: 1, mid: "m", task_id: "t", exp }), ["report"]);

  assert.equal(mt.assistantMemoryOn(), false);
  let statements = 0;
  const real = db.query;
  db.query = (async () => { statements += 1; throw new Error("no database here"); }) as typeof db.query;
  try {
    assert.equal(await mt.routerMemoryBlock("alice", "s"), null);
    assert.equal(await mt.workerMemoryBlock("alice", "i", "s"), null);
    assert.equal(await mt.reviewMemoryBlock("s"), null);
  } finally {
    db.query = real;
  }
  assert.equal(statements, 0, "nothing was read to find out");
});
