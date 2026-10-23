// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOPOLOGY_HANDOFF_JSON_SCHEMA as S,
  TOPOLOGY_HANDOFF_SCHEMA,
  validateTopologyHandoff,
  type TopologyHandoffV1,
} from "../src/apps.js";

// A document that sets every field the type has. `satisfies` makes the compiler
// fail this file when a field is added to the type and not here.
const FULL = {
  schema: TOPOLOGY_HANDOFF_SCHEMA,
  backend: "infera",
  nodes: 2,
  gpus_per_node: 8,
  service_url: "http://h:1",
  ray: { head_ip: "h", dashboard_token_file: "/w/.claw/ray-token" },
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

test("a full document validates", () => {
  assert.deepEqual(validateTopologyHandoff(FULL), []);
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
