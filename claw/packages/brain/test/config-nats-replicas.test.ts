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
 *   R7 every per-bucket count falls back to NATS_REPLICAS and not to a sibling
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/**
 * Every `export const <NAME>_REPLICAS = envInt("<KEY>", <fallback>, ...)` in
 * config, comments stripped, as the constant's name and the expression it falls
 * back to.
 *
 * Text rather than values because the value cannot tell these apart. One
 * process imports config under one environment, and a per-bucket setting only
 * reveals which variable it chains to when that variable resolves to something
 * other than `NATS_REPLICAS` -- which means every OTHER per-bucket key has to
 * be explicitly set in that same process, with the one under test left blank.
 * That is one process per setting, and none of those files would cover the
 * bucket somebody adds next year. Reading the declarations covers all of them
 * at once and keeps covering whatever the file grows, which is the same trade
 * the api package's nats-stream-config.test.ts makes for the `ensureStream`
 * call sites.
 */
interface ReplicaSetting { name: string; fallback: string }

function replicaSettings(source: string): ReplicaSetting[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const found: ReplicaSetting[] = [];
  for (const m of code.matchAll(
    /export\s+const\s+(\w+_REPLICAS)\s*=\s*envInt\(\s*"[^"]+"\s*,\s*([^,)]+?)\s*[,)]/g,
  )) {
    found.push({ name: m[1], fallback: m[2].trim() });
  }
  return found;
}

test("R7 every per-bucket count falls back to NATS_REPLICAS and not to a sibling", () => {
  // R1 above holds that a configured NATS_REPLICAS reaches all three buckets.
  // What it cannot see is which route it took: rewrite DAG_HANDLES_REPLICAS to
  // fall back to BRAIN_CHECKPOINTS_REPLICAS and every assertion in this package
  // still passes, because in R1 the sibling is absent and resolves to
  // NATS_REPLICAS too, and in the blank file the sibling is 3 like everything
  // else. The chain only comes apart for the operator it exists for -- someone
  // who raises one bucket on its own and silently drags DAG_HANDLES with it, or
  // who lowers the deployment-wide value and finds one bucket did not follow.
  // A chain that points at a sibling declared further down this file is worse
  // still: BRAIN_REGISTRY_REPLICAS is declared at the top of the NATS block and
  // BRAIN_CHECKPOINTS_REPLICAS a hundred lines below it, so pointing the first
  // at the second is a temporal dead zone -- config throws on import and brain
  // does not start at all.
  //
  // This reads the declarations rather than the values for the reason above the
  // helper. It holds the shape of each default, not that any of them is
  // evaluated -- R1, R3 and R5 are what hold the numbers.
  const src = readFileSync(fileURLToPath(new URL("../src/config.ts", import.meta.url)), "utf-8");
  const settings = replicaSettings(src);
  const names = settings.map((s) => s.name);

  // Named rather than counted: a declaration the scan stops matching -- an
  // `envInt` renamed, a default moved onto its own line -- would otherwise
  // leave the loop below iterating over a shorter list and passing.
  for (const expected of [
    "NATS_REPLICAS", "BRAIN_REGISTRY_REPLICAS", "BRAIN_CHECKPOINTS_REPLICAS",
    "DAG_HANDLES_REPLICAS",
  ]) {
    assert.ok(names.includes(expected),
      `${expected} is not being read by this scan, so whatever it now falls back `
      + `to is unchecked; found ${JSON.stringify(names)}`);
  }

  const root = settings.find((s) => s.name === "NATS_REPLICAS");
  assert.match(root?.fallback ?? "", /^\d+$/,
    "the deployment-wide default is the root of the chain and has to end in a "
    + "literal; anything else is a cycle or a chain with no bottom");

  for (const { name, fallback } of settings) {
    if (name === "NATS_REPLICAS") continue;
    assert.equal(fallback, "NATS_REPLICAS",
      `${name} falls back to ${fallback}. NATS_REPLICAS is the one variable the `
      + `chart writes into primus-claw-secrets and the README tells an operator `
      + `to set, so a per-bucket count that chains to a sibling instead answers `
      + `to a key nobody set: it moves when that sibling is overridden and stays `
      + `put when the deployment-wide value changes, and if the sibling is `
      + `declared below this line config throws on import and brain never boots`);
  }
});
