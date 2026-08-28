// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Starting Hands again inside a container that is still running.
 *
 * The recovery this belongs to exists to avoid destroying a live container, so
 * the failure that matters most here is a partial success reported as a
 * success: a Hands that was launched and never answered would send the run on
 * with a client pointed at nothing, and the caller would have spent its one
 * chance to escalate.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { exec as execCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  isSafeHandsBinaryPath,
  mcpPortFromUrl,
  restartHandsInSandbox,
  stopStaleHandsCmd,
  stopStaleHandsCmdForPaths,
} from "../src/sandbox/hands-restart.js";
import { bindContainerProbeEffects } from "../src/sandbox/container-probe.js";
import type { SandboxExecResult } from "../src/sandbox/provider.js";

const realFetch = globalThis.fetch;
const exec = promisify(execCallback);
let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
  globalThis.fetch = realFetch;
});

const ENTRY = {
  provider: "safe-workload",
  workloadId: "wl-1",
  platformKey: "pk",
  namespace: "ns",
};

/** Production bounds are 10 * 2s; nothing here needs to wait that out. */
const FAST_POLL = { pollTries: 2, pollIntervalMs: 1 };
const TEST_SCAN_PATHS = ["/app/hands-binary", "/tmp/.hands-binary"] as const;

test("only shell-literal-safe absolute binary paths reach the proc scanner", () => {
  assert.equal(isSafeHandsBinaryPath("/mnt/shared/ns/hands-binary"), true);
  for (const path of [
    "",
    "relative/hands-binary",
    "/mnt/has space/hands-binary",
    "/mnt/'$(touch /tmp/injected)'/hands-binary",
    "/mnt/`touch /tmp/injected`/hands-binary",
    "/mnt/$PATH/hands-binary",
  ]) {
    assert.equal(isSafeHandsBinaryPath(path), false, path);
  }
});

/** Record every command the restart runs, answering each with exit 0. */
function execRecorder(over: (cmd: string) => SandboxExecResult | null = () => null) {
  const cmds: string[] = [];
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => ENTRY,
    exec: async (_inst, cmd) => {
      cmds.push(cmd);
      return over(cmd) ?? { exitCode: 0, stdout: "started_pid=1", stderr: "" };
    },
  });
  return cmds;
}

/** Answer /health `ok` after `healthyAfter` polls. */
function stubHealth(healthyAfter: number): () => number {
  let polls = 0;
  globalThis.fetch = (async () => {
    polls += 1;
    return { ok: polls > healthyAfter, status: polls > healthyAfter ? 200 : 503 } as Response;
  }) as typeof fetch;
  return () => polls;
}

test("the port comes from the recorded url, not a hardcoded default", () => {
  assert.equal(mcpPortFromUrl("http://10.0.0.1:9310/mcp"), "9310");
  assert.equal(mcpPortFromUrl("http://sandbox.ns.svc/mcp"), "9100");
  assert.equal(mcpPortFromUrl("not a url"), "9100");
});

test("a wedged Hands is cleared off the port before a new one binds it", () => {
  const cmd = stopStaleHandsCmd();
  // A Hands that stopped answering has not necessarily stopped running, and one
  // still holding the port turns "Hands is wedged" into "Hands cannot start".
  assert.match(cmd, /for proc in \/proc\/\[0-9\]\*/);
  assert.match(cmd, /kill -KILL "\$pid"/);
  // The deployed sandbox image has no procps or BusyBox process utilities.
  assert.doesNotMatch(cmd, /\b(?:pkill|pgrep|killall|ps)\b/);
});

test("the stale Hands is killed, never asked -- SIGTERM would reap the job", () => {
  // Hands handles SIGTERM by taking every background shell down with it, so
  // that a pod eviction leaves no orphaned training runs (hands/src/index.ts).
  // On this path that handler is the enemy: a wedged-but-live Hands asked
  // politely to stop would reap the Hyperloom job the container is being kept
  // alive for, and restarting in place would preserve nothing.
  assert.doesNotMatch(stopStaleHandsCmd(), /-TERM|-15\b|SIGTERM/);
});

test("the kill pattern cannot match the shell that runs it", () => {
  const cmd = stopStaleHandsCmd();
  assert.match(cmd, /hands-'bin'ary/);
  assert.doesNotMatch(cmd, /hands-binary/);
  assert.match(cmd, /"\$proc\/cmdline"/);
  assert.match(cmd, /\/app\/hands-'bin'ary/);
  assert.match(cmd, /\/tmp\/\.hands-'bin'ary/);
});

test("the proc scanner kills Hands without killing an unrelated holder", async () => {
  const hands = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    argv0: "/tmp/.hands-binary",
    stdio: "ignore",
  });
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    argv0: "e2e-holder",
    stdio: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await exec(stopStaleHandsCmdForPaths(TEST_SCAN_PATHS));
    if (hands.exitCode === null && hands.signalCode === null) {
      await Promise.race([
        once(hands, "exit"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Hands process survived scanner")), 1_000)),
      ]);
    }
    assert.equal(hands.signalCode, "SIGKILL");
    assert.doesNotThrow(() => process.kill(holder.pid!, 0), "holder must survive");
  } finally {
    hands.kill("SIGKILL");
    holder.kill("SIGKILL");
  }
});

test("a process whose cmdline only mentions hands-binary is not killed", async () => {
  const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    argv0: "/opt/run-hands-binary-helper",
    stdio: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await exec(stopStaleHandsCmdForPaths(TEST_SCAN_PATHS));
    assert.doesNotThrow(() => process.kill(decoy.pid!, 0), "substring decoy must survive");
  } finally {
    decoy.kill("SIGKILL");
  }
});

test("an exact Hands path used as a non-argv0 argument is not killed", async () => {
  const decoy = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 60_000)", "/app/hands-binary"],
    { argv0: "argument-holder", stdio: "ignore" },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await exec(stopStaleHandsCmdForPaths(TEST_SCAN_PATHS));
    assert.doesNotThrow(() => process.kill(decoy.pid!, 0), "argument-only decoy must survive");
  } finally {
    decoy.kill("SIGKILL");
  }
});

test("a restart that comes up healthy is reported as such", async () => {
  const cmds = execRecorder();
  const polls = stubHealth(0);

  const r = await restartHandsInSandbox({
    sessionId: "sess-1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok-1",
    entry: ENTRY,
  });

  assert.deepEqual(r, { ok: true, detail: "healthy" });
  assert.ok(cmds.some((c) => /\/proc\/\[0-9\]\*/.test(c)), "the stale process is killed first");
  assert.ok(
    cmds.some((c) => /AUTH_CLAW_TOKEN=tok-1/.test(c)),
    "the sandbox is restarted with the token the run is already holding",
  );
  assert.ok(
    cmds.some((c) => /MCP_PORT=9100/.test(c)),
    "and on the port the run is already talking to",
  );
  assert.equal(polls(), 1);
});

test("a Hands that starts but never answers is a failure, not a success", async () => {
  const cmds = execRecorder();
  // Never healthy: the poll runs out. Reporting ok here would hand the run a
  // client pointed at a port with nothing behind it.
  stubHealth(Number.MAX_SAFE_INTEGER);

  const r = await restartHandsInSandbox({
    sessionId: "sess-1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok-1",
    entry: ENTRY,
    ...FAST_POLL,
  });

  assert.equal(r.ok, false);
  assert.equal(r.detail, "started_but_unhealthy");
  assert.ok(cmds.length > 0);
});

test("a bootstrap that fails outright is reported without throwing", async () => {
  // Every caller is already on a recovery path choosing between this and a
  // rebuild; it needs a verdict, not a second failure to handle.
  execRecorder((cmd) => (/\/proc\/\[0-9\]\*/.test(cmd)
    ? null
    : { exitCode: 1, stdout: "", stderr: "no usable hands-binary" }));
  stubHealth(Number.MAX_SAFE_INTEGER);

  const r = await restartHandsInSandbox({
    sessionId: "sess-1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok-1",
    entry: ENTRY,
    ...FAST_POLL,
  });

  assert.equal(r.ok, false);
  assert.match(r.detail, /no source produced a running Hands|hands-binary/);
});

test("a session with no recorded sandbox has nothing to restart", async () => {
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => null,
    exec: async () => { throw new Error("exec must not run without an identity"); },
  });

  const r = await restartHandsInSandbox({
    sessionId: "sess-1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok-1",
  });

  assert.deepEqual(r, { ok: false, detail: "no_sandbox_identity" });
});

test("an explicit identity is used instead of the session's key", async () => {
  // Same reason the probe takes one: a DAG's nodes share a session, so that key
  // names whichever sibling wrote it last.
  const seen: string[] = [];
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => {
      throw new Error("the session key must not be consulted when the caller knows");
    },
    exec: async (inst, cmd) => {
      seen.push(inst.id);
      void cmd;
      return { exitCode: 0, stdout: "started_pid=1", stderr: "" };
    },
  });
  stubHealth(0);

  const r = await restartHandsInSandbox({
    sessionId: "sess-shared",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok-1",
    entry: { provider: "safe-workload", workloadId: "inherited-wl", namespace: "ns" },
  });

  assert.equal(r.ok, true);
  assert.ok(seen.every((id) => id === "inherited-wl"));
});

test("a Hands that bound its port while the exec was abandoned is not reported dead", async () => {
  // The deadline gives up on the *exec*, not on the launch: setsid detached the
  // process before the control plane went quiet, so Hands may be seconds from
  // answering. Concluding failure without asking once spends a recovery budget
  // unit on a sandbox that is already fine, and tells the model its container
  // could not be repaired when it was.
  stubHealth(0); // answers ok on the first poll
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => ENTRY,
    exec: (_inst, _cmd, _timeout, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });

  const r = await restartHandsInSandbox({
    sessionId: "sess-1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok-1",
    entry: ENTRY,
    execDeadlineMs: 40,
  });

  assert.equal(r.ok, true, "the port answered, whatever the exec did");
  assert.equal(r.detail, "healthy_after_deadline",
    "the caller should still be able to see that the exec was abandoned");
});

test("a hung exec is abandoned at the restart deadline, not left running", async () => {
  let aborted = false;
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => ENTRY,
    exec: (_inst, _cmd, _timeout, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });

  const t0 = Date.now();
  const r = await restartHandsInSandbox({
    sessionId: "sess-1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok-1",
    entry: ENTRY,
    execDeadlineMs: 40,
  });

  assert.equal(r.ok, false);
  assert.equal(r.detail, "exec_deadline");
  assert.equal(aborted, true, "deadline must cancel the provider request");
  assert.ok(Date.now() - t0 < 1_000, "must not wait out the bootstrap timeout");
});

test("a scanner with no usable paths is a no-op, not a syntax error", async () => {
  // Every candidate filtered out leaves nothing to match. The generated shell
  // used to be `; self=$$; ... case "$argv0" in )` -- a leading separator and
  // an empty case list -- so the step failed with a syntax error rather than
  // the "nothing to kill" it actually means.
  const cmd = stopStaleHandsCmdForPaths(["relative/hands-binary", ""]);
  await exec(`/bin/sh -n -c ${JSON.stringify(cmd)}`);
  await exec(`/bin/sh -c ${JSON.stringify(cmd)}`);
});

test("the generated scanner is valid shell at full production shape", async () => {
  // Three paths, the shape stopStaleHandsCmd assembles where shared storage is
  // configured -- but from a literal list, never from the environment. Handing
  // the env-derived production string to a host shell is the env-to-command
  // flow this file removed in e4963aa6 (CodeQL
  // js/indirect-command-line-injection), and what needs checking here is the
  // generated shell's shape, which a literal list checks just as well.
  const cmd = stopStaleHandsCmdForPaths([
    "/app/hands-binary",
    "/tmp/.hands-binary",
    "/mnt/shared/ns/hands-binary",
  ]);
  await exec(`/bin/sh -n -c ${JSON.stringify(cmd)}`);
});

test("a second restart of the same sandbox joins the first instead of killing it", async () => {
  // The scanner SIGKILLs every process whose argv[0] is a Hands binary. That is
  // right for one restart and wrong for two: the second one's kill step cannot
  // tell the Hands the first just launched from the wedged one it meant to
  // clear, so it kills it and both report failure for a healthy container.
  let kills = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => ENTRY,
    exec: async (_inst, cmd) => {
      if (/\/proc\/\[0-9\]\*/.test(cmd)) { kills++; await gate; }
      return { exitCode: 0, stdout: "started_pid=1", stderr: "" };
    },
  });
  stubHealth(0);

  const attempt = {
    sessionId: "sess-1",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok-1",
    entry: ENTRY,
    ...FAST_POLL,
  };
  const first = restartHandsInSandbox(attempt);
  const second = restartHandsInSandbox(attempt);
  release!();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(kills, 1, "the container must be swept once, not once per caller");
  assert.deepEqual(a, b, "both callers get the one verdict that was reached");
  assert.equal(a.ok, true);
});

test("two different sandboxes in one session restart independently", async () => {
  // A DAG's nodes share a session and own different sandboxes, so keying the
  // in-flight map by session would serialise repairs that have nothing to do
  // with each other.
  let kills = 0;
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => ENTRY,
    exec: async (_inst, cmd) => {
      if (/\/proc\/\[0-9\]\*/.test(cmd)) kills++;
      return { exitCode: 0, stdout: "started_pid=1", stderr: "" };
    },
  });
  stubHealth(0);

  const base = { sessionId: "sess-1", handsUrl: "http://sandbox:9100/mcp", token: "t", ...FAST_POLL };
  await Promise.all([
    restartHandsInSandbox({ ...base, entry: { ...ENTRY, workloadId: "wl-A" } }),
    restartHandsInSandbox({ ...base, entry: { ...ENTRY, workloadId: "wl-B" } }),
  ]);

  assert.equal(kills, 2, "sibling sandboxes must each be repaired");
});

test("a joiner does not inherit an owner abort that rejects mid-poll", async () => {
  // The owner leaves by two doors. An abort inside kill/relaunch RESOLVES with
  // `aborted`; an abort during an inter-poll wait REJECTS with
  // `restart_aborted` out of sleepUntilNextPoll. Guarding only the first left
  // the second doing exactly what the guard exists to stop -- handing a caller
  // that was never cancelled someone else's shutdown, and a budget unit with it.
  const owner = new AbortController();
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => ENTRY,
    exec: async () => ({ exitCode: 0, stdout: "started_pid=1", stderr: "" }),
  });
  stubHealth(Number.MAX_SAFE_INTEGER); // never healthy, so the poll sleeps

  const base = {
    sessionId: "s-j", handsUrl: "http://sandbox:9100/mcp", token: "t", entry: ENTRY,
    pollTries: 4, pollIntervalMs: 400,
  };
  const ownerRun = restartHandsInSandbox({ ...base, signal: owner.signal });
  await new Promise((r) => setTimeout(r, 60));
  const joinerRun = restartHandsInSandbox({ ...base });   // no signal of its own
  await new Promise((r) => setTimeout(r, 60));
  owner.abort();                                          // lands during a poll sleep
  const [ownerRes, joiner] = await Promise.all([ownerRun, joinerRun]);

  assert.equal(ownerRes.ok, false);
  assert.equal(joiner.ok, false);
  assert.equal(joiner.detail, "owner_aborted",
    `a joiner that was never cancelled must say so; got ${joiner.detail}`);
});

test("a restart that was attempted and failed is NOT marked refused", async () => {
  // The negative half. A blanket `refused: true` on every failure return would
  // be just as wrong in the other direction: ensure-hands would destroy a live
  // container over a transient failure, inverting the behaviour the probe path
  // exists to protect.
  execRecorder();
  stubHealth(Number.MAX_SAFE_INTEGER); // starts, never answers
  const r = await restartHandsInSandbox({
    sessionId: "sess-1", handsUrl: "http://sandbox:9100/mcp", token: "tok",
    entry: ENTRY, ...FAST_POLL,
  });
  assert.equal(r.ok, false);
  assert.equal(r.detail, "started_but_unhealthy");
  assert.ok(!r.refused, "an attempted repair that failed must keep the container");
});

test("a joiner that is cancelled stops waiting on the owner's repair", async () => {
  // The mirror of the test above. Every other wait in the module observes the
  // caller's signal; the join did not, so a joiner cancelled mid-repair stayed
  // blocked for the owner's entire budget -- here four 400ms polls, and in
  // production the exec deadline plus a final poll -- and its task could not
  // finish shutting down until another node's repair gave up.
  const joiner = new AbortController();
  restore = bindContainerProbeEffects({
    readHandsEntry: async () => ENTRY,
    exec: async () => ({ exitCode: 0, stdout: "started_pid=1", stderr: "" }),
  });
  stubHealth(Number.MAX_SAFE_INTEGER); // the owner never finishes

  const base = {
    sessionId: "s-jc", handsUrl: "http://sandbox:9100/mcp", token: "t", entry: ENTRY,
    pollTries: 4, pollIntervalMs: 400,
  };
  const ownerRun = restartHandsInSandbox({ ...base });
  let ownerSettled = false;
  void ownerRun.then(() => { ownerSettled = true; });
  await new Promise((r) => setTimeout(r, 60));
  const joinerRun = restartHandsInSandbox({ ...base, signal: joiner.signal });
  await new Promise((r) => setTimeout(r, 60));
  joiner.abort();

  const res = await joinerRun;
  assert.equal(ownerSettled, false,
    "the joiner must return on its own abort, not outlive it waiting for the owner");
  assert.equal(res.ok, false);
  assert.equal(res.detail, "aborted",
    `a cancelled joiner reports its own abort, not the owner's; got ${res.detail}`);
  await ownerRun; // let the owner finish rather than leaking its timer into the next test
});
