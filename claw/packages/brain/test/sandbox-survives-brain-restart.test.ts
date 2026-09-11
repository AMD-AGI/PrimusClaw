// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The half of Brain-restart recovery that lives in the sandbox.
 *
 * Covered: after every client-side thing is gone -- transport, module state,
 * heap, the process itself -- the ids in the transcript are still sufficient to
 * reach the same processes, poll, wait and kill each one, and nothing is
 * started on the way. A recovery that respawns looks identical from the outside
 * and is a second execution of the command, which is the failure this catches.
 *
 * Not covered: the Brain application is never started, so the restore of its
 * own durable task and run state, and the loop that consumes it, are outside
 * this file.
 *
 * Two shells for one run identity, so a recovery reaching only the first
 * cannot pass.
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
const CLIENT_DIST = fileURLToPath(new URL("../dist/clients/hands.js", import.meta.url));
const RESULT_MARKER = "__recovery_answer__";
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

/** A client with nothing carried over from the one before it, in this process. */
const freshBrain = () => new HandsClient(`http://127.0.0.1:${port}/mcp`, TOKEN, OWNER, RUN);

/**
 * The same, in a process of its own.
 *
 * Closing a client and building another leaves every module-level cache, every
 * connection pool and the whole heap in place, so it cannot tell recovery from
 * a client that simply reconnected. A separate process removes all of that --
 * which is the sandbox-facing half of a Brain restart, not the whole of one.
 */
async function inSeparateBrain(body: string): Promise<string> {
  const script = `
    const { HandsClient } = await import(${JSON.stringify(CLIENT_DIST)});
    const brain = new HandsClient(${JSON.stringify(`http://127.0.0.1:`)} + process.env.PORT + "/mcp",
      ${JSON.stringify(TOKEN)}, ${JSON.stringify(OWNER)}, ${JSON.stringify(RUN)});
    const out = [];
    ${body}
    await brain.close();
    // Delimited: the client logs to stdout too, so the answer has to be
    // findable in a stream it shares with them.
    process.stdout.write(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(out));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  const errs: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  child.stderr.on("data", (c: Buffer) => errs.push(c));
  const code = await new Promise<number>((r) => child.on("exit", (c) => r(c ?? 1)));
  assert.equal(code, 0, `the separate Brain failed: ${Buffer.concat(errs).toString()}`);
  const out = Buffer.concat(chunks).toString();
  const at = out.lastIndexOf(RESULT_MARKER);
  assert.ok(at >= 0, `the separate Brain produced no answer: ${out}`);
  return out.slice(at + RESULT_MARKER.length);
}

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
      // The boundary needs an identity this host can assume and a process view
      // it can partition, neither of which a test runner has. Stated rather
      // than left unset, because unset is what Hands refuses to start on.
      HANDS_CHILD_ISOLATION: "unenforced",
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

test("a client in a new process reaches both of a run's shells by the ids in the transcript", async () => {
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

  // Everything Brain-local goes -- the process included. Only the ids survive,
  // as a transcript would carry them.
  await first.close();

  const answers = JSON.parse(await inSeparateBrain(`
    out.push(await brain.callTool("bash_output", { shell_id: "primary" }));
    out.push(await brain.callTool("bash_output", { shell_id: "monitor" }));
  `)) as string[];

  assert.match(answers[0], /primary-line/, "the pre-restart output is not readable");
  assert.match(answers[1], /monitor-line/, "the second shell was not recovered, only the first");
  assert.doesNotMatch(answers[0], /monitor-line/, "the two resolved to one shell");

  // Nothing was started to make that work: a recovery that respawns looks
  // identical from the outside and has run the command twice.
  assert.equal(recordCount(), started, "the recovery path started a shell");
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

test("a wait from a new process resolves on the original process's exit", async () => {
  const brain = freshBrain();
  await brain.callTool("bash", {
    command: "sleep 1; exit 5", run_in_background: true, shell_id: "short",
  });
  await brain.close();

  const [text] = JSON.parse(await inSeparateBrain(`
    out.push(await brain.callTool("wait", { shell_id: "short", timeout_sec: 20 }));
  `)) as string[];
  assert.match(text, /exit_code=5/, "the exit status came from the process that was already running");
});

test("an id that was never issued is refused, and starts nothing", async () => {
  const brain = freshBrain();
  const before = recordCount();

  const text = await brain.callTool("bash_output", { shell_id: "never-issued" });
  assert.match(text, /shell not found/);
  assert.equal(recordCount(), before, "a poll for an unknown id created something");
  await brain.close();
});
