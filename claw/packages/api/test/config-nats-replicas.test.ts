// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One variable has to be enough to make a whole deployment single-replica.
 *
 * `NATS_REPLICAS` is the deployment-wide default every stream and bucket falls
 * back to, and the local quick start is the reason it exists: a single
 * `nats-server -js` is not clustered, JetStream answers a replicas>1 request
 * there with err 10074, and the API exits while provisioning. The README tells
 * the reader to set one variable. If any of the five per-object settings kept
 * its own hardcoded 3 instead of falling back to this one, that reader's API
 * would still die -- on whichever object was missed, with an error naming a
 * variable they did set correctly.
 *
 * The fallback chain is the thing being pinned, not the numbers: writing
 * `envInt("TASK_STREAM_REPLICAS", 3, { min: 1 })` again is a one-token change
 * that nothing else in the suite notices, because every other test that touches
 * replicas passes the count to `ensureStream` as a literal.
 *
 * Env vars are set before the import because config reads each of them once at
 * module scope; hence the dynamic import, as in config-blank-env.test.ts. This
 * process is the single-node configuration and holds no other environment --
 * the clustered-default and per-object-override cases need different values for
 * these same keys, so they live in config-nats-replicas-blank.test.ts, and the
 * count that is out of range altogether lives in
 * config-nats-replicas-refused.test.ts. R7 at the bottom reads the source
 * rather than the imported values and so is indifferent to which of the three
 * processes it runs in; it lives here because this file is where the chain
 * itself is the subject.
 *
 * Coverage:
 *   R1 NATS_REPLICAS reaches both streams
 *   R2 NATS_REPLICAS reaches all three KV buckets this process creates
 *   R7 every per-object count falls back to NATS_REPLICAS and not to a sibling
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The one line the quick start asks for. The per-object keys are blank on
// purpose: that is what `set -a; source .env` exports from a copied
// `.env.example`, so this is the configuration a local reader actually runs,
// not an artificially empty environment.
process.env.NATS_REPLICAS = "1";
process.env.TASK_STREAM_REPLICAS = "";
process.env.EVENT_STREAM_REPLICAS = "";
process.env.BRAIN_REGISTRY_REPLICAS = "";
process.env.BRAIN_CHECKPOINTS_REPLICAS = "";
process.env.SYSTEM_ENV_REPLICAS = "";

const {
  NATS_REPLICAS, TASK_STREAM_REPLICAS, EVENT_STREAM_REPLICAS,
  BRAIN_REGISTRY_REPLICAS, BRAIN_CHECKPOINTS_REPLICAS, SYSTEM_ENV_REPLICAS,
} = await import("../src/config.js");

test("R1 NATS_REPLICAS reaches both streams", () => {
  assert.equal(NATS_REPLICAS, 1, "the value under test, or the rest proves nothing");
  assert.equal(TASK_STREAM_REPLICAS, 1,
    "a task stream that ignores NATS_REPLICAS asks a non-clustered server for "
    + "three and takes the local API down at startup");
  assert.equal(EVENT_STREAM_REPLICAS, 1,
    "and the event stream is created first, so it fails before the task stream "
    + "is even reached");
});

test("R2 NATS_REPLICAS reaches all three KV buckets this process creates", () => {
  // These three were the objects that already had per-object variables, which
  // is exactly how one of them comes to keep a literal while the others are
  // rewired: the edit that adds the fallback has five places to land.
  assert.equal(BRAIN_REGISTRY_REPLICAS, 1,
    "js.views.kv refuses replicas>1 on a single node the same way a stream does");
  assert.equal(BRAIN_CHECKPOINTS_REPLICAS, 1);
  assert.equal(SYSTEM_ENV_REPLICAS, 1);
});

/**
 * Every `export const <NAME>_REPLICAS = envInt("<KEY>", <fallback>, ...)` in
 * config, comments stripped, as the constant's name and the expression it falls
 * back to.
 *
 * Text rather than values because the value cannot tell these apart. One
 * process imports config under one environment, and a per-object setting only
 * reveals which variable it chains to when that variable resolves to something
 * other than `NATS_REPLICAS` -- which means every OTHER per-object key has to
 * be explicitly set in that same process, with the one under test left blank.
 * That is one process per setting, six files that each pin one name, and none
 * of them would cover the seventh setting somebody adds next year. Reading the
 * declarations covers all of them at once and keeps covering whatever the file
 * grows, which is the same trade nats-stream-config.test.ts makes for the
 * `ensureStream` call sites.
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

test("R7 every per-object count falls back to NATS_REPLICAS and not to a sibling", () => {
  // R1 above holds that a configured NATS_REPLICAS reaches all six settings.
  // What it cannot see is which route it took: rewrite EVENT_STREAM_REPLICAS to
  // fall back to TASK_STREAM_REPLICAS and every assertion in this package still
  // passes, because in R1 the sibling is blank and resolves to NATS_REPLICAS
  // too, and in the blank file the sibling is 3 like everything else. The chain
  // only comes apart for the operator it exists for -- someone who raises
  // TASK_STREAM_REPLICAS after the outage and silently moves the event stream
  // with it, or who lowers one object and finds another followed. A chain that
  // points at a sibling declared further down the file is worse still: it is a
  // temporal dead zone, and config throws on import.
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
    "SYSTEM_ENV_REPLICAS", "TASK_STREAM_REPLICAS", "EVENT_STREAM_REPLICAS",
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
      + `chart writes and the README tells an operator to set, so a per-object `
      + `count that chains to a sibling instead answers to a key nobody set: it `
      + `moves when that sibling is overridden and stays put when the `
      + `deployment-wide value changes, and if the sibling is declared below `
      + `this line config throws on import and no process starts at all`);
  }
});
