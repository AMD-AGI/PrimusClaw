// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain names its built-in web tools to Claw's assistant server, so that the assistant's list of what it can do (`claw_capabilities`)
 * claims web search or page reading only where this Brain has it: each tool is on by its own setting (WEB_SEARCH_PROVIDER, off by
 * default; WEB_FETCH_ENABLED, off by default), and the tools a turn is offered are the same list.
 *
 *   WH1 the list follows each setting on its own, and the header names it ("none" for neither); only the assistant's server gets it
 *   WH2 against a real MCP server: a call to the assistant's path carries what this Brain has (web_fetch only here), replacing a spelling
 *       of the same header the spec carried; a call to any other server carries none
 */
import test from "node:test";
import assert from "node:assert/strict";

// This Brain: page reading on, no search provider.
process.env.WEB_FETCH_ENABLED = "true";
delete process.env.WEB_SEARCH_PROVIDER;
const { startPluginWorld } = await import("./support/plugin-world.js");
const { connectPlatformMcp, trustedServerHeaders, WEB_TOOLS_HEADER } = await import("../src/clients/mcp.js");
const { builtinWebTools, BUILTIN_WEB_TOOLS } = await import("../src/config.js");

const pw = await startPluginWorld();
test.after(async () => { await pw.close(); });

test("WH1 each web tool by its own setting, named only to the assistant's server", () => {
  assert.deepEqual(builtinWebTools("disabled", false), [], "Brain's defaults: neither");
  assert.deepEqual(builtinWebTools("anthropic", false), ["web_search"]);
  assert.deepEqual(builtinWebTools("disabled", true), ["web_fetch"]);
  assert.deepEqual(builtinWebTools("tavily", true), ["web_search", "web_fetch"]);
  assert.deepEqual(BUILTIN_WEB_TOOLS, ["web_fetch"], "this process: fetch on, no provider");

  const assistant = "http://api:8080/v1/internal/assistant-mcp";
  assert.equal(WEB_TOOLS_HEADER, "x-claw-web-tools");
  assert.deepEqual(trustedServerHeaders("assistant", assistant, []), { "x-claw-web-tools": "none" });
  assert.deepEqual(trustedServerHeaders("assistant", assistant, ["web_search", "web_fetch"]), { "x-claw-web-tools": "web_search,web_fetch" });
  assert.deepEqual(trustedServerHeaders("assistant", assistant), { "x-claw-web-tools": "web_fetch" });
  assert.deepEqual(trustedServerHeaders("board", assistant), {}, "another server's name");
  assert.deepEqual(trustedServerHeaders("assistant", "http://elsewhere/mcp"), {}, "another path");
});

test("WH2 a real call carries the header to the assistant's server, and to no other", async () => {
  const base = new URL(pw.mcpUrl).origin;
  for (const [name, path, expected] of [
    ["assistant", "/v1/internal/assistant-mcp", "web_fetch"], ["board", "/mcp", undefined], ["assistant", "/mcp", undefined],
  ] as const) {
    pw.mcpHeaders.length = 0;
    const r = await connectPlatformMcp({ [name]: { type: "http", token: "t", url: `${base}${path}`, headers: { "X-Claw-Web-Tools": "web_search,web_fetch" } } });
    try {
      assert.deepEqual(r.schemas.map((t) => t.name), [`mcp__${name}__ping`]);
      assert.ok(pw.mcpHeaders.length > 0);
      for (const h of pw.mcpHeaders) {
        assert.equal(h[WEB_TOOLS_HEADER], expected ?? "web_search,web_fetch", `${name} ${path}: ${expected ? "Brain's own" : "the spec's, untouched"}`);
      }
    } finally {
      await r.closeAll();
    }
  }
});
