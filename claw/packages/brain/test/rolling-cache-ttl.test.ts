// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ExecuteRequest.rolling_cache_ttl: "5m"`, through the real engine to the wire: every request of the run and of its sub-agent sends the
 * anchor at Brain's TTL (1h) and every rolling marker as the bare 5m one, the longer-lived marker first as the API requires. A run
 * without the field, or with a value Brain does not know, sends every marker at 1h, as before the field. Only the network edges are fake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { uniqueSession } from "./support/plugin-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(() => world.close());

/** The `cache_control` markers of each request, front to back (hoisted system first, then messages). */
async function markersPerRequest(over: Record<string, unknown>): Promise<unknown[][]> {
  world.script([
    { tool: "task", input: { description: "d", prompt: "p" } },
    { tool: "bash", input: { command: "true" } },
    { text: "sub done" },
    { text: "parent done" },
  ]);
  world.llmBodies.length = 0;
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), ...over }),
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  return world.llmBodies.map((raw) => {
    const body = JSON.parse(raw) as { system?: unknown; messages: Array<{ content: unknown }> };
    const blocks = [
      ...(Array.isArray(body.system) ? body.system : []),
      ...body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
    ] as Array<Record<string, unknown>>;
    return blocks.filter((b) => b.cache_control).map((b) => b.cache_control);
  });
}

const ONE_HOUR = { type: "ephemeral", ttl: "1h" };
const FIVE_MIN = { type: "ephemeral" };

test("rolling markers at 5m on every request of the run and of its sub-agent; the anchor stays 1h and comes first", async () => {
  // [what, request fields, expected marker of every rolling position]
  const cases: Array<[string, Record<string, unknown>, unknown]> = [
    ["5m", { rolling_cache_ttl: "5m" }, FIVE_MIN],
    ["absent", {}, ONE_HOUR],
    ["unknown value", { rolling_cache_ttl: "1m" }, ONE_HOUR],
  ];
  for (const [what, over, rolling] of cases) {
    const requests = await markersPerRequest(over);
    assert.equal(requests.length, 4, `${what}: the parent twice, the sub-agent twice`);
    for (const [i, markers] of requests.entries()) {
      assert.deepEqual(markers[0], ONE_HOUR, `${what}: request ${i} anchor`);
      for (const m of markers.slice(1)) assert.deepEqual(m, rolling, `${what}: request ${i} rolling`);
    }
    // Requests go parent, sub-agent, sub-agent, parent; the last two carry rolling markers, so the case is not vacuous.
    assert.ok(requests[2]!.length > 1 && requests[3]!.length > 1, `${what}: ${JSON.stringify(requests)}`);
  }
});
