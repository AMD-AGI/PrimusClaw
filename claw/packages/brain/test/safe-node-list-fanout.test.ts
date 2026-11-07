// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SaFE's node list without a workspace (`tools/workspace-fanout.ts`). SaFE answers a member's unscoped `node_list` with 200 and no
 * nodes (measured 2026-11-07 for a default-role member of crusoe-spur-vk and global-cpu: `{"items": null, "totalCount": 0}`, while
 * `workspace_id: global-cpu` answers 6), so the person was told SaFE has no nodes (E229).
 *
 *   NL1 a member's unscoped node list is read per workspace of user_self, filters kept; `limit: -1` (every node) is not cut; a
 *       workspace's empty page (`items: null`) is a count of 0, not a failed workspace
 *   NL2 an admin's non-empty unscoped list, and any call that names a workspace, is one call answered as the server answered it
 *   NL3 an empty answer with an unreadable user_self keeps the empty answer, not an error, and says it does not mean "no nodes"
 *   NL4 an empty workload list (200) is not read again: only the node list treats an empty answer as unscoped
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { McpCallOutcome, McpToolCaller } from "../src/clients/mcp.js";
import { callWithWorkspaceFanout, fansOut } from "../src/tools/workspace-fanout.js";

const NAME = "mcp__safe__node_list";
const EMPTY = JSON.stringify({ items: null, totalCount: 0 }, null, 2);

type Nodes = Record<string, Array<Record<string, unknown>>>;

/** A SaFE MCP server: `admin` sees every node unscoped; anyone else gets SaFE's empty page; user_self names `self`. */
function fakeSafe(opts: { admin?: boolean; self?: string[] | "broken"; ws?: Nodes }) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client: McpToolCaller = {
    async callTool(tool: string, args: Record<string, unknown>, outcome?: McpCallOutcome) {
      calls.push({ tool, args });
      if (tool === "user_self") {
        if (opts.self === "broken") {
          if (outcome) outcome.isError = true;
          return "api GET /users/self: 500 Internal Server Error";
        }
        return JSON.stringify({ id: "u1", roles: ["default"], workspaces: (opts.self ?? []).map((id) => ({ id, name: id })) });
      }
      const ws = args.workspace_id as string | undefined;
      let nodes = ws ? (opts.ws?.[ws] ?? []) : opts.admin ? Object.values(opts.ws ?? {}).flat() : [];
      if (typeof args.phase === "string") nodes = nodes.filter((n) => n.phase === args.phase);
      if (!nodes.length) return EMPTY;
      const limit = typeof args.limit === "number" && args.limit >= 1 ? args.limit : nodes.length;
      return JSON.stringify({ items: nodes.slice(0, limit), totalCount: nodes.length }, null, 2);
    },
  };
  return { client, calls };
}

const node = (id: string, phase = "Ready") => ({ nodeId: id, nodeName: id, phase, available: true });
const WS: Nodes = {
  "global-cpu": Array.from({ length: 6 }, (_, i) => node(`primus-global-vm0${i + 7}`)),
  "crusoe-spur-vk": [node("autopilot-g1"), node("autopilot-g2", "SSHFailed")],
};

test("NL1 a member's unscoped node list is read per workspace; limit -1 returns every node", async () => {
  assert.equal(fansOut(NAME), true);
  const { client, calls } = fakeSafe({ self: ["crusoe-spur-vk", "global-cpu"], ws: WS });
  const outcome = { isError: false };
  const out = JSON.parse(await callWithWorkspaceFanout(client, NAME, "node_list", { brief: true, limit: -1 }, outcome));
  assert.equal(outcome.isError, false);
  assert.deepEqual(calls.map((c) => c.tool), ["node_list", "user_self", "node_list", "node_list"]);
  for (const c of calls.slice(2)) assert.equal(c.args.brief, true, "the model's arguments go to every workspace");
  assert.equal(out.totalCount, 8);
  assert.equal(out.items.length, 8, "limit -1 asks for every node: the merged list is not cut");
  assert.equal(out.truncated, false);
  assert.equal(out.complete, true);
  assert.equal(out.scope, "caller_workspaces");
  assert.match(out.note, /nodes only for an admin/);
  assert.doesNotMatch(out.note, /workloads/);

  const ready = fakeSafe({ self: ["crusoe-spur-vk", "global-cpu"], ws: WS });
  const r = JSON.parse(await callWithWorkspaceFanout(ready.client, NAME, "node_list", { phase: "SSHFailed", limit: 1 }));
  assert.equal(r.totalCount, 1, "a filter is kept per workspace");
  assert.deepEqual(r.items.map((n: { nodeId: string }) => n.nodeId), ["autopilot-g2"]);
  assert.equal(r.complete, true, "a workspace with no matching node (SaFE's items: null) is read, not failed");
  assert.equal(r.workspaces_failed, undefined);

  // Nothing matches anywhere: an answer of 0 across every workspace, not an error.
  const o3 = { isError: false };
  const none = JSON.parse(await callWithWorkspaceFanout(fakeSafe({ self: ["crusoe-spur-vk", "global-cpu"], ws: WS }).client, NAME, "node_list", { phase: "Managing" }, o3));
  assert.equal(o3.isError, false);
  assert.equal(none.totalCount, 0);
  assert.equal(none.complete, true);
  assert.equal(none.workspaces.length, 2);

  // More nodes than SaFE's default page: -1 still means every one, not the first 100.
  const big = fakeSafe({ self: ["a", "b"], ws: { a: Array.from({ length: 90 }, (_, i) => node(`a${i}`)), b: Array.from({ length: 40 }, (_, i) => node(`b${i}`)) } });
  const all = JSON.parse(await callWithWorkspaceFanout(big.client, NAME, "node_list", { limit: -1 }));
  assert.equal(all.totalCount, 130);
  assert.equal(all.items.length, 130);
  const page = JSON.parse(await callWithWorkspaceFanout(fakeSafe({ self: ["a"], ws: { a: WS["global-cpu"] } }).client, NAME, "node_list", { limit: 2 }));
  assert.equal(page.items.length, 2);
  assert.equal(page.truncated, true);
});

test("NL2 an admin's non-empty unscoped list and a scoped call are one call, answered as the server answered", async () => {
  const admin = fakeSafe({ admin: true, self: ["global-cpu"], ws: WS });
  const first = await callWithWorkspaceFanout(admin.client, NAME, "node_list", { brief: true });
  assert.equal(JSON.parse(first).totalCount, 8);
  assert.deepEqual(admin.calls.map((c) => c.tool), ["node_list"]);

  const member = fakeSafe({ self: ["global-cpu"], ws: WS });
  const scoped = JSON.parse(await callWithWorkspaceFanout(member.client, NAME, "node_list", { workspace_id: "global-cpu" }));
  assert.equal(scoped.totalCount, 6);
  assert.equal(scoped.scope, undefined);
  assert.deepEqual(member.calls.map((c) => c.tool), ["node_list"]);
});

test("NL3 an empty answer with an unreadable user_self stays an answer and says it is not 'no nodes'", async () => {
  const { client } = fakeSafe({ self: "broken", ws: WS });
  const outcome = { isError: false };
  const text = await callWithWorkspaceFanout(client, NAME, "node_list", {}, outcome);
  assert.equal(outcome.isError, false);
  assert.ok(text.startsWith(EMPTY));
  assert.match(text, /does not mean there are no nodes/);
  assert.match(text, /workspace_id/);

  const none = fakeSafe({ self: [] });
  const out = JSON.parse(await callWithWorkspaceFanout(none.client, NAME, "node_list", {}));
  assert.equal(out.totalCount, 0);
  assert.match(out.note, /member of no workspace: there are no nodes they can list/);
});

test("NL4 an empty workload list is not read again", async () => {
  const calls: string[] = [];
  const client: McpToolCaller = { async callTool(tool: string) { calls.push(tool); return EMPTY; } };
  assert.equal(await callWithWorkspaceFanout(client, "mcp__safe__workload_list", "workload_list", { phase: "Pending" }), EMPTY);
  assert.deepEqual(calls, ["workload_list"]);
});
