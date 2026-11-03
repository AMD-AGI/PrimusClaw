// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The deployment's platform defaults (`PLATFORM_DEFAULTS_FILE`) and a session that acts as a user (`withhold_sandbox_keys`), through the
 * real engine. The model of such a session reads what strangers wrote, and a default MCP server is called with the requester's own key, so
 * a read tool of it is the requester's read access to the platform in the hands of that text; a default skill steers the model towards it.
 * Such a run is given neither. What it has is what its own request carries: here a stand-in for the review tools, which the API puts in
 * `mcp_servers`.
 *
 * Only the network edges are fake (marketplace, LLM, Hands); both MCP servers are real ones, so what the model is offered is what
 * `connectPlatformMcp` actually made of the config, and a call that reaches a server is counted there.
 *
 *   A1  an ordinary task is still given the defaults: the server's tool, the skill in the prompt, the skill fetched (unchanged)
 *   A2  the mark `false` is an ordinary task
 *   A3  a marked task is given neither: no default tool offered, no default skill listed or fetched, its own server still there
 *   A4  a marked task that calls a default tool anyway is turned away and nothing reaches the default server; its own tool runs
 *   A5  a sub-agent of a marked task starts from its parent's tools and so has no default tool either (of an ordinary one it does)
 *   A6  a mark that is not a boolean still withholds
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";

const BODY = "SKILL-BODY-ONLY-IN-FILE";
const pw = await startPluginWorld();
const defaultsMcp = await startPluginWorld();
const world = await startWorld({
  skills: [{ tool_id: 11 }],
  mcp_servers: { fleet: { type: "http", url: defaultsMcp.mcpUrl, token: "<SAFE_API_KEY>" } },
});
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
world.setTools([{ id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", BODY, "Operate the GPU fleet") }]);
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); await pw.close(); await defaultsMcp.close(); });

const DEFAULT_TOOL = "mcp__fleet__ping";
const OWN_TOOL = "mcp__github_review__ping";
/** What the API puts on the turn of an acting session. */
const ownServers = { github_review: { type: "http", url: pw.mcpUrl, token: "t" } };

async function run(over: Record<string, unknown>, turns: Turn[]) {
  world.script(turns);
  world.llmBodies.length = 0;
  world.downloads.length = 0;
  world.byIdCalls.length = 0;
  const ownBefore = pw.mcpCalls.length;
  const defaultBefore = defaultsMcp.mcpCalls.length;
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), ...over }),
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  const bodies = world.llmBodies.map((b) => JSON.parse(b) as { tools?: Array<{ name: string }> });
  return {
    /** The tool names each model request carried, in request order. */
    offered: bodies.map((b) => (b.tools ?? []).map((t) => t.name).sort()),
    /** The prompt the model was given, with the tools it was told about. */
    first: world.llmBodies[0],
    modelSaw: world.llmBodies[1] ?? "",
    ownRan: pw.mcpCalls.length - ownBefore,
    defaultRan: defaultsMcp.mcpCalls.length - defaultBefore,
    skillsFetched: world.byIdCalls.length + world.downloads.length,
  };
}

test("A1 an ordinary task is given the defaults, as before", async () => {
  const r = await run({}, [{ text: "ok" }]);
  assert.ok(r.offered[0].includes(DEFAULT_TOOL), "the default server's tool is offered");
  assert.match(r.first, /Available MCP servers: fleet/);
  assert.match(r.first, /Platform Skills \(load on demand\)/);
  assert.match(r.first, /fleet-ops: Operate the GPU fleet/);
  assert.ok(r.skillsFetched > 0, "the default skill was fetched from the marketplace");
});

test("A2 withhold_sandbox_keys false is an ordinary task", async () => {
  const r = await run({ withhold_sandbox_keys: false }, [{ text: "ok" }]);
  assert.ok(r.offered[0].includes(DEFAULT_TOOL));
  assert.match(r.first, /fleet-ops: Operate the GPU fleet/);
});

test("A3 a marked task is given no default tool and no default skill, only what its request carries", async () => {
  const r = await run({ withhold_sandbox_keys: true, mcp_servers: ownServers }, [{ text: "ok" }]);
  assert.equal(r.offered[0].includes(DEFAULT_TOOL), false, "no default server tool is offered");
  assert.deepEqual(r.offered[0].filter((n) => n.startsWith("mcp__")), [OWN_TOOL], "the only MCP tool is the request's own");
  assert.match(r.first, /Available MCP servers: github_review\b/);
  assert.equal(r.first.includes("fleet"), false, "neither the server nor the skill is named to the model");
  assert.equal(r.first.includes("Platform Skills"), false, "no default skill is listed");
  assert.equal(r.skillsFetched, 0, "and none is fetched from the marketplace");
});

test("A3b a marked task with nothing of its own is offered no MCP tool at all", async () => {
  const r = await run({ withhold_sandbox_keys: true }, [{ text: "ok" }]);
  assert.deepEqual(r.offered[0].filter((n) => n.startsWith("mcp__")), []);
  assert.equal(r.first.includes("Available MCP servers"), false);
  assert.equal(r.first.includes("Platform Skills"), false);
});

test("A4 a marked task that calls a default tool anyway is turned away; its own tool runs", async () => {
  const refused = await run({ withhold_sandbox_keys: true, mcp_servers: ownServers }, [{ tool: DEFAULT_TOOL, input: {} }, { text: "ok" }]);
  assert.equal(refused.defaultRan, 0, "nothing reached the default server");
  assert.equal(refused.ownRan, 0);
  const own = await run({ withhold_sandbox_keys: true, mcp_servers: ownServers }, [{ tool: OWN_TOOL, input: {} }, { text: "ok" }]);
  assert.equal(own.ownRan, 1, "the request's own server is called as ever");
  assert.equal(own.defaultRan, 0);
  const ordinary = await run({}, [{ tool: DEFAULT_TOOL, input: {} }, { text: "ok" }]);
  assert.equal(ordinary.defaultRan, 1, "and an ordinary task does reach the default server");
});

test("A5 a sub-agent of a marked task has no default tool; one of an ordinary task has", async () => {
  const turns: Turn[] = [
    { tool: "task", input: { description: "d", prompt: "p" } },
    { text: "sub done" },
    { text: "parent done" },
  ];
  const marked = await run({ withhold_sandbox_keys: true, mcp_servers: ownServers }, turns);
  assert.equal(marked.offered.length, 3, "the parent, the sub-agent, the parent again");
  for (const [who, offered] of [["parent", marked.offered[0]], ["sub-agent", marked.offered[1]]] as const) {
    assert.equal(offered.includes(DEFAULT_TOOL), false, `${who}: no default tool`);
    assert.ok(offered.includes(OWN_TOOL), `${who}: its own tool`);
  }
  const ordinary = await run({ mcp_servers: ownServers }, turns);
  assert.ok(ordinary.offered[1].includes(DEFAULT_TOOL), "an ordinary sub-agent has the default tool: the row above is not vacuous");
});

test("A6 a mark that is not a boolean still withholds", async () => {
  for (const mark of ["true", 1, "yes"]) {
    const r = await run({ withhold_sandbox_keys: mark, mcp_servers: ownServers }, [{ text: "ok" }]);
    assert.equal(r.offered[0].includes(DEFAULT_TOOL), false, `mark ${JSON.stringify(mark)}`);
    assert.equal(r.first.includes("Platform Skills"), false, `mark ${JSON.stringify(mark)}`);
  }
});
