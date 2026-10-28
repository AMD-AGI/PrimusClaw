// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an A2A send hands Brain for the plugin its metadata names.
 *
 * `metadata.plugin_id` is the caller's to name, so the plugin has to be read as
 * the caller sees it -- the same reader and the same visibility rule a chat
 * message goes through (`resolveTaskPlugin`). Read without that rule, any
 * authenticated caller who knew the id of a private plugin ran with its tools,
 * skills and rules. And a plugin that cannot be had has to arrive as `null`,
 * which Brain holds bash on: defaulted to `[]` it declared "no rules" instead.
 *
 * Coverage:
 *   A1 a plugin the caller owns arrives with its tools
 *   A2 a public plugin arrives with its tools
 *   A3 a private plugin of someone else arrives as null, and its config does not
 *   A4 an admin sees what the chat path shows an admin
 *   A5 a plugin that does not exist arrives as null, not as an empty list
 *   A6 a send that names no plugin carries neither field
 *
 * The NATS seam is the one `a2a-publish-failure-classes.test.ts` uses: `js` and
 * `nc` are module bindings `initNats` assigns, so a resolve hook points
 * `routes/a2a.ts` at this module's exports and must be registered before it loads.
 *
 * Only the unary entry is driven. A streaming send that succeeds holds its
 * response open for events, which an injected request waits on for ever; it
 * reaches the same `resolveA2ARunSpec`, whose `auth` argument is required.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { StringCodec } from "nats";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const A2A_MODULE = new URL("../src/routes/a2a.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === A2A_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const sc = StringCodec();

const published: Array<{ subject: string; payload: string }> = [];

export const js = {
  async publish(subject: string, payload: Uint8Array): Promise<void> {
    published.push({ subject, payload: new TextDecoder().decode(payload) });
  },
};

export const nc = {
  subscribe(_subject: string) {
    return {
      unsubscribe(): void { /* nothing to release */ },
      async *[Symbol.asyncIterator]() { /* no events on this connection */ },
    };
  },
};

const skip = postgresSkipReason();

const PLUGIN_ID = 7;
const CALLER = { userId: "u-caller", userName: "u-caller", roles: ["user"], platformKey: "pk", virtualKey: "vk" };
const ADMIN = { ...CALLER, userId: "u-admin", userName: "u-admin", roles: ["system-admin"] };

// Written out rather than derived from the production formatter.
const TOOL_CONFIG = {
  mcpServers: { files: { url: "http://mcp.invalid/files" } },
  bash_approval: [{ label: "no rm", regex: "\\brm\\b" }],
};
const EXPECTED_TOOLS = [
  { id: 11, type: "mcp", name: "files-tool", description: "file access", config: TOOL_CONFIG },
];

interface Ctx {
  harness: AdmissionCluster;
  app: FastifyInstance;
  user: typeof CALLER;
}

/** The plugin `MarketplaceDb` answers for, or none when `plugin` is null. */
function stubPlugin(ctx: Ctx, plugin: { ownedBy: string; isPublic: boolean } | null): void {
  const { MarketplaceDb } = ctx.harness.app.db;
  MarketplaceDb.pluginGetById = (async (id: number) => (
    plugin && id === PLUGIN_ID
      ? {
        id: PLUGIN_ID, name: "plugin", version: "1", images: [], resource: {}, tools: [{ id: 11 }],
        owner_user_id: plugin.ownedBy, is_public: plugin.isPublic,
      }
      : null
  )) as typeof MarketplaceDb.pluginGetById;
  MarketplaceDb.toolsGetByIds = (async () => [
    { id: 11, type: "mcp", name: "files-tool", description: "file access", config: TOOL_CONFIG },
  ]) as typeof MarketplaceDb.toolsGetByIds;
}

let sends = 0;

/** One send, and the execute request it published. */
async function sendAndRead(
  ctx: Ctx, metadata: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  await ctx.harness.app.db.db.query("DELETE FROM claw_tasks");
  await ctx.harness.app.db.db.query("DELETE FROM claw_workspace_refs");
  await ctx.harness.app.db.db.query("DELETE FROM claw_sessions WHERE user_id = 'a2a' OR user_id = $1", [ctx.user.userId]);
  published.length = 0;
  sends += 1;
  const res = await ctx.app.inject({
    method: "POST",
    url: "/a2a",
    headers: { "a2a-version": "1.0" },
    payload: {
      jsonrpc: "2.0", id: 1, method: "SendMessage",
      params: {
        message: { messageId: `m-plugin-${sends}`, role: "user", parts: [{ text: "ls /tmp" }] },
        configuration: { returnImmediately: true },
        ...(metadata ? { metadata } : {}),
      },
    },
  });
  assert.ok(res.statusCode < 500, `the send failed: ${res.statusCode} ${res.body.slice(0, 200)}`);
  const tasks = published.filter((m) => m.subject === "tasks.execute");
  assert.equal(tasks.length, 1, `expected one execute request, got ${tasks.length}: ${res.body.slice(0, 200)}`);
  return JSON.parse(tasks[0]!.payload) as Record<string, unknown>;
}

describe("an A2A send hands Brain the plugin its caller may see", { skip }, () => {
  const ctx = {} as Ctx;

  before(async () => {
    ctx.harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "50" });
    const a2a = await import("../src/routes/a2a.js");
    ctx.app = Fastify();
    ctx.app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = ctx.user; });
    await a2a.registerA2ARoutes(ctx.app);
    await ctx.app.ready();
  });
  after(async () => {
    await ctx.app?.close();
    await ctx.harness?.stop();
  });

  test("A1 a plugin the caller owns arrives with its tools", async () => {
    ctx.user = CALLER;
    stubPlugin(ctx, { ownedBy: CALLER.userId, isPublic: false });
    const request = await sendAndRead(ctx, { plugin_id: PLUGIN_ID });
    assert.equal(request.plugin_id, PLUGIN_ID);
    assert.deepEqual(request.plugin_tools, EXPECTED_TOOLS);
  });

  test("A3 a private plugin of someone else is null, and its config does not travel", async () => {
    ctx.user = CALLER;
    stubPlugin(ctx, { ownedBy: "u-someone-else", isPublic: false });
    const request = await sendAndRead(ctx, { plugin_id: PLUGIN_ID });
    assert.equal(request.plugin_id, PLUGIN_ID);
    assert.equal(request.plugin_tools, null);
    assert.ok(!JSON.stringify(request).includes("mcp.invalid"), "the private plugin's config reached the message");
  });

  test("A2 a public plugin arrives with its tools", async () => {
    ctx.user = CALLER;
    stubPlugin(ctx, { ownedBy: "u-someone-else", isPublic: true });
    const request = await sendAndRead(ctx, { plugin_id: PLUGIN_ID });
    assert.deepEqual(request.plugin_tools, EXPECTED_TOOLS);
  });

  test("A4 an admin sees another user's private plugin, as on the chat path", async () => {
    ctx.user = ADMIN;
    stubPlugin(ctx, { ownedBy: "u-someone-else", isPublic: false });
    const request = await sendAndRead(ctx, { plugin_id: PLUGIN_ID });
    assert.deepEqual(request.plugin_tools, EXPECTED_TOOLS);
  });

  test("A5 a plugin that does not exist is null, not an empty list", async () => {
    ctx.user = CALLER;
    stubPlugin(ctx, null);
    const request = await sendAndRead(ctx, { plugin_id: PLUGIN_ID });
    assert.equal(request.plugin_id, PLUGIN_ID);
    assert.equal(request.plugin_tools, null, "[] would say the plugin declares no bash rules");
  });

  test("A6 a send that names no plugin carries neither field", async () => {
    ctx.user = CALLER;
    stubPlugin(ctx, { ownedBy: CALLER.userId, isPublic: true });
    const request = await sendAndRead(ctx, undefined);
    assert.equal("plugin_id" in request, false);
    assert.equal("plugin_tools" in request, false);
  });
});
