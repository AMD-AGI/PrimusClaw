// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Whether a live sandbox may serve the request in front of it.
//
// Reuse used to be decided on liveness alone -- ready in KV, one /health GET, a
// non-empty token -- and the check ran before the request was parsed, so it
// could not have compared specs even if it wanted to. A user who changed the
// image and sent another message silently landed in the old sandbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sandboxSpecFingerprint, evaluateReuse,
} from "../src/sandbox/spec-fingerprint.js";

const base = {
  image: "example.io/torch:2.4",
  resources: { cpu: "4", memory: "16Gi" },
  env: { PYTHONPATH: "/workspace" },
};

test("the same request describes the same sandbox", () => {
  assert.equal(sandboxSpecFingerprint(base), sandboxSpecFingerprint({ ...base }));
});

test("env order is not part of the spec", () => {
  const a = sandboxSpecFingerprint({ ...base, env: { A: "1", B: "2" } });
  const b = sandboxSpecFingerprint({ ...base, env: { B: "2", A: "1" } });

  assert.equal(a, b, "two requests that differ only in key order want the same sandbox");
});

test("each baked-in field moves the fingerprint", () => {
  const cases: Array<[string, Parameters<typeof sandboxSpecFingerprint>[0]]> = [
    ["image", { ...base, image: "example.io/torch:2.5" }],
    ["cpu", { ...base, resources: { ...base.resources, cpu: "8" } }],
    ["memory", { ...base, resources: { ...base.resources, memory: "32Gi" } }],
    ["gpu", { ...base, resources: { ...base.resources, gpu: "1" } }],
    ["env value", { ...base, env: { PYTHONPATH: "/workspace/src" } }],
    ["env key", { ...base, env: { ...base.env, HF_HOME: "/workspace/.hf" } }],
    // The five the first version of this left out. Each is fixed at create and
    // chosen by the caller, so each is a way to ask for a different sandbox and
    // be handed the old one: the platform kills the workload at its timeout,
    // evicts it at its TTL, schedules it into its namespace, and the agent CLI
    // authenticates with the key that was injected when the pod started.
    ["timeout", { ...base, timeout: 28_800 }],
    ["ttl", { ...base, ttlSec: 600 }],
    ["label", { ...base, labels: { "team/cost-centre": "b" } }],
    ["namespace", { ...base, namespace: "other-workspace" }],
    ["llm key", { ...base, llmKey: "second-key" }],
  ];

  for (const [what, changed] of cases) {
    assert.notEqual(sandboxSpecFingerprint(changed), sandboxSpecFingerprint(base),
      `changing the ${what} must not resolve to the sandbox built without it`);
  }
});

test("adding a GPU is never mistaken for the CPU-only sandbox", () => {
  // The expensive half of the bug: silently reusing a CPU sandbox for a request
  // that asked for an accelerator fails much later and much less legibly.
  const cpuOnly = sandboxSpecFingerprint(base);
  const withGpu = sandboxSpecFingerprint({
    ...base, resources: { ...base.resources, gpu: "8" },
  });

  assert.notEqual(cpuOnly, withGpu);
});

test("a matching spec is reused", () => {
  const fp = sandboxSpecFingerprint(base);
  const verdict = evaluateReuse(fp, fp);

  assert.equal(verdict.reuse, true);
});

test("a changed spec is refused, and says what it saw", () => {
  const recorded = sandboxSpecFingerprint(base);
  const requested = sandboxSpecFingerprint({ ...base, image: "other:1" });
  const verdict = evaluateReuse(recorded, requested);

  assert.equal(verdict.reuse, false);
  assert.equal(verdict.reason, "spec_changed");
  assert.equal(verdict.recorded, recorded, "the rebuild has to be explainable after the fact");
  assert.equal(verdict.requested, requested);
});

test("a sandbox from before this field existed is reused, not torn down", () => {
  // Every sandbox alive when this ships has no fingerprint. Refusing them would
  // rebuild the running fleet in one sweep the first time a Brain with this
  // code starts, which is a great deal worse than one more session on a stale
  // spec -- and a stale spec is exactly what those sessions have today.
  for (const missing of [undefined, null, "", 0, false]) {
    const verdict = evaluateReuse(missing, sandboxSpecFingerprint(base));
    assert.equal(verdict.reuse, true, `a ${JSON.stringify(missing)} fingerprint must not force a rebuild`);
    assert.equal(verdict.reason, "no_recorded_spec");
  }
});

test("the compatibility rule does not extend to a recorded spec that disagrees", () => {
  const requested = sandboxSpecFingerprint(base);
  const colon = requested.indexOf(":");
  const recorded = `${requested.slice(0, colon + 1)}${"0".repeat(16)}`;
  const verdict = evaluateReuse(recorded, requested);

  assert.equal(verdict.reuse, false,
    "tolerating a missing value must not become tolerating a wrong one");
});

test("an omitted field and its default describe the same sandbox", () => {
  // The caller's two ways of asking for the same thing have to agree, or the
  // first message after a client starts sending an explicit default rebuilds a
  // sandbox that was already right.
  assert.equal(
    sandboxSpecFingerprint({ ...base, labels: {} }),
    sandboxSpecFingerprint(base),
    "no labels and an empty label set are the same request",
  );
  assert.equal(
    sandboxSpecFingerprint({ ...base, namespace: "" }),
    sandboxSpecFingerprint(base),
  );
});

test("the key itself is never what gets compared", () => {
  // The fingerprint is stored in KV and logged on a rebuild, so the key is
  // hashed before it joins the canonical form rather than after.
  const key = "sk-not-a-real-key-0123456789";
  const fp = sandboxSpecFingerprint({ ...base, llmKey: key });

  assert.match(fp, /^\d+:[0-9a-f]{16}$/, "a format prefix and a hash, nothing else");
  assert.ok(!fp.includes(key.slice(3)), "no part of the key survives into the fingerprint");
});

test("a fingerprint from an earlier format is reused, not torn down", () => {
  // The hash inputs changed. Rebuilding every live sandbox over that would
  // be the fleet-wide sweep the missing-fingerprint rule exists to prevent,
  // and rewriting the stored value would make an older Brain see a mismatch.
  const requested = sandboxSpecFingerprint(base);
  const recorded = "abcdabcdabcdabcd";
  const verdict = evaluateReuse(recorded, requested);

  assert.equal(verdict.reuse, true);
  assert.equal(verdict.reason, "spec_format_changed");
});
