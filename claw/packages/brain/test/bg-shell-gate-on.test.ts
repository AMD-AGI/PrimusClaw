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

  assert.deepEqual(calls, ["bash", "bash_output", "kill_shell"]);
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
  assert.match(env, /BASH_MAX_TIMEOUT_SEC=120/,
    "the tight ceiling belongs with the background shells that make it livable");
  assert.match(env, /BASH_DEFAULT_TIMEOUT_SEC=120/);
  assert.match(env, /WAIT_MAX_SEC=1800/,
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
  // replica has no command from the previous owner still writing.
  assert.equal(BASH_FOREGROUND_MAX_SEC, 120);
});
