// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The single-source claim, proven where the default cannot prove it.
 *
 * Comparing the schema, the deadline and the forwarded env against
 * `toolTimeoutCeilingSec()` at shipped defaults passes just as happily for a
 * surface that duplicated the switch-dependent literal instead of calling the
 * function -- the copy and the source are the same number there. Moving the
 * configured maximum to a value neither state ships separates them.
 *
 * Below 3540, deliberately: at or above it every surface is pinned to the MCP
 * cap whatever the configuration says, which would not distinguish one source
 * from three agreeing constants. Its own file because both sides freeze the
 * value at module load, so one process can establish exactly one configuration.
 */
import test from "node:test";
import assert from "node:assert/strict";

const OVERRIDE_SEC = 2000;
process.env.BASH_MAX_TIMEOUT_SEC = String(OVERRIDE_SEC);
delete process.env.BG_SHELL_ENABLED;

const { ToolRouter } = await import("../src/tools/router.js");
const { handsBaseEnv } = await import("../src/sandbox/bootstrap.js");
const { callDeadlineMs } = await import("../src/clients/hands.js");
const { MCP_DEADLINE_SLACK_MS, toolTimeoutCeilingSec } = await import("../src/tools/hands.js");
type HandsClient = import("../src/clients/hands.js").HandsClient;

function bashTimeoutDescription(): string {
  const router = new ToolRouter({ callTool: async () => "" } as unknown as HandsClient);
  const bash = router.getToolSchemas().find((t) => t.name === "bash")!;
  return String((bash.input_schema as {
    properties: Record<string, { description?: string }>;
  }).properties.timeout!.description);
}

test("an operator-set ceiling moves every surface together, with the switch off", () => {
  assert.equal(toolTimeoutCeilingSec("bash"), OVERRIDE_SEC,
    "held under the MCP cap, so a configured value below it is the ceiling");
  assert.notEqual(OVERRIDE_SEC, 3540, "or this proves nothing about single-sourcing");

  assert.ok(bashTimeoutDescription().includes(`capped at ${OVERRIDE_SEC}`));
  assert.ok(!bashTimeoutDescription().includes("capped at 3540"),
    "the shipped default is the number a surface holding its own copy of the "
      + "switch-dependent literal would still be stating");
  assert.equal(
    callDeadlineMs("bash", { command: "x", timeout: 36_000 }),
    OVERRIDE_SEC * 1000 + MCP_DEADLINE_SLACK_MS,
  );
  assert.match(handsBaseEnv("s-1", "9100", "tok"),
    new RegExp(`BASH_MAX_TIMEOUT_SEC=${OVERRIDE_SEC}(\\s|$)`));
});
