// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Platform defaults through the real engine and agent loop, flag ON.
 *
 * Only the network edges are fake (marketplace, LLM, Hands). Pins: the prompt
 * carries name+description and never the body; a chat that never touches a
 * default skill starts no sandbox and writes nothing; the body is written the
 * first time a sandbox tool names `.skills`, before that call; plugin-style
 * (tool_ids) skills stay inlined; defaults MCP are merged under the request's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

const BODY = "SECRET-BODY-LINE-ONLY-IN-FILE";
const world = await startWorld({
  skills: [{ tool_id: 11 }, { tool_id: 12 }],
  mcp_servers: { safe: { type: "http", url: "http://127.0.0.1:1/mcp" } },
});
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
world.setTools([
  { id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", BODY, "Operate the GPU fleet") },
  { id: 12, name: "broken-one", fail: true },
  { id: 13, name: "user-picked", zip: skillZip("user-picked", "INLINE-BODY", "picked by user") },
  { id: 14, name: "fleet-ops", zip: skillZip("fleet-ops", "INLINE-OVERRIDE", "user-picked copy") },
]);
const { AgentEngine } = await import("../src/agent/engine.js");
const events: Array<Record<string, unknown>> = [];
const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };

function run(over: Record<string, unknown>, hands: ReturnType<typeof fakeHands> | null) {
  let attached = 0;
  const made: Array<ReturnType<typeof fakeHands>> = [];
  const extras = hands ? undefined : { attachHands: async () => { attached++; const h = fakeHands(); made.push(h); return h as never; } };
  const p = new AgentEngine().execute(baseRequest(over), onEvent as never, undefined, hands as never, extras as never);
  return { p, attached: () => attached, made };
}

test.after(() => world.close());

test("chat that never touches a default skill: description in prompt, no body, no sandbox, no write", async () => {
  world.script([{ text: "plain answer" }]);
  world.llmBodies.length = 0;
  const r = run({}, null);
  await r.p;
  const body = world.llmBodies[0];
  assert.match(body, /Platform Skills \(load on demand\)/);
  assert.match(body, /fleet-ops: Operate the GPU fleet/);
  assert.ok(!body.includes(BODY), "skill body must not be in the prompt");
  assert.equal(r.attached(), 0, "no sandbox may be started");
  assert.match(body, /Available MCP servers: safe/);
  assert.ok(!body.includes("broken-one"), "a failed download is not listed");
  assert.ok(events.some((e) => e.status === "error" && String(e.brief).includes("broken-one")), "failure is a visible event");
});

test("a sandbox tool that does not name .skills starts the sandbox but writes no skill", async () => {
  world.script([{ tool: "bash", input: { command: "echo hi" } }, { text: "ok" }]);
  const r = run({}, null);
  await r.p;
  assert.equal(r.attached(), 1);
  assert.equal(r.made[0].calls.filter((c) => c.name === "write").length, 0, "no default skill is written");
});

test("first read of a default skill writes it before the read, once", async () => {
  const hands = fakeHands();
  world.script([
    { tool: "read", input: { path: "/workspace/.skills/fleet-ops/SKILL.md" } },
    { tool: "read", input: { path: "/workspace/.skills/fleet-ops/references/extra.md" } },
    { text: "done" },
  ]);
  await run({}, hands).p;
  const names = hands.calls.map((c) => `${c.name}:${String(c.args.path ?? "")}`);
  const readIdx = names.indexOf("read:/workspace/.skills/fleet-ops/SKILL.md");
  const writes = hands.calls.filter((c) => c.name === "write");
  assert.ok(writes.length >= 2, "SKILL.md and the reference file are uploaded");
  assert.ok(writes.some((w) => String(w.args.path).endsWith(".skills/fleet-ops/SKILL.md")));
  assert.ok(readIdx >= 0);
  assert.ok(names.indexOf("read:/workspace/.skills/fleet-ops/SKILL.md") > names.findIndex((n) => n.startsWith("write:")));
  assert.equal(writes.length, 2, "the second read does not write again");
});

test("tool_ids skills stay fully inlined and win over a default of the same name", async () => {
  world.script([{ text: "x" }]);
  world.llmBodies.length = 0;
  await run({ tool_ids: [13, 14] }, fakeHands()).p;
  const body = world.llmBodies[0];
  assert.match(body, /=== SKILL: user-picked \(SKILL.md\) ===/);
  assert.ok(body.includes("INLINE-BODY") && body.includes("INLINE-OVERRIDE"));
  assert.ok(!body.includes(BODY));
  assert.ok(!body.includes("Operate the GPU fleet"), "the default of the same name is not listed again");
});
