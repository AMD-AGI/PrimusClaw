// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Temporary directories for the tests, removed when the test file ends. Every directory `tmpdir` makes is
 * recorded; the file's `after` hook first runs what `onCleanup` registered (a connector to stop, a stand-in Claw to
 * close), newest first, then kills the adapters still recorded in a children.json under them (they run detached and
 * would outlive the file) and every process the file itself started that is still running (SIGTERM, SIGKILL after a
 * short grace), so nothing is still writing, and then removes the directories. A file that dies before its
 * hooks run (an uncaught error, `process.exit`) does the same, synchronously, on the process's `exit`; one interrupted by
 * SIGINT, SIGTERM or SIGHUP runs the whole cleanup first and then ends by that signal.
 *
 * A file SIGKILLed with its whole process group (`timeout -s KILL`, an OOM kill, a tool that kills the tree) runs none
 * of that. So its directories are not made in TMPDIR itself but in one directory of the file's own there, cc-run-*,
 * named with the file's pid and start time; the next test file to make a directory in that TMPDIR removes every
 * cc-run-* whose process is gone, after killing the connectors (connector.pid) and adapters (children.json) recorded
 * in it, which would otherwise go on writing there. Such a run leaves one directory per file until then, not one per test.
 *
 * Only the test files' own processes import this: it registers a hook with node:test, which a helper process a
 * test spawns must not do (support/run-fast.ts imports support/timing.ts, not the harness, for that reason).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { ChildProcess } from "node:child_process";
import { ChildRegistry, processStart } from "../../src/children.js";

const made = new Set<string>();
const closers: Array<() => unknown> = [];

/** This file's directory in TMPDIR, which holds every directory `tmpdir` makes; null until the first is made. */
let runDir: string | null = null;
const RUN_PREFIX = "cc-run-";
/** What names a run directory: its file's process, whose start time tells it from a later process given the same pid. */
const RUN_NAME = /^cc-run-(\d+)-(\d+)-[A-Za-z0-9]{6}$/;

/** Whether the process that made the run directory `name` is still running (where its start time cannot be read, any process with its pid). */
function runOwnerAlive(name: string): boolean {
  const m = RUN_NAME.exec(name);
  if (!m) return true;
  const pid = Number(m[1]);
  if (pid === process.pid) return true;
  if (process.platform === "linux") return processStart(pid) === m[2];
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Whether `dir` is a directory (not a link to one) this user made and only this user can write in: one mkdtemp made. */
function ownPrivateDir(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && (process.getuid === undefined || st.uid === process.getuid()) && (st.mode & 0o022) === 0;
  } catch { return false; }
}

/**
 * Remove the run directories in TMPDIR whose file was killed before it could remove them, first killing the connectors
 * and adapters recorded in them, which outlive such a file as well. Those of a running file, this one's included, are
 * not touched, nor any this user did not make itself (in a shared TMPDIR, what it records must not be someone else's).
 */
function sweepDeadRuns(): void {
  let names: string[] = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(RUN_PREFIX) || !RUN_NAME.test(name) || runOwnerAlive(name)) continue;
    const dir = path.join(os.tmpdir(), name);
    if (!ownPrivateDir(dir)) continue;
    try { killRecordedConnectors(dir, 4); } catch { /* the directory goes regardless */ }
    try { killAdaptersUnder(dir, 4); } catch { /* the directory goes regardless */ }
    forceRemove(dir);
  }
}

function ensureRunDir(): string {
  if (runDir && fs.existsSync(runDir)) return runDir;
  sweepDeadRuns();
  // Off Linux the name carries 0 for the start time, and the directory is removed once no process has its pid.
  const start = process.platform === "linux" ? processStart(process.pid) ?? "0" : "0";
  runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${RUN_PREFIX}${process.pid}-${start}-`)));
  return runDir;
}

/** A new directory under os.tmpdir() (TMPDIR), its real path, removed when the test file ends. */
export const tmpdir = (prefix = "cc-"): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(ensureRunDir(), prefix)));
  made.add(dir);
  return dir;
};

/** Run `close` when the test file ends, before its temporary directories are removed. */
export const onCleanup = (close: () => unknown): void => { closers.push(close); };

const exitSync: Array<() => void> = [];
/**
 * Run `stop`, synchronously, when the file ends without its `after` hook having run (it crashed, called `process.exit`,
 * or an interrupted cleanup ran out of time), before the directories are removed: for what must not outlive them, such
 * as a tmux server whose socket is in one. It must be safe to run after `onCleanup`'s closers.
 */
export const onExitSync = (stop: () => void): void => { exitSync.push(stop); };
function runExitSync(): void {
  for (const stop of [...exitSync].reverse()) { try { stop(); } catch { /* the directories go regardless */ } }
}

/** The directories made and not yet removed. */
export const liveTmpdirs = (): string[] => [...made].filter((d) => fs.existsSync(d));

/** A test may leave a directory it cannot enter (mode 0): give the owner its bits back, top down, then remove. */
function forceRemove(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return;
  } catch { /* fall through */ }
  const open = (p: string): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    if (!st.isDirectory()) return;
    try { fs.chmodSync(p, 0o700); } catch { /* not ours */ }
    let names: string[] = [];
    try { names = fs.readdirSync(p); } catch { return; }
    for (const n of names) open(path.join(p, n));
  };
  open(dir);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* reported by liveTmpdirs */ }
}

/** Every file called `name` at most `depth` levels below `dir` (a connector home is `<dir>/state` or nested a little deeper). */
function filesNamed(dir: string, depth: number, name = "children.json"): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return [p];
    return e.isDirectory() && depth > 0 ? filesNamed(p, depth - 1, name) : [];
  });
}

/**
 * SIGKILL the connectors whose pid file (connector.pid: pid and start time) is under `dir` and still names a running
 * process: one a test started in a process of its own outlives a file killed hard, and goes on writing into its home.
 */
function killRecordedConnectors(dir: string, depth: number): void {
  for (const file of filesNamed(dir, depth, "connector.pid")) {
    try {
      const { pid, start } = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown; start?: unknown };
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid || typeof start !== "string" || start === "") continue;
      if (processStart(pid) === start) process.kill(pid, "SIGKILL");
    } catch { /* unreadable, or gone */ }
  }
}

/**
 * SIGKILL the process groups the connectors recorded in children.json under the directories made, by the connector's
 * own rule (ChildRegistry.isOurs: the leader is still the process started, or it is gone and its group lives on; a
 * recycled pid is never hit), and never this file's process or its runner. Synchronous, for `exit`.
 */
function killRecordedAdapters(): void {
  for (const dir of made) killAdaptersUnder(dir);
}
function killAdaptersUnder(dir: string, depth = 3): void {
  for (const file of filesNamed(dir, depth)) {
    let reg: ChildRegistry;
    try { reg = new ChildRegistry(file); } catch { continue; }
    for (const r of reg.list()) {
      if (!Number.isInteger(r.pgid) || r.pgid <= 1 || [process.pid, process.ppid].includes(r.pgid) || r.pid === process.pid) continue;
      if (!reg.isOurs(r)) continue;
      try { process.kill(-r.pgid, "SIGKILL"); } catch { /* gone */ }
    }
  }
}

/**
 * Every process this file's own process starts (spawn, exec, execFile and fork all go through ChildProcess#spawn, the
 * connector's adapters included), so that none outlives the file: a test's detached sleeper or stand-in agent, or one
 * that ignores SIGTERM, was left running for good by an interrupted run, its group untouched by the signal `timeout`
 * or Ctrl-C sends. A detached child leads its own group and the group is stopped; any other only the child itself.
 */
interface Started { child: ChildProcess; pid: number; detached: boolean; start: string | null }
const started: Started[] = [];
/** Node's own, undeclared in its types: every child_process function that starts a process calls it on a new ChildProcess. */
type SpawnMethod = (this: ChildProcess, options: { detached?: boolean }) => unknown;
const proto = ChildProcess.prototype as unknown as { spawn: SpawnMethod };
const spawnChild = proto.spawn;
proto.spawn = function (this: ChildProcess, options: { detached?: boolean }) {
  const ret = spawnChild.call(this, options);
  if (Number.isInteger(this.pid) && this.pid! > 1) {
    // Read now, while the child cannot have been reaped: a pid recycled later then no longer matches.
    started.push({ child: this, pid: this.pid!, detached: options?.detached === true, start: process.platform === "linux" ? processStart(this.pid!) : null });
  }
  return ret;
};

const groupAlive = (pgid: number): boolean => {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
/** The id to signal for `s` (negative for a group), or null when nothing of it is left or the pid is someone else's now. */
function target(s: Started): number | null {
  if ([process.pid, process.ppid].includes(s.pid)) return null;
  const exited = s.child.exitCode !== null || s.child.signalCode !== null;
  const now = process.platform === "linux" ? processStart(s.pid) : (exited ? null : "");
  const same = process.platform === "linux" ? now !== null && now === s.start : !exited;
  if (s.detached) {
    // The leader still the child started, or gone with its group living on (a group id is not handed out while any
    // member lives): the connector's own rule for its adapters (ChildRegistry.isOurs).
    if (same || (now === null && groupAlive(s.pid))) return -s.pid;
    return null;
  }
  return same && !exited ? s.pid : null;
}
/** Send `sig` to what of `of` is still running; returns those it was sent to. */
function signalStarted(sig: NodeJS.Signals, of: Started[] = started): Started[] {
  const sent: Started[] = [];
  for (const s of of) {
    const id = target(s);
    if (id === null) continue;
    try { process.kill(id, sig); sent.push(s); } catch { /* gone */ }
  }
  return sent;
}
/** How long what this file started gets, after SIGTERM, to end before it is sent SIGKILL. */
const CHILD_GRACE_MS = 1_000;
/** SIGTERM what this file started and is still running, then SIGKILL what is left after CHILD_GRACE_MS. */
async function stopStarted(): Promise<void> {
  let live = signalStarted("SIGTERM");
  for (let by = Date.now() + CHILD_GRACE_MS; live.length > 0 && Date.now() < by;) {
    await new Promise((r) => setTimeout(r, 25));
    live = live.filter((s) => target(s) !== null);
  }
  signalStarted("SIGKILL", live);
}
/** Synchronous, for `exit` and for an interrupted file whose cleanup ran out of time: SIGKILL, no grace. */
function killStarted(): void { try { signalStarted("SIGKILL"); } catch { /* the directories go regardless */ } }

function removeAll(): void {
  for (const dir of made) {
    forceRemove(dir);
    if (!fs.existsSync(dir)) made.delete(dir);
  }
  // Empty unless something was left in it besides the directories above: rmdir, not rm -r, so that is reported.
  if (runDir && made.size === 0) { try { fs.rmdirSync(runDir); } catch { /* reported by the CI step */ } }
}

/**
 * Close what was registered (newest first), kill the adapters still recorded under the directories made, stop what
 * this file started and left running (SIGTERM, then SIGKILL after CHILD_GRACE_MS), then remove the directories. Safe to
 * call more than once.
 */
export async function cleanupTmp(): Promise<void> {
  for (const close of closers.splice(0).reverse()) {
    try { await close(); } catch { /* the directories go regardless */ }
  }
  // What a stopped connector still lists is what it could not stop, or what a test recorded and left.
  try { killRecordedAdapters(); } catch { /* the directories go regardless */ }
  try { await stopStarted(); } catch { /* the directories go regardless */ }
  removeAll();
}

after(cleanupTmp);
// A crash, or a process.exit before the hooks ran. A directory a late writer recreates after `after` is not looked at
// again: it is left for the CI step to report, as something still writing after its test has ended.
process.on("exit", () => {
  runExitSync();
  try { killRecordedAdapters(); } catch { /* the directories go regardless */ }
  killStarted();
  removeAll();
});

/** How long an interrupted file waits for what `onCleanup` registered before it removes the directories regardless. */
const SIGNAL_CLEANUP_MS = 10_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let interrupted: (typeof SIGNALS)[number] | null = null;
/**
 * An interrupted run: `timeout`, Ctrl-C, a closed terminal, or the runner told to stop. A signal's default action ends
 * the process without `after` or `exit`, which left every directory and every tmux server a file had made. The file
 * runs its cleanup (the closers too, which stop what children.json does not name, such as a tmux server), bounded by
 * SIGNAL_CLEANUP_MS, and then ends as the first signal would have ended it. Signals that arrive meanwhile (the runner
 * passes on the one its process group already got) are absorbed: the deadline, not a second signal, bounds the wait.
 */
function onSignal(sig: (typeof SIGNALS)[number]): void {
  if (interrupted) return;
  interrupted = sig;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    runExitSync();
    try { killRecordedAdapters(); } catch { /* the directories go regardless */ }
    killStarted();
    removeAll();
    for (const s of SIGNALS) process.removeListener(s, onSignal);
    // Another listener (none of ours) keeps the process alive after a re-raise: exit with the code the signal would give.
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    process.exit(128 + os.constants.signals[sig]);
  };
  setTimeout(end, SIGNAL_CLEANUP_MS);
  void cleanupTmp().finally(end);
}
for (const sig of SIGNALS) process.on(sig, onSignal);
// The runner reads the file's report through a pipe, and it leaves first when it is interrupted: a report written after
// that fails with EPIPE, which node:test's own handler cannot report either, so the process ended (exit code 7) with
// neither `after` nor `exit` run, before the signal sent with the interruption was handled. A file whose runner is gone
// has no one left to report to: it cleans up as if interrupted.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") onSignal("SIGTERM");
    else throw e;
  });
}
