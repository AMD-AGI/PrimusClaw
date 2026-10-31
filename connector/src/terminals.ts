// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which conversations are open in a terminal, as the terminal itself says so.
 *
 * Claude Code runs the user-level `SessionStart` and `SessionEnd` hooks of its settings file. `claw-connector init`
 * installs two (see hooks.ts); each runs `terminal-hook.js`, which keeps one small file per open terminal session,
 * `<config dir>/claw-connector-terminals/<pid>.json`: the session id, the process that holds it and that process's
 * start time. A taking-over connector reads those files first (attach.ts). The pid and the start time are what make a
 * crash safe: `kill -9` and a power cut run no `SessionEnd`, and the row they leave names a process that is gone or
 * a different process by now, so it is not read as open.
 *
 * Measured on Claude Code 2.1.314 (claw-181): both hooks run for terminal sessions, for `--resume` and `-c`, and also
 * for sessions started by an ACP adapter and `claude -p`; those are told apart by `CLAUDE_CODE_ENTRYPOINT` in the
 * hook's environment (`cli` in a terminal, `sdk-cli` otherwise), so only terminal sessions are registered here. The
 * hook's stdin has no pid; `CLAUDE_PID` in its environment is the claude process. A hook only runs for a session that
 * started after it was installed, so this is a first source that can add a refusal and never remove one: the
 * detection in attach.ts stays the fallback for everything this does not know about.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isAlive, processStart } from "./children.js";

/** Claude Code names a session by a UUID; anything else is never used to build a path. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where, inside a Claude config directory, the rows live. */
export const TERMINALS_DIR = "claw-connector-terminals";
export const terminalsDir = (configDir: string): string => path.join(configDir, TERMINALS_DIR);

/** A row that does not parse is ignored once it is this old; a younger one may be mid-write by another writer. */
const UNREADABLE_GRACE_MS = 60_000;
const MAX_STDIN = 1 << 20;

export interface TerminalRow {
  v: 1;
  pid: number;
  /** The process's start time (children.ts `processStart`), so a recycled pid is not taken for it. */
  procStart: string | null;
  sessionId: string;
  cwd: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** The machine and pid namespace the pid belongs to, as Claude Code's own `pidDomain`. */
  pidDomain: string | null;
}

/** A session some process holds open, as read from the rows. Shaped like attach.ts's `LiveEntry`. */
export interface TerminalEntry {
  pid: number;
  sessionId: string;
  status: string | null;
  foreign: boolean;
  via: "hook";
}

/** The machine and pid namespace this process is in, written the way Claude Code writes `pidDomain`; null where that is not known. */
export function localPidDomain(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return `linux:${fs.readFileSync("/etc/machine-id", "utf8").trim()}:${fs.readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return null;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** True while `row`'s process is the same one that was registered. A row of another host or pid namespace cannot be checked and is not provably gone. */
function holdsStill(row: TerminalRow, localDomain: string | null): { open: boolean; foreign: boolean } {
  const foreign = row.pidDomain !== null && localDomain !== null && row.pidDomain !== localDomain;
  if (foreign) return { open: true, foreign };
  if (!isAlive(row.pid)) return { open: false, foreign };
  if (row.procStart !== null && processStart(row.pid) !== row.procStart) return { open: false, foreign };
  return { open: true, foreign };
}

function parseRow(doc: unknown): TerminalRow | null {
  if (!isObject(doc) || doc.v !== 1) return null;
  if (typeof doc.pid !== "number" || !Number.isInteger(doc.pid) || doc.pid <= 1) return null;
  if (typeof doc.sessionId !== "string" || !SESSION_ID_RE.test(doc.sessionId)) return null;
  return {
    v: 1, pid: doc.pid, sessionId: doc.sessionId.toLowerCase(),
    procStart: typeof doc.procStart === "string" && doc.procStart ? doc.procStart : null,
    cwd: typeof doc.cwd === "string" ? doc.cwd : "",
    at: typeof doc.at === "number" ? doc.at : 0,
    pidDomain: typeof doc.pidDomain === "string" ? doc.pidDomain : null,
  };
}

/**
 * The sessions the rows say are open in a terminal now. A directory that is not there is an empty answer (the hooks were
 * never installed); one that cannot be read, or a young row that does not parse, throws: the caller decides what an
 * unknown answer from this source means (attach.ts: nothing, its other sources still decide).
 */
export function readTerminals(configDir: string, localDomain: string | null, now = Date.now()): TerminalEntry[] {
  const dir = terminalsDir(configDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: TerminalEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // removed by its SessionEnd meanwhile
      let age = Infinity;
      try { age = now - fs.statSync(file).mtimeMs; } catch { /* gone meanwhile */ }
      if (age < UNREADABLE_GRACE_MS) throw new Error(`${file} is unreadable (${(e as Error).message.split("\n")[0]})`);
      continue;
    }
    const row = parseRow(doc);
    if (!row) continue;
    const still = holdsStill(row, localDomain);
    if (still.open) out.push({ pid: row.pid, sessionId: row.sessionId, status: null, foreign: still.foreign, via: "hook" });
  }
  return out;
}

// --- the hook ----------------------------------------------------------------------------------

export interface HookDeps {
  /** The pids above `pid`, nearest first (at most `max`). */
  ancestors?: (pid: number, max: number) => number[];
  /** The name of a process, or null. */
  commOf?: (pid: number) => string | null;
  localDomain?: string | null;
  now?: () => number;
}

export interface HookInput {
  event: "start" | "end";
  /** The Claude config directory the hooks were installed into. */
  configDir: string;
  /** What Claude Code wrote to the hook's stdin. */
  stdin: string;
  env: NodeJS.ProcessEnv;
  /** The hook process's parent (the shell Claude Code started it with). */
  ppid: number;
}

export type HookResult = { done: "registered" | "unregistered" | "ignored"; why?: string };

function ancestorsOf(pid: number, max: number): number[] {
  const out: number[] = [];
  let p = pid;
  for (let i = 0; i < max && p > 1; i++) {
    out.push(p);
    let parent = 0;
    try {
      if (process.platform === "linux") {
        const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8");
        parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } else {
        parent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(p)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
      }
    } catch { break; }
    if (!Number.isInteger(parent) || parent <= 1) break;
    p = parent;
  }
  return out;
}

function commOfProcess(pid: number): string | null {
  try {
    if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
    return path.basename(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || null;
  } catch {
    return null;
  }
}

/**
 * The claude process the hook belongs to. `CLAUDE_PID` names it (it matched the process in every measured run); it is
 * believed only if it is one of the hook's own ancestors, so a stale value inherited through a nested launch is not.
 * Failing that, the nearest ancestor called `claude`. Null when neither is found: nothing is registered then, and the
 * connector's other detection still sees the session.
 */
function claudePid(env: NodeJS.ProcessEnv, ppid: number, deps: HookDeps): number | null {
  const chain = (deps.ancestors ?? ancestorsOf)(ppid, 8);
  const fromEnv = Number(env.CLAUDE_PID);
  if (Number.isInteger(fromEnv) && fromEnv > 1 && (chain.length === 0 ? isAlive(fromEnv) : chain.includes(fromEnv))) return fromEnv;
  const comm = deps.commOf ?? commOfProcess;
  for (const p of chain) if (comm(p) === "claude") return p;
  return null;
}

function writeRow(dir: string, row: TerminalRow): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${row.pid}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(row) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Forget the rows whose process is gone (a `kill -9` never ran its SessionEnd), and temp files a crashed writer left. Best effort. */
function prune(dir: string, localDomain: string | null, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (name.endsWith(".tmp")) {
        if (now - fs.statSync(file).mtimeMs > UNREADABLE_GRACE_MS) fs.rmSync(file, { force: true });
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const row = parseRow(JSON.parse(fs.readFileSync(file, "utf8")));
      if (row && !holdsStill(row, localDomain).open) fs.rmSync(file, { force: true });
    } catch { /* unreadable or gone: left for the reader's rules */ }
  }
}

/**
 * What the installed hook does. `SessionStart` of a terminal session registers its claude process under the session id;
 * `SessionEnd` takes that row away (only if it still names that session: `/clear` ends the old id and starts a new one in
 * the same process). Anything that is not a terminal session, or cannot be attributed to a claude process, is ignored.
 * Never throws for what it reads; a caller that must stay silent (the hook) reports the failure itself.
 */
export function runHook(i: HookInput, deps: HookDeps = {}): HookResult {
  let doc: unknown;
  try { doc = JSON.parse(i.stdin); } catch { return { done: "ignored", why: "stdin is not JSON" }; }
  if (!isObject(doc) || typeof doc.session_id !== "string" || !SESSION_ID_RE.test(doc.session_id)) return { done: "ignored", why: "no session id" };
  const sessionId = doc.session_id.toLowerCase();
  const dir = terminalsDir(i.configDir);
  const localDomain = deps.localDomain !== undefined ? deps.localDomain : localPidDomain();
  const now = (deps.now ?? Date.now)();

  if (i.event === "start") {
    // `cli` is a terminal; `sdk-cli` is an ACP adapter (this connector's own included) or `claude -p`. An unset value (a version
    // that does not export it) is given the benefit of the doubt only when the session says it has a person at it.
    const entry = i.env.CLAUDE_CODE_ENTRYPOINT;
    if (entry !== "cli" && !(entry === undefined && i.env.CLAUDE_CODE_SESSION_ATTENDED === "1")) return { done: "ignored", why: `not a terminal session (entrypoint ${entry ?? "unset"})` };
    if (i.env.CLAUDE_CODE_SESSION_ATTENDED === "0") return { done: "ignored", why: "unattended session" };
    const pid = claudePid(i.env, i.ppid, deps);
    if (pid === null) return { done: "ignored", why: "cannot tell which process is claude" };
    const procStart = processStart(pid);
    if (procStart === null) return { done: "ignored", why: `cannot read the start time of pid ${pid}` };
    writeRow(dir, { v: 1, pid, procStart, sessionId, cwd: typeof doc.cwd === "string" ? doc.cwd.slice(0, 1024) : "", at: now, pidDomain: localDomain });
    prune(dir, localDomain, now);
    return { done: "registered" };
  }

  const pid = claudePid(i.env, i.ppid, deps);
  let removed = false;
  if (pid !== null) {
    const file = path.join(dir, `${pid}.json`);
    try {
      const row = parseRow(JSON.parse(fs.readFileSync(file, "utf8")));
      if (row?.sessionId === sessionId) { fs.rmSync(file, { force: true }); removed = true; }
    } catch { /* no row for this process */ }
  }
  prune(dir, localDomain, now);
  return removed ? { done: "unregistered" } : { done: "ignored", why: "no row to remove" };
}

/** Read all of stdin, but never wait for more than `ms` for it to end (Claude Code closes it after writing). */
export function readStdin(stream: NodeJS.ReadableStream, ms = 1500): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => { clearTimeout(timer); resolve(buf); };
    const timer = setTimeout(done, ms);
    stream.setEncoding?.("utf8");
    stream.on("data", (c) => { if (buf.length < MAX_STDIN) buf += c; });
    stream.on("end", done);
    stream.on("error", done);
  });
}
