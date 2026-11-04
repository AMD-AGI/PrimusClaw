// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A plugin's MCP server at an origin the operator's defaults file already sends the platform key to
 * gets the key, with MCP_PLATFORM_KEY_ALLOWED_HOSTS unset, through the real engine.
 *
 * The deployment that met this mounts `safe` and `agent-board` from its defaults file with
 * `<SAFE_API_KEY>`, and its plugins carry servers of the same names at the same origin. A plugin
 * server replaces the default of its name, so with the key withheld from plugin servers on every
 * unlisted host those tools stopped authenticating altogether. What vouches is the defaults file's
 * keyed server and its exact origin: the same host on another port, a host the defaults file reaches
 * with its own token, and a run that is not given the defaults (one acting as a user) get nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";
import { originsSendingPlaceholder } from "../src/clients/mcp-config.js";

delete process.env.MCP_PLATFORM_KEY_ALLOWED_HOSTS;
const pw = await startPluginWorld();
/** A second MCP server: the vouched host name on another port. */
const otherPort = await startPluginWorld();
/** The same MCP server by the name the defaults file's keyed server uses, and by one it does not. */
const keyedUrl = pw.mcpUrl.replace("127.0.0.1", "localhost");
const otherHostUrl = pw.mcpUrl;
const otherPortUrl = otherPort.mcpUrl.replace("127.0.0.1", "localhost");

const server = (layer: string, url: string, token = "<SAFE_API_KEY>") => ({
  type: "http", url, token, headers: { "x-layer": layer, "x-key": "<SAFE_API_KEY>" },
});

const world = await startWorld({
  mcp_servers: {
    safe: server("defaults", keyedUrl),
    own: { type: "http", url: otherHostUrl, token: "the-operator-s-own-token", headers: { "x-layer": "defaults-own" } },
  },
});
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); await pw.close(); await otherPort.close(); });

async function run(over: Record<string, unknown> = {}) {
  pw.mcpHeaders.length = 0;
  otherPort.mcpHeaders.length = 0;
  world.script([{ text: "done" }]);
  await new AgentEngine().execute(
    baseRequest({
      session_id: uniqueSession(),
      plugin_id: 5,
      plugin_tools: [{
        id: 17, type: "mcp", name: "plg",
        config: {
          mcpServers: {
            safe: server("plugin", keyedUrl),
            elsewhere: server("plugin-other-host", otherHostUrl, "the-plugin-s-own-token"),
            other_port: server("plugin-other-port", otherPortUrl, "the-plugin-s-own-token"),
          },
        },
      }],
      ...over,
    }),
    (async () => {}) as never, undefined, null as never, { attachHands: async () => fakeHands() as never } as never,
  );
  const seen = new Map<string, { auth: unknown; key: unknown }>();
  for (const h of [...pw.mcpHeaders, ...otherPort.mcpHeaders]) {
    if (typeof h["x-layer"] === "string" && !seen.has(h["x-layer"])) {
      seen.set(h["x-layer"], { auth: h.authorization, key: h["x-key"] });
    }
  }
  return seen;
}

test("a plugin server at the origin the defaults file sends the key to gets it; others do not", async () => {
  const seen = await run();
  assert.equal(seen.get("plugin")?.auth, "Bearer ak-user-key", "the plugin's `safe`, which replaced the default's, authenticates");
  assert.equal(seen.get("plugin")?.key, "ak-user-key");
  assert.ok(!seen.has("defaults"), "the plugin's `safe` replaced the default's");
  assert.equal(seen.get("plugin-other-host")?.key, "", "a host the defaults file reaches without the key is not trusted with it");
  assert.equal(seen.get("plugin-other-port")?.key, "", "the vouched host name on another port is another origin");
});

test("a run not given the defaults is not given their trust either", async () => {
  const seen = await run({ withhold_sandbox_keys: true });
  assert.ok(!seen.has("defaults-own"), "no default server was mounted");
  assert.ok(seen.has("plugin-other-host"), "the plugin's servers were mounted");
  assert.notEqual(seen.get("plugin")?.key, "ak-user-key", "the plugin's server got the platform key on the defaults' word");
});

test("only a server sending the placeholder (URL, bearer, header value), at a literal http(s) origin, vouches for it", () => {
  assert.deepEqual(
    [...originsSendingPlaceholder({
      a: { url: "https://Platform.Example.com:443/mcp", token: "<SAFE_API_KEY>" },
      b: { url: "https://other.example.com/mcp", token: "fixed" },
      c: { url: "http://third.example.com:8080/mcp", headers: { "x-key": "<SAFE_API_KEY>" } },
      d: { url: "https://<HOST>/mcp", token: "<SAFE_API_KEY>" },
      e: { command: "run-it", token: "<SAFE_API_KEY>" },
      f: { url: "https://described.example.com/mcp", token: "fixed", description: "takes <SAFE_API_KEY>" },
      g: { url: "https://named.example.com/mcp", token: "fixed", headers: { "x-<SAFE_API_KEY>": "fixed" } },
      h: { url: "https://replaced.example.com/mcp", token: "<SAFE_API_KEY>", headers: { authorization: "Bearer fixed" } },
    }, "SAFE_API_KEY")].sort(),
    ["http://third.example.com:8080", "https://platform.example.com"],
  );
});
