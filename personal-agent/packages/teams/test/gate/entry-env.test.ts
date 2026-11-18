// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The release gate's test entry is off unless the gate's Job turns it on, and a typo stops the worker. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { gateEntryFromEnv, GateEntryRefused, loopbackUrl } from "../../src/gate/entry-env.js";

const ON = { TEAMS_GATE_ENTRY: "1", GATE_RUN_ID: "run-7", TEAMS_GATE_CONNECTOR_URL: "http://127.0.0.1:8082" };

test("the test entry is off unless the environment turns it on", () => {
  assert.equal(gateEntryFromEnv({}), undefined);
  assert.equal(gateEntryFromEnv({ TEAMS_GATE_ENTRY: "" }), undefined);
  assert.deepEqual(gateEntryFromEnv(ON), {
    connectorUrl: "http://127.0.0.1:8082",
    runId: "run-7",
    filesPrefix: "http://127.0.0.1:8082/gate-files/",
  });
});

test("any other value, a missing run id or a connector off the loopback stops the worker", () => {
  for (const value of ["0", "true", "yes", " 1"]) {
    assert.throws(() => gateEntryFromEnv({ ...ON, TEAMS_GATE_ENTRY: value }), GateEntryRefused);
  }
  assert.throws(() => gateEntryFromEnv({ ...ON, GATE_RUN_ID: " " }), GateEntryRefused);
  for (const url of [
    "",
    "https://127.0.0.1:8082",
    "http://localhost:8082",
    "http://127.0.0.1",
    "http://127.0.0.1:8082/v3",
    "http://user@127.0.0.1:8082",
    "http://127.0.0.1:8082?x=1",
    "http://127.0.0.1:8082#x",
    "http://10.0.0.1:8082",
    "http://127.0.0.1:0",
    "not a url",
  ]) {
    assert.throws(() => loopbackUrl(url), GateEntryRefused, url);
  }
  assert.equal(loopbackUrl(" http://127.0.0.1:9/ "), "http://127.0.0.1:9");
});
