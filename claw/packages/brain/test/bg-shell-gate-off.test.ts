// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `BG_SHELL_ENABLED=false` has to stop calls, not just hide them.
 *
 * The flag only ever edited the tool schemas handed to the model. `route()`
 * forwarded any name it was given, so the feature stayed fully usable through
 * every path that does not read a schema first: a resumed conversation whose
 * transcript already contains a `bash_output` call, a sub-agent replaying a
 * plan, a plugin, a model that guessed. Hands then ran it, because it had no
 * flag of its own either.
 *
 * The flag is read at module load, so the enabled case lives in its own file.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ToolRouter, isBackgroundShellCall } from "../src/tools/router.js";
import { BASH_FOREGROUND_MAX_SEC } from "../src/config.js";
import { toolTimeoutCeilingSec } from "../src/tools/hands.js";
import type { HandsClient } from "../src/clients/hands.js";

/** Records what would have reached the sandbox. */
function makeRouter(): { router: ToolRouter; calls: string[] } {
  const calls: string[] = [];
  const hands = {
    callTool: async (name: string) => { calls.push(name); return "ran"; },
  } as unknown as HandsClient;
  return { router: new ToolRouter(hands), calls };
}

test("a background bash call is refused instead of forwarded", async () => {
  const { router, calls } = makeRouter();
  const out = await router.route("bash", { command: "sleep 999", run_in_background: true });

  assert.match(String(out), /disabled/);
  assert.deepEqual(calls, [], "the sandbox must never see a call the operator turned off");
});

test("a stale bash_output or kill_shell gets a legible answer", async () => {
  const { router, calls } = makeRouter();

  assert.match(String(await router.route("bash_output", { shell_id: "bg-1" })), /disabled/);
  assert.match(String(await router.route("kill_shell", { shell_id: "bg-1" })), /disabled/);
  assert.deepEqual(calls, []);
});

test("the refusal names the alternative", async () => {
  const { router } = makeRouter();
  const out = String(await router.route("bash", { command: "x", run_in_background: true }));
  assert.match(out, /foreground/,
    "a model told only 'no' retries the identical call until the turn budget runs out");
});

test("ordinary bash is untouched", async () => {
  const { router, calls } = makeRouter();
  assert.equal(await router.route("bash", { command: "ls" }), "ran");
  assert.deepEqual(calls, ["bash"]);
});

test("run_in_background=false is an ordinary bash call", async () => {
  const { router, calls } = makeRouter();
  await router.route("bash", { command: "ls", run_in_background: false });
  assert.deepEqual(calls, ["bash"], "only an actual background request is refused");
});

test("the model is not shown a feature it cannot use", () => {
  const { router } = makeRouter();
  const schemas = router.getToolSchemas();
  const names = schemas.map((s) => s.name);

  assert.ok(!names.includes("bash_output"));
  assert.ok(!names.includes("kill_shell"));

  const bash = schemas.find((s) => s.name === "bash")!;
  const props = (bash.input_schema as { properties: Record<string, unknown> }).properties;
  assert.ok(!("run_in_background" in props));
  assert.ok(!("shell_id" in props));
  assert.doesNotMatch(bash.description, /background/i,
    "describing a parameter that is not in the schema invites the model to invent it");
});

test("the bash description still explains what the timeout does", () => {
  const { router } = makeRouter();
  const bash = router.getToolSchemas().find((s) => s.name === "bash")!;
  const timeout = (bash.input_schema as { properties: Record<string, { description?: string }> })
    .properties.timeout!;

  assert.match(bash.description, /process group/,
    "a model that does not know the group is killed will assume its child survived");

  // There used to be three numbers in play -- a 36000s maximum in the schema,
  // a ten-hour limit in Hands and a one-hour deadline in Brain -- and the model
  // was told the largest and stopped by the smallest. The schema now states the
  // ceiling that is actually enforced, and only that one: the same call the
  // deadline and the timeout message are built from, so the model cannot be
  // told one number while planning against another.
  assert.match(timeout.description!, new RegExp(String(toolTimeoutCeilingSec("bash"))));
  assert.doesNotMatch(timeout.description!, new RegExp(String(BASH_FOREGROUND_MAX_SEC)),
    "Hands' own ten-hour limit is not a timeout any single call can be granted");
  assert.doesNotMatch(timeout.description!, /run_in_background/,
    "naming a route this deployment refuses sends the model round a loop it "
      + "cannot leave");
});

test("without background shells, the ceiling is the one that lets work finish", async () => {
  const { BASH_FOREGROUND_MAX_SEC: ceiling } = await import("../src/config.js");
  // The 120s ceiling buys a clean handover between replicas, and the price is
  // paid by run_in_background + wait taking the long work. With those refused
  // there is nothing to pay it with: a build, a test suite or a training step
  // would have no route at all, so the ceiling stays where it was.
  assert.equal(ceiling, 36_000);

  const { handsBaseEnv } = await import("../src/sandbox/bootstrap.js");
  const env = handsBaseEnv("s-1", "9100", "tok");
  assert.match(env, new RegExp(`BASH_MAX_TIMEOUT_SEC=${toolTimeoutCeilingSec("bash")}`),
    "Hands is what enforces the limit, so it is told the number the schema "
      + "states and the deadline is built from: the setting held under the MCP "
      + "hard cap, 3540s, and not the ten hours the setting alone would allow");
  assert.match(env, /BASH_DEFAULT_TIMEOUT_SEC=120/,
    "the default does not move with the ceiling, or every command is planned as "
      + "if it had ten hours");
});

test("isBackgroundShellCall recognises exactly the background paths", () => {
  assert.ok(isBackgroundShellCall("bash", { run_in_background: true }));
  assert.ok(isBackgroundShellCall("bash_output", {}));
  assert.ok(isBackgroundShellCall("kill_shell", {}));

  assert.ok(!isBackgroundShellCall("bash", {}));
  assert.ok(!isBackgroundShellCall("bash", { run_in_background: "yes" }),
    "a string is not the boolean the schema asks for and must not open the path");
  assert.ok(!isBackgroundShellCall("read", { path: "a" }));
});
