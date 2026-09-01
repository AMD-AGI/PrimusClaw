// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// bash-schema-long-wait.test.ts
//
// With background shells off the foreground ceiling is ten hours, so a single
// `sleep 300` has always been legal. Production instead emitted
// `sleep 100; sleep 100; sleep 100` two hundred and thirteen times in one
// session -- three model requests, each re-sending a 600K-token conversation,
// to wait five minutes. The schema said "default 120, capped at 36000" and the
// model steered by the default.
//
// Nothing here can prove the model reads it differently. What it can hold down
// is that the ceiling stays visible and stays true, and that the guidance is
// not quietly dropped by a later edit.

import test from "node:test";
import assert from "node:assert/strict";

process.env.BG_SHELL_ENABLED = "false";
const { ToolRouter } = await import("../src/tools/router.js");
const { BASH_FOREGROUND_DEFAULT_SEC } = await import("../src/config.js");
const { toolTimeoutCeilingSec } = await import("../src/tools/hands.js");
const BASH_TIMEOUT_CEILING_SEC = toolTimeoutCeilingSec("bash");
type HandsClient = import("../src/clients/hands.js").HandsClient;

function bashSchema() {
  const router = new ToolRouter({ callTool: async () => "" } as unknown as HandsClient);
  const schema = router.getToolSchemas().find((t) => t.name === "bash");
  assert.ok(schema, "bash must always be offered");
  return schema;
}

test("the timeout description states the real ceiling, not a hardcoded number", () => {
  // Read from the constant rather than asserting "36000": the ceiling moves
  // with BG_SHELL_ENABLED, and a schema that promises a limit the sandbox does
  // not enforce is worse than either number alone.
  const desc = String((bashSchema().input_schema as any).properties.timeout.description);
  assert.match(desc, new RegExp(String(BASH_TIMEOUT_CEILING_SEC)));
  assert.match(desc, new RegExp(String(BASH_FOREGROUND_DEFAULT_SEC)));
});

test("the schema tells the model a long wait belongs in one call", () => {
  // The cost being described is real and not obvious from the tool's shape:
  // one bash call is one model request carrying the whole conversation, so
  // splitting a wait multiplies the most expensive thing in the loop.
  const text = `${bashSchema().description} ${String((bashSchema().input_schema as any).properties.timeout.description)}`;
  assert.match(text, /one call/i, "the schema must say to wait once, not in chunks");
  assert.match(text, /re-sends the entire conversation|cost three times/i,
    "and must say why, or it reads as style advice");
});

test("background-only affordances stay absent when the feature is off", () => {
  // The guidance above is the fallback for a deployment with no `wait` tool.
  // If these ever appear here, the advice is wrong and should be the
  // run_in_background wording instead.
  const props = (bashSchema().input_schema as any).properties;
  assert.equal(props.run_in_background, undefined);
  assert.equal(props.shell_id, undefined);
  assert.equal(bashSchema().description.includes("run_in_background"), false);
});
