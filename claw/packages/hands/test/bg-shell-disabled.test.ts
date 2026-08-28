// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What `BG_SHELL_ENABLED=false` actually turns off.
 *
 * It used to remove fields and tools from the schemas Brain showed the model,
 * and nothing else: Hands registered the tools unconditionally and ran them for
 * anyone who asked, so a resumed transcript that already contained a
 * `bash_output` call, a sub-agent, or a direct MCP request kept using a feature
 * the operator had switched off. The refusal now sits in front of the spawn,
 * which is the only way to reach a process.
 *
 * Separate file from the ownership tests because the flag is read at module
 * load and the test runner gives each file its own process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
delete process.env.BG_SHELL_ENABLED;
const bg = await import("../src/tools/shell/bg-manager.js");
const { bash } = await import("../src/tools/shell/bash.js");
const { bash_output } = await import("../src/tools/shell/bash-output.js");
const { kill_shell } = await import("../src/tools/shell/kill-shell.js");

/** The flag is off by default; leaving it unset must not leave it on. */
test("the default is off", () => {
  assert.throws(() => bg.spawnBackground("someone", "run-1", "sleep 30"), /disabled/);
});

test("nothing is spawned when the feature is off", () => {
  assert.throws(() => bg.spawnBackground("someone", "run-1", "sleep 30", "id"), /BG_SHELL_ENABLED/);
  assert.deepEqual(bg.listRunningShells("someone"), [],
    "a refusal that still left a process behind would be the bug it is meant to prevent");
});

test("polling and killing refuse too, so a stale transcript gets an answer", () => {
  assert.match(bg.pollOutput("someone", "bg-1"), /disabled/);
  assert.match(bg.killShell("someone", "bg-1"), /disabled/);
});

test("the refusal tells the caller what to do instead", () => {
  assert.match(bg.BG_SHELL_DISABLED_MESSAGE, /foreground/,
    "a model that is only told 'no' will retry the same call");
});

test("the foreground ceiling does not assume an escape hatch that is switched off", () => {
  // The 120s ceiling is worth having because long work goes to a background
  // shell instead. Where that is refused, the same ceiling means nothing over
  // two minutes can run by any route -- so the fallback here is the ten hours it
  // replaced. Brain applies the rule and forwards the number, and this covers a
  // Hands launched without it.
  assert.match(bash.zodSchema.timeout.description!, /capped at 36000/);
});

test("bash still runs foreground commands", async () => {
  const res = await bash.execute({ command: "echo alive" });
  assert.match(res.content[0]!.text!, /alive/);
});

test("bash reports the refusal as a tool error, not as success", async () => {
  const res = await bash.execute({ command: "sleep 30", run_in_background: true });
  assert.match(res.content[0]!.text!, /disabled/);
  assert.equal((res as { isError?: boolean }).isError, true,
    "returning ok text would have the model wait for output that will never come");
});

test("the background tools are still reachable and still say no", async () => {
  assert.match((await bash_output.execute({ shell_id: "bg-1" })).content[0]!.text!, /disabled/);
  assert.match((await kill_shell.execute({ shell_id: "bg-1" })).content[0]!.text!, /disabled/);
});
