// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run says what it needs, and a typo is refused rather than rounded down.
 *
 * Multi-node provisioning has been read out of the prompt with a regular
 * expression: `--nodes 64 --mn-backend infera`. That makes a misspelling
 * indistinguishable from silence -- `--node 64` matches nothing, the node
 * count falls back to its default of 1, and a request for sixty-four GPU
 * machines becomes a request for none, discovered when the job finishes at the
 * wrong scale. It also puts the request somewhere nothing upstream of Brain
 * can see it: admission and quota run in the API, on the body, while the flags
 * are inside a string only Brain parses and only after the message has been
 * accepted and queued.
 *
 * Hence a declared field, and hence strictness about it: rejecting an unknown
 * key is the entire behavioural difference from the regular expression.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { validateTopology } from "../src/topology.js";

const ok = (input: unknown) => {
  const r = validateTopology(input);
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join("; "));
  return r.ok ? r.value : undefined!;
};
const errs = (input: unknown): string[] => {
  const r = validateTopology(input);
  assert.equal(r.ok, false, "expected this to be refused");
  return r.ok ? [] : r.errors;
};

test("a well-formed declaration passes through unchanged", () => {
  const value = ok({ nodes: 64, backend: "rayjob", gpus_per_node: 8 });
  assert.equal(value.nodes, 64);
  assert.equal(value.backend, "rayjob");
});

test("a misspelled field is refused, and named, instead of being ignored", () => {
  // The whole point. Ignoring `node_count` leaves `nodes` unset, which reads
  // as a single-node run -- the failure this field exists to remove.
  const messages = errs({ node_count: 64, backend: "rayjob" });
  assert.ok(messages.some((m) => m.includes("node_count")), messages.join("; "));
  assert.ok(messages.some((m) => m.includes("nodes")), "the intended field should be suggested");
});

test("every problem is reported, not just the first", () => {
  // An operator fixing one field at a time through a request-response loop
  // learns about the next one only after redeploying.
  const messages = errs({ nodes: "sixty-four", backend: "torchrun", gpus: 8 });
  assert.ok(messages.length >= 3, messages.join("; "));
});

test("the backend has to be stated", () => {
  // `--nodes` alone used to be enough to provision a cluster on whichever
  // engine happened to be the default, which is a large thing to acquire by
  // omission.
  assert.ok(errs({ nodes: 4 }).some((m) => m.includes("backend")));
});

test("infera without a model is refused at declaration time", () => {
  // The frontend takes it as --router-tokenizer-path. Without it the cluster
  // comes up, costs money, and the frontend cannot start.
  assert.ok(errs({ nodes: 4, backend: "infera" }).some((m) => m.includes("model")));
  ok({ nodes: 4, backend: "infera", model: "/models/llama-3-70b" });
});

test("platform-owned environment names cannot be set by the caller", () => {
  const messages = errs({
    nodes: 2, backend: "rayjob",
    extra_env: { RAY_JOB_ENTRYPOINT: "mine", HF_TOKEN: "fine" },
  });
  assert.ok(messages.some((m) => m.includes("RAY_JOB_ENTRYPOINT")));
  ok({ nodes: 2, backend: "rayjob", extra_env: { HF_TOKEN: "fine" } });
});

test("numbers must be whole and non-negative", () => {
  assert.ok(errs({ nodes: 2.5, backend: "rayjob" }).length > 0);
  assert.ok(errs({ nodes: 4, backend: "rayjob", gpus_per_node: -1 }).length > 0);
  assert.ok(errs({ nodes: 0, backend: "rayjob" }).length > 0);
});

test("a declaration that is not an object is refused rather than coerced", () => {
  for (const bad of [null, 4, "nodes=4", ["nodes"], true]) {
    assert.equal(validateTopology(bad).ok, false, `${JSON.stringify(bad)} should not validate`);
  }
});
