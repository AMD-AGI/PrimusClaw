// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Taking over a conversation that already exists on this machine.
 *
 * Which sessions exist is the adapter's own answer (`session/list`), and continuing one is `session/resume`: both
 * are the adapter's official surface. What no one provides is a guard against a second writer. A session that is
 * still open in a terminal and is resumed again has two processes appending to one transcript; the two lines of
 * history fork and the next resume follows only one of them, so a turn typed on the phone silently disappears.
 * This file is that guard, and it fails closed: an answer that cannot be had is a refusal, never a yes.
 *
 * Who holds a session open is read, first, from the rows the installed `SessionStart`/`SessionEnd` hooks keep for
 * terminal sessions (terminals.ts; a session that was opened before the hooks were installed is not in them), then from
 * Claude Code's own `claude agents --json` (it lists the live processes with their session ids and ignores the stale
 * files a killed process leaves) and from the registry it keeps, `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`, directly.
 * The hook rows can only add a refusal: what they do not know is still decided by the rest. Each local registry row is checked against the process it
 * names (same start time), so a file left behind by a crash is not a twin. A row from another host or container
 * that shares the directory cannot be checked, and the command does not report it either (it asks whether the pid
 * is alive in this pid namespace): such a row counts as open whatever the command says. If the command is not
 * there or does not answer, the registry alone is the answer.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AdapterProcess, type AdapterHooks } from "./adapter.js";
import type { Audit } from "./audit.js";
import { isAlive, processStart, type ChildRegistry } from "./children.js";
import type { AgentConfig } from "./config.js";
import { hooksStatus } from "./hooks.js";
import { REMOTE_AGENT_LIMITS } from "./protocol.js";
import { redactText } from "./redact.js";
import { checkCwd, resolveCwd } from "./roots.js";
import { within } from "./statefile.js";
import { SESSION_ID_RE, localPidDomain, readTerminals, readTerminalsAsync, terminalsDir } from "./terminals.js";
import { errMessage, isObject, type Logger } from "./util.js";

/** idle: nothing holds it open. live: a process (a terminal) does. attached: this connector holds it. unknown: the check could not be made. */
export type ResumableState = "idle" | "live" | "attached" | "unknown";

/** One entry of the list an attach agent reports to Claw. The `ref` is what `session.new` names to take it over. */
export interface Resumable {
  ref: string;
  title: string;
  cwd: string;
  /** Last activity, seconds since the epoch. */
  updated_at: number;
  state: ResumableState;
  /**
   * For a conversation a terminal holds open (`live`), what it is doing there, as Claude Code itself says it
   * (`claude agents --json` / its session registry): `working` on a turn, `waiting` for the person at that terminal, or
   * `idle`. Absent when it does not say.
   */
  activity?: LiveActivity;
  /** With `waiting`: what it waits for, in Claude Code's words ("input needed"), short and scrubbed. */
  waiting_for?: string;
}

export type LiveActivity = "working" | "waiting" | "idle";

interface Listed {
  ref: string;
  title: string;
  /** The canonical directory, already inside the agent's roots. */
  cwd: string;
  /** Milliseconds since the epoch. */
  updatedAt: number;
}

export interface LiveEntry {
  pid: number;
  sessionId: string;
  status: string | null;
  /** What a `waiting` session waits for, as Claude Code says it. */
  waitingFor?: string | null;
  /** The directory the process registered (the registry only). */
  cwd?: string | null;
  /** Registered by a process this machine cannot see (another host or container sharing the directory): not provably gone. */
  foreign: boolean;
  /** Read from the rows the terminal hooks keep, not from Claude Code's own registry. */
  via?: "hook";
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: "session_live" | "recently_written" | "twin_check_failed"; detail: string };

export type EndVerdict =
  | { ok: true; ended: number[] }
  | { ok: false; reason: "session_live_elsewhere" | "takeover_not_permitted" | "takeover_failed" | "terminal_did_not_exit" | "recently_written" | "twin_check_failed"; detail: string };

export type Resolved = { ok: true; item: Listed } | { ok: false; reason: "unknown_session" | "catalog_unavailable" };

/** The check could not be answered. Attaching is refused: not being able to read it is not "nothing is open". */
export class TwinCheckError extends Error {}

/** Claude Code names a session by a UUID; anything else is never used to build a path. */
export const SESSION_REF_RE = SESSION_ID_RE;
export { localPidDomain };

/** Most entries of the list that goes into the heartbeat. */
export const MAX_REPORTED = 12;
const MAX_LIST_PAGES = 8;
const MAX_TITLE = 80;
const MAX_WAITING_FOR = 60;
/** A conversation the list does not know yet is listed again at most this often (it starts an adapter). */
const UNKNOWN_RELIST_MS = 20_000;
/** Project folders looked at by {@link AttachSupport.poll}. */
const MAX_WATCHED_PROJECT_DIRS = 200;
const MAX_SCANNED_PROJECT_DIRS = 2000;
/** A registry file that does not parse is ignored once it is this old; a younger one may be mid-write. */
const UNREADABLE_GRACE_MS = 60_000;

export interface AttachDeps {
  registry: ChildRegistry;
  audit: Audit;
  log: Logger;
  logDir: string;
  version: string;
  env: NodeJS.ProcessEnv;
  /** The adapter's list is reused this long. */
  catalogMs: number;
  /** How long `claude agents --json` may take. */
  cliTimeoutMs: number;
  /** A transcript written to this recently is still being written by someone. */
  recentWriteMs: number;
  /** The session ids this connector itself holds open. */
  attachedRefs: () => ReadonlySet<string>;
  now?: () => number;
}

const NO_HOOKS: AdapterHooks = {
  onUpdate() {},
  onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  onExtension: async (method) => { throw new Error(`unsupported extension ${method}`); },
  onNotification() {},
  onStderr() {},
  onExit() {},
};

export class AttachSupport {
  readonly configDir: string;
  private listed: Listed[] = [];
  private listedAt = 0;
  private listError: string | null = null;
  private refreshing: Promise<void> | null = null;
  private waitedOnce = false;
  /** Where each conversation's transcript was found, so that it is not searched for again on every prompt. */
  private readonly transcripts = new Map<string, string>();
  private readonly localDomain = localPidDomain();

  constructor(readonly agent: AgentConfig, private readonly d: AttachDeps) {
    this.configDir = path.resolve(agent.env.CLAUDE_CONFIG_DIR ?? d.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  private hookNote = false;
  private lastHookError = "";

  /** Once: say whether the terminal hooks are in this agent's Claude config, so a missing one is not a mystery. */
  private noteHooks(): void {
    if (this.hookNote) return;
    this.hookNote = true;
    const st = hooksStatus(this.configDir);
    if (!st.installed) this.d.log.info("the terminal hooks are not installed in this Claude config directory; sessions open in a terminal are found by listing processes only (claw-connector hooks install)", { agent: this.agent.id, dir: this.configDir });
    else if (!st.healthy) this.d.log.warn("an installed terminal hook points at a file that is gone", { agent: this.agent.id, problem: st.problem });
  }

  /**
   * The sessions the terminal hooks say are open. This source only ever adds: when it cannot be read it answers
   * nothing (and says so once), because the sources behind it decide everything it does not know.
   */
  private terminalRows(): LiveEntry[] {
    try {
      this.lastHookError = "";
      return readTerminals(this.configDir, this.localDomain, this.now());
    } catch (e) {
      return this.terminalRowsFailed(e);
    }
  }

  /** {@link terminalRows}, off the event loop (the heartbeat's look). */
  private async terminalRowsAsync(): Promise<LiveEntry[]> {
    try {
      const rows = await readTerminalsAsync(this.configDir, this.localDomain, this.now());
      this.lastHookError = "";
      return rows;
    } catch (e) {
      return this.terminalRowsFailed(e);
    }
  }

  private terminalRowsFailed(e: unknown): LiveEntry[] {
    const msg = errMessage(e);
    if (msg !== this.lastHookError) this.d.log.warn("the terminal hook rows could not be read; the other checks decide", { agent: this.agent.id, error: msg });
    this.lastHookError = msg;
    return [];
  }

  // --- what exists -------------------------------------------------------------------

  /** Ask the adapter for the sessions on this machine and keep those whose directory is inside the roots. One adapter process, started and stopped here. */
  refreshCatalog(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Where the listing adapter starts: the first root that is there now (a root may be missing), else the home directory. */
  private async listingDir(): Promise<string> {
    for (const r of this.agent.roots) {
      const v = await resolveCwd(r, [r], { home: os.homedir(), timeoutMs: 5_000 });
      if (v.ok) return v.real;
    }
    return os.homedir();
  }

  private async doRefresh(): Promise<void> {
    let adapter: AdapterProcess | null = null;
    this.noteHooks();
    try {
      adapter = await AdapterProcess.start({
        cfg: this.agent, registry: this.d.registry, sessionId: `list-${this.agent.id}`, cwd: await this.listingDir(),
        hooks: NO_HOOKS, logFile: path.join(this.d.logDir, `adapter-${this.agent.id}.log`), version: this.d.version, initTimeoutMs: 30_000,
      });
      const caps = adapter.caps.sessionCapabilities as Record<string, unknown> | undefined;
      if (!caps?.list) throw new Error("the adapter cannot list sessions");
      const found = new Map<string, Listed>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await adapter.request("session/list", cursor ? { cursor } : {}, 30_000);
        for (const s of Array.isArray(res.sessions) ? res.sessions : []) {
          if (!isObject(s) || typeof s.sessionId !== "string" || !SESSION_REF_RE.test(s.sessionId) || typeof s.cwd !== "string") continue;
          // Absolute paths only (a listed session's own directory), looked at without blocking: a stalled mount skips it.
          if (!path.isAbsolute(s.cwd)) continue;
          const where = await resolveCwd(s.cwd, this.agent.roots, { home: os.homedir(), timeoutMs: 5_000 });
          if (!where.ok) continue;
          const at = typeof s.updatedAt === "string" ? Date.parse(s.updatedAt) : NaN;
          found.set(s.sessionId.toLowerCase(), {
            ref: s.sessionId.toLowerCase(), cwd: where.real, updatedAt: Number.isFinite(at) ? at : 0,
            title: cleanTitle(typeof s.title === "string" ? s.title : ""),
          });
        }
        cursor = typeof res.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
        if (!cursor) break;
      }
      this.listed = [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      this.listedAt = this.now();
      this.listError = null;
    } catch (e) {
      this.listError = errMessage(e);
      this.d.log.warn("listing the sessions on this machine failed", { agent: this.agent.id, error: this.listError });
    } finally {
      if (adapter) await adapter.kill();
    }
  }

  /** The session `ref` names, from a fresh enough list; the directory it records is the one it will be resumed in. */
  async resolve(ref: string): Promise<Resolved> {
    const want = ref.toLowerCase();
    const have = () => this.listed.find((l) => l.ref === want);
    let hit = have();
    if (!hit || this.now() - this.listedAt > this.d.catalogMs) {
      await this.refreshCatalog();
      hit = have();
    }
    if (hit) return { ok: true, item: hit };
    return { ok: false, reason: this.listedAt === 0 || this.listError ? "catalog_unavailable" : "unknown_session" };
  }

  /**
   * What the heartbeat reports: the newest sessions with their state now. The list itself comes from the last
   * refresh (a new one starts in the background when it is old); the state is read fresh, but never holds the
   * heartbeat for more than `capMs`.
   */
  private looking: Promise<LiveEntry[] | null> | null = null;

  async resumable(capMs = 3_000): Promise<Resumable[]> {
    if (!this.waitedOnce) {
      // Only the very first report waits (briefly) for a list; a list that cannot be had must not slow every heartbeat.
      this.waitedOnce = true;
      await within(this.refreshCatalog().then(() => true), 5_000, false);
    } else if (this.now() - this.listedAt > this.d.catalogMs) void this.refreshCatalog();
    // One look at a time: a look still waiting on a stalled disk is shared, not started again by every heartbeat (each
    // would hold a thread of the pool until the disk answers).
    this.looking ??= this.liveEntries().catch(() => null).finally(() => { this.looking = null; });
    const live = await within(this.looking, capMs, null);
    const attached = this.d.attachedRefs();
    return this.listed.slice(0, MAX_REPORTED).map((l) => {
      const holders = live?.filter((e) => e.sessionId.toLowerCase() === l.ref) ?? [];
      const state: ResumableState = attached.has(l.ref) ? "attached" : live === null ? "unknown" : holders.length ? "live" : "idle";
      const out: Resumable = { ref: l.ref, title: l.title, cwd: l.cwd, updated_at: Math.floor(l.updatedAt / 1000), state };
      if (state === "live") Object.assign(out, liveActivity(holders));
      return out;
    });
  }

  // --- noticing a change without starting anything ----------------------------------------

  private lastPrint: string | null = null;
  private lastUnknownList = 0;

  /**
   * A cheap look, with no process started: the names and modification times of Claude Code's session registry files (one
   * is written when a terminal opens a conversation, rewritten when it starts or finishes a turn or starts waiting, and
   * removed when it exits) and of its projects directory (a new working directory). True when something changed since
   * the previous look, so that the caller reports at once rather than at the next heartbeat. A live conversation inside
   * the roots whose transcript exists but which the list does not have yet (a terminal just opened it), or a new transcript
   * in a project folder inside the roots (one a terminal ran and already ended), is listed again first, at most every
   * {@link UNKNOWN_RELIST_MS} (a change inside that time is listed when it is up). The first look only learns what is there.
   */
  async poll(): Promise<boolean> {
    // Read off the event loop (this runs every few seconds, and the Claude config directory may be on a network disk).
    const print = await this.fingerprint();
    const projects = await this.projectsPrint();
    if (print === this.lastPrint && projects === this.lastProjects && !this.relistDue) return false;
    const first = this.lastPrint === null;
    const looked = print !== this.lastPrint || projects !== this.lastProjects;
    // A new transcript in a project folder inside the roots: a conversation was started there (one a terminal ran and
    // already ended, `claude -p`, is in no registry). Appending to a transcript does not change its folder.
    const newTranscript = !first && projects !== this.lastProjects;
    this.lastPrint = print;
    this.lastProjects = projects;
    let rows: LiveEntry[] | null;
    try { rows = await readRegistryAsync(this.configDir, this.localDomain, this.now()); } catch { rows = null; }
    // Once per change: a list that still lacks the conversation afterwards is not asked again until something changes. The
    // first look asks too, for a terminal opened between the list made at start and this look.
    if (looked && (newTranscript || (rows !== null && await this.unlistedLive(rows)))) this.relistDue = true;
    let relisted = false;
    if (this.relistDue && this.now() - this.lastUnknownList >= UNKNOWN_RELIST_MS) {
      this.relistDue = false;
      this.lastUnknownList = this.now();
      relisted = await within(this.refreshCatalog().then(() => true), 60_000, false);
    }
    // Only a change in what the phone is shown is worth a report: a file rewritten with the same status is not.
    // (A registry that cannot be read, or is not there yet, still lets a new conversation in the list count as a change.)
    const summary = (rows === null ? "unreadable;" : "") + this.listed.slice(0, MAX_REPORTED).map((l) => {
      const holders = (rows ?? []).filter((e) => e.sessionId.toLowerCase() === l.ref);
      return `${l.ref}:${holders.length ? (liveActivity(holders).activity ?? "live") : "-"}:${liveActivity(holders).waiting_for ?? ""}`;
    }).join(",");
    const changed = summary !== this.lastSummary;
    this.lastSummary = summary;
    return changed && (!first || relisted);
  }

  private lastSummary = "";
  private lastProjects: string | null = null;
  /** A change asked for a new list that the rate limit has held back; the next look makes it. */
  private relistDue = false;

  /**
   * The project folders inside the roots (Claude Code names one after the working directory, every non-alphanumeric
   * turned into "-") with their modification times: one changes when a conversation is started in it. At most
   * {@link MAX_WATCHED_PROJECT_DIRS} of them, so a huge config directory is not walked every few seconds.
   */
  private async projectsPrint(): Promise<string> {
    const projects = path.join(this.configDir, "projects");
    const prefixes = this.agent.roots.map((r) => r.replace(/[^A-Za-z0-9]/g, "-"));
    const parts: string[] = [];
    try {
      parts.push(`projects:${(await fsp.stat(projects)).mtimeMs}`);
      for (const name of (await fsp.readdir(projects)).sort()) {
        if (!prefixes.some((p) => name.startsWith(p))) continue;
        if (parts.length > MAX_WATCHED_PROJECT_DIRS) break;
        try { parts.push(`${name}:${(await fsp.stat(path.join(projects, name))).mtimeMs}`); } catch { /* removed meanwhile */ }
      }
    } catch { parts.push("no-projects"); }
    return parts.join("|");
  }

  private async fingerprint(): Promise<string> {
    const parts: string[] = [];
    const dir = path.join(this.configDir, "sessions");
    try {
      for (const name of (await fsp.readdir(dir)).sort()) {
        if (!name.endsWith(".json")) continue;
        try { parts.push(`${name}:${(await fsp.stat(path.join(dir, name))).mtimeMs}`); } catch { /* removed meanwhile */ }
      }
    } catch { parts.push("no-sessions"); }
    return parts.join("|");
  }

  /** Whether a process holds open a conversation in the roots, with a transcript on disk, that the last list did not have. */
  private async unlistedLive(rows: LiveEntry[]): Promise<boolean> {
    for (const e of rows) {
      const ref = e.sessionId.toLowerCase();
      if (e.foreign || !SESSION_REF_RE.test(ref) || !e.cwd || this.listed.some((l) => l.ref === ref)) continue;
      if (!checkCwd(e.cwd, this.agent.roots).ok) continue;
      const transcript = path.join(this.configDir, "projects", e.cwd.replace(/[^A-Za-z0-9]/g, "-"), `${ref}.jsonl`);
      if (await fsp.access(transcript).then(() => true, () => false)) return true;
    }
    return false;
  }

  // --- the twin check ----------------------------------------------------------------

  /**
   * May this session be opened (or prompted) now?
   * `ownPgid` is the process group of this connector's own adapter for it: that adapter's agent process is listed
   * too and is not a twin. `transcript` also refuses a session whose transcript was written within the last
   * moments, which covers a terminal that has only just exited and is still flushing; it is skipped while this
   * connector's own adapter is the one writing.
   */
  async check(ref: string, o: { ownPgid?: number | null; transcript: boolean }): Promise<Verdict> {
    if (!SESSION_REF_RE.test(ref)) return { ok: false, reason: "twin_check_failed", detail: "not a session id" };
    const want = ref.toLowerCase();
    // The terminals' own rows first: they answer without starting anything, and a yes from them is final.
    const inTerminal = this.terminalRows().find((e) => isTwin(e, want, o.ownPgid));
    if (inTerminal) return { ok: false, reason: "session_live", detail: describeTwin(inTerminal) };
    let live: LiveEntry[];
    try {
      live = await this.liveEntries();
    } catch (e) {
      return { ok: false, reason: "twin_check_failed", detail: errMessage(e) };
    }
    const twin = live.find((e) => isTwin(e, want, o.ownPgid));
    if (twin) {
      return { ok: false, reason: "session_live", detail: describeTwin(twin) };
    }
    if (o.transcript) {
      const file = this.transcriptFile(want);
      let age: number | null = null;
      try { if (file) age = this.now() - fs.statSync(file).mtimeMs; } catch { /* no transcript to look at */ }
      if (age !== null && age < this.d.recentWriteMs) return { ok: false, reason: "recently_written", detail: `its transcript was written ${Math.max(0, Math.round(age / 1000))} s ago` };
    }
    return { ok: true };
  }

  /**
   * Taking over a conversation a terminal has open, after the person confirmed it on the phone: every local process that
   * holds `ref` open is asked to end (SIGTERM; Claude Code writes the end of its transcript, drops its registry row and
   * exits, measured on 2.1.319 in about a second), and this waits until none is left and the transcript has been quiet
   * for `recentWriteMs`, so that the resume that follows goes through the full check like any other. It fails closed: a
   * holder this machine cannot see (another host or container sharing the directory) cannot be ended, a process of
   * another user is not touched, and one that is still there after `waitMs` is a refusal, never a second writer.
   */
  async endHolders(ref: string, o: { ownPgid?: number | null; waitMs: number; sleep?: (ms: number) => Promise<void> }): Promise<EndVerdict> {
    if (!SESSION_REF_RE.test(ref)) return { ok: false, reason: "twin_check_failed", detail: "not a session id" };
    const want = ref.toLowerCase();
    const pause = o.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    let live: LiveEntry[];
    try {
      live = await this.liveEntries();
    } catch (e) {
      return { ok: false, reason: "twin_check_failed", detail: errMessage(e) };
    }
    const holders = live.filter((e) => isTwin(e, want, o.ownPgid));
    const foreign = holders.find((e) => e.foreign);
    if (foreign) return { ok: false, reason: "session_live_elsewhere", detail: describeTwin(foreign) };
    const pids = [...new Set(holders.map((e) => e.pid))].filter((pid) => pid > 1 && pid !== process.pid);
    // Only a process proven to be the local one that holds it is ever signalled: a pid read from a shared directory may
    // name another host's process, and the same number here is someone else's.
    const proven = await this.provenLocalHolders(want);
    const unproven = pids.find((pid) => !proven.has(pid));
    if (unproven !== undefined) {
      return { ok: false, reason: "takeover_failed", detail: `cannot tell that process ${unproven} on this machine is the one holding it` };
    }
    for (const pid of pids) {
      const owner = processUid(pid);
      if (owner !== null && typeof process.getuid === "function" && owner !== process.getuid()) {
        return { ok: false, reason: "takeover_not_permitted", detail: `process ${pid} belongs to another user` };
      }
    }
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ESRCH") continue;
        return { ok: false, reason: code === "EPERM" ? "takeover_not_permitted" : "takeover_failed", detail: `process ${pid}: ${errMessage(e)}` };
      }
    }
    const deadline = this.now() + o.waitMs;
    // Gone, and the transcript quiet: the terminal may write its last lines on the way out.
    for (;;) {
      const left = pids.filter((pid) => isAlive(pid) && !isZombie(pid));
      const file = this.transcriptFile(want);
      let age = Infinity;
      try { if (file) age = this.now() - fs.statSync(file).mtimeMs; } catch { /* no transcript to look at */ }
      if (!left.length && age >= this.d.recentWriteMs) break;
      if (this.now() >= deadline) {
        return left.length
          ? { ok: false, reason: "terminal_did_not_exit", detail: `process ${left.join(", ")} did not exit within ${Math.round(o.waitMs / 1000)} s` }
          : { ok: false, reason: "recently_written", detail: "its transcript is still being written" };
      }
      await pause(250);
    }
    return { ok: true, ended: pids };
  }

  /**
   * The local processes that provably hold `want` open: those Claude Code's own `claude agents --json` lists for it (it only
   * lists processes of this pid namespace that are alive), and those whose registry or hook row names this machine's pid
   * domain and the start time of the process that has that pid now. A row without either proof is not enough to signal a pid.
   */
  private async provenLocalHolders(want: string): Promise<Set<number>> {
    const proven = await this.provenHolderPids(want);
    // ... and only one that works inside this agent's roots: a takeover never reaches a process outside what it may touch.
    return new Set([...proven.keys()].filter((pid) => {
      let cwd = proven.get(pid) ?? null;
      if (process.platform === "linux") {
        try { cwd = fs.realpathSync(`/proc/${pid}/cwd`); } catch { cwd = null; }
      }
      return cwd !== null && checkCwd(cwd, this.agent.roots).ok;
    }));
  }

  /** The proven holders of `want` (see {@link provenLocalHolders}), each with the directory its row reports (null: none). */
  private async provenHolderPids(want: string): Promise<Map<number, string | null>> {
    const out = new Map<number, string | null>();
    const env = { ...this.d.env, ...this.agent.env, CLAUDE_CONFIG_DIR: this.configDir };
    try {
      for (const e of parseAgentsJson(await run(this.agent.attach?.cli ?? "claude", ["agents", "--json"], env, this.d.cliTimeoutMs))) {
        if (e.sessionId.toLowerCase() === want) out.set(e.pid, typeof e.cwd === "string" ? e.cwd : null);
      }
    } catch { /* the rows below may still prove it */ }
    if (this.localDomain === null) return out;
    for (const dir of [path.join(this.configDir, "sessions"), terminalsDir(this.configDir)]) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        let doc: unknown;
        try { doc = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
        if (!isObject(doc) || typeof doc.pid !== "number" || !Number.isInteger(doc.pid) || typeof doc.sessionId !== "string") continue;
        if (doc.sessionId.toLowerCase() !== want || doc.pidDomain !== this.localDomain) continue;
        if (typeof doc.procStart === "string" && doc.procStart && processStart(doc.pid) === doc.procStart) {
          out.set(doc.pid, typeof doc.cwd === "string" ? doc.cwd : out.get(doc.pid) ?? null);
        }
      }
    }
    return out;
  }

  /** Every live process that holds a session open. Throws {@link TwinCheckError} when neither source can be read. */
  async liveEntries(): Promise<LiveEntry[]> {
    const env = { ...this.d.env, ...this.agent.env, CLAUDE_CONFIG_DIR: this.configDir };
    let viaCli: LiveEntry[] | null = null;
    let cliError = "";
    try {
      viaCli = parseAgentsJson(await run(this.agent.attach?.cli ?? "claude", ["agents", "--json"], env, this.d.cliTimeoutMs));
    } catch (e) {
      cliError = errMessage(e).split("\n")[0]!;
    }
    let registry: LiveEntry[] = [];
    let registryError = "";
    try {
      registry = await readRegistryAsync(this.configDir, this.localDomain);
    } catch (e) {
      registryError = errMessage(e);
    }
    let out: LiveEntry[];
    if (viaCli) {
      // The command knows the processes of this pid namespace and nothing else, so the registry adds to its answer: a
      // local row it did not list (a duplicate by pid is dropped), and every foreign row. A foreign row's pid is a
      // number in a namespace this one does not share; it is neither matched against the command's pids nor dropped
      // because the command did not list it.
      const seen = new Set(viaCli.map((e) => e.pid));
      out = [...viaCli, ...registry.filter((e) => e.foreign || !seen.has(e.pid))];
    } else if (!registryError) {
      out = registry;
    } else {
      throw new TwinCheckError(`cannot tell which sessions are open: "${this.agent.attach?.cli ?? "claude"} agents --json" failed (${cliError}) and the session registry could not be read (${registryError})`);
    }
    // The hook rows add to whatever the other two say (the same process may be in both, which changes nothing).
    return [...await this.terminalRowsAsync(), ...out];
  }

  /**
   * A look at the registry alone, with nothing started: is another process listed as holding `ref` open? It is cheap
   * enough to repeat every second while this connector's own agent is writing to the transcript, which is when a
   * terminal that opens the conversation and closes it again must not go unseen (see `Session.watchTwins`). Null when
   * the registry cannot be read; the full {@link check} made when the work ends is the one that has to answer.
   */
  peek(ref: string, ownPgid: number | null): { twin: LiveEntry | null } | null {
    if (!SESSION_REF_RE.test(ref)) return null;
    const want = ref.toLowerCase();
    const hook = this.terminalRows().find((e) => isTwin(e, want, ownPgid));
    try {
      return { twin: hook ?? readRegistry(this.configDir, this.localDomain, this.now()).find((e) => isTwin(e, want, ownPgid)) ?? null };
    } catch {
      return hook ? { twin: hook } : null;
    }
  }

  /** The size of the conversation's transcript now, or null when there is none to look at. */
  transcriptSize(ref: string): number | null {
    const file = SESSION_REF_RE.test(ref) ? this.transcriptFile(ref.toLowerCase()) : null;
    try { return file ? fs.statSync(file).size : null; } catch { return null; }
  }

  /** Where the conversation's transcript is, or null when it cannot be found (yet). */
  transcriptPath(ref: string): string | null {
    const file = SESSION_REF_RE.test(ref) ? this.transcriptFile(ref.toLowerCase()) : null;
    if (!file) return null;
    // Read only what really is in this config directory's projects: a link that leads anywhere else is not followed.
    try {
      const root = fs.realpathSync(path.join(this.configDir, "projects"));
      const real = fs.realpathSync(file);
      return real.startsWith(root + path.sep) && real.endsWith(`${ref.toLowerCase()}.jsonl`) ? real : null;
    } catch {
      return null;
    }
  }

  /** `<config dir>/projects/<working directory with every non-alphanumeric turned into "-">/<id>.jsonl`, found by name when that guess misses. */
  private transcriptFile(ref: string): string | null {
    const cached = this.transcripts.get(ref);
    if (cached && fs.existsSync(cached)) return cached;
    this.transcripts.delete(ref);
    const projects = path.join(this.configDir, "projects");
    const remember = (f: string) => { this.transcripts.set(ref, f); return f; };
    const known = this.listed.find((l) => l.ref === ref);
    if (known) {
      const guess = path.join(projects, known.cwd.replace(/[^A-Za-z0-9]/g, "-"), `${ref}.jsonl`);
      if (fs.existsSync(guess)) return remember(guess);
    }
    try {
      let n = 0;
      for (const dir of fs.readdirSync(projects)) {
        if (++n > MAX_SCANNED_PROJECT_DIRS) break;
        const f = path.join(projects, dir, `${ref}.jsonl`);
        if (fs.existsSync(f)) return remember(f);
      }
    } catch { /* no projects directory */ }
    return null;
  }
}

function describeTwin(e: LiveEntry): string {
  if (e.via === "hook") return e.foreign ? `open in a terminal, registered by a process this machine cannot see (pid ${e.pid})` : `open in a terminal (pid ${e.pid}, registered by its session hook)`;
  return e.foreign ? `registered by a process this machine cannot see (pid ${e.pid})` : `process ${e.pid} has it open (${e.status ?? "running"})`;
}

/**
 * Whether `e` is another process holding `want` open. This connector's own agent (a process of the group `ownPgid`) is
 * not. A foreign row is never excluded that way: its pid is a number in a namespace this machine does not share, and
 * the local process that happens to have the same number says nothing about it.
 */
function isTwin(e: LiveEntry, want: string, ownPgid: number | null | undefined): boolean {
  if (e.sessionId.toLowerCase() !== want) return false;
  return e.foreign || !(ownPgid != null && processGroup(e.pid) === ownPgid);
}

/** An exited process its parent has not reaped yet (Linux): it holds nothing open any more. */
function isZombie(pid: number): boolean {
  if (process.platform !== "linux") return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

/** The real user id of a process (Linux), or null where that cannot be read. */
function processUid(pid: number): number | null {
  if (process.platform !== "linux") return null;
  try {
    const m = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// --- sources ---------------------------------------------------------------------------

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin?.end();
  });
}

/** `claude agents --json`: a JSON array of the live sessions. Rows without a pid and a session id are not sessions of ours to compare. */
export function parseAgentsJson(text: string): LiveEntry[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("the answer is not a list");
  const out: LiveEntry[] = [];
  for (const x of raw) {
    if (isObject(x) && typeof x.pid === "number" && Number.isInteger(x.pid) && typeof x.sessionId === "string") {
      out.push({ pid: x.pid, sessionId: x.sessionId, status: typeof x.status === "string" ? x.status : null, foreign: false,
        waitingFor: typeof x.waitingFor === "string" ? x.waitingFor : null, cwd: typeof x.cwd === "string" ? x.cwd : null });
    }
  }
  return out;
}

/**
 * The registry Claude Code keeps itself. A row counts when the process it names is still the same process (same
 * start time on Linux, the only platform where that value is known to match); a row from another host or pid
 * namespace cannot be checked and counts, because "cannot tell" must not read as "gone".
 */
export function readRegistry(configDir: string, localDomain: string | null, now = Date.now()): LiveEntry[] {
  const dir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    throw new TwinCheckError(`${dir}: ${errMessage(e)}`);
  }
  const out: LiveEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      // A file that is not valid JSON and is not old might be one being written right now: the answer is not known yet.
      let age = Infinity;
      try { age = now - fs.statSync(file).mtimeMs; } catch { /* gone meanwhile */ }
      if (age < UNREADABLE_GRACE_MS) throw new TwinCheckError(`${file} is unreadable (${errMessage(e).split("\n")[0]})`);
      continue;
    }
    const entry = registryEntry(doc, localDomain);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * {@link readRegistry}, off the event loop: the heartbeat's look ({@link AttachSupport.liveEntries}) reads the Claude
 * config directory, which may be on a network disk that stalls, and a stalled read must not stop the heartbeat.
 */
export async function readRegistryAsync(configDir: string, localDomain: string | null, now = Date.now()): Promise<LiveEntry[]> {
  const dir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    throw new TwinCheckError(`${dir}: ${errMessage(e)}`);
  }
  const out: LiveEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let doc: unknown;
    try {
      doc = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch (e) {
      let age = Infinity;
      try { age = now - (await fsp.stat(file)).mtimeMs; } catch { /* gone meanwhile */ }
      if (age < UNREADABLE_GRACE_MS) throw new TwinCheckError(`${file} is unreadable (${errMessage(e).split("\n")[0]})`);
      continue;
    }
    const entry = registryEntry(doc, localDomain);
    if (entry) out.push(entry);
  }
  return out;
}

/** One registry row, if it names a process that still holds the session (see {@link readRegistry}). */
function registryEntry(doc: unknown, localDomain: string | null): LiveEntry | null {
  if (!isObject(doc) || typeof doc.pid !== "number" || !Number.isInteger(doc.pid) || typeof doc.sessionId !== "string") return null;
  const domain = typeof doc.pidDomain === "string" ? doc.pidDomain : null;
  const foreign = domain !== null && localDomain !== null && domain !== localDomain;
  if (!foreign) {
    if (!isAlive(doc.pid)) return null;
    if (process.platform === "linux" && typeof doc.procStart === "string" && processStart(doc.pid) !== doc.procStart) return null;
  }
  return { pid: doc.pid, sessionId: doc.sessionId, status: typeof doc.status === "string" ? doc.status : null, foreign,
    waitingFor: typeof doc.waitingFor === "string" ? doc.waitingFor : null, cwd: typeof doc.cwd === "string" ? doc.cwd : null };
}

/** The process group of a process, or null when it cannot be read. */
export function processGroup(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) || null;
    }
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || null;
  } catch {
    return null;
  }
}

/**
 * What the processes holding a conversation open say it is doing: waiting for the person wins over working, which wins
 * over idle (two holders: the one that needs someone is the one to show). Nothing when none of them says.
 */
export function liveActivity(holders: LiveEntry[]): { activity?: LiveActivity; waiting_for?: string } {
  const waiting = holders.find((e) => e.status === "waiting");
  if (waiting) {
    const why = waiting.waitingFor ? cleanTitle(waiting.waitingFor).slice(0, MAX_WAITING_FOR) : "";
    return why ? { activity: "waiting", waiting_for: why } : { activity: "waiting" };
  }
  if (holders.some((e) => e.status === "busy")) return { activity: "working" };
  if (holders.some((e) => e.status === "idle")) return { activity: "idle" };
  return {};
}

/** A title that is safe to send: no credential shapes, no control characters, one line, short. */
export function cleanTitle(raw: string): string {
  const one = redactText(raw).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > MAX_TITLE ? `${one.slice(0, MAX_TITLE - 1)}…` : one;
}

/**
 * The capabilities an attach agent reports, with as many of the newest sessions as fit under the limit Claw puts on
 * them. `base` is the rest of the capabilities; the list is cut from the oldest end, and when not even an empty list
 * fits the key is left out, so that this never makes a heartbeat invalid that would have been valid without it.
 */
export function fitResumable(base: Record<string, unknown>, items: Resumable[], limit = REMOTE_AGENT_LIMITS.maxCapabilitiesBytes): Record<string, unknown> {
  let n = Math.min(items.length, MAX_REPORTED);
  const size = (c: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(c)).length;
  for (;;) {
    const caps = { ...base, resumable: items.slice(0, n) };
    if (size(caps) <= limit) return caps;
    if (n === 0) {
      // Not even an empty list fits. `watch_live` goes too when the rest fits without it: it only matters with a list, and
      // the heartbeat must stay as valid as it was before the flag existed.
      const { watch_live: _watch, ...rest } = base;
      return size(base) > limit && size(rest) < size(base) ? rest : base;
    }
    n--;
  }
}

// --- watching a conversation another process holds open --------------------------------------

/** One thing the transcript says happened, shaped as the ACP `session/update` an adapter would have sent for it. */
export interface TranscriptUpdate {
  type: "user_message_chunk" | "agent_message_chunk" | "tool_call" | "tool_call_update";
  update: Record<string, unknown>;
}

const MAX_TOOL_TITLE = 200;

/**
 * What one line of a Claude Code transcript shows a phone: the user's words, the agent's words, the steps it starts and how
 * they end. Thinking, sub-agent lines (`isSidechain`), lines Claude Code adds for itself (`isMeta`, summaries, snapshots) and
 * anything that does not parse are nothing. Read-only: the line is never written back, and nothing here runs.
 */
export function transcriptUpdates(line: string): TranscriptUpdate[] {
  let doc: unknown;
  try { doc = JSON.parse(line); } catch { return []; }
  if (!isObject(doc) || doc.isSidechain === true || doc.isMeta === true) return [];
  if (doc.type !== "user" && doc.type !== "assistant") return [];
  const msg = isObject(doc.message) ? doc.message : null;
  if (!msg) return [];
  const text = (type: "user_message_chunk" | "agent_message_chunk", t: string): TranscriptUpdate[] =>
    t.trim() ? [{ type, update: { sessionUpdate: type, content: { type: "text", text: t } } }] : [];
  if (typeof msg.content === "string") return text(doc.type === "user" ? "user_message_chunk" : "agent_message_chunk", msg.content);
  if (!Array.isArray(msg.content)) return [];
  const out: TranscriptUpdate[] = [];
  for (const block of msg.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push(...text(doc.type === "user" ? "user_message_chunk" : "agent_message_chunk", block.text));
    } else if (doc.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
      out.push({ type: "tool_call", update: { sessionUpdate: "tool_call", toolCallId: block.id, title: toolTitle(block.name, block.input), kind: "other", status: "in_progress", rawInput: isObject(block.input) ? block.input : {} } });
    } else if (doc.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const result = resultText(block.content);
      out.push({ type: "tool_call_update", update: {
        sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error === true ? "failed" : "completed",
        ...(result ? { content: [{ type: "content", content: { type: "text", text: result } }] } : {}),
      } });
    }
  }
  return out;
}

function toolTitle(name: unknown, input: unknown): string {
  const tool = typeof name === "string" && name ? name : "Tool";
  const i = isObject(input) ? input : {};
  const what = [i.description, i.command, i.file_path, i.path, i.pattern, i.url].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return cleanTitleTo(what ? `${tool}: ${what}` : tool, MAX_TOOL_TITLE);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => isObject(c) && c.type === "text" && typeof c.text === "string").map((c) => (c as { text: string }).text).join("\n");
}

function cleanTitleTo(raw: string, max: number): string {
  const one = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** How much of the end of a transcript is read for what came just before a watcher arrived. */
const TAIL_BACKLOG_BYTES = 64 * 1024;
/** What one look reads at most; a burst larger than this is read over the next looks. */
const TAIL_READ_BYTES = 256 * 1024;
/** A line longer than this (one huge tool result) is skipped rather than held. */
const TAIL_MAX_LINE = 1024 * 1024;
/** How many of the backlog's updates are passed on. */
export const TAIL_BACKLOG_UPDATES = 20;

/**
 * Follows a transcript another process is writing, from its end, by reading it: the file is opened read-only and nothing
 * is ever written to it or to anything next to it. `poll()` returns what was appended since the last look; `backlog()`
 * what was at the end of it before the first look. A file that is not there yet is looked for again; one that shrinks
 * (rewritten) is followed from its new end.
 */
export class TranscriptTail {
  private offset: number | null = null;
  private partial = "";
  private skipping = false;
  /** A read can end inside a character; the decoder keeps its first bytes for the next one. */
  private decoder = new StringDecoder("utf8");

  constructor(private readonly locate: () => string | null) {}

  /** The last updates already in the transcript (at most {@link TAIL_BACKLOG_UPDATES}); from here on `poll()` reads what is new. */
  backlog(): TranscriptUpdate[] {
    const file = this.locate();
    if (!file) return [];
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BACKLOG_BYTES);
      const buf = Buffer.alloc(size - start);
      const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, start) : 0;
      this.offset = start + n;
      this.decoder = new StringDecoder("utf8");
      // Through the decoder: a read that ends inside a character keeps its first bytes for the next poll.
      let text = this.decoder.write(buf.subarray(0, n));
      // The first line is cut in the middle unless the read began at the start.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      const end = text.lastIndexOf("\n");
      this.partial = end === text.length - 1 ? "" : text.slice(end + 1);
      const updates = text.slice(0, end + 1).split("\n").flatMap((l) => (l ? transcriptUpdates(l) : []));
      return updates.slice(-TAIL_BACKLOG_UPDATES);
    } catch {
      return [];
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  /** Start from the end without reading what is there (a watcher that was already following, after a restart). */
  fromEnd(): void {
    const file = this.locate();
    try { this.offset = file ? fs.statSync(file).size : null; } catch { this.offset = null; }
    this.partial = "";
    this.decoder = new StringDecoder("utf8");
  }

  /** What was appended since the last look. */
  poll(): TranscriptUpdate[] {
    const file = this.locate();
    if (!file) return [];
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      if (this.offset === null) this.offset = 0;   // it did not exist when the watch began: all of it is new
      if (size < this.offset) { this.offset = size; this.partial = ""; this.decoder = new StringDecoder("utf8"); return []; }
      if (size === this.offset) return [];
      const buf = Buffer.alloc(Math.min(TAIL_READ_BYTES, size - this.offset));
      const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      return this.take(this.decoder.write(buf.subarray(0, n)));
    } catch {
      return [];
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private take(chunk: string): TranscriptUpdate[] {
    const text = this.partial + chunk;
    const end = text.lastIndexOf("\n");
    if (end < 0) {
      this.partial = text;
      if (this.partial.length > TAIL_MAX_LINE) { this.partial = ""; this.skipping = true; }
      return [];
    }
    this.partial = text.slice(end + 1);
    const lines = text.slice(0, end).split("\n");
    if (this.skipping) { lines.shift(); this.skipping = false; }   // the rest of a line too long to hold
    if (this.partial.length > TAIL_MAX_LINE) { this.partial = ""; this.skipping = true; }
    return lines.flatMap((l) => (l ? transcriptUpdates(l) : []));
  }
}
