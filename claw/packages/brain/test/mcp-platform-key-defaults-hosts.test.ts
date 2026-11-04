// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A plugin's MCP server on a host the operator's defaults file already sends the platform key to gets
 * the key, with MCP_PLATFORM_KEY_ALLOWED_HOSTS unset, through the real engine.
 *
 * The deployment that met this mounts `safe` and `agent-board` from its defaults file with
 * `<SAFE_API_KEY>`, and its plugins carry servers of the same names on the same host. A plugin server
 * replaces the default of its name, so with the key withheld from plugin servers on every unlisted
 * host those tools stopped authenticating altogether. A defaults server that does not name the key
 * vouches for nothing: the plugin's server on its host still gets the empty string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";
import { hostsNamingPlaceholder } from "../src/clients/mcp-config.js";

delete process.env.MCP_PLATFORM_KEY_ALLOWED_HOSTS;
const pw = await startPluginWorld();
/** The same MCP server, by a name only the defaults file's keyed server uses and by one it does not. */
const keyedHostUrl = pw.mcpUrl.replace("127.0.0.1", "localhost");
const otherHostUrl = pw.mcpUrl;

const server = (layer: string, url: string, token = "<SAFE_API_KEY>") => ({
  type: "http", url, token, headers: { "x-layer": layer, "x-key": "<SAFE_API_KEY>" },
});

const world = await startWorld({
  mcp_servers: {
    safe: server("defaults", keyedHostUrl),
    own: { type: "http", url: otherHostUrl, token: "the-operator-s-own-token", headers: { "x-layer": "defaults-own" } },
  },
});
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); await pw.close(); });

test("a plugin server on a host the defaults file sends the key to gets it; one elsewhere does not", async () => {
  pw.mcpHeaders.length = 0;
  world.script([{ text: "done" }]);
  await new AgentEngine().execute(
    baseRequest({
      session_id: uniqueSession(),
      plugin_id: 5,
      plugin_tools: [{
        id: 17, type: "mcp", name: "plg",
        config: {
          mcpServers: {
            safe: server("plugin", keyedHostUrl),
            elsewhere: server("plugin-elsewhere", otherHostUrl, "the-plugin-s-own-token"),
          },
        },
      }],
    }),
    (async () => {}) as never, undefined, null as never, { attachHands: async () => fakeHands() as never } as never,
  );

  const seen = new Map<string, { auth: unknown; key: unknown }>();
  for (const h of pw.mcpHeaders) {
    if (typeof h["x-layer"] === "string" && !seen.has(h["x-layer"])) {
      seen.set(h["x-layer"], { auth: h.authorization, key: h["x-key"] });
    }
  }
  assert.deepEqual([...seen.keys()].sort(), ["defaults-own", "plugin", "plugin-elsewhere"], "the plugin's `safe`, which replaced the default's, was given the key and connected");
  assert.equal(seen.get("plugin")?.auth, "Bearer ak-user-key", "the plugin's server on the defaults file's keyed host authenticates");
  assert.equal(seen.get("plugin")?.key, "ak-user-key");
  assert.equal(seen.get("plugin-elsewhere")?.key, "", "a host the defaults file reaches without the key is not trusted with it");
});

test("only a server naming the placeholder at a literal host vouches for that host", () => {
  assert.deepEqual(
    [...hostsNamingPlaceholder({
      a: { url: "https://Platform.Example.com/mcp", token: "<SAFE_API_KEY>" },
      b: { url: "https://other.example.com/mcp", token: "fixed" },
      c: { url: "https://third.example.com/mcp", headers: { "x-key": "<SAFE_API_KEY>" } },
      d: { url: "https://<HOST>/mcp", token: "<SAFE_API_KEY>" },
      e: { command: "run-it", token: "<SAFE_API_KEY>" },
    }, "SAFE_API_KEY")].sort(),
    ["platform.example.com", "third.example.com"],
  );
});
