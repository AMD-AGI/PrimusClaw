// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A blank `NATS_REPLICAS` is a `NATS_REPLICAS` nobody set, and a per-object
 * variable outranks it.
 *
 * Blank is the shipping default, not an edge case. The Helm chart writes
 * `NATS_REPLICAS: ""` into primus-claw-secrets for every install
 * (deploy/charts/claw/templates/secret.yaml, `natsReplicas: ""` in values.yaml),
 * and the local quick start's `set -a; source .env` exports the blank line
 * `.env.example` ships too. So the value this file pins is the one nearly every
 * deployment actually runs on: if blank resolved to anything but the code
 * default of 3 -- to 0, or to 1, or to a refused setting quietly replaced by
 * something else -- then a default clustered install would provision its
 * registry, its checkpoints and its DAG handles at that count. At 1 that is the
 * 2026-09-01 outage reproduced by doing nothing: one server owning a bucket,
 * and nothing hosting it the moment that pod goes away.
 *
 * The second half is the reason the per-object variables still exist. They have
 * to beat the deployment-wide value, or an operator raising one bucket on its
 * own has no way to do it and the variables are decoration.
 *
 * A test process can only import config under one environment, so the case
 * where `NATS_REPLICAS` is genuinely set -- which is what tells the fall-back
 * chain apart from a literal default -- lives in config-nats-replicas.test.ts,
 * and the case where it is set to a count outside the usable range lives in
 * config-nats-replicas-refused.test.ts.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-blank-env.test.ts.
 *
 * Coverage:
 *   R3 a blank NATS_REPLICAS leaves every count at the clustered default of 3
 *   R4 a per-object variable overrides the deployment-wide default
 */
import test from "node:test";
import assert from "node:assert/strict";

// The three spellings of "nobody configured this", which all have to resolve
// the same way. Blank is what a default Helm install produces -- the chart
// quotes an empty `natsReplicas` into primus-claw-secrets -- and what
// `set -a; source .env` exports from a copied `.env.example`. Spaces are the
// same absent setting, because trim() runs before the fallback decision. And
// DAG_HANDLES_REPLICAS is deleted rather than blanked because absent is what
// that key genuinely is on a cluster: secret.yaml writes NATS_REPLICAS and none
// of the per-object names, so a pod is handed no such variable at all -- and
// that install has to land on the same count as the local reader whose
// `.env` line is merely empty.
process.env.NATS_REPLICAS = "";
delete process.env.DAG_HANDLES_REPLICAS;
process.env.BRAIN_CHECKPOINTS_REPLICAS = "  ";
// One bucket configured on its own, at a count that is neither the blank
// default nor the single-node value, so an override that was being ignored
// cannot pass by coincidence. Five is the most replicas JetStream will serve.
process.env.BRAIN_REGISTRY_REPLICAS = "5";

const {
  NATS_REPLICAS, DAG_HANDLES_REPLICAS, BRAIN_REGISTRY_REPLICAS,
  BRAIN_CHECKPOINTS_REPLICAS, envSettingProblems,
} = await import("../src/config.js");

test("R3 a blank NATS_REPLICAS leaves every count at the clustered default of 3", () => {
  // The highest-stakes of the three configurations: this is what a default Helm
  // install and a copied .env.example both produce, so whatever blank resolves
  // to here is what almost every deployment is provisioned at. One is the
  // answer that matters, and it is dangerous rather than merely wrong -- a
  // bucket on a single server comes up healthy and stays healthy right up to
  // the moment that pod goes away, which is the outage. A count that is
  // configured but unusable takes a different path entirely, because blank
  // returns the fallback before the bounds are consulted; that path is
  // config-nats-replicas-refused.test.ts.
  assert.equal(NATS_REPLICAS, 3,
    "blank is an absent setting; a default install has to provision against "
    + "the clustered NATS the chart itself installs");
  assert.deepEqual(
    { DAG_HANDLES_REPLICAS, BRAIN_CHECKPOINTS_REPLICAS },
    { DAG_HANDLES_REPLICAS: 3, BRAIN_CHECKPOINTS_REPLICAS: 3 },
    "and a blank per-object variable is absent in the same way, so it falls "
    + "through to the deployment-wide value rather than stopping the chain",
  );
  assert.equal(
    envSettingProblems().filter((p) => p.startsWith("NATS_REPLICAS=")).length,
    0,
    "a setting nobody configured is not a refused one, so startup reports nothing",
  );
});

test("R4 a per-object variable overrides the deployment-wide default", () => {
  // Otherwise the per-object variables .env.example documents do nothing, and
  // an operator who needs one bucket at a different count -- the registry, whose
  // `lock.<key>` entries decide which pod owns a session -- has no setting that
  // works.
  assert.equal(BRAIN_REGISTRY_REPLICAS, 5,
    "the bucket's own variable is what provisions it, or the override is decoration");
  assert.notEqual(BRAIN_REGISTRY_REPLICAS, NATS_REPLICAS,
    "which is only shown by the two disagreeing");
  assert.equal(DAG_HANDLES_REPLICAS, 3,
    "and one object being overridden does not drag its siblings along with it");
});
