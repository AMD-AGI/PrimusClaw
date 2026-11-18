// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A long JSON list from an MCP server is counted whole before it is cut (`agent/list-fit.ts`, `truncateToolResult`).
 *
 *   L1  Autopilot's status, pools and allocations over the cap: in_result of each list is its whole length, by counts the
 *       allocations per pool and per phase over all of them, both lists keep their first items, and the answer fits the bound
 *   L2  SaFE's page ({items, totalCount}) keeps the server's own totalCount, and the note says by is of this page and how to count
 *       one kind across every page
 *   L3  a result that fits once written compactly is returned whole; one that is not JSON, or holds no list, is cut head and tail
 *   L4  the API's GitHub lists and non-MCP tools are not fitted
 *   L5  a field each item has its own value of is not counted, and neither are times, links or titles
 *   L6  Pulse's page ({matched, shown, items}) keeps its matched as the count of every match, and the note says by is of this page;
 *       a page whose matched is all of it (state submitted: 42 of 42) is not called one page
 */
import assert from "node:assert/strict";
import test from "node:test";

import { countBy, fitJsonResult, LIST_FIT_MAX_CHARS } from "../src/agent/list-fit.js";
import { fitsAsList, truncateToolResult } from "../src/agent/agent-loop.js";

const pools = Array.from({ length: 40 }, (_, i) => ({
  pool_id: `pool-${String(i).padStart(2, "0")}-${"x".repeat(30)}`, namespace: i < 30 ? "" : "autopilot-acceptance", policy_revision: 90000 + i,
  max_running: 0, layout: i % 2 ? null : { node_count: 1, gpu_count: 8, qos_ladder: ["amd-burst-qos"], fields: { partitions: ["amd-spur-v2"] } },
}));
const allocations = Array.from({ length: 57 }, (_, i) => ({
  allocation_id: `alloc-${i}-${"y".repeat(28)}`, pool_id: i < 40 ? "pool-top-models" : i < 52 ? "pool-acceptance" : "pool-hyperloom",
  phase: i % 3 === 0 ? "Ready" : i % 3 === 1 ? "Released" : "Pending", node: `crsuse2-m2m-v3-${200 + i}`, submitted_at: `2026-11-06T0${i % 10}:00:00Z`,
}));
const status = { generated_at: "2026-11-06T15:15:58Z", cluster_enabled: true, pools, allocations };

test("L1 Autopilot's pools and allocations are counted whole, both lists keep their first items, and it fits", () => {
  const raw = JSON.stringify(status);
  assert.ok(raw.length > LIST_FIT_MAX_CHARS);
  const seen = truncateToolResult(raw, "mcp__autopilot__get_status");
  assert.ok(seen.length <= LIST_FIT_MAX_CHARS, `${seen.length}`);
  const fit = JSON.parse(seen);
  assert.equal(fit.complete, false);
  assert.deepEqual(fit.in_result, { pools: 40, allocations: 57 });
  assert.deepEqual(fit.by.allocations.pool_id, { "pool-top-models": 40, "pool-acceptance": 12, "pool-hyperloom": 5 });
  assert.deepEqual(fit.by.allocations.phase, { Ready: 19, Released: 19, Pending: 19 });
  assert.equal(fit.by.allocations.allocation_id, undefined, "one value per item is an id");
  assert.equal(fit.by.allocations.submitted_at, undefined, "a time is not a grouping");
  assert.deepEqual(fit.by.pools.namespace, { "": 30, "autopilot-acceptance": 10 });
  assert.ok(fit.shown.pools > 0 && fit.shown.pools < 40);
  assert.ok(fit.shown.allocations > 0 && fit.shown.allocations < 57);
  assert.deepEqual(fit.result.pools, pools.slice(0, fit.shown.pools));
  assert.deepEqual(fit.result.allocations, allocations.slice(0, fit.shown.allocations));
  assert.equal(fit.result.generated_at, status.generated_at);
  assert.match(fit.note, /never by counting the items shown/);
  assert.doesNotMatch(fit.note, /one page/, "a result without a count of its own is all there is");
});

test("L2 SaFE's page keeps its own totalCount beside the counts of what it sent", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    workloadId: `wl-${i}-${"z".repeat(200)}`, workspace: i < 35 ? "top-models" : "spur-vk", phase: i < 44 ? "Running" : "Failed",
    userName: `user${i % 4}`, creationTime: "2026-11-06T06:00:00",
  }));
  const raw = JSON.stringify({ items, totalCount: 183 }, null, 2);
  const fit = JSON.parse(truncateToolResult(raw, "mcp__safe__workload_list", "/workspace/.tool-results/t.json"));
  assert.equal(fit.result.totalCount, 183);
  assert.deepEqual(fit.in_result, { items: 50 });
  assert.deepEqual(fit.by.items.workspace, { "top-models": 35, "spur-vk": 15 });
  assert.deepEqual(fit.by.items.phase, { Running: 44, Failed: 6 });
  assert.equal(fit.by.items.creationTime, undefined);
  assert.match(fit.note, /saved at \/workspace\/\.tool-results\/t\.json/);
  assert.match(fit.note, /result\.totalCount \(183\) is the server's count of every match, of which these 50 are one page/);
  assert.match(fit.note, /call the tool with that filter \(a phase, a user\) and read its totalCount/);
});

test("L3 a result that fits compactly is whole; one that is not JSON or has no list is cut head and tail", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: i, state: "open" }));
  const pretty = JSON.stringify({ items }, null, 8);
  assert.ok(pretty.length > 6000 && JSON.stringify({ items }).length < LIST_FIT_MAX_CHARS);
  assert.equal(truncateToolResult(pretty, "mcp__safe__node_list"), JSON.stringify({ items }));
  const prose = "word ".repeat(4000);
  assert.match(truncateToolResult(prose, "mcp__safe__node_list"), /chars truncated for context efficiency/);
  const noList = JSON.stringify({ blob: "b".repeat(20_000) });
  assert.equal(fitJsonResult(noList), null);
  assert.match(truncateToolResult(noList, "mcp__autopilot__get_whoami"), /chars truncated for context efficiency/);
});

test("L4 the API's GitHub lists and tools that are not MCP's are left as they were", () => {
  assert.equal(fitsAsList("mcp__github__issue_search"), false);
  assert.equal(fitsAsList("mcp__github_review__gh_pr_get"), false);
  assert.equal(fitsAsList("bash"), false);
  assert.equal(fitsAsList("mcp__autopilot__get_status"), true);
  assert.equal(fitsAsList("mcp__github__pr_get"), true);
  const raw = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: i, s: "a".repeat(40) })) });
  assert.match(truncateToolResult(raw, "bash"), /chars truncated for context efficiency/);
});

test("L5 ids, times, links and titles are not counted; groupings are, most frequent value first", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `i${i}`, repo: i < 7 ? "AMD-AGI/PrimusClaw" : "ROCm/spur", title: i < 5 ? "same" : "other", url: "https://x", updated_at: "t",
    draft: i === 0,
  }));
  const by = countBy(items);
  assert.deepEqual(by.repo, { "AMD-AGI/PrimusClaw": 7, "ROCm/spur": 3 });
  assert.deepEqual(by.draft, { false: 9, true: 1 });
  for (const k of ["id", "title", "url", "updated_at"]) assert.equal(by[k], undefined, k);
});

test("L6 Pulse's upstream_prs page keeps its matched as the count of every match, and by is of the page", () => {
  // The shape Pulse answered on 2026-11-09 (limit 50 of 193 matched, 27066 characters): the latest items, every state mixed.
  const states = ["submitted", "merged", "closed", "draft", "created"];
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: 300 - i, repo: ["vllm", "sglang", "aiter", "spur"][i % 4], state: i < 23 ? "submitted" : states[1 + (i % 4)], scope: "upstream",
    updated_at: `2026-11-0${1 + (i % 8)}T00:00:00Z`, rebase_status: i % 3 ? "clean" : "conflict", title: `[ROCm] change ${i} ${"t".repeat(400)}`,
  }));
  const raw = JSON.stringify({ matched: 193, shown: 50, items });
  assert.ok(raw.length > LIST_FIT_MAX_CHARS);
  const fit = JSON.parse(truncateToolResult(raw, "mcp__pulse__upstream_prs"));
  assert.equal(fit.complete, false);
  assert.equal(fit.result.matched, 193);
  assert.deepEqual(fit.in_result, { items: 50 });
  assert.equal(fit.by.items.state.submitted, 23);
  assert.match(fit.note, /result\.matched \(193\) is the server's count of every match, of which these 50 are one page, so by covers this page only/);
  assert.match(fit.note, /call the tool with that filter \(a phase, a user\) and read its matched/);

  // Filtered to one state, matched is the page's own length: the page is all of it, and the note does not call it one.
  const open = items.slice(0, 23).map((it, i) => ({ ...it, id: 400 + i }));
  const whole = JSON.parse(truncateToolResult(JSON.stringify({ matched: 23, shown: 23, items: open }), "mcp__pulse__upstream_prs"));
  assert.deepEqual(whole.in_result, { items: 23 });
  assert.doesNotMatch(whole.note, /one page/);
});
