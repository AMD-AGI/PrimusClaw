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
import {
  BASH_FOREGROUND_DEFAULT_SEC, BASH_FOREGROUND_MAX_SEC, WAIT_DEFAULT_SEC,
} from "../src/config.js";
import { MCP_DEADLINE_SLACK_MS, toolTimeoutCeilingSec } from "../src/tools/hands.js";
import { callDeadlineMs } from "../src/clients/hands.js";
import { HANDS_STATE_DIR, handsBaseEnv } from "../src/sandbox/bootstrap.js";
import type { HandsClient } from "../src/clients/hands.js";
import { assertBackgroundSurface, assertSurfaceMatches } from "./fixtures/builtin-tool-surface.js";

/** Records what would have reached the sandbox. */
function makeRouter(): { router: ToolRouter; calls: string[] } {
  const calls: string[] = [];
  // Both entry points, because the router uses the one that carries the error
  // bit and a stub with only the other would answer undefined.
  const hands = {
    callTool: async (name: string) => { calls.push(name); return "ran"; },
    callToolFull: async (name: string) => {
      calls.push(name);
      return { text: "ran", isError: false };
    },
  } as unknown as HandsClient;
  return { router: new ToolRouter(hands), calls };
}

test("a background bash call is refused instead of forwarded", async () => {
  const { router, calls } = makeRouter();
  const out = await router.route("bash", { command: "sleep 999", run_in_background: true });

  assert.match(String(out), /disabled/);
  assert.deepEqual(calls, [], "the sandbox must never see a call the operator turned off");
});

test("a stale bash_output, kill_shell or wait gets a legible answer", async () => {
  const { router, calls } = makeRouter();

  assert.match(String(await router.route("bash_output", { shell_id: "bg-1" })), /disabled/);
  assert.match(String(await router.route("kill_shell", { shell_id: "bg-1" })), /disabled/);
  assert.match(String(await router.route("wait", { shell_id: "bg-1" })), /disabled/);
  assert.match(
    String(await router.route("bash", { command: "sleep 999", run_in_background: true })),
    /disabled/,
  );
  assert.deepEqual(calls, [],
    "all four entry points, or the one left out is the one a replayed "
      + "transcript reaches the sandbox through");
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
  const { BASH_FOREGROUND_MAX_SEC: rawSetting } = await import("../src/config.js");
  // The 120s ceiling buys a clean handover between replicas, and the price is
  // paid by run_in_background + wait taking the long work. With those refused
  // there is nothing to pay it with: a build, a test suite or a training step
  // would have no route at all, so the setting stays where it was. The literal
  // is the subject here -- this is the raw setting, not a surface value, and no
  // surface states it.
  assert.equal(rawSetting, 36_000);

  const { handsBaseEnv } = await import("../src/sandbox/bootstrap.js");
  const env = handsBaseEnv("s-1", "9100", "tok");
  assert.match(env, new RegExp(`BASH_MAX_TIMEOUT_SEC=${toolTimeoutCeilingSec("bash")}`),
    "Hands is what enforces the limit, so it is told the number the schema "
      + "states and the deadline is built from: the setting held under the MCP "
      + "hard cap, and not the ten hours the setting alone would allow");
  assert.notEqual(toolTimeoutCeilingSec("bash"), rawSetting,
    "the held ceiling is what is forwarded; forwarding the raw setting would "
      + "leave the schema promising one number against a sandbox honouring another");
});

test("isBackgroundShellCall recognises exactly the background paths", () => {
  assert.ok(isBackgroundShellCall("bash", { run_in_background: true }));
  assert.ok(isBackgroundShellCall("bash_output", {}));
  assert.ok(isBackgroundShellCall("kill_shell", {}));
  assert.ok(isBackgroundShellCall("wait", {}));

  assert.ok(!isBackgroundShellCall("bash", {}));
  assert.ok(!isBackgroundShellCall("bash", { run_in_background: "yes" }),
    "a string is not the boolean the schema asks for and must not open the path");
  assert.ok(!isBackgroundShellCall("read", { path: "a" }));
});

test("the whole built-in surface is pinned, not only the tools that moved", () => {
  // Every other feature flag is left at its shipped default by not being set
  // here, so BG_SHELL_ENABLED is the only thing separating this snapshot from
  // the enabled file's.
  assertSurfaceMatches(makeRouter().router.getToolSchemas(), false);
});

test("the background tool set is exactly bash", () => {
  assertBackgroundSurface(makeRouter().router.getToolSchemas(), false);
  const names = makeRouter().router.getToolSchemas().map((s) => s.name);
  for (const absent of ["bash_output", "kill_shell", "wait"]) {
    assert.ok(!names.includes(absent), `${absent} must not be offered`);
  }
});

test("the ceiling function's own answers are pinned, not only agreement with it", () => {
  // Comparing surfaces to the function proves they cannot diverge from each
  // other and nothing more: a changed hard cap or slack inside it moves all
  // three together and satisfies every such comparison. These two literals are
  // the subject rather than a copy of one.
  assert.equal(toolTimeoutCeilingSec("bash"), 3540);
  assert.equal(toolTimeoutCeilingSec("wait"), 1800);
});

test("schema, deadline and forwarded env all state the one held ceiling", () => {
  const held = toolTimeoutCeilingSec("bash");
  const { router } = makeRouter();
  const timeout = (router.getToolSchemas().find((s) => s.name === "bash")!
    .input_schema as { properties: Record<string, { description?: string }> }).properties.timeout!;

  assert.match(timeout.description!, new RegExp(`\\b${held}\\b`));
  assert.equal(
    callDeadlineMs("bash", { command: "x", timeout: held * 10 }),
    held * 1000 + MCP_DEADLINE_SLACK_MS,
    "a request above the ceiling is deadlined at the ceiling, not at the request",
  );
  assert.match(handsBaseEnv("s-1", "9100", "tok"), new RegExp(`BASH_MAX_TIMEOUT_SEC=${held}(\\s|$)`));
});

test("the closed-state forwarding tuple is asserted whole, not key by key", () => {
  // A key silently dropped from the string is the failure this shape catches;
  // asserting one key at a time cannot. Every value is read from its source, so
  // a surface holding its own copy of a number fails here rather than agreeing
  // with itself.
  const env = handsBaseEnv("s-1", "9100", "tok");
  const pairs = Object.fromEntries(
    env.split(" ").filter((p) => p.includes("=")).map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );

  assert.equal(pairs.BG_SHELL_ENABLED, "false");
  assert.equal(pairs.BASH_MAX_TIMEOUT_SEC, String(toolTimeoutCeilingSec("bash")));
  assert.equal(pairs.BASH_DEFAULT_TIMEOUT_SEC, String(BASH_FOREGROUND_DEFAULT_SEC));
  assert.equal(pairs.WAIT_MAX_SEC, String(toolTimeoutCeilingSec("wait")),
    "unasserted, this is where the wait ceiling becomes a second instance of "
      + "the divergence the bash ceiling already has");
  assert.equal(pairs.WAIT_DEFAULT_SEC, String(WAIT_DEFAULT_SEC));
  assert.equal(pairs.HANDS_STATE_DIR, HANDS_STATE_DIR,
    "Hands refuses to start where it cannot file records, so the sandbox is "
      + "told a path it can own rather than left to a system default an image "
      + "need not make writable");
  assert.ok(!HANDS_STATE_DIR.startsWith("/workspace"),
    "the workspace is synced, and a sync must not carry the records out");
});

test("the disabled refusal names no duration, so it cannot be read as a timeout", async () => {
  const { router, calls } = makeRouter();
  const out = String(await router.route("wait", { shell_id: "bg-1" }));

  assert.match(out, /disabled/);
  assert.match(out, /foreground/, "the alternative this deployment does have");
  assert.doesNotMatch(out, /\d+\s*s\b|\d+ seconds/,
    "a seconds figure is what separates the two timeout classes from this one");
  assert.doesNotMatch(out, /deadline|may still be running|process group/,
    "nothing here implies the call reached a process");
  assert.doesNotMatch(out, /not found|unknown shell|no longer available/,
    "those are the natural shape of a lost-registry answer, which is a "
      + "different class and out of scope here");
  assert.deepEqual(calls, []);
});
