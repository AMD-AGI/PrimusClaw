// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A GPU figure must be a whole number the count can hold.
 *
 * `loadUsage` casts `input->'topology'->>'nodes'` behind a type guard that
 * admits `2.5` and `1e30`; Postgres then aborts the whole aggregate, and every
 * later admission on the fleet is refused by a row that never metered GPUs.
 * The bound belongs at the boundary, and on the paths that persist a figure
 * without passing through one.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { PG_INT4_MAX } from "@claw/utils";
import { validateTopology } from "@claw/protocol";

import { gpuNodesFromSpec } from "../src/tasks/run-spec.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

test("validateTopology refuses a node count int4 cannot hold", () => {
  const over = validateTopology({ nodes: 1e30, backend: "rayjob" });
  assert.equal(over.ok, false);
  assert.ok(
    (over as { errors: string[] }).errors.some((e) => e.includes("topology.nodes")),
    "the field is named, so the caller knows which one",
  );
  assert.equal(validateTopology({ nodes: PG_INT4_MAX, backend: "rayjob" }).ok, true);
});

test("validateTopology bounds every numeric field, not only nodes", () => {
  const over = validateTopology({ nodes: 1, backend: "rayjob", gpus_per_node: 1e30 });
  assert.equal(over.ok, false);
  assert.ok((over as { errors: string[] }).errors.some((e) => e.includes("gpus_per_node")));
});

test("gpuNodesFromSpec never names a number the count cannot express", () => {
  assert.equal(gpuNodesFromSpec({ topology: { nodes: 2.5 } }), 0, "a fraction is not countable");
  assert.equal(gpuNodesFromSpec({ topology: { nodes: 1e30 } }), PG_INT4_MAX, "clamped, as the sum is");
  assert.equal(gpuNodesFromSpec({ topology: { nodes: 4 } }), 4);
});

test("topologyErrors is silent about a spec that declares none", async () => {
  const { topologyErrors } = await import("../src/tasks/run-spec.js");
  assert.equal(topologyErrors({}), null);
  assert.equal(topologyErrors(undefined), null);
  assert.ok(topologyErrors({ topology: { nodes: 1e30, backend: "rayjob" } }));
});

describe("the three paths that used to skip the validator", { skip }, () => {
  let harness: AdmissionCluster;

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "8" });
    await harness.app.db.db.query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s-topo','t','u1','claw')`,
    );
  });
  after(async () => { await harness?.stop(); });

  const clear = () => harness.app.db.db.query("DELETE FROM claw_tasks");
  const rowCount = async () => {
    const r = await harness.app.db.db.query("SELECT COUNT(*)::int AS n FROM claw_tasks");
    return Number((r.rows[0] as { n: number }).n);
  };

  test("createSingleTask refuses an unbounded topology at the boundary", async () => {
    await clear();
    const result = await harness.app.dagExpander.createSingleTask({
      session_id: "s-topo", prompt: "p", input: { topology: { nodes: 1e30, backend: "rayjob" } },
    });
    assert.ok("invalidTopology" in result, "a malformed declaration is the request's fault");
    assert.equal(await rowCount(), 0);
  });

  test("expandDag refuses one too", async () => {
    await clear();
    const result = await harness.app.dagExpander.expandDag({
      session_id: "s-topo",
      user_id: "u1",
      input: { topology: { nodes: 1e30, backend: "rayjob" } },
      plugin: null,
      dag: {
        dag_id: "d", name: "d",
        nodes: [{ id: "n0", executor: "brain", mode: "llm", sandbox: "none", depends_on: [] }],
        metadata: { derived: { root_node_id: "n0", handle_last_user: {}, schema_digest: "x" } },
      } as never,
    });
    assert.ok("invalidTopology" in result);
    assert.equal(await rowCount(), 0);
  });

  test("retryTask refuses to re-enter a figure persisted before the bound", async () => {
    await clear();
    // Written straight to the column, as a row from before the bound would be.
    await harness.app.db.db.query(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, input, metadata)
       VALUES ('t-legacy','s-topo','legacy','failed','task','brain',$1::jsonb,'{}'::jsonb)`,
      [JSON.stringify({ topology: { nodes: 1e30, backend: "rayjob" } })],
    );
    assert.deepEqual(await harness.app.lifecycle.retryTask("t-legacy"), { ok: false });
    assert.equal(await rowCount(), 1, "the clone that would have re-entered was never written");
  });
});
