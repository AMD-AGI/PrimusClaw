// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A Brain restarts, the sandbox does not, and the work is still there.
 *
 * All Brain-local state goes: the client, its transport, whatever it knew about
 * which shells exist. What survives is the sandbox and the ids in the
 * transcript, and a fresh Brain has to reach the same processes by them --
 * poll, wait and kill each one, and start nothing on the way. Starting
 * something is the failure this exists to catch, because it looks like a
 * recovery and is a second execution of the command.
 *
 * A real Hands process and a real port, because what is under test is exactly
 * the boundary a stand-in would replace. Two shells for one run identity, so a
 * recovery that reaches only the first cannot pass.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HandsClient } from "../src/clients/hands.js";

const HANDS_DIST = fileURLToPath(new URL("../../hands/dist/index.js", import.meta.url));
const TOKEN = "restart-e2e-token";
const OWNER = "sess-restart-e2e";
const RUN = "ktsk_1";

let hands: ChildProcess | null = null;
let workspace = "";
let stateDir = "";
let port = 0;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, () => {
    const { port: p } = s.address() as { port: number };
    s.close(() => resolve(p));
  });
});

/** A Brain with nothing carried over from the one before it. */
const freshBrain = () => new HandsClient(`http://127.0.0.1:${port}/mcp`, TOKEN, OWNER, RUN);

/**
 * How many shells this sandbox has records for.
 *
 * Read off the record subtree rather than asked of Hands: a spawn on the
 * recovery path leaves a record whether or not anything reports it, so this
 * sees a second execution that a request count would not.
 */
function recordCount(dir = join(stateDir, "scopes")): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? recordCount(join(dir, e.name)) : 1), 0);
}

before(async () => {
  assert.ok(existsSync(HANDS_DIST), `${HANDS_DIST} not built -- run npm run build first`);

  workspace = mkdtempSync(join(tmpdir(), "claw-restart-ws-"));
  stateDir = mkdtempSync(join(tmpdir(), "claw-restart-state-"));
  port = await freePort();
  hands = spawn(process.execPath, [HANDS_DIST], {
    env: {
      ...process.env,
      WORKSPACE_PATH: workspace,
      HANDS_STATE_DIR: stateDir,
      MCP_PORT: String(port),
      AUTH_CLAW_TOKEN: TOKEN,
      BG_SHELL_ENABLED: "true",
      // Long enough that nothing under test is reaped out of the registry
      // mid-fixture, which would make a recovery look like a loss.
      BG_SHELL_REAP_DELAY_MS: "600000",
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch { /* not up yet */ }
    assert.ok(Date.now() < deadline, "Hands never came up");
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  hands?.kill("SIGKILL");
  for (const dir of [workspace, stateDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh Brain reaches both of a run's shells by the ids in the transcript", async () => {
  const first = freshBrain();
  await first.callTool("bash", {
    command: "echo primary-line; sleep 60", run_in_background: true, shell_id: "primary",
  });
  await first.callTool("bash", {
    command: "echo monitor-line; sleep 60", run_in_background: true, shell_id: "monitor",
  });
  await new Promise((r) => setTimeout(r, 400));
  const started = recordCount();
  assert.equal(started, 2, "the fixture has to start two shells for one run identity");

  // Everything Brain-local goes. Only the ids survive, as a transcript would
  // carry them.
  await first.close();

  const recovered = freshBrain();
  const primary = await recovered.callTool("bash_output", { shell_id: "primary" });
  const monitor = await recovered.callTool("bash_output", { shell_id: "monitor" });

  assert.match(primary, /primary-line/, "the pre-restart output is not readable");
  assert.match(monitor, /monitor-line/, "the second shell was not recovered, only the first");
  assert.doesNotMatch(primary, /monitor-line/, "the two resolved to one shell");

  // Nothing was started to make that work: a recovery that respawns looks
  // identical from the outside and has run the command twice.
  assert.equal(recordCount(), started, "the recovery path started a shell");
  await recovered.close();
});

test("the recovered shells are waitable and killable, and killing one leaves the other", async () => {
  const brain = freshBrain();

  // A wait on a running shell that runs out reports it still running and is
  // repeatable, exactly as one issued before the restart would.
  const waited = await brain.callTool("wait", { shell_id: "primary", timeout_sec: 1 });
  assert.match(waited, /still running/);

  await brain.callTool("kill_shell", { shell_id: "monitor" });
  await new Promise((r) => setTimeout(r, 400));

  const survivor = await brain.callTool("bash_output", { shell_id: "primary" });
  assert.match(survivor, /Class: running/, "killing a sibling ended the wrong shell");

  const killed = await brain.callTool("bash_output", { shell_id: "monitor" });
  assert.match(killed, /Class: finished/);
  await brain.close();
});

test("a wait by a fresh Brain resolves on the original process's exit", async () => {
  const brain = freshBrain();
  await brain.callTool("bash", {
    command: "sleep 1; exit 5", run_in_background: true, shell_id: "short",
  });
  await brain.close();

  const recovered = freshBrain();
  const text = await recovered.callTool("wait", { shell_id: "short", timeout_sec: 20 });
  assert.match(text, /exit_code=5/, "the exit status came from the process that was already running");
  await recovered.close();
});

test("an id that was never issued is refused, and starts nothing", async () => {
  const brain = freshBrain();
  const before = recordCount();

  const text = await brain.callTool("bash_output", { shell_id: "never-issued" });
  assert.match(text, /shell not found/);
  assert.equal(recordCount(), before, "a poll for an unknown id created something");
  await brain.close();
});
