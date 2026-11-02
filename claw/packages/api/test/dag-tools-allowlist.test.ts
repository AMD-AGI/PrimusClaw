// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a DAG node sends Brain as `tools_allowlist`, read the way Brain reads it.
 *
 * Brain offers a run only the tools its allowlist names. The expander used to
 * fill a node that wrote no list with the plugin's MCP tool-row names (`board`),
 * which Brain's tools are not called (`mcp__board__ping`): once Brain honoured
 * the field, every plugin-backed llm node would have lost bash and the plugin's
 * own MCP tools. So the two ends are tested together here: the list
 * `applyPluginDefaults` produces is handed to Brain's own parser and filter, over
 * the tool names a plugin-backed node is actually offered.
 *
 * The brain modules imported are the pure ones (the parser and the schema
 * filter), the same two the engine uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filterToolSchemas, parseToolAllowlist } from "../../brain/src/tools/allowlist.js";
import { applyPluginDefaults, nodeToolsAllowlist } from "../src/tasks/dag-expander.js";
import type { DagNode } from "../src/tasks/dags/types.js";

/** A plugin with one MCP server per row, one row with two servers, and rows that are not MCP. */
const PLUGIN = {
  id: 5, version: "v1", image: "img", resource: {},
  tools: [
    { id: 1, type: "mcp", name: "board", config: { mcpServers: { board: { type: "http", url: "http://board.test/mcp" } } } },
    { id: 2, type: "mcp", name: "multi", config: { mcpServers: { alpha: { type: "http", url: "http://a.test" }, beta: { type: "http", url: "http://b.test" } } } },
    { id: 3, type: "MCP", name: "upper", config: { mcpServers: { upper: { type: "http", url: "http://u.test" } } } },
    { id: 4, type: "mcp", name: "bq", config: { scope: "backend" } },
    { id: 5, type: "skill", name: "triage", config: { s3_key: "skills/triage/" } },
    { id: 6, type: "rule", name: "style", config: { s3_key: "rules/style.md" } },
  ],
};

/**
 * What Brain offers a plugin-backed llm node before any allowlist: its own tools,
 * the plugin's MCP servers' (`mcp__<server>__<tool>`), and a deployment default's.
 */
const OFFERED = [
  "bash", "read", "write", "edit", "task", "save_memory",
  "mcp__board__ping", "mcp__board__pong", "mcp__alpha__x", "mcp__beta__y", "mcp__upper__z", "mcp__default__q",
];

const node = (over: Partial<DagNode> = {}): DagNode => ({
  id: "n1", executor: "brain", mode: "llm", sandbox: "none", ...over,
}) as DagNode;

/** What Brain would offer a node whose request carries this list. */
const seenBy = (list: unknown[]): string[] =>
  filterToolSchemas(OFFERED.map((name) => ({ name })), parseToolAllowlist(list)).map((s) => s.name);

interface Row {
  name: string;
  tools?: unknown;
  plugin?: typeof PLUGIN | null;
  /** Exactly what the node row carries. */
  sent: unknown[];
  /** What Brain then offers the node. */
  offered: string[];
}

const rows: Row[] = [
  // The regression this file exists for: today the node has every tool.
  { name: "no list, plugin with MCP rows: no restriction, bash and the plugin's MCP tools stay", plugin: PLUGIN, sent: [], offered: OFFERED },
  { name: "no list, no plugin: no restriction", plugin: null, sent: [], offered: OFFERED },
  { name: "an empty list is no restriction", tools: [], plugin: PLUGIN, sent: [], offered: OFFERED },
  { name: "a list that is not a list is no restriction, as it was before Brain read it", tools: "bash", plugin: PLUGIN, sent: [], offered: OFFERED },

  // An explicit list is what the node sees, and nothing else.
  { name: "a builtin name passes through", tools: ["bash"], plugin: PLUGIN, sent: ["bash"], offered: ["bash"] },
  { name: "builtins only: the plugin's MCP tools are not offered", tools: ["bash", "read"], plugin: PLUGIN, sent: ["bash", "read"], offered: ["bash", "read"] },
  { name: "an MCP tool row's name becomes its server's prefix", tools: ["board"], plugin: PLUGIN, sent: ["mcp__board__*"], offered: ["mcp__board__ping", "mcp__board__pong"] },
  { name: "a row with two servers becomes one prefix per server", tools: ["multi", "read"], plugin: PLUGIN, sent: ["mcp__alpha__*", "mcp__beta__*", "read"], offered: ["read", "mcp__alpha__x", "mcp__beta__y"] },
  { name: "a row whose type is spelled in capitals is still an MCP row", tools: ["upper"], plugin: PLUGIN, sent: ["mcp__upper__*"], offered: ["mcp__upper__z"] },
  { name: "a name already in Brain's form is left alone (exact)", tools: ["mcp__board__ping"], plugin: PLUGIN, sent: ["mcp__board__ping"], offered: ["mcp__board__ping"] },
  { name: "a name already in Brain's form is left alone (prefix)", tools: ["mcp__default__*"], plugin: PLUGIN, sent: ["mcp__default__*"], offered: ["mcp__default__q"] },
  { name: "a row that declares no server has nothing to convert to", tools: ["bq"], plugin: PLUGIN, sent: ["bq"], offered: [] },
  { name: "a skill row's name is not an MCP tool", tools: ["triage"], plugin: PLUGIN, sent: ["triage"], offered: [] },
  { name: "a name the plugin does not know passes through", tools: ["nope"], plugin: PLUGIN, sent: ["nope"], offered: [] },
  { name: "the same row named twice, or by both spellings, is listed once", tools: ["board", "board", "mcp__board__*"], plugin: PLUGIN, sent: ["mcp__board__*"], offered: ["mcp__board__ping", "mcp__board__pong"] },
  { name: "without a plugin a row name has nothing to resolve against", tools: ["board"], plugin: null, sent: ["board"], offered: [] },
];

for (const row of rows) {
  test(row.name, () => {
    const n = node(row.tools === undefined ? {} : { tools_allowlist: row.tools as string[] });
    // The path the expander takes, not just the function it calls.
    const sent = applyPluginDefaults(n, row.plugin ?? null).tools_allowlist;
    assert.deepEqual(sent, row.sent, "what the node row carries");
    assert.deepEqual(sent, nodeToolsAllowlist(n, row.plugin ?? null));
    assert.deepEqual(seenBy(sent), row.offered, "what Brain then offers the node");
  });
}

test("a plugin-backed llm node with no list keeps bash and the plugin's MCP tools", () => {
  const sent = applyPluginDefaults(node(), PLUGIN).tools_allowlist;
  const offered = seenBy(sent);
  assert.ok(offered.includes("bash"));
  assert.ok(offered.includes("mcp__board__ping"));
  assert.deepEqual(offered, OFFERED);
});

test("a plugin-backed llm node with a list sees only what the list names", () => {
  const sent = applyPluginDefaults(node({ tools_allowlist: ["read", "board"] }), PLUGIN).tools_allowlist;
  assert.deepEqual(seenBy(sent), ["read", "mcp__board__ping", "mcp__board__pong"]);
  assert.ok(!seenBy(sent).includes("bash"));
});

test("the rest of what a plugin supplies a node is unchanged", () => {
  const out = applyPluginDefaults(node(), PLUGIN);
  assert.deepEqual(out.skills, ["triage"]);
  assert.equal(out.rules_text, null, "rule bodies come from the object store, not this row");
});
