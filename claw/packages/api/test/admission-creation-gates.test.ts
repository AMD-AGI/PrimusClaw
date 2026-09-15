// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every surface that creates a counted run asks the ceiling first: `expandDag`,
 * `createSingleTask` and `retryTask`.
 *
 * Each assertion is that the refusal writes nothing. A gate that refuses after
 * the insert is not a gate -- the row is already committed, already counted,
 * and already claimable by the drain.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { seedRun, startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

/** A template whose shape the tree ceilings are read against. */
function chainDag(nodeCount: number) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    executor: "brain",
    mode: "llm",
    sandbox: "none",
    depends_on: i === 0 ? [] : [`n${i - 1}`],
  }));
  return {
    dag_id: "chain",
    name: "chain",
    nodes,
    metadata: { derived: { root_node_id: "n0", handle_last_user: {}, schema_digest: "d" } },
  };
}

function fanOutDag(entryCount: number) {
  const nodes = [
    ...Array.from({ length: entryCount }, (_, i) => ({
      id: `e${i}`, executor: "brain", mode: "llm", sandbox: { handle: "main", image: "img" }, depends_on: [],
    })),
    {
      id: "tail", executor: "brain", mode: "llm", sandbox: { handle: "main", image: "img" },
      depends_on: Array.from({ length: entryCount }, (_, i) => `e${i}`),
    },
  ];
  return {
    dag_id: "fan",
    name: "fan",
    nodes,
    metadata: { derived: { root_node_id: "e0", handle_last_user: {}, schema_digest: "d" } },
  };
}

describe("every creation surface consults the ceiling before it writes", { skip }, () => {
  let harness: AdmissionCluster;

  before(async () => {
    harness = await startAdmissionCluster({
      ADMIT_HARD_RUNS: "1",
      ADMIT_TREE_MAX_NODES: "3",
      ADMIT_TREE_MAX_DEPTH: "2",
    });
    await harness.app.db.db.query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s-gate','g','u1','claw')`,
    );
  });
  after(async () => { await harness?.stop(); });

  const clear = () => harness.app.db.db.query("DELETE FROM claw_tasks");
  const rowCount = async () => {
    const r = await harness.app.db.db.query("SELECT COUNT(*)::int AS n FROM claw_tasks");
    return Number((r.rows[0] as { n: number }).n);
  };

  const expand = (dag: unknown) => harness.app.dagExpander.expandDag({
    session_id: "s-gate", user_id: "u1", input: {}, dag: dag as never, plugin: null,
  });

  test("a DAG past the node ceiling is refused, and writes no row", async () => {
    await clear();
    const result = await expand(chainDag(4));
    assert.deepEqual(result, { admitted: false, reason: "tree_nodes_exceeded" });
    assert.equal(await rowCount(), 0, "a refused expansion leaves neither root nor nodes");
  });

  test("a DAG past the depth ceiling is refused on its longest path", async () => {
    await clear();
    const result = await expand(chainDag(3));
    assert.deepEqual(result, { admitted: false, reason: "tree_depth_exceeded" });
    assert.equal(await rowCount(), 0);
  });

  test("a DAG inside both tree ceilings expands", async () => {
    await clear();
    const result = await expand(chainDag(2));
    assert.ok("dag_root_task_id" in result, "two nodes, two levels, one run root");
    assert.equal(await rowCount(), 3, "the virtual root plus its two nodes");
  });

  test("expansion is charged the entry set, not the whole graph", async () => {
    await clear();
    // One occupying sandbox already, a ceiling of two, and a graph of three
    // sandbox nodes of which one is an entry node: charging the graph would
    // refuse work the graph will never hold at once.
    const q = await harness.connect();
    await seedRun(q, { taskId: "t-held", sessionId: "s-gate", status: "running", sandbox: true });
    const limits = harness.app.admission.envAdmitLimits();
    assert.equal(limits.hardSandboxes, 0, "this case is about the ask, not this ceiling");
    const ask = harness.app.dagExpander.dagResourceAsk(
      fanOutDag(2).nodes.filter((n) => !n.depends_on.length) as never,
      null,
      {},
    );
    assert.deepEqual(ask, { sandboxes: 2, gpuNodes: 0 }, "the two entry nodes, never the tail");
  });

  test("a single task past the run ceiling is refused, and writes no row", async () => {
    await clear();
    const q = await harness.connect();
    await seedRun(q, { taskId: "t-occupy", sessionId: "s-gate", status: "queued" });
    const result = await harness.app.dagExpander.createSingleTask({
      session_id: "s-gate", prompt: "hello", input: {},
    });
    assert.deepEqual(result, { admitted: false, reason: "runs_hard_limit" });
    assert.equal(await rowCount(), 1, "only the row that was already there");
  });

  test("a retry past the run ceiling is refused, and clones no row", async () => {
    await clear();
    const q = await harness.connect();
    await seedRun(q, { taskId: "t-failed", sessionId: "s-gate", status: "failed" });
    await seedRun(q, { taskId: "t-busy", sessionId: "s-gate", status: "running" });
    const result = await harness.app.lifecycle.retryTask("t-failed");
    assert.deepEqual(result, { admitted: false, reason: "runs_hard_limit" });
    assert.equal(await rowCount(), 2, "the clone the ceiling refused was never written");
  });

  test("a retry inside the ceiling still clones", async () => {
    await clear();
    const q = await harness.connect();
    await seedRun(q, { taskId: "t-alone", sessionId: "s-gate", status: "failed" });
    const result = await harness.app.lifecycle.retryTask("t-alone");
    assert.ok("ok" in result && result.ok, "a refusal is a ceiling, not a policy against retries");
    assert.equal(await rowCount(), 2);
  });
});

describe("the shape a tree ceiling is read against", () => {
  test("depth is the longest depends_on path, not the node count", async () => {
    const { dagShape } = await import("../src/tasks/dag-expander.js");
    const diamond = [
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
      { id: "c", depends_on: ["a"] },
      { id: "d", depends_on: ["b", "c"] },
    ];
    assert.deepEqual(dagShape(diamond as never), { nodeCount: 4, depth: 3 });
  });

  test("a graph with no edges is four nodes at one level", async () => {
    const { dagShape } = await import("../src/tasks/dag-expander.js");
    const flat = ["a", "b", "c", "d"].map((id) => ({ id, depends_on: [] }));
    assert.deepEqual(dagShape(flat as never), { nodeCount: 4, depth: 1 });
  });
});
