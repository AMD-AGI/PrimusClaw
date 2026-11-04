// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model's memory tools on Brain's side: offered only when the API said the conversation has memory, and
 * then answered by the API during the turn, over the cluster route, naming the session and the turn.
 *
 *   B1  a request without memory: none of the four is offered, and a call that arrives anyway is refused
 *       without reaching the API
 *   B2  with memory: all four are offered, a call reaches the API with the turn and the input, and the API's
 *       answer is what the model sees (its refusal counted as one)
 *   B3  a sub-agent's router never has memory, whatever its parent has
 */
process.env.AUTH_INTERNAL_TOKEN = "memory-test-internal-token";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const { ToolRouter } = await import("../src/tools/router.js");
const { MEMORY_TOOLS } = await import("../src/tools/memory-tools.js");

const NAMES = ["save_memory", "update_memory", "recall_memory", "forget_memory"];
const calls: Array<{ path: string; auth: string; body: any }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, text: "Saved memory #7 \"tabs\"." } };
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      calls.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: JSON.parse(raw || "{}") });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.INTERNAL_BACKEND_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const input = { type: "user", title: "tabs", body: "Indent with tabs", evidence_quote: "always indent with tabs" };

function routerWithMemory(): InstanceType<typeof ToolRouter> {
  const router = new ToolRouter(null);
  router.memoryEnabled = true;
  router.memoryTurn = { sessionId: "sess-1", messageId: "claw-42" };
  return router;
}

test("B1 a request without memory offers none of the tools and refuses a call without reaching the API", async () => {
  calls.length = 0;
  const router = new ToolRouter(null);
  router.memoryTurn = { sessionId: "sess-1", messageId: "claw-42" };
  const offered = router.getToolSchemas().map((t) => t.name);
  for (const name of NAMES) assert.ok(!offered.includes(name), `${name} is withheld`);
  assert.ok(offered.includes("bash"), "the other tools are untouched");
  for (const name of NAMES) {
    const outcome = { isError: false };
    const out = await router.route(name, input, undefined, outcome);
    assert.match(out, /^Error: long-term memory is not available/);
    assert.equal(outcome.isError, true);
  }
  assert.deepEqual(calls, [], "nothing reached the API");
});

test("B2 with memory every tool is offered and answered by the API for this turn", async () => {
  calls.length = 0;
  answer = { status: 200, body: { ok: true, text: "Saved memory #7 \"tabs\"." } };
  const router = routerWithMemory();
  const offered = router.getToolSchemas().map((t) => t.name);
  for (const name of NAMES) assert.ok(offered.includes(name), `${name} is offered`);
  assert.deepEqual([...MEMORY_TOOLS].sort(), [...NAMES].sort());

  for (const name of NAMES) {
    const outcome = { isError: false };
    const out = await router.route(name, input, undefined, outcome);
    assert.equal(out, "Saved memory #7 \"tabs\".");
    assert.equal(outcome.isError, false);
  }
  assert.deepEqual(calls.map((c) => c.path), NAMES.map((n) => `/v1/internal/memory/${n}`));
  for (const c of calls) {
    assert.equal(c.auth, "Bearer memory-test-internal-token");
    assert.deepEqual(c.body, { session_id: "sess-1", message_id: "claw-42", input });
  }

  answer = { status: 409, body: { ok: false, text: "Error: not saved (similar_exists): an entry already says much the same (#3 \"tabs\")" } };
  const outcome = { isError: false };
  const out = await router.route("save_memory", input, undefined, outcome);
  assert.match(out, /similar_exists/);
  assert.equal(outcome.isError, true, "the API's refusal is counted as one");
});

test("B3 a sub-agent's router has no memory even when its parent has", async () => {
  calls.length = 0;
  const parent = routerWithMemory();
  const child = new ToolRouter(null);
  parent.registerChild(child);
  assert.ok(!child.getToolSchemas().some((t) => MEMORY_TOOLS.has(t.name)));
  const out = await child.route("save_memory", input);
  assert.match(out, /^Error: long-term memory is not available/);
  assert.deepEqual(calls, []);
});
