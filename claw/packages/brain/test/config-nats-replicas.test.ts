// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `NATS_REPLICAS` is one setting for a whole deployment, and every replica
 * count brain reads has to actually fall through to it.
 *
 * The variable exists for the single-node quick start. `nats-server -js` on a
 * laptop is not clustered, and JetStream answers a replicas>1 request there
 * with err 10074, so a bucket that quietly kept asking for three would kill
 * brain at startup on the configuration the README documents -- one variable
 * per bucket is exactly the per-object bookkeeping `NATS_REPLICAS` was added to
 * remove, and the one bucket somebody forgets is the one that fails.
 *
 * That fall-through is invisible while `NATS_REPLICAS` is unset: with nothing
 * in the environment, `envInt("DAG_HANDLES_REPLICAS", NATS_REPLICAS)` and
 * `envInt("DAG_HANDLES_REPLICAS", 3)` resolve to the same 3, so a chain
 * rewritten back to a literal passes every other test in this package. Setting
 * `NATS_REPLICAS` is the only way to tell the two apart, which is why this file
 * owns its environment and why it is separate from config-blank-env.test.ts.
 *
 * A test process can only import config under one environment, so the rest of
 * the chain lives next door: what an unset (blank) `NATS_REPLICAS` resolves to
 * and a per-object override beating it are in config-nats-replicas-blank.test.ts,
 * and what a count outside the usable range does is in
 * config-nats-replicas-refused.test.ts.
 *
 * This file stops at the number config hands out. That the number then reaches
 * `js.views.kv(DAG_HANDLES, { replicas })` -- the one bucket brain creates
 * itself, on the one call in a cluster's life that can set the count -- is
 * dag-handles-replicas.test.ts, which sets an environment where no other
 * expression at that call site can produce the same number.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-blank-env.test.ts.
 *
 * Coverage:
 *   R1 a deployment-wide NATS_REPLICAS reaches every replica setting brain reads
 */
import test from "node:test";
import assert from "node:assert/strict";

// The single-node quick start, verbatim: one variable, no per-object settings.
// The per-object variables are deliberately left absent -- the whole question
// here is what an object resolves to when only the deployment-wide value is
// configured.
process.env.NATS_REPLICAS = "1";
delete process.env.DAG_HANDLES_REPLICAS;
delete process.env.BRAIN_REGISTRY_REPLICAS;
delete process.env.BRAIN_CHECKPOINTS_REPLICAS;

const {
  NATS_REPLICAS, DAG_HANDLES_REPLICAS, BRAIN_REGISTRY_REPLICAS,
  BRAIN_CHECKPOINTS_REPLICAS, envSettingProblems,
} = await import("../src/config.js");

test("R1 a deployment-wide NATS_REPLICAS reaches every replica setting brain reads", () => {
  // The mutation this file exists to kill: any one of these defaults written as
  // a literal 3 instead of NATS_REPLICAS comes out as 3 here while staying
  // green everywhere else, and a 3 is what JetStream refuses on a single node.
  // Every replica setting brain reads is listed, because the failure is one
  // bucket being missed rather than all of them being wrong.
  assert.deepEqual(
    {
      DAG_HANDLES_REPLICAS,
      BRAIN_REGISTRY_REPLICAS,
      BRAIN_CHECKPOINTS_REPLICAS,
    },
    {
      DAG_HANDLES_REPLICAS: 1,
      BRAIN_CHECKPOINTS_REPLICAS: 1,
      BRAIN_REGISTRY_REPLICAS: 1,
    },
    "one of these still asking for three replicas is a brain that cannot start "
    + "against the single-node NATS the quick start tells the reader to run",
  );
  assert.equal(NATS_REPLICAS, 1,
    "and the default they chain to is the configured value, not a copy of the literal");
  assert.equal(
    envSettingProblems().filter((p) => p.startsWith("NATS_REPLICAS=")).length,
    0,
    "1 is a supported replica count, so nothing was refused and silently defaulted",
  );
});
