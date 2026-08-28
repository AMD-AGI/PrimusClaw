// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Where the Hands binary comes from when a sandbox starts.
//
// The source used to be picked by guessing from the image name -- anything not
// matching "primussafe/claw" or "primus-claw-hands" was assumed not to ship
// Hands and went straight to the ~90MB per-sandbox download, even when the
// image had the binary sitting right there. These pin the replacement: probe
// every image for the free source first, fall through in ascending cost, and
// say what was tried when nothing works.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootstrapHandsInSandbox, handsBinarySources, handsBaseEnv, HANDS_ENV_FILE,
  inImageStartCmd, type SandboxExecFn,
} from "../src/sandbox/bootstrap.js";
import { CLAW_DEPLOY_ROOT, BRAIN_HTTP_URL } from "../src/config.js";

const SESSION = "sess-bootstrap";
const TOKEN = "tok-abc";
const PORT = "9100";

const ok = { exitCode: 0, stdout: "started_pid=42", stderr: "" };
const fail = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });

/** Record every command the bootstrap runs, and reply from a scripted list. */
function recorder(replies: Array<{ exitCode: number; stdout: string; stderr: string }>) {
  const cmds: string[] = [];
  const exec: SandboxExecFn = async (cmd) => {
    cmds.push(cmd);
    return replies[cmds.length - 1] ?? ok;
  };
  return { cmds, exec };
}

/** The command that writes the env file, which precedes each source. */
function isEnvWrite(cmd: string): boolean {
  return cmd.startsWith("printf '%s'");
}

function isEnvCleanup(cmd: string): boolean {
  return cmd.startsWith("rm -f ");
}

/**
 * The commands that start Hands: everything after the mkdir step, minus the
 * env-file write that goes before each source and the unlink that follows
 * the run.
 */
function startAttempts(cmds: string[]): string[] {
  return cmds.slice(1).filter((c) => !isEnvWrite(c) && !isEnvCleanup(c));
}

test("the free in-image source is tried on every image, not just recognised ones", () => {
  const sources = handsBinarySources(handsBaseEnv(SESSION, PORT, TOKEN), TOKEN);

  assert.equal(sources[0]?.name, "in_image",
    "the source that costs nothing must be attempted before the ones that do");
  assert.match(sources[0]!.cmd, /\/app\/hands-binary --self-check/,
    "presence alone is not enough — the binary has to actually run");
});

test("configured sources follow in ascending cost, unconfigured ones are absent", () => {
  const names = handsBinarySources(handsBaseEnv(SESSION, PORT, TOKEN), TOKEN).map((s) => s.name);

  assert.deepEqual(names, [
    "in_image",
    ...(CLAW_DEPLOY_ROOT ? ["shared_storage" as const] : []),
    ...(BRAIN_HTTP_URL ? ["brain_http" as const] : []),
  ], "the download must be last, and a source nobody configured must not be attempted");
});

test("every source launches with the same env and the same liveness check", () => {
  const baseEnv = handsBaseEnv(SESSION, PORT, TOKEN);
  for (const source of handsBinarySources(baseEnv, TOKEN)) {
    assert.ok(source.cmd.includes(baseEnv),
      `${source.name} must pass the token, session and port through to the binary`);
    assert.match(source.cmd, /kill -0 \$PID/,
      `${source.name} must confirm the process survived, not just that it spawned`);
  }
});

test("an image carrying the binary starts from it and never reaches the download", async () => {
  const r = recorder([ok, ok]);
  await bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN);

  const attempts = startAttempts(r.cmds);
  assert.equal(attempts.length, 1, "a source that worked must end the search");
  assert.match(attempts[0]!, /\/app\/hands-binary/);
  assert.ok(!attempts[0]!.includes("curl"), "no image that ships Hands should pay for a download");
});

test("an image without the binary falls through to the next source", async (t) => {
  if (!CLAW_DEPLOY_ROOT && !BRAIN_HTTP_URL) {
    t.skip("no fallback source configured in this environment");
    return;
  }
  const r = recorder([ok, fail("no usable hands-binary at /app/hands-binary"), ok]);
  await bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN);

  const attempts = startAttempts(r.cmds);
  assert.equal(attempts.length, 2, "the probe failing must lead to the next source, not to an error");
});

test("when no source works the error names each one that was tried", async () => {
  const sourceCount = handsBinarySources(handsBaseEnv(SESSION, PORT, TOKEN), TOKEN).length;
  const r = recorder([ok, ...Array(sourceCount).fill(fail("boom"))]);

  await assert.rejects(
    bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN),
    (err: Error) => {
      // The last failure is usually the interesting one, and the reason the
      // earlier sources were skipped is the rest of the story.
      assert.match(err.message, /in_image/);
      assert.match(err.message, /exit_code=1/);
      return true;
    },
  );
  assert.equal(startAttempts(r.cmds).length, sourceCount, "every source must get its turn");
});

test("a failed mkdir stops before any source is attempted", async () => {
  const r = recorder([fail("read-only file system")]);

  await assert.rejects(
    bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN),
    /bootstrap\.mkdir_workspace/,
  );
  assert.deepEqual(startAttempts(r.cmds), [],
    "there is no point starting Hands in a sandbox with no workspace");
});

/**
 * The per-request environment used to travel only in the pod spec, which is
 * decided when the pod is created. A pooled pod is created before anyone knows
 * whose request it will take, and a running pod's environment cannot be
 * changed, so that route cannot serve a warm pool at all -- which is why the
 * pool has been pinned to size 0 rather than merely left unused. Bootstrap
 * happens after the request is known, so the environment goes with it.
 */
test("the caller's environment is handed to the sandbox, not left in the pod spec", async () => {
  const r = recorder([ok, ok, ok]);
  await bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN, {
    HF_TOKEN: "hf-secret",
    ANTHROPIC_API_KEY: "sk-test",
  });

  const write = r.cmds.find((c) => c.includes(HANDS_ENV_FILE) && c.includes("base64 -d"));
  assert.ok(write, "the environment has to reach the sandbox somehow");
  assert.ok(!write!.includes("hf-secret"),
    "encoded rather than interpolated: values contain quotes, newlines and $(...)");

  const payload = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(write!)?.[1] ?? "";
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64").toString("utf8")), {
    HF_TOKEN: "hf-secret",
    ANTHROPIC_API_KEY: "sk-test",
  });

  const launch = r.cmds.find((c) => c.includes(`HANDS_ENV_FILE=${HANDS_ENV_FILE}`) && !isEnvWrite(c));
  assert.ok(launch, "Hands is told where to find it, or it will never be read");
});

test("a sandbox with no environment to hand over is bootstrapped as before", () => {
  // Every deployment that does not use the pool is on this path, and adding a
  // round trip to it would be a cost paid for nothing.
  assert.ok(!handsBaseEnv(SESSION, PORT, TOKEN).includes("HANDS_ENV_FILE"));
});

test("the environment file is put back before each source, not written once", async (t) => {
  // The guard inside each source reads the file's absence as proof that the
  // Hands it just started consumed it. Writing once makes that proof
  // transferable: a source whose Hands read the file and then died leaves it
  // gone, so the next source starts with nothing to read and is told it
  // passed -- a sandbox running without the user's environment, which is the
  // exact failure the file was added to remove.
  if (!CLAW_DEPLOY_ROOT && !BRAIN_HTTP_URL) {
    t.skip("no fallback source configured in this environment");
    return;
  }
  // mkdir, write, first source (fails), write again, second source.
  const r = recorder([ok, ok, fail("no usable hands-binary at /app/hands-binary"), ok, ok]);
  await bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN, { HF_TOKEN: "hf-secret" });

  const writes = r.cmds.filter(isEnvWrite);
  assert.equal(writes.length, 2, "one write per source attempted, not one for the run");
  const attempts = startAttempts(r.cmds);
  assert.equal(attempts.length, 2);
  const writeAt = r.cmds.map((c, i) => isEnvWrite(c) ? i : -1).filter((i) => i >= 0);
  const attemptAt = r.cmds.map((c, i) => (
    i > 0 && !isEnvWrite(c) && !isEnvCleanup(c) ? i : -1
  )).filter((i) => i >= 0);
  for (const [i, at] of attemptAt.entries()) {
    assert.ok(
      writeAt[i]! < at,
      `source ${i} must be handed a file that is already on disk`,
    );
  }
});

test("a run with no environment writes no file at all", async () => {
  const r = recorder([ok, ok]);
  await bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN);

  assert.deepEqual(
    r.cmds.filter(isEnvWrite), [],
    "nothing to hand over is not the same as handing over nothing",
  );
});

/**
 * The probe is only safe if it cannot outlive itself.
 *
 * `--self-check` exists in Hands built after 2026-07-31. An older binary does
 * not recognise the flag and starts serving instead, in the foreground, so the
 * probe never returns. This was observed on a deployment whose sandbox image
 * carried a May binary: the exec timeout abandoned the stream after two minutes
 * but left the process holding Hands' port, and the two remaining sources then
 * failed with EADDRINUSE -- so an image shipping a merely older Hands became a
 * sandbox that could not start Hands at all, while a healthy server sat on the
 * port the whole time.
 *
 * These run the generated command against a stand-in for that older binary
 * rather than matching its text, because what went wrong was the behaviour of
 * the shell, not the spelling of the command.
 */
async function runShell(cmd: string, shell: string): Promise<{ code: number; elapsedMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(shell, ["-c", cmd], () => {
      resolve({ code: 0, elapsedMs: Date.now() - started });
    }).on("exit", (code) => {
      resolve({ code: code ?? -1, elapsedMs: Date.now() - started });
    });
  });
}

/** Production writes `/workspace/hands.log`; tests must not. */
function startCmd(
  bin: string,
  dir: string,
  envFile?: string,
  envWaitSec: number = 2,
): string {
  return inImageStartCmd("ENV=1", bin, 1, envFile, envWaitSec, path.join(dir, "hands.log"));
}

for (const shell of ["sh", "bash"] as const) {
test(`a probe the binary never answers is killed, and leaves nothing on the port (${shell})`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hands-probe-"));
  const bin = path.join(dir, "hands-binary");
  const pidFile = path.join(dir, "pid");
  // Stands in for a pre-July binary: unknown flags are ignored and it goes
  // straight to serving. `exec` so the pid it records is the one that lingers.
  await writeFile(bin, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 300\n`);
  await chmod(bin, 0o755);

  const { code, elapsedMs } = await runShell(startCmd(bin, dir), shell);

  assert.notEqual(code, 0,
    "a binary that will not answer the probe must be rejected, not launched");
  assert.ok(elapsedMs < 20_000,
    `the probe must be bounded by its own timeout, took ${elapsedMs}ms`);

  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isFinite(pid) && pid > 0, "the stand-in should have recorded its pid");
  assert.throws(() => process.kill(pid, 0),
    "the probe must not leave a process behind — that is what holds the port and " +
    "makes every later source fail with EADDRINUSE");
});

test(`a Hands that ignores the environment file fails its source and frees the port (${shell})`, async () => {
  // `--self-check` is older than HANDS_ENV_FILE support, so a binary in that
  // window passes the probe, comes up, answers /health, and runs every command
  // without the user's environment. Nothing about that is visible from
  // outside, which is why the proof has to be taken from inside: Hands reads
  // the file and unlinks it, so a file still on disk is a Hands that ignored
  // it. The process is killed on the way out because it holds the MCP port,
  // and a source that failed must not fail the next one with a bind error.
  const dir = await mkdtemp(path.join(tmpdir(), "hands-envfile-"));
  const bin = path.join(dir, "hands-binary");
  const envFile = path.join(dir, "hands-env");
  const pidFile = path.join(dir, "pid");
  await writeFile(bin, `#!/bin/sh\n[ "$1" = "--self-check" ] && exit 0\necho $$ > ${pidFile}\nexec sleep 300\n`);
  await chmod(bin, 0o755);
  await writeFile(envFile, "{}");

  const { code } = await runShell(startCmd(bin, dir, envFile, 2), shell);

  assert.notEqual(code, 0, "a Hands that never read the file has not been given the environment");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.throws(() => process.kill(pid, 0),
    "the rejected Hands must not be left holding the port the next source needs");
});

test(`a Hands that consumes the environment file starts normally (${shell})`, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hands-envfile-ok-"));
  const bin = path.join(dir, "hands-binary");
  const envFile = path.join(dir, "hands-env");
  // Reads it and unlinks it, which is what the real one does at startup.
  await writeFile(bin, `#!/bin/sh\n[ "$1" = "--self-check" ] && exit 0\nrm -f ${envFile}\nexec sleep 300\n`);
  await chmod(bin, 0o755);
  await writeFile(envFile, "{}");

  const { code } = await runShell(startCmd(bin, dir, envFile, 2), shell);

  assert.equal(code, 0, "the guard must not cost a working Hands its source");
});

test(`a Hands that is slow to read the file is waited for, not killed (${shell})`, async () => {
  // The case between the two above, and the one the wait exists for: a cold
  // page-in of the binary off a shared mount puts seconds between "started"
  // and "read its environment". Killing a Hands that was going to succeed is
  // the expensive direction -- every source carries this same check, so a
  // mount slow enough to trip it trips all three and the sandbox never starts.
  const dir = await mkdtemp(path.join(tmpdir(), "hands-envfile-slow-"));
  const bin = path.join(dir, "hands-binary");
  const envFile = path.join(dir, "hands-env");
  await writeFile(
    bin,
    `#!/bin/sh\n[ "$1" = "--self-check" ] && exit 0\nsleep 3\nrm -f ${envFile}\nexec sleep 300\n`,
  );
  await chmod(bin, 0o755);
  await writeFile(envFile, "{}");

  const { code } = await runShell(startCmd(bin, dir, envFile, 20), shell);

  assert.equal(code, 0, "the wait has to outlast a slow start, not just a fast one");
});
}

test("the guard counts in the shell rather than through seq", () => {
  // Every image is probed now, not only the ones whose name we recognise, and
  // an image without coreutils has no `seq`: `for _ in $(seq N)` expands to an
  // empty list there, checks once, and fails a healthy Hands with a message
  // about a binary that is too old.
  const cmd = inImageStartCmd(handsBaseEnv(SESSION, PORT, TOKEN), undefined, undefined, "/tmp/.hands-env");
  assert.doesNotMatch(cmd, /\bseq\b/, "seq is not on every image this now probes");
  assert.match(cmd, /while \[ \$_w -lt \d+ \]/, "the wait is a shell-arithmetic loop");
  assert.match(cmd, /kill -9 -\$PID/,
    "a Hands that catches TERM still holds the port while it handles it");
  assert.doesNotMatch(cmd, /kill -9 --/,
    "dash rejects -- after a signal option, so SIGKILL names the group without it");
  assert.match(cmd, /: > \/workspace\/hands\.log \|\|/,
    "the log truncate is a statement of its own so $! is the setsid process, not a helper shell");
  assert.doesNotMatch(cmd, /: > \/workspace\/hands\.log &&/,
    "&& ... & is what made $! a bash subshell on images whose /bin/sh is bash");
});

test("the production probe carries a bound", () => {
  // The parameters above are for the test; this is the command a sandbox gets.
  assert.match(
    inImageStartCmd(handsBaseEnv(SESSION, PORT, TOKEN)),
    /timeout -k 2 \d+ \/app\/hands-binary --self-check/,
    "an unbounded probe is the failure this pins",
  );
});

test("a failed handover fails the bootstrap rather than starting without it", async () => {
  // The alternative is a sandbox that comes up healthy and is missing the
  // user's credentials, which fails later, further away, and reads as the
  // user's own mistake.
  const r = recorder([ok, fail("no space left on device")]);
  await assert.rejects(
    bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN, { HF_TOKEN: "x" }),
    /bootstrap\.write_env/,
  );
  assert.ok(r.cmds.some((c) => c.startsWith("rm -f ")),
    "a failed write still has to take the keys off the disk");
  assert.deepEqual(startAttempts(r.cmds), [], "and nothing is started afterwards");
});

test("a write that fails on a later source still removes the file", async (t) => {
  if (!CLAW_DEPLOY_ROOT && !BRAIN_HTTP_URL) {
    t.skip("no fallback source configured in this environment");
    return;
  }
  // mkdir, first write, first source fails, second write fails.
  const r = recorder([ok, ok, fail("no usable hands-binary at /app/hands-binary"), fail("no space")]);
  await assert.rejects(
    bootstrapHandsInSandbox(r.exec, SESSION, PORT, TOKEN, { HF_TOKEN: "x" }),
    /bootstrap\.write_env/,
  );
  assert.match(r.cmds[r.cmds.length - 1]!, /^rm -f /,
    "the first write already placed the keys; throwing must not leave them");
});
