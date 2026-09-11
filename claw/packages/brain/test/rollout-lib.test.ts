// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The rollout guide's decisions, executed rather than read.
 *
 * These four used to be prose in the guide, which meant the only thing a test
 * could do was match the prose -- and matching prose proves the sentence is
 * present, not that the decision is right. Each has one correct answer and a
 * failure mode that reads as success, so each is run here against the inputs
 * that produce it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = new URL("../../../deploy/rollout-lib.sh", import.meta.url).pathname;

/** Run one library call and report its exit code, stdout and stderr. */
function callLib(script: string, cwd?: string): { code: number; out: string; err: string } {
  const wrapped = `set -uo pipefail\n. ${JSON.stringify(LIB)}\n${script}\n`;
  try {
    const out = execFileSync("bash", ["-c", wrapped], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout ?? "", err: err.stderr ?? "" };
  }
}

const census = (over: Record<string, unknown> = {}) => JSON.stringify({
  ok: true, count: 1, unreadable: 0,
  sessions: [{ session_id: "s1", sandbox_name: "sb-1", namespace: "ns", hands_url: "http://a/mcp", workload_id: "" }],
  dag_handles: [],
  ...over,
});

test("chart_dir resolves the override the deploy scripts honour", () => {
  const dir = mkdtempSync(join(tmpdir(), "claw-chart-"));
  try {
    writeFileSync(join(dir, "values.env"), 'CLAW_CHART_DIR="/opt/custom-chart"\n');
    const found = callLib(`chart_dir ${JSON.stringify(join(dir, "values.env"))}`);
    assert.equal(found.code, 0);
    assert.equal(found.out.trim(), "/opt/custom-chart",
      "a check pinned to the in-tree path validates a chart the upgrade never deploys");

    writeFileSync(join(dir, "empty.env"), "DOMAIN=x\n");
    const fallback = callLib(`chart_dir ${JSON.stringify(join(dir, "empty.env"))}`);
    assert.equal(fallback.out.trim(), "claw/deploy/charts/claw", "no override means the default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a values file that cannot be sourced aborts rather than falling back", () => {
  // Falling back to the default here is the same wrong answer as pinning the
  // literal path, arrived at quietly: validation would inspect a chart the
  // deployment does not render and report it green.
  const dir = mkdtempSync(join(tmpdir(), "claw-chart-"));
  try {
    writeFileSync(join(dir, "broken.env"), 'CLAW_CHART_DIR="/opt/x\nthis is (not) shell\n');
    const result = callLib(`chart_dir ${JSON.stringify(join(dir, "broken.env"))}`);

    assert.equal(result.code, 3, "abort, not a default");
    assert.doesNotMatch(result.out, /claw\/deploy\/charts\/claw/);
    assert.match(result.err, /could not be sourced/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the census aborts on every way it can be incomplete", () => {
  const cases: Array<[string, string]> = [
    ["ok:false at HTTP 200, which curl cannot see", census({ ok: false })],
    ["an unreadable record", census({ unreadable: 2 })],
    ["a build whose census cannot see DAG sandboxes", JSON.stringify({ ok: true, unreadable: 0, sessions: [] })],
    ["an empty body", ""],
    ["a body that is not JSON", "<html>gateway error</html>"],
  ];
  for (const [why, body] of cases) {
    const result = callLib(`inventory_judge ${JSON.stringify(body)}`);
    assert.equal(result.code, 3, why);
  }
});

test("a successful read that is empty is not an abort", () => {
  // An empty fleet is the true answer on a low-traffic deployment or one
  // already drained, and the flip and the Brain restart still have to happen.
  const empty = JSON.stringify({ ok: true, count: 0, unreadable: 0, sessions: [], dag_handles: [] });
  const judged = callLib(`inventory_judge ${JSON.stringify(empty)}`);
  assert.equal(judged.code, 0);

  const rows = callLib(`inventory_rows ${JSON.stringify(empty)}`);
  assert.equal(rows.code, 0);
  assert.equal(rows.out.trim(), "", "nothing to iterate, and nothing that stops the rollback");
});

test("the rows a rollback iterates carry both halves of the fleet", () => {
  const body = census({
    dag_handles: [{
      dag_root_task_id: "dag-1", handle: "primary", sandbox_name: "sb-dag",
      namespace: "ns-b", hands_url: "http://b/mcp", workload_id: "",
    }],
  });
  const result = callLib(`inventory_rows ${JSON.stringify(body)}`);
  const names = result.out.trim().split("\n").map((l) => l.split("\t")[1]);
  assert.deepEqual(names.sort(), ["sb-1", "sb-dag"]);
});

test("distinct SaFE workloads in one namespace are not collapsed", () => {
  const body = census({
    count: 3,
    sessions: [
      { session_id: "s1", namespace: "ns", hands_url: "http://wl-1/mcp", workload_id: "wl-1" },
      { session_id: "s2", namespace: "ns", hands_url: "http://wl-2/mcp", workload_id: "wl-2" },
    ],
    dag_handles: [
      { dag_root_task_id: "dag-1", namespace: "ns", hands_url: "http://wl-1/mcp", workload_id: "wl-1" },
    ],
  });
  const result = callLib(`inventory_rows ${JSON.stringify(body)}`);
  const rows = result.out.trim().split("\n").map((line) => line.split("\t"));

  assert.equal(result.code, 0);
  assert.deepEqual(rows.map((row) => row[4]).sort(), ["wl-1", "wl-2"]);
});

test("hands_base strips the MCP suffix the census reports", () => {
  for (const [url, base] of [
    ["http://a:9100/mcp", "http://a:9100"],
    ["http://a:9100/mcp/", "http://a:9100"],
    ["http://a:9100", "http://a:9100"],
  ]) {
    assert.equal(callLib(`hands_base ${JSON.stringify(url)}`).out.trim(), base);
  }
});

/** What the API returns for a task whose bash call really ran and succeeded. */
const refreshed = (over: Record<string, unknown> = {}) => JSON.stringify({
  status: "completed", out: "alive", by_tool: { bash: 1 }, by_tool_ok: { bash: 1 }, ...over,
});

test("a refresh counts only where the machinery says the call succeeded", () => {
  assert.equal(callLib(`settle_verdict '${refreshed()}' bash`).code, 0);

  for (const status of ["failed", "cancelled", "NOT_TERMINAL"]) {
    const result = callLib(`settle_verdict '${refreshed({ status })}' bash`);
    assert.equal(result.code, 1, status);
    assert.match(result.err, /activity task/, status);
  }
});

test("a completed task whose bash call FAILED is not a refresh", () => {
  // The gap a call count cannot see: `by_tool` is incremented before the tool
  // runs, a pre-hook can reject it immediately afterwards, and a command that
  // failed comes back as result text with the task completing normally. All
  // three leave `by_tool.bash == 1` and the sandbox untouched.
  const failed = JSON.stringify({
    status: "completed",
    out: "The command failed and I could not run it.",
    by_tool: { bash: 1 }, by_tool_ok: {},
  });
  const result = callLib(`settle_verdict '${failed}' bash`);

  assert.equal(result.code, 1, "counted, attempted, and still no refresh");
  assert.match(result.err, /no successful bash call/);
});

test("a model that merely says the right words is not evidence", () => {
  // The decisive case for anything read out of model text: the final response
  // asserts the command ran, and even repeats a token the prompt handed it,
  // while no successful call happened. Nothing the model writes reaches the
  // verdict.
  const talkedAboutIt = JSON.stringify({
    status: "completed",
    out: "I ran `echo alive` in the sandbox and it printed: alive claw-alive-1234",
    by_tool: { bash: 1 }, by_tool_ok: {},
  });
  assert.equal(callLib(`settle_verdict '${talkedAboutIt}' bash`).code, 1);

  const neverCalled = JSON.stringify({
    status: "completed", out: "alive claw-alive-1234", by_tool: {}, by_tool_ok: {},
  });
  assert.equal(callLib(`settle_verdict '${neverCalled}' bash`).code, 1);
});

test("a build that cannot report tool success has no reading, and says so", () => {
  // Silently passing on an older payload would make the whole gate vacuous
  // exactly where it is being introduced.
  const older = JSON.stringify({ status: "completed", out: "alive", by_tool: { bash: 1 } });
  const result = callLib(`settle_verdict '${older}' bash`);
  assert.equal(result.code, 1);
  assert.match(result.err, /cannot report whether bash succeeded/);
});

test("an unreadable activity result is a failure", () => {
  assert.equal(callLib(`settle_verdict 'not json' bash`).code, 1);
  assert.equal(callLib(`settle_verdict '{}' bash`).code, 1);
});

test("G7-d2 stops at a refresh whose command failed", () => {
  const gate = `
    dispatch() { echo "task-1"; }
    settle() { echo '{"status":"completed","out":"I ran it.","by_tool":{"bash":1},"by_tool_ok":{}}'; }
    tid=$(dispatch 'Run: echo alive') || exit 1
    settle_verdict "$(settle "$tid")" bash || exit 1
    echo REACHED_THE_CR_CHECK`;
  const result = callLib(gate);

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.out, /REACHED_THE_CR_CHECK/,
    "the gate stops at the refresh, not at whatever the CR happens to be doing");
  assert.match(result.err, /no successful bash call/);
});

test("G7-d2 proceeds past a refresh the sandbox actually performed", () => {
  const gate = `
    dispatch() { echo "task-1"; }
    settle() { echo '${refreshed()}'; }
    tid=$(dispatch 'Run: echo alive') || exit 1
    settle_verdict "$(settle "$tid")" bash || exit 1
    deadline_verdict gone true 1200 1000`;
  assert.equal(callLib(gate).code, 0);
});

test("the absolute-lifetime verdict cannot be reached without a live observation", () => {
  // A first look that finds the CR already gone proves only that it is gone
  // now. Without the prior live observation the whole gate passes trivially on
  // a sandbox something else reclaimed long before.
  const noPriorLook = callLib('deadline_verdict gone false 2000 1000');
  assert.equal(noPriorLook.code, 1);
  assert.match(noPriorLook.err, /never observed live/);
});

test("a CR that disappears before its deadline is a failure, not the cap firing", () => {
  const early = callLib('deadline_verdict gone true 900 1000');
  assert.equal(early.code, 1);
  assert.match(early.err, /reclaimed by something other than the absolute cap/);
});

test("a CR that outlives its deadline is a failure too", () => {
  const late = callLib('deadline_verdict present true 1001 1000');
  assert.equal(late.code, 1);
  assert.match(late.err, /outlived its own shutdownTime/);
});

test("gone at or after the deadline, having been seen live, is the pass", () => {
  assert.equal(callLib('deadline_verdict gone true 1000 1000').code, 0, "at the deadline");
  assert.equal(callLib('deadline_verdict gone true 1200 1000').code, 0, "after it");
  assert.equal(callLib('deadline_verdict present true 900 1000').code, 3,
    "still present and still early is neither verdict yet -- keep watching");
});
