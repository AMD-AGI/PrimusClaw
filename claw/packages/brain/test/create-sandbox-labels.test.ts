// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The shared label composition must give a hands sandbox the labels it always had. */
import test from "node:test";
import assert from "node:assert/strict";
import { composeSandboxLabels } from "../src/sandbox/create-sandbox.js";

test("hands labels are exactly what ensureHands composed inline before the extraction", () => {
  const labels = composeSandboxLabels({
    sessionId: "s1",
    component: "hands",
    own: {
      "primus-claw/plugin-id": "7",
      "primus-claw/dag-root": "root",
      "primus-claw/dag-node": "single",
      "primus-claw/sandbox-handle": "main",
    },
    extra: { custom: "x" },
  });
  assert.deepEqual(labels, {
    "primus-claw/session-id": "s1",
    "primus-claw/component": "hands",
    "primus-claw/plugin-id": "7",
    "primus-claw/dag-root": "root",
    "primus-claw/dag-node": "single",
    "primus-claw/sandbox-handle": "main",
    team: "primus-claw",
    custom: "x",
  });
  // Spec labels still win over the defaults, as the inline spread did.
  assert.equal(composeSandboxLabels({ sessionId: "s", component: "hands", extra: { team: "t" } }).team, "t");
});
