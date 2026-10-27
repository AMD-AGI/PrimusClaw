// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The paged-list fallback of resolveToolIds (used when the by-id route is not
 * reachable) finds tools past the first page, keeps what earlier pages gave it
 * when a later page fails, and is bounded.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveToolIds } from "../src/tools/resolve.js";

const mcp = (id: number) => ({
  id,
  name: `tool-${id}`,
  type: "mcp",
  config: { mcpServers: { [`srv-${id}`]: { url: "http://x" } } },
});

interface Case {
  name: string;
  count: number;
  ids: number[];
  /** Return a Response to override the default page, or undefined for the default. */
  override?: (offset: number) => Response | undefined;
  /** When true the endpoint ignores `offset` and always serves page one. */
  ignoreOffset?: boolean;
  /** Report `total` in the body. */
  total?: (count: number) => number | undefined;
  expectServers: string[];
  expectMaxListCalls?: number;
  expectListCalls?: number;
}

const cases: Case[] = [
  {
    name: "a tool past the first page is resolved",
    count: 250,
    ids: [1000, 800],
    expectServers: ["srv-1000", "srv-800"],
  },
  {
    name: "a page-2 502 keeps the tools found on page 1",
    count: 250,
    ids: [1000, 800],
    override: (offset) => (offset === 100 ? new Response("bad gateway", { status: 502 }) : undefined),
    expectServers: ["srv-1000"],
    expectListCalls: 2,
  },
  {
    name: "an endpoint that ignores offset stops at the page cap",
    count: 250,
    ids: [1000, 999999],
    ignoreOffset: true,
    expectServers: ["srv-1000"],
    expectMaxListCalls: 50,
  },
  {
    name: "reaching the reported total stops paging",
    count: 200,
    ids: [1000, 999999],
    total: (n) => n,
    expectServers: ["srv-1000"],
    expectListCalls: 2,
  },
];

for (const c of cases) {
  test(`list fallback: ${c.name}`, async () => {
    const all = Array.from({ length: c.count }, (_, i) => mcp(1000 - i));
    let listCalls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input instanceof Request ? input.url : input), "http://tools.test");
      // No by-id route behind this gateway: the lookup falls back to the paged list.
      if (/\/\d+$/.test(u.pathname)) return new Response("not found", { status: 404 });
      listCalls++;
      const offset = c.ignoreOffset ? 0 : Number(u.searchParams.get("offset") ?? 0);
      const over = c.override?.(offset);
      if (over) return over;
      const limit = Math.min(100, Number(u.searchParams.get("limit") ?? 50));
      const data: Record<string, unknown> = { tools: all.slice(offset, offset + limit) };
      const total = c.total?.(all.length);
      if (total !== undefined) data.total = total;
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    try {
      const out = await resolveToolIds(c.ids, "key");
      assert.deepEqual(Object.keys(out.mcpServers).sort(), [...c.expectServers].sort());
      if (c.expectListCalls !== undefined) assert.equal(listCalls, c.expectListCalls);
      if (c.expectMaxListCalls !== undefined) assert.ok(listCalls <= c.expectMaxListCalls, `${listCalls} list calls`);
    } finally {
      globalThis.fetch = real;
    }
  });
}
