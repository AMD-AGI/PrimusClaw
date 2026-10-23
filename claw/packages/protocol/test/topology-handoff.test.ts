// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOPOLOGY_HANDOFF_JSON_SCHEMA as S,
  TOPOLOGY_HANDOFF_SCHEMA,
  validateTopologyHandoff,
  type TopologyHandoffV1,
} from "../src/topology-handoff.js";

// A document that sets every field the type has. `satisfies` makes the compiler
// fail this file when a field is added to the type and not here.
const FULL = {
  schema: TOPOLOGY_HANDOFF_SCHEMA,
  backend: "infera",
  nodes: 2,
  gpus_per_node: 8,
  service_url: "http://h:1",
  ray: { head_ip: "h" },
  infera: {
    ssh_key_file: "/k",
    ssh_port_base: 2233,
    known_hosts_file: "/kh",
    prefill_ips: ["1.1.1.1"],
    decode_ips: [],
    worker_ips: [],
  },
} satisfies TopologyHandoffV1;

test("JSON schema property names equal the type's field names", () => {
  assert.deepEqual(Object.keys(S.properties).sort(), Object.keys(FULL).sort());
  assert.deepEqual(Object.keys(S.properties.ray.properties).sort(), Object.keys(FULL.ray).sort());
  assert.deepEqual(Object.keys(S.properties.infera.properties).sort(), Object.keys(FULL.infera).sort());
});

test("a document with both blocks is rejected whichever backend it names", () => {
  assert.ok(validateTopologyHandoff(FULL).some((p) => p.startsWith("ray")));
  assert.ok(validateTopologyHandoff({ ...FULL, backend: "rayjob" }).some((p) => p.startsWith("infera")));
});

test("full documents validate, one per backend", () => {
  const { ray, infera, ...base } = FULL;
  assert.deepEqual(validateTopologyHandoff({ ...base, backend: "infera", infera }), []);
  assert.deepEqual(validateTopologyHandoff({ ...base, backend: "rayjob", ray }), []);
});

test("backend and block must agree", () => {
  const { ray, infera, ...base } = FULL;
  assert.ok(validateTopologyHandoff({ ...base, backend: "rayjob", infera }).length > 0, "rayjob with infera");
  assert.ok(validateTopologyHandoff({ ...base, backend: "rayjob" }).some((p) => p.startsWith("ray")), "rayjob without ray");
  assert.ok(validateTopologyHandoff({ ...base, backend: "infera", ray }).length > 0, "infera with ray");
  assert.ok(validateTopologyHandoff({ ...base, backend: "infera" }).some((p) => p.startsWith("infera")), "infera without infera");
});

test("the JSON schema states the same backend/block rule", () => {
  assert.deepEqual(S.allOf.map((r) => r.if.properties.backend.const), ["rayjob", "infera"]);
  assert.deepEqual(S.allOf.map((r) => r.then.required[0]), ["ray", "infera"]);
  assert.deepEqual(S.allOf.map((r) => r.then.not.required[0]), ["infera", "ray"]);
});

test("every schema-required field is enforced by the validator", () => {
  for (const k of S.required) {
    const doc: Record<string, unknown> = { ...FULL };
    delete doc[k];
    assert.ok(validateTopologyHandoff(doc).some((p) => p.startsWith(k)), `missing ${k}`);
  }
  for (const k of S.properties.infera.required) {
    const infera: Record<string, unknown> = { ...FULL.infera };
    delete infera[k];
    assert.ok(validateTopologyHandoff({ ...FULL, infera }).some((p) => p.includes(k)), `missing infera.${k}`);
  }
});

test("rejects unknown fields, wrong schema string and bad numbers", () => {
  assert.ok(validateTopologyHandoff({ ...FULL, extra: 1 }).length > 0);
  assert.ok(validateTopologyHandoff({ ...FULL, schema: "topology-handoff/v2" }).length > 0);
  assert.ok(validateTopologyHandoff({ ...FULL, nodes: 0 }).length > 0);
  assert.ok(validateTopologyHandoff({ ...FULL, gpus_per_node: 1.5 }).length > 0);
  assert.ok(validateTopologyHandoff({ ...FULL, infera: { ...FULL.infera, ssh_port_base: 70000 } }).length > 0);
  assert.ok(validateTopologyHandoff({ ...FULL, ray: { token: "inline" } }).length > 0);
  assert.ok(validateTopologyHandoff("nope").length > 0);
});
