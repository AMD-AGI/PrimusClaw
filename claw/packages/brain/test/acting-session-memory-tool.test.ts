// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `save_memory` and a session that acts as a user (`withhold_sandbox_keys`), through the real engine. The model of such a session reads
 * what strangers wrote, and what it saves is read by every later session of its requester, so a stranger's text could steer them. It is
 * not offered the tool, and a call to it anyway saves nothing, whatever the API says about the requester's memory (`memory_enabled`
 * true: the requester has opted in, which is the case that matters).
 *
 *   B1  an ordinary task is offered `save_memory`, and a call to it reaches the API (unchanged)
 *   B2  the mark `false` is an ordinary task
 *   B3  a marked task is not offered it and a call is refused: nothing reaches the API, even with `memory_enabled: true`
 *   B4  a sub-agent of a marked task has none either (it starts from its parent's tools), B4b and cannot save one; nothing reaches the API
 *   B5  a mark that is not a boolean still withholds
 *
 * Only the network edges are fake (LLM, Hands, the API's memory route).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startWorld, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { uniqueSession } from "./support/plugin-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
/** Every call that reached the API's memory route. */
let memoryCalls = 0;
const api = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    memoryCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, text: "Saved memory #1 \"tabs\"." }));
  });
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
process.env.INTERNAL_BACKEND_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
test.after(() => { world.close(); api.close(); });

const SAVE = { tool: "save_memory", input: { type: "user", title: "tabs", body: "the requester likes tabs", evidence_quote: "I like tabs" } } as const;

async function run(over: Record<string, unknown>, turns: Turn[]) {
  world.script(turns);
  world.llmBodies.length = 0;
  memoryCalls = 0;
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), message_id: "claw-1", memory_enabled: true, ...over }),
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  const bodies = world.llmBodies.map((b) => JSON.parse(b) as { tools?: Array<{ name: string }> });
  return {
    offered: bodies.map((b) => (b.tools ?? []).map((t) => t.name)),
    modelSaw: world.llmBodies[1] ?? "",
    saved: memoryCalls,
  };
}

test("B1 an ordinary task is offered save_memory and a call to it reaches the API", async () => {
  const r = await run({}, [SAVE, { text: "ok" }]);
  assert.ok(r.offered[0].includes("save_memory"));
  assert.equal(r.saved, 1);
  assert.match(r.modelSaw, /Saved memory/);
});

test("B2 withhold_sandbox_keys false is an ordinary task", async () => {
  const r = await run({ withhold_sandbox_keys: false }, [SAVE, { text: "ok" }]);
  assert.ok(r.offered[0].includes("save_memory"));
  assert.equal(r.saved, 1);
});

test("B3 a marked task is not offered save_memory and a call saves nothing, though the requester has memory on", async () => {
  const r = await run({ withhold_sandbox_keys: true }, [SAVE, { text: "ok" }]);
  assert.equal(r.offered[0].includes("save_memory"), false, "not offered");
  assert.equal(r.saved, 0, "nothing reaches the API");
  assert.equal(r.modelSaw.includes("Saved memory"), false, "the model is not told it saved");
});

test("B4 a sub-agent of a marked task has no save_memory and saves nothing", async () => {
  const marked = await run({ withhold_sandbox_keys: true }, [
    { tool: "task", input: { description: "d", prompt: "p" } },
    SAVE,
    { text: "sub done" },
    { text: "parent done" },
  ]);
  assert.equal(marked.offered.length, 4, "the parent, the sub-agent twice, the parent again");
  for (const [i, offered] of marked.offered.entries()) assert.equal(offered.includes("save_memory"), false, `request ${i}`);
  assert.equal(marked.saved, 0);
  // The control: a sub-agent of an ordinary task is not given it either (no sub-agent is), while its parent was.
  const ordinary = await run({}, [
    { tool: "task", input: { description: "d", prompt: "p" } },
    SAVE,
    { text: "sub done" },
    { text: "parent done" },
  ]);
  assert.ok(ordinary.offered[0].includes("save_memory"), "the ordinary parent has it");
  assert.equal(ordinary.offered[1].includes("save_memory"), false, "no sub-agent has it");
  assert.equal(ordinary.saved, 0, "and its call saved nothing");
});

test("B4b a sub-agent of a marked task that calls save_memory anyway saves nothing and is not told it did", async () => {
  const r = await run({ withhold_sandbox_keys: true }, [
    { tool: "task", input: { description: "d", prompt: "p" } },
    SAVE,
    { text: "sub done" },
    { text: "parent done" },
  ]);
  assert.equal(r.saved, 0, "nothing reaches the API");
  assert.equal(world.llmBodies[2].includes("Saved memory"), false, "the sub-agent is not told it saved");
});

test("B5 a mark that is not a boolean still withholds", async () => {
  for (const mark of ["true", 1, "yes"]) {
    const r = await run({ withhold_sandbox_keys: mark }, [SAVE, { text: "ok" }]);
    assert.equal(r.offered[0].includes("save_memory"), false, `mark ${JSON.stringify(mark)}`);
    assert.equal(r.saved, 0, `mark ${JSON.stringify(mark)}`);
  }
});
