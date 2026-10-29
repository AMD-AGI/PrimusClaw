// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The shell the AppRunner sends through EnvD, run by a real `sh`.
 *
 * app-runner.test.ts answers those commands from a fake that recognises their
 * shape, which proves the state machine and says nothing about whether the
 * commands do what they claim. Here the same machine runs against a directory
 * and real processes: `setsid` detaches, `kill -0` finds it, `exit.json` is
 * read back, the quoting survives an argument with a quote in it, and the
 * environment reaches the process through the request's env map.
 *
 * Only what `sh` itself can do is exercised: EnvD's job shim, which adopts the
 * detached process in a sandbox, is not available here (see the PR for what the
 * EnvD code does with it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppManifestV1 } from "@claw/protocol";

import { AppRunner } from "../src/apps/app-runner.js";
import { startCommand, generationTag, expandStateDirCommand } from "../src/apps/app-env.js";
import { World, MANIFEST, RUN_ID, TOKEN } from "./support/app-runner-world.js";

const workdirs: string[] = [];
const pids: number[] = [];

type ShellResult = { exitCode: number; stdout: string; stderr: string };

/**
 * `sh -c command`, in `cwd`.
 *
 * A spawn that fails with EAGAIN is the machine out of processes or threads for
 * the moment -- twelve of these start at once in one test, beside every other
 * test file the runner is executing -- and it says nothing about the command,
 * which never ran. Reporting it as the command's exit status turns a full
 * process table into "nothing was started", so it is attempted again until the
 * deadline instead. Only that: a command that ran and failed is answered as it is.
 */
async function runShell(command: string, cwd: string, env: Record<string, string>): Promise<ShellResult> {
  const signal = AbortSignal.timeout(30_000);
  for (;;) {
    const outcome = await new Promise<ShellResult & { spawnFailed: boolean }>((resolve) => {
      execFile("sh", ["-c", command], {
        cwd, env: { PATH: process.env.PATH ?? "", USER_DATA_PATH: cwd, ...env }, timeout: 20_000,
      }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ exitCode: code, stdout, stderr, spawnFailed: (err as { code?: unknown } | null)?.code === "EAGAIN" });
      });
    });
    if (!outcome.spawnFailed || signal.aborted) return outcome;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Stop an application and anything it started.
 *
 * It is detached with setsid, so it leads its own group, and `sh -c "...; sleep
 * 30"` runs the sleep as a child: signalling the leader alone left that `sleep`
 * running for the rest of its thirty seconds, once per test.
 */
function stopApp(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
}

/** The lines of `file`, once it has at least `atLeast` of them: the application's own word that it ran. */
async function linesOnceWritten(file: string, atLeast = 1, ms = 20_000): Promise<string[]> {
  const signal = AbortSignal.timeout(ms);
  for (;;) {
    const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
    if (lines.length >= atLeast) return lines;
    if (signal.aborted) throw new Error(`${file} had ${lines.length} of ${atLeast} lines after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function realWorld(script: string, extra: Partial<AppManifestV1> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "c2-03b-"));
  workdirs.push(dir);
  const manifest: AppManifestV1 = {
    ...MANIFEST,
    command: ["sh", "-c", script],
    restart: { max_restarts: 2, backoff_sec: [1] },
    ...extra,
  };
  const world = new World(manifest);
  const stateDir = `${dir}/.claw-apps/${RUN_ID}`;
  const exec = (command: string, env: Record<string, string> = {}) => runShell(command, dir, env);
  world.sandbox = {
    ...world.sandbox,
    exec: async (_inst, command, _t, opts) => exec(command, opts?.env),
    stop: async () => undefined,
  };
  const runner = new AppRunner(RUN_ID, "pk", {
    store: world.store, sandbox: world.sandbox, tickMs: 100,
  });
  const readPid = () => Number(readFileSync(`${stateDir}/app.pid`, "utf8"));
  return { dir, stateDir, world, runner, exec, readPid };
}

test.after(() => {
  for (const pid of pids) stopApp(pid);
  for (const d of workdirs) rmSync(d, { recursive: true, force: true });
});

const SECS = (n: number) => AbortSignal.timeout(n * 1000);

test("a real run: input and bootstrap are written, the env reaches the process, final rc 0 ends it", async () => {
  const w = realWorld(
    'env | grep "^APP_" | sort > "$APP_STATE_DIR/env.txt"; echo "$0 $1" > "$APP_STATE_DIR/argv.txt"; sleep 0.5; printf \'{"final":true,"returncode":0}\' > "$APP_STATE_DIR/exit.json"',
  );
  const result = await w.runner.run(SECS(30));
  assert.deepEqual(result, { kind: "ended", outcome: { success: true, reason: "app finished", captures: { session_dir: w.stateDir } } });
  assert.equal(w.world.rec.state, "ended");

  assert.equal(readFileSync(`${w.stateDir}/input.json`, "utf8"), JSON.stringify(w.world.rec.input));
  assert.equal(statSync(`${w.stateDir}/input.json`).mode & 0o777, 0o600);
  assert.equal(readFileSync(`${w.stateDir}/boot/start.sh`, "utf8"), "#!/bin/sh\necho boot\n");
  assert.equal(statSync(`${w.stateDir}/boot/start.sh`).mode & 0o777, 0o700);
  const env = readFileSync(`${w.stateDir}/env.txt`, "utf8");
  assert.match(env, new RegExp(`^APP_MCP_TOKEN=${TOKEN}$`, "m"));
  assert.match(env, new RegExp(`^APP_STATE_DIR=${w.stateDir}$`, "m"));
  assert.match(env, /^APP_RUN_ID=run-1$/m);
  assert.ok(existsSync(`${w.stateDir}/app.log`));
  assert.equal(readFileSync(`${w.stateDir}/app.sandbox`, "utf8"), generationTag("wl-1", 0));
  assert.equal(w.world.rec.state_dir, w.stateDir, "the real expansion of ${USER_DATA_PATH}/.claw-apps/${run_id}");
});

test("the application is detached: it outlives the shell that started it", async () => {
  const w = realWorld('echo $$ > "$APP_STATE_DIR/self.pid"; sleep 30');
  await w.runner.reconcile();
  await w.runner.reconcile();
  const pid = w.readPid();
  pids.push(pid);
  const probe = await w.exec(`kill -0 ${pid} && echo up`);
  assert.equal(probe.stdout.trim(), "up");
  // setsid: its own session, so it is not in the process group of the shell that was killed or finished.
  const sid = await w.exec(`ps -o sid= -p ${pid}`);
  assert.equal(Number(sid.stdout.trim()), pid, "the app leads its own session");
  await w.runner.reconcile();
  assert.equal(w.world.rec.state, "running");
  stopApp(pid);
});

test("a final exit with a failing return code is not run again, for real", async () => {
  const w = realWorld('echo run >> "$APP_STATE_DIR/starts.txt"; printf \'{"final":true,"returncode":3}\' > "$APP_STATE_DIR/exit.json"');
  const result = await w.runner.run(SECS(30));
  assert.equal(result.kind, "ended");
  assert.equal(result.kind === "ended" && result.outcome.success, false);
  assert.equal(w.world.rec.restarts, 0);
  assert.equal(readFileSync(`${w.stateDir}/starts.txt`, "utf8").trim().split("\n").length, 1);
});

test("a crash without final restarts, and the second run finishes it, for real", async () => {
  const w = realWorld(
    'echo run >> "$APP_STATE_DIR/starts.txt"; if [ -f "$APP_STATE_DIR/crashed" ]; then printf \'{"final":true,"returncode":0}\' > "$APP_STATE_DIR/exit.json"; else touch "$APP_STATE_DIR/crashed"; exit 9; fi',
  );
  const result = await w.runner.run(SECS(40));
  assert.deepEqual(result, { kind: "ended", outcome: { success: true, reason: "app finished", captures: { session_dir: w.stateDir } } });
  assert.equal(w.world.rec.restarts, 1);
  assert.equal(readFileSync(`${w.stateDir}/starts.txt`, "utf8").trim().split("\n").length, 2);
});

test("the start command refuses a second process while its generation is alive", async () => {
  const w = realWorld('echo run >> "$APP_STATE_DIR/starts.txt"; sleep 30');
  await w.runner.reconcile();
  await w.runner.reconcile();
  pids.push(w.readPid());
  const again = await w.exec(startCommand(w.world.rec.manifest, w.stateDir, generationTag("wl-1", 0)));
  assert.equal(again.stdout.trim(), "already");
  const another = await w.exec(startCommand(w.world.rec.manifest, w.stateDir, generationTag("wl-1", 0)));
  assert.equal(another.stdout.trim(), "already");
  // The answers above are what say nothing else was started. This is the
  // application's own record that the one run happened, read once it has written
  // it -- not after a guess at how long a process takes to get going.
  assert.equal((await linesOnceWritten(`${w.stateDir}/starts.txt`)).length, 1);
  stopApp(w.readPid());
});

test("many starts at once launch the application once: the start command serialises itself", async () => {
  const w = realWorld('echo run >> "$APP_STATE_DIR/starts.txt"; sleep 30');
  await w.runner.reconcile();
  await w.runner.reconcile(); // state dir known, files written, one start done; remove it and race fresh starts
  pids.push(w.readPid());
  stopApp(w.readPid());
  await w.exec(`rm -f ${w.stateDir}/app.sandbox ${w.stateDir}/app.pid ${w.stateDir}/starts.txt`);
  const tag = generationTag("wl-1", 5);
  const cmd = startCommand(w.world.rec.manifest, w.stateDir, tag);
  const env = { APP_STATE_DIR: w.stateDir };
  const results = await Promise.all(Array.from({ length: 12 }, () => w.exec(cmd, env)));
  const words = results.map((r) => r.stdout.trim());
  assert.equal(words.filter((x) => x === "started").length, 1, words.join(","));
  assert.ok(words.every((x) => ["started", "busy", "already"].includes(x)), words.join(","));
  pids.push(w.readPid());
  assert.equal((await linesOnceWritten(`${w.stateDir}/starts.txt`)).length, 1, "one process, not several");
  stopApp(w.readPid());
});

test("a live process of this sandbox under an older generation is 'already', and the marker follows", async () => {
  const w = realWorld('echo run >> "$APP_STATE_DIR/starts.txt"; sleep 30');
  await w.runner.reconcile();
  await w.runner.reconcile();
  pids.push(w.readPid());
  const next = await w.exec(startCommand(w.world.rec.manifest, w.stateDir, generationTag("wl-1", 1)));
  assert.equal(next.stdout.trim(), "already");
  assert.equal(readFileSync(`${w.stateDir}/app.sandbox`, "utf8"), generationTag("wl-1", 1));
  // A different sandbox's pid file is not a live process here.
  await w.exec(`printf %s ${generationTag("wl-OLD", 0)} > ${w.stateDir}/app.sandbox`);
  const other = await w.exec(startCommand(w.world.rec.manifest, w.stateDir, generationTag("wl-2", 1)), { APP_STATE_DIR: w.stateDir });
  assert.equal(other.stdout.trim(), "started");
  pids.push(w.readPid());
  stopApp(w.readPid());
});

test("a start lock left by a holder that died does not block starting for ever", async () => {
  const w = realWorld('echo run >> "$APP_STATE_DIR/starts.txt"; sleep 30');
  await w.exec(`mkdir -p ${w.stateDir}/.start.lock && echo 999999 > ${w.stateDir}/.start.lock/pid`);
  const r = await w.exec(startCommand(w.world.rec.manifest, w.stateDir, generationTag("wl-1", 0)), { APP_STATE_DIR: w.stateDir });
  assert.equal(r.stdout.trim(), "started");
  pids.push(w.readPid());
  stopApp(w.readPid());
  assert.equal(existsSync(`${w.stateDir}/.start.lock`), false, "and the lock is released");
});

test("the state_dir expansion refuses (exit 4) when USER_DATA_PATH is unset, rather than answer a root path", async () => {
  const w = realWorld("sleep 0");
  const unset = await w.exec(expandStateDirCommand("${USER_DATA_PATH}/.claw-apps/${run_id}", RUN_ID), { USER_DATA_PATH: "" });
  assert.equal(unset.exitCode, 4);
  assert.equal(unset.stdout, "");
  const set = await w.exec(expandStateDirCommand("${USER_DATA_PATH}/.claw-apps/${run_id}", RUN_ID));
  assert.equal(set.stdout, `${w.dir}/.claw-apps/${RUN_ID}`);
  const quoted = await w.exec(expandStateDirCommand("${USER_DATA_PATH}/it's/${run_id}", RUN_ID));
  assert.equal(quoted.stdout, `${w.dir}/it's/${RUN_ID}`);
});

test("a manifest argument with a quote and a space reaches the process intact", async () => {
  const w = realWorld('sleep 0', {});
  w.world.rec.manifest = { ...w.world.rec.manifest, command: ["sh", "-c", 'printf %s "$1" > "$APP_STATE_DIR/arg.txt"; printf \'{"final":true,"returncode":0}\' > "$APP_STATE_DIR/exit.json"', "x", "it's a \"test\" $HOME"] };
  const result = await w.runner.run(SECS(30));
  assert.equal(result.kind, "ended");
  assert.equal(readFileSync(`${w.stateDir}/arg.txt`, "utf8"), "it's a \"test\" $HOME");
});


// --- the start lock and the previous generation's exit record ---------------

test("a start lock left by another sandbox is stale, even when its pid is alive here", async () => {
  const w = realWorld("sleep 30");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(w.stateDir, { recursive: true });
  // A lock from a gone container whose pid number is, by bad luck, a live process in this one: this test's own.
  const { symlinkSync } = await import("node:fs");
  symlinkSync(`${process.pid}|wl-from-another-container`, `${w.stateDir}/.start.lock`);
  const out = await w.exec(startCommand(MANIFEST, w.stateDir, generationTag("wl-1", 0)));
  assert.equal(out.stdout.trim(), "started", out.stderr);
  pids.push(Number(readFileSync(`${w.stateDir}/app.pid`, "utf8")));
});

test("a lock directory left by an older version is stale, not a holder", async () => {
  const w = realWorld("sleep 30");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(`${w.stateDir}/.start.lock`, { recursive: true });
  writeFileSync(`${w.stateDir}/.start.lock/pid`, String(process.pid));
  const out = await w.exec(startCommand(MANIFEST, w.stateDir, generationTag("wl-1", 0)));
  assert.equal(out.stdout.trim(), "started", out.stderr);
  pids.push(Number(readFileSync(`${w.stateDir}/app.pid`, "utf8")));
});

test("a live lock of this sandbox still says busy", async () => {
  const w = realWorld("sleep 30");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(w.stateDir, { recursive: true });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(`${process.pid}|wl-1`, `${w.stateDir}/.start.lock`);
  const out = await w.exec(startCommand(MANIFEST, w.stateDir, generationTag("wl-1", 0)));
  assert.equal(out.stdout.trim(), "busy");
  assert.equal(existsSync(`${w.stateDir}/app.pid`), false, "nothing was started");
});

test("starting a new generation removes the previous generation's exit.json; an already-running one keeps it", async () => {
  const w = realWorld("sleep 30");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(w.stateDir, { recursive: true });
  writeFileSync(`${w.stateDir}/exit.json`, '{"final":false,"returncode":2,"stop_reason":"x"}');
  const out = await w.exec(startCommand(MANIFEST, w.stateDir, generationTag("wl-1", 1)));
  assert.equal(out.stdout.trim(), "started", out.stderr);
  pids.push(Number(readFileSync(`${w.stateDir}/app.pid`, "utf8")));
  assert.equal(existsSync(`${w.stateDir}/exit.json`), false, "the new generation starts with no exit record");
  // The same sandbox, next generation, process still alive (this test's own pid stands in): `already`, nothing removed.
  writeFileSync(`${w.stateDir}/app.pid`, String(process.pid));
  writeFileSync(`${w.stateDir}/app.sandbox`, generationTag("wl-1", 1));
  writeFileSync(`${w.stateDir}/exit.json`, '{"final":false}');
  const again = await w.exec(startCommand(MANIFEST, w.stateDir, generationTag("wl-1", 2)));
  assert.equal(again.stdout.trim(), "already");
  assert.equal(existsSync(`${w.stateDir}/exit.json`), true);
});
