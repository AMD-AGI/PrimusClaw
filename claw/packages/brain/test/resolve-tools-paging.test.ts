// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * resolveToolIds finds a tool (via the paged-list fallback) that is not on the first page of the marketplace
 * list. The list endpoint is paged; a lookup that reads only the first page
 * reports every later tool as "not found" and silently drops it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveToolIds } from "../src/tools/resolve.js";

test("a tool past the first marketplace page is resolved", async () => {
  const all = Array.from({ length: 250 }, (_, i) => ({
    id: 1000 - i,
    name: `tool-${1000 - i}`,
    type: "mcp",
    config: { mcpServers: { [`srv-${1000 - i}`]: { url: "http://x" } } },
  }));
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input instanceof Request ? input.url : input), "http://tools.test");
    // No by-id route behind this gateway: the lookup falls back to the paged list.
    if (/\/\d+$/.test(u.pathname)) return new Response("not found", { status: 404 });
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const limit = Math.min(100, Number(u.searchParams.get("limit") ?? 50));
    return new Response(
      JSON.stringify({ data: { tools: all.slice(offset, offset + limit), total: all.length } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    // 1000 is on page 1; 800 is index 200, on page 3.
    const out = await resolveToolIds([1000, 800], "key");
    assert.deepEqual(Object.keys(out.mcpServers).sort(), ["srv-1000", "srv-800"]);
  } finally {
    globalThis.fetch = real;
  }
});
