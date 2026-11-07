// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SaFE's workload list without a workspace (`tools/workspace-fanout.ts`): a member's unscoped call, which SaFE refuses with 403,
 * is read across the workspaces the member may use; an admin's is answered as before.
 *
 *   WF1 a member's unscoped list: one page per workspace of user_self, the model's filters kept, merged newest first, totalCount
 *       the sum, complete, and no error
 *   WF2 an admin's unscoped list, and any call that names a workspace, is one call answered as the server answered it
 *   WF3 one workspace refused: the others are still returned, the refused one is named with SaFE's reason, complete is false and
 *       the note says the count is not the whole
 *   WF4 more workspaces than the bound: the rest are named as not read; a page shorter than its count says truncated
 *   WF5 no workspace at all is an honest empty answer; an unreadable user_self keeps the 403 and says to name a workspace;
 *       a failure that is not a 403 is passed through
 *   WF6 through the real engine against a real MCP server shaped like SaFE's: the model is shown the merged list, not the 403
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { McpCallOutcome, McpToolCaller } from "../src/clients/mcp.js";
import { callWithWorkspaceFanout, FANOUT_MAX_WORKSPACES, workspacesOfSelf } from "../src/tools/workspace-fanout.js";

const NAME = "mcp__safe__workload_list";
const FORBIDDEN = "api GET /workloads?limit=1&phase=Running: 403 Forbidden (Primus.00003)";

type Ws = Record<string, { items: Array<Record<string, unknown>>; totalCount: number } | "forbidden" | "boom">;

/** A SaFE MCP server: `admin` may list unscoped; everyone may list the workspaces in `ws`; user_self names `self`. */
function fakeSafe(opts: { admin?: boolean; self?: string[] | "broken"; ws?: Ws; all?: unknown }) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client: McpToolCaller = {
    async callTool(tool: string, args: Record<string, unknown>, outcome?: McpCallOutcome) {
      calls.push({ tool, args });
      const err = (t: string) => { if (outcome) outcome.isError = true; return t; };
      if (tool === "user_self") {
        if (opts.self === "broken") return err("api GET /users/self: 500 Internal Server Error");
        return JSON.stringify({ id: "u1", name: "member", roles: ["default"], workspaces: (opts.self ?? []).map((id) => ({ id, name: id })) });
      }
      assert.equal(tool, "workload_list");
      const scope = args.workspace_id as string | undefined;
      if (!scope) return opts.admin ? JSON.stringify(opts.all) : err(FORBIDDEN);
      const page = opts.ws?.[scope];
      if (page === undefined || page === "forbidden") return err(`api GET /workloads?workspaceId=${scope}: 403 Forbidden (Primus.00003)`);
      if (page === "boom") throw new Error("socket hang up");
      const limit = typeof args.limit === "number" ? args.limit : 100;
      return JSON.stringify({ items: page.items.slice(0, limit), totalCount: page.totalCount }, null, 2);
    },
  };
  return { client, calls };
}

const wl = (id: string, ws: string, t: string, phase = "Running") => ({ workloadId: id, workspaceId: ws, creationTime: t, phase });

test("WF1 a member's unscoped list is read per workspace of user_self, filters kept, merged newest first", async () => {
  const { client, calls } = fakeSafe({
    self: ["crusoe-spur-vk", "global-cpu"],
    ws: {
      "crusoe-spur-vk": { items: [wl("a1", "crusoe-spur-vk", "2026-11-07T09:00:00")], totalCount: 3 },
      "global-cpu": { items: [wl("b1", "global-cpu", "2026-11-07T10:00:00")], totalCount: 40 },
    },
  });
  const outcome = { isError: false };
  const out = JSON.parse(await callWithWorkspaceFanout(client, NAME, "workload_list", { limit: 1, phase: "Running" }, outcome));
  assert.equal(outcome.isError, false);
  assert.deepEqual(calls.map((c) => c.tool), ["workload_list", "user_self", "workload_list", "workload_list"]);
  for (const c of calls.slice(2)) assert.equal(c.args.phase, "Running", "the model's filter goes to every workspace");
  assert.deepEqual(calls.slice(2).map((c) => c.args.workspace_id).sort(), ["crusoe-spur-vk", "global-cpu"]);
  assert.equal(out.totalCount, 43);
  assert.equal(out.complete, true);
  assert.equal(out.truncated, true);
  assert.equal(out.scope, "caller_workspaces");
  assert.deepEqual(out.items.map((i: { workloadId: string }) => i.workloadId), ["b1"], "newest first, cut to the asked limit");
  assert.deepEqual(out.workspaces, [
    { workspace_id: "crusoe-spur-vk", totalCount: 3, returned: 1 },
    { workspace_id: "global-cpu", totalCount: 40, returned: 1 },
  ]);
  assert.equal(out.workspaces_failed, undefined);
  assert.match(out.note, /every one of them/);
  assert.doesNotMatch(JSON.stringify(out), /403/);
});

test("WF2 an admin's unscoped list and a scoped call are one call, answered as the server answered", async () => {
  const all = { items: [wl("x", "top-models", "2026-11-07T08:00:00")], totalCount: 2086 };
  const admin = fakeSafe({ admin: true, all });
  const outcome = { isError: false };
  assert.equal(await callWithWorkspaceFanout(admin.client, NAME, "workload_list", { limit: 1 }, outcome), JSON.stringify(all));
  assert.equal(outcome.isError, false);
  assert.deepEqual(admin.calls.map((c) => c.tool), ["workload_list"]);

  const member = fakeSafe({ self: ["global-cpu"], ws: { "global-cpu": { items: [], totalCount: 0 } } });
  const scoped = await callWithWorkspaceFanout(member.client, NAME, "workload_list", { workspace_id: "global-cpu" });
  assert.deepEqual(JSON.parse(scoped), { items: [], totalCount: 0 });
  assert.deepEqual(member.calls.map((c) => c.tool), ["workload_list"]);

  // A tool that is not a fanned-out list is not touched, whatever it answers.
  const other = fakeSafe({});
  const o2 = { isError: false };
  await callWithWorkspaceFanout(other.client, "mcp__safe__workload_get", "workload_list", {}, o2);
  assert.equal(o2.isError, true);
  assert.equal(other.calls.length, 1);
});

test("WF3 one workspace refused: the others are returned, the gap named, the count said to be partial", async () => {
  const { client } = fakeSafe({
    self: ["a", "b", "c"],
    ws: { a: { items: [wl("a1", "a", "2026-11-07T01:00:00")], totalCount: 1 }, b: "forbidden", c: "boom" },
  });
  const outcome = { isError: false };
  const out = JSON.parse(await callWithWorkspaceFanout(client, NAME, "workload_list", {}, outcome));
  assert.equal(outcome.isError, false, "one workspace read is an answer, not an error");
  assert.equal(out.totalCount, 1);
  assert.equal(out.complete, false);
  assert.deepEqual(out.workspaces.map((w: { workspace_id: string }) => w.workspace_id), ["a"]);
  assert.deepEqual(out.workspaces_failed.map((f: { workspace_id: string }) => f.workspace_id), ["b", "c"]);
  assert.match(out.workspaces_failed[0].error, /403 Forbidden/);
  assert.match(out.workspaces_failed[1].error, /socket hang up/);
  assert.match(out.note, /not the whole count/);

  const none = fakeSafe({ self: ["b"], ws: { b: "forbidden" } });
  const o2 = { isError: false };
  const all = JSON.parse(await callWithWorkspaceFanout(none.client, NAME, "workload_list", {}, o2));
  assert.equal(o2.isError, true, "no workspace could be read: the call failed");
  assert.equal(all.complete, false);
});

test("WF4 more workspaces than the bound are named as not read", async () => {
  const self = Array.from({ length: FANOUT_MAX_WORKSPACES + 3 }, (_, i) => `ws${i}`);
  const ws: Ws = Object.fromEntries(self.map((id) => [id, { items: [wl(`${id}-1`, id, "2026-11-07T00:00:00")], totalCount: 1 }]));
  const { client, calls } = fakeSafe({ self, ws });
  const out = JSON.parse(await callWithWorkspaceFanout(client, NAME, "workload_list", {}));
  assert.equal(calls.filter((c) => c.args.workspace_id).length, FANOUT_MAX_WORKSPACES, "bounded");
  assert.equal(out.totalCount, FANOUT_MAX_WORKSPACES);
  assert.deepEqual(out.workspaces_not_read, self.slice(FANOUT_MAX_WORKSPACES));
  assert.equal(out.complete, false);
  assert.equal(out.truncated, false);
});

test("WF5 no workspace, an unreadable user_self, and a failure that is not a 403", async () => {
  const empty = fakeSafe({ self: [] });
  const o1 = { isError: false };
  const out = JSON.parse(await callWithWorkspaceFanout(empty.client, NAME, "workload_list", {}, o1));
  assert.equal(o1.isError, false);
  assert.deepEqual(out.items, []);
  assert.equal(out.totalCount, 0);
  assert.match(out.note, /member of no workspace/);

  const broken = fakeSafe({ self: "broken" });
  const o2 = { isError: false };
  const text = await callWithWorkspaceFanout(broken.client, NAME, "workload_list", {}, o2);
  assert.equal(o2.isError, true);
  assert.match(text, /could not be read/);
  assert.match(text, /workspace_id/);

  const down: McpToolCaller = {
    async callTool(_t, _a, outcome) { if (outcome) outcome.isError = true; return "api GET /workloads: 502 Bad Gateway"; },
  };
  const o3 = { isError: false };
  assert.equal(await callWithWorkspaceFanout(down, NAME, "workload_list", {}, o3), "api GET /workloads: 502 Bad Gateway");
  assert.equal(o3.isError, true);

  assert.deepEqual(workspacesOfSelf(JSON.stringify({ workspaces: [{ id: "a" }, { id: "a" }, { id: " " }, "b"] })), ["a", "b"]);
  assert.equal(workspacesOfSelf("not json"), null);
});

test("WF6 through the engine: the model sees the merged list, not SaFE's 403", async () => {
  const { startWorld, fakeHands, baseRequest } = await import("./support/platform-defaults-world.js");
  const seen: Array<Record<string, unknown>> = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const server = new McpServer({ name: "safe", version: "1.0.0" });
      server.tool("workload_list", "list", { workspace_id: z.string().optional(), limit: z.number().optional(), phase: z.string().optional() }, async (args) => {
        seen.push(args);
        if (!args.workspace_id) return { content: [{ type: "text" as const, text: FORBIDDEN }], isError: true };
        return { content: [{ type: "text" as const, text: JSON.stringify({ items: [wl(`${args.workspace_id}-1`, args.workspace_id, "2026-11-07T00:00:00")], totalCount: 7 }) }] };
      });
      server.tool("user_self", "self", {}, async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({ name: "member", workspaces: [{ id: "crusoe-spur-vk" }, { id: "global-cpu" }] }) }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const world = await startWorld();
  try {
    const { AgentEngine } = await import("../src/agent/engine.js");
    let body = "";
    world.script([{ tool: NAME, input: { limit: 1, phase: "Running" } }, (b) => { body = b; return { text: "done" }; }]);
    await new AgentEngine().execute(
      baseRequest({
        session_id: `fanout-${Math.random().toString(36).slice(2)}`,
        prompt: "safe的运行情况如何",
        tools_allowlist: [NAME],
        max_turns: 4,
        plugin_id: 9,
        plugin_tools: [{ id: 3, type: "mcp", name: "safe-mcp", config: { mcpServers: { safe: { type: "http", url: `http://127.0.0.1:${port}/mcp`, token: "t" } } } }],
        skip_platform_defaults: true,
      }) as never,
      (async () => {}) as never, undefined, null as never,
      { attachHands: async () => fakeHands() as never } as never,
    );
    assert.deepEqual(seen.map((a) => a.workspace_id ?? null).sort(), ["crusoe-spur-vk", "global-cpu", null].sort());
    assert.match(body, /caller_workspaces/);
    assert.match(body, /\\"totalCount\\":14/);
    assert.doesNotMatch(body, /403 Forbidden/);
  } finally {
    await world.close();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
