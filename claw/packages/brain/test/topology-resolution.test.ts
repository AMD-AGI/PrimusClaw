// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where Brain reads a run's topology from, now that a request can declare one.
 *
 * The prompt flags stay, because callers exist that use them and their
 * requests must keep working. What changes is precedence and what happens on a
 * mistake: a declared topology is the answer, and a declared topology that
 * does not validate is refused rather than quietly replaced by whatever the
 * prompt happens to say. Falling back there would answer a question the caller
 * did not ask, using text they may have written for a person to read.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTopology, isMultiNodeRequest, specFromTopology,
} from "../src/sandbox/multi-node/prompt-flags.js";

test("the declaration wins over flags in the prompt", () => {
  const spec = resolveTopology({
    prompt: "optimize --nodes 2 --mn-backend rayjob",
    topology: { nodes: 8, backend: "infera", model: "/models/m" },
  });
  assert.equal(spec?.nodes, 8);
  assert.equal(spec?.backend, "infera");
});

test("a request that declares nothing is still read the old way", () => {
  const spec = resolveTopology({ prompt: "optimize --nodes 4 --mn-backend rayjob" });
  assert.equal(spec?.nodes, 4);
  assert.equal(spec?.backend, "rayjob");
});

test("an invalid declaration fails the run instead of falling back to the prompt", () => {
  assert.throws(
    () => resolveTopology({
      prompt: "optimize --nodes 2 --mn-backend rayjob",
      topology: { node_count: 8, backend: "rayjob" },
    }),
    /node_count/,
  );
});

test("defaults are the same whichever route the request took", () => {
  // Hyperloom's defaults live in one place, so a caller who moves from flags
  // to the declaration does not silently get different per-node hardware.
  const declared = specFromTopology({ nodes: 4, backend: "rayjob" });
  const parsed = resolveTopology({ prompt: "--nodes 4 --mn-backend rayjob" })!;
  assert.deepEqual(declared, parsed);
});

test("a single-node declaration is not multi-node, and provisions nothing", () => {
  assert.equal(resolveTopology({ topology: { nodes: 1, backend: "rayjob" } }), null);
  assert.equal(isMultiNodeRequest({ topology: { nodes: 1, backend: "rayjob" } }), false);
});

test("asking whether a run is multi-node never throws", () => {
  // The question is asked on the hot path, before anything is set up to
  // report a validation failure. An invalid declaration is multi-node by
  // intent, so saying yes routes it to the resolver, which explains why.
  assert.equal(isMultiNodeRequest({ topology: { nodes: 8, backend: "nonsense" } }), true);
  assert.equal(isMultiNodeRequest({ prompt: "hello" }), false);
});

test("a declaration too broken to count is still a request for a cluster", () => {
  // These used to answer false, because the question was asked with a counter
  // that returns 1 for anything it cannot read. A quoted number or a misspelled
  // key would then run on one GPU, with the resolver never consulted and the
  // downgrade warning suppressed because a topology was present -- the silent
  // single-node run the declaration was introduced to remove.
  for (const topology of [
    { nodes: "eight" },
    { node: 64, backend: "rayjob" },
    { nodes: 64, backend: "rayjob", extras: {} },
    "sixty-four nodes please",
  ]) {
    assert.equal(
      isMultiNodeRequest({ topology } as never), true,
      `${JSON.stringify(topology)} has to reach the resolver, which reports what is wrong with it`,
    );
  }
});

test("platform-owned environment names are dropped on both routes", () => {
  const declared = specFromTopology({
    nodes: 2, backend: "rayjob",
    extra_env: { RAY_JOB_ENTRYPOINT: "mine", HF_TOKEN: "keep" },
  });
  assert.deepEqual(declared.extraEnv, { HF_TOKEN: "keep" });
});
