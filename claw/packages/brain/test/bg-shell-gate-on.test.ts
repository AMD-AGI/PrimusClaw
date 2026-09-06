// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The other half of the switch: with `BG_SHELL_ENABLED=true` the calls go
 * through, the model is told the tools exist, and the sandbox is told the
 * feature is on.
 *
 * Its own file because the flag is read at module load and the test runner
 * gives each file a process; the disabled half is in bg-shell-gate-off.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.BG_SHELL_ENABLED = "true";
const { ToolRouter } = await import("../src/tools/router.js");
const { handsBaseEnv } = await import("../src/sandbox/bootstrap.js");
const { callDeadlineMs, explainHandsError } = await import("../src/clients/hands.js");
const { MCP_DEADLINE_SLACK_MS, toolTimeoutCeilingSec } = await import("../src/tools/hands.js");
const { assertBackgroundSurface, assertSurfaceMatches } =
  await import("./fixtures/builtin-tool-surface.js");
type HandsClient = import("../src/clients/hands.js").HandsClient;

function makeRouter(): { router: InstanceType<typeof ToolRouter>; calls: string[] } {
  const calls: string[] = [];
  const hands = {
    callTool: async (name: string) => { calls.push(name); return "ran"; },
  } as unknown as HandsClient;
  return { router: new ToolRouter(hands), calls };
}

test("background calls reach the sandbox when the feature is on", async () => {
  const { router, calls } = makeRouter();
  await router.route("bash", { command: "sleep 999", run_in_background: true });
  await router.route("bash_output", { shell_id: "bg-1" });
  await router.route("kill_shell", { shell_id: "bg-1" });
  await router.route("wait", { shell_id: "bg-1" });

  assert.deepEqual(calls, ["bash", "bash_output", "kill_shell", "wait"]);
});

test("the model is shown the tools and the parameters", () => {
  const { router } = makeRouter();
  const schemas = router.getToolSchemas();
  const names = schemas.map((s) => s.name);

  assert.ok(names.includes("bash_output"));
  assert.ok(names.includes("kill_shell"));

  const props = (schemas.find((s) => s.name === "bash")!
    .input_schema as { properties: Record<string, unknown> }).properties;
  assert.ok("run_in_background" in props);
  assert.ok("background_kind" in props);
});

test("the descriptions say when to reach for a background shell", () => {
  const { router } = makeRouter();
  const schemas = router.getToolSchemas();
  const bash = schemas.find((s) => s.name === "bash")!;

  assert.match(bash.description, /run_in_background=true/,
    "the model raised the timeout instead, because nothing told it there was another option");
  assert.match(schemas.find((s) => s.name === "bash_output")!.description, /since your previous poll/,
    "a model expecting the full log will read a second poll as the work having restarted");
  assert.match(schemas.find((s) => s.name === "kill_shell")!.description, /until it is stopped/,
    "left unsaid, abandoned shells keep the sandbox busy for the rest of the session");
});

test("the sandbox is launched with the same answer Brain gave the model", () => {
  // Hands has its own copy of the flag, and the two disagreeing would mean
  // either a tool the model can see and not use, or one it uses unannounced.
  const env = handsBaseEnv("s-1", "9100", "tok");
  assert.match(env, /BG_SHELL_ENABLED=true/);
  assert.match(env, new RegExp(`BASH_MAX_TIMEOUT_SEC=${toolTimeoutCeilingSec("bash")}(\\s|$)`),
    "the tight ceiling belongs with the background shells that make it livable, "
      + "and is read from the one function every surface reads");
  assert.match(env, /BASH_DEFAULT_TIMEOUT_SEC=120/);
  assert.match(env, new RegExp(`WAIT_MAX_SEC=${toolTimeoutCeilingSec("wait")}(\\s|$)`),
    "Brain builds a wait's deadline from this, so the sandbox has to clamp waits "
      + "at the same number");
});

/** The MCP client's own deadline, as the SDK reports it. */
function toolTimeout(): Error {
  return Object.assign(new Error("MCP error -32001: Request timed out"), { code: -32001 });
}

test("a call that outran the deadline is sent to the tool that can outlast it", async () => {
  // The same message reads differently on either side of the flag: here there is
  // somewhere else to put the work, and the disabled half of this pair pins that
  // it is not offered where there is not.
  const text = explainHandsError(toolTimeout(), "bash");
  assert.match(text, /run_in_background=true/);
  assert.match(text, /wait/, "the half that makes a long job survivable");
  assert.match(text, /180s deadline/, "the 120s ceiling plus transport slack");
  assert.doesNotMatch(text, /killed/,
    "abandoning the call cancels nothing in the sandbox, and a model told "
      + "otherwise re-runs a command that is still writing");
});

test("where the ceiling is 120s, the advice is not to raise the timeout", () => {
  // Hands clamps the argument to 120s, and the bash schema says so. A message
  // offering an hour instead contradicted the schema the model was planning
  // against, and buying a longer block than the tool can use is how a -32001
  // from a sandbox that stopped answering became an hour-long hang.
  const asked = explainHandsError(toolTimeout(), "bash", { command: "train", timeout: 3600 });
  assert.match(asked, /180s deadline/, "3600 was never granted, so it is not the deadline");
  assert.match(asked, /unlikely to be the repair/);
  assert.doesNotMatch(asked, /does raise it/);
  assert.doesNotMatch(asked, /3600s/, "the hard cap is not this call's ceiling");

  assert.equal(callDeadlineMs("bash", { command: "train", timeout: 3600 }), 180_000,
    "and the deadline the call is actually given is the one reported");
});

test("with somewhere to put long work, the foreground ceiling is the tight one", async () => {
  const { BASH_FOREGROUND_MAX_SEC } = await import("../src/config.js");
  // F <= S < G: under the 300s graceful shutdown, so a run handed to another
  // replica has no command from the previous owner still writing. The literal
  // is the subject: this is the raw setting, not a surface value.
  assert.equal(BASH_FOREGROUND_MAX_SEC, 120);
});

test("the whole built-in surface is pinned in the open state too", () => {
  assertSurfaceMatches(makeRouter().router.getToolSchemas(), true);
});

test("the background tool set is exactly the four names", () => {
  assertBackgroundSurface(makeRouter().router.getToolSchemas(), true);
});

test("the ceiling function's own answers are pinned with the switch on", () => {
  assert.equal(toolTimeoutCeilingSec("bash"), 120);
  assert.equal(toolTimeoutCeilingSec("wait"), 1800,
    "the wait ceiling does not follow the switch; only bash's configured "
      + "maximum does");
});

test("schema, deadline and forwarded env agree with the one held ceiling", () => {
  const held = toolTimeoutCeilingSec("bash");
  const timeout = (makeRouter().router.getToolSchemas().find((s) => s.name === "bash")!
    .input_schema as { properties: Record<string, { description?: string }> }).properties.timeout!;

  assert.match(timeout.description!, new RegExp(`\\b${held}\\b`));
  assert.equal(
    callDeadlineMs("bash", { command: "x", timeout: held * 10 }),
    held * 1000 + MCP_DEADLINE_SLACK_MS,
  );
  assert.match(handsBaseEnv("s-1", "9100", "tok"),
    new RegExp(`BASH_MAX_TIMEOUT_SEC=${held}(\\s|$)`));
});

test("the descriptions send long work at the background tools, not at a bigger timeout", () => {
  // Targeted phrases rather than a snapshot of the prose: each one is what
  // decides whether the model reaches for run_in_background or keeps raising
  // the foreground timeout against a cap it cannot move.
  const schemas = makeRouter().router.getToolSchemas();
  const bash = schemas.find((s) => s.name === "bash")!;
  const timeout = (bash.input_schema as { properties: Record<string, { description?: string }> })
    .properties.timeout!;

  assert.match(bash.description, /run_in_background=true/);
  assert.match(bash.description, /call wait/);
  assert.match(timeout.description!, /instead of raising this/,
    "the cap is not a budget to be argued up");
  assert.match(schemas.find((s) => s.name === "wait")!.description, /final output/,
    "a model that does not know wait returns the output polls for it instead");
});
