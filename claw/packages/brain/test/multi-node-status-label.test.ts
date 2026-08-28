// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The provisioning events the client renders must name the backend that is
 * actually running. An infera run reporting `rayjob_provisioning` is what this
 * guards against.
 *
 * sandbox/multi-node/safe-provider.ts pulls in the k8s client (undici), which cannot load under tsx
 * here, so the contract is asserted against the source text: no hard-coded
 * `rayjob_*` status literal may survive, and every emitted event must carry the
 * backend plus a neutral workload name.
 */
const SRC = readFileSync(
  new URL("../src/sandbox/multi-node/safe-provider.ts", import.meta.url),
  "utf-8",
);

test("no provisioning event hard-codes a rayjob status label", () => {
  for (const phase of ["creating", "provisioning", "ready", "reused", "failed"]) {
    assert.ok(
      !SRC.includes(`status: "rayjob_${phase}"`),
      `status: "rayjob_${phase}" is hard-coded; derive it from the backend instead`,
    );
  }
});

test("every sandboxStatus event derives its label from the backend", () => {
  const events = SRC.split('type: "sandboxStatus"').slice(1);
  assert.equal(events.length, 5, "expected the five provisioning events");
  for (const [i, body] of events.entries()) {
    const head = body.slice(0, 400);
    assert.match(head, /status: mnStatus\(spec\.backend, "\w+"\)/, `event ${i}: status not backend-derived`);
    assert.match(head, /mn_backend: spec\.backend/, `event ${i}: missing mn_backend`);
    assert.match(head, /workload_name:/, `event ${i}: missing neutral workload_name`);
  }
});

test("mnStatus keeps the phase suffix so phase-matching consumers still work", () => {
  const fn = /function mnStatus\([^)]*\): string \{\s*return `\$\{backend\}_\$\{phase\}`;/;
  assert.match(SRC, fn, "mnStatus must be `<backend>_<phase>`");
});
