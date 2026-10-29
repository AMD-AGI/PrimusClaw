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
 * Who holds a session open is read from Claude Code's own `claude agents --json` (it lists the live processes with
 * their session ids and ignores the stale files a killed process leaves). If that command is not there or does
 * not answer, the registry it reads, `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`, is read directly and each entry is
 * checked against the process it names (same start time), so a file left behind by a crash is not a twin.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdapterProcess, type AdapterHooks } from "./adapter.js";
import type { Audit } from "./audit.js";
import { isAlive, processStart, type ChildRegistry } from "./children.js";
import type { AgentConfig } from "./config.js";
import { REMOTE_AGENT_LIMITS } from "./protocol.js";
import { redactText } from "./redact.js";
import { checkCwd } from "./roots.js";
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
}

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
  /** Registered by a process this machine cannot see (another host or container sharing the directory): not provably gone. */
  foreign: boolean;
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: "session_live" | "recently_written" | "twin_check_failed"; detail: string };

export type Resolved = { ok: true; item: Listed } | { ok: false; reason: "unknown_session" | "catalog_unavailable" };

/** The check could not be answered. Attaching is refused: not being able to read it is not "nothing is open". */
export class TwinCheckError extends Error {}

/** Claude Code names a session by a UUID; anything else is never used to build a path. */
export const SESSION_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Most entries of the list that goes into the heartbeat. */
export const MAX_REPORTED = 12;
const MAX_LIST_PAGES = 8;
const MAX_TITLE = 80;
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
  private readonly localDomain = localPidDomain();

  constructor(readonly agent: AgentConfig, private readonly d: AttachDeps) {
    this.configDir = path.resolve(agent.env.CLAUDE_CONFIG_DIR ?? d.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
  }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  // --- what exists -------------------------------------------------------------------

  /** Ask the adapter for the sessions on this machine and keep those whose directory is inside the roots. One adapter process, started and stopped here. */
  refreshCatalog(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    let adapter: AdapterProcess | null = null;
    try {
      adapter = await AdapterProcess.start({
        cfg: this.agent, registry: this.d.registry, sessionId: `list-${this.agent.id}`, cwd: this.agent.roots[0] ?? os.homedir(),
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
          const where = checkCwd(s.cwd, this.agent.roots);
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
  async resumable(capMs = 3_000): Promise<Resumable[]> {
    if (!this.waitedOnce) {
      // Only the very first report waits (briefly) for a list; a list that cannot be had must not slow every heartbeat.
      this.waitedOnce = true;
      await within(this.refreshCatalog().then(() => true), 5_000, false);
    } else if (this.now() - this.listedAt > this.d.catalogMs) void this.refreshCatalog();
    const live = await within(this.liveEntries().catch(() => null), capMs, null);
    const attached = this.d.attachedRefs();
    return this.listed.slice(0, MAX_REPORTED).map((l) => ({
      ref: l.ref, title: l.title, cwd: l.cwd, updated_at: Math.floor(l.updatedAt / 1000),
      state: attached.has(l.ref) ? "attached" : live === null ? "unknown" : live.some((e) => e.sessionId.toLowerCase() === l.ref) ? "live" : "idle",
    }));
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
    let live: LiveEntry[];
    try {
      live = await this.liveEntries();
    } catch (e) {
      return { ok: false, reason: "twin_check_failed", detail: errMessage(e) };
    }
    const twin = live.find((e) => e.sessionId.toLowerCase() === want && !(o.ownPgid != null && processGroup(e.pid) === o.ownPgid));
    if (twin) {
      return { ok: false, reason: "session_live", detail: twin.foreign ? `registered by a process this machine cannot see (pid ${twin.pid})` : `process ${twin.pid} has it open (${twin.status ?? "running"})` };
    }
    if (o.transcript) {
      const file = this.transcriptFile(want);
      let age: number | null = null;
      try { if (file) age = this.now() - fs.statSync(file).mtimeMs; } catch { /* no transcript to look at */ }
      if (age !== null && age < this.d.recentWriteMs) return { ok: false, reason: "recently_written", detail: `its transcript was written ${Math.max(0, Math.round(age / 1000))} s ago` };
    }
    return { ok: true };
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
      registry = readRegistry(this.configDir, this.localDomain);
    } catch (e) {
      registryError = errMessage(e);
    }
    let out: LiveEntry[];
    if (viaCli) {
      // The command's answer is the whole answer; a local registry row it did not list can only add to it.
      const seen = new Set(viaCli.map((e) => e.pid));
      out = [...viaCli, ...registry.filter((e) => !e.foreign && !seen.has(e.pid))];
    } else if (!registryError) {
      out = registry;
    } else {
      throw new TwinCheckError(`cannot tell which sessions are open: "${this.agent.attach?.cli ?? "claude"} agents --json" failed (${cliError}) and the session registry could not be read (${registryError})`);
    }
    return out;
  }

  /** `<config dir>/projects/<working directory with every non-alphanumeric turned into "-">/<id>.jsonl`, found by name when that guess misses. */
  private transcriptFile(ref: string): string | null {
    const projects = path.join(this.configDir, "projects");
    const known = this.listed.find((l) => l.ref === ref);
    if (known) {
      const guess = path.join(projects, known.cwd.replace(/[^A-Za-z0-9]/g, "-"), `${ref}.jsonl`);
      if (fs.existsSync(guess)) return guess;
    }
    try {
      let n = 0;
      for (const dir of fs.readdirSync(projects)) {
        if (++n > MAX_SCANNED_PROJECT_DIRS) break;
        const f = path.join(projects, dir, `${ref}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
    } catch { /* no projects directory */ }
    return null;
  }
}

/** `p`'s answer, or `late` if it takes longer than `ms`; the timer never keeps the process alive. */
function within<T>(p: Promise<T>, ms: number, late: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(late), ms);
    t.unref?.();
    void p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(late); });
  });
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
      out.push({ pid: x.pid, sessionId: x.sessionId, status: typeof x.status === "string" ? x.status : null, foreign: false });
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
    if (!isObject(doc) || typeof doc.pid !== "number" || !Number.isInteger(doc.pid) || typeof doc.sessionId !== "string") continue;
    const domain = typeof doc.pidDomain === "string" ? doc.pidDomain : null;
    const foreign = domain !== null && localDomain !== null && domain !== localDomain;
    if (!foreign) {
      if (!isAlive(doc.pid)) continue;
      if (process.platform === "linux" && typeof doc.procStart === "string" && processStart(doc.pid) !== doc.procStart) continue;
    }
    out.push({ pid: doc.pid, sessionId: doc.sessionId, status: typeof doc.status === "string" ? doc.status : null, foreign });
  }
  return out;
}

/** What Claude Code writes as `pidDomain`: the machine, and the pid namespace the pid belongs to. */
export function localPidDomain(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return `linux:${fs.readFileSync("/etc/machine-id", "utf8").trim()}:${fs.readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return null;
  }
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
    if (n === 0) return base;
    n--;
  }
}
