// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which MCP server configs may read the Brain's environment, end to end through
 * the real engine. Four layers name the same real MCP server: the platform
 * defaults file, the request's `mcp_servers`, a marketplace tool and a plugin
 * tool. Each sends a header holding a `<NAME>` placeholder, and the server
 * records what arrived. Only the network edges are fake: LLM, marketplace, S3,
 * the MCP server, Hands.
 *
 * Only the defaults file is written by the operator; the other three are
 * written by whoever sends the message or publishes the tool. So only the
 * defaults file gets environment values, and only the names it lists in
 * `mcp_env_allow`. The defaults file and the request's own servers get the
 * values the request itself carries (`<SAFE_API_KEY>`, the requester's own
 * platform key); a marketplace or plugin server gets it only on a host listed in
 * MCP_PLATFORM_KEY_ALLOWED_HOSTS. The same server is reached as `127.0.0.1`
 * (listed) and as `localhost` (not), so only the host name differs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";

const pw = await startPluginWorld();
/** Stands in for any Brain environment value; not a real credential. */
const PROBE = "probe-value-from-brain-env";
process.env.CLAW261_PROBE = PROBE;
process.env.CLAW261_LISTED = "listed-by-the-defaults-file";
process.env.MCP_PLATFORM_KEY_ALLOWED_HOSTS = " 127.0.0.1 ,mcp.example.internal";
const untrustedUrl = pw.mcpUrl.replace("127.0.0.1", "localhost");

const server = (layer: string, url = pw.mcpUrl) => ({
  type: "http",
  url,
  token: "<SAFE_API_KEY>",
  headers: { "x-layer": layer, "x-probe": "<CLAW261_PROBE>", "x-listed": "<CLAW261_LISTED>", "x-key": "<SAFE_API_KEY>" },
});
/** An empty token is refused before connecting, so the unlisted-host servers carry one of their own to be seen arriving. */
const untrusted = (layer: string) => ({ ...server(layer, untrustedUrl), token: "the-tool-s-own-token" });

const world = await startWorld({
  mcp_servers: { pd: server("defaults") },
  mcp_env_allow: ["CLAW261_LISTED"],
});
world.setTools([{
  id: 41, name: "mkt", type: "mcp",
  config: {
    mcpServers: {
      mkt: server("marketplace"),
      mkt_untrusted: untrusted("marketplace-untrusted"),
      // A listed name that resolves nowhere, pinned by the tool's author to the address the key would go to.
      mkt_pinned: {
        ...server("marketplace-self-pinned", `http://mcp.example.internal:${new URL(pw.mcpUrl).port}/mcp`),
        pinned_address: { address: "127.0.0.1", family: 4 },
      },
    },
  },
}]);
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); await pw.close(); });

async function run(over: Record<string, unknown>): Promise<void> {
  world.script([{ text: "done" }]);
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), ...over }),
    (async () => {}) as never, undefined, null as never, { attachHands: async () => fakeHands() as never } as never,
  );
}

test("only the operator's defaults file reads the environment, and only the names it lists", async () => {
  pw.mcpHeaders.length = 0;
  // A turn with a plugin does not resolve marketplace tool ids, so the plugin gets a turn of its own.
  await run({ mcp_servers: { req: server("request") }, tool_ids: [41] });
  await run({
    plugin_id: 5,
    plugin_tools: [{
      id: 17, type: "mcp", name: "plg",
      config: { mcpServers: { plg: server("plugin"), plg_untrusted: untrusted("plugin-untrusted") } },
    }],
  });

  const seen = new Map<string, { probe: unknown; listed: unknown; auth: unknown; key: unknown }>();
  for (const h of pw.mcpHeaders) {
    if (typeof h["x-layer"] === "string" && !seen.has(h["x-layer"])) {
      seen.set(h["x-layer"], { probe: h["x-probe"], listed: h["x-listed"], auth: h.authorization, key: h["x-key"] });
    }
  }
  assert.deepEqual(
    [...seen.keys()].sort(),
    ["defaults", "marketplace", "marketplace-untrusted", "plugin", "plugin-untrusted", "request"],
    "every layer's server was contacted",
  );
  for (const [layer, got] of seen) {
    if (layer.endsWith("-untrusted")) {
      assert.equal(got.key, "", `${layer}: a third party's server on an unlisted host gets no platform key`);
    } else {
      assert.equal(got.auth, "Bearer ak-user-key", `${layer}: the request's own platform key fills <SAFE_API_KEY>`);
      assert.equal(got.key, "ak-user-key", `${layer}: in a header as well`);
    }
    assert.equal(got.probe, "", `${layer}: a name nobody listed expands to nothing`);
    assert.equal(got.listed, layer === "defaults" ? "listed-by-the-defaults-file" : "", `${layer}: the allow list is the defaults file's own`);
  }
  assert.ok(!JSON.stringify(pw.mcpHeaders).includes(PROBE), "the environment value reached the MCP server");
  assert.ok(!seen.has("marketplace-self-pinned"), "a tool author's pinned_address decided where a trusted host's key went");
  assert.ok(
    !pw.mcpHeaders.some((h) => String(h["x-layer"]).endsWith("-untrusted") && JSON.stringify(h).includes("ak-user-key")),
    "the platform key reached an unlisted host",
  );
});
