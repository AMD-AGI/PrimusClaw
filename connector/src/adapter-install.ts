// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The pinned ACP adapters (`npx -y @agentclientprotocol/claude-agent-acp@0.99.0` and the like), installed once into
 * the connector's own state directory and started from there, never resolved by npx when a session opens.
 *
 * Resolving through npx at every start failed first sessions three ways: on a cold machine the download (Claude's
 * adapter takes about 350 MB on disk with its dependencies) outlasted the start-up timeout; with an unreachable registry npx
 * spent about 70 s retrying its metadata request before it ran even a cached copy; and npx was started in the session's
 * folder, so a repository's own `.npmrc` chose the registry. So:
 *  - `init`, `service install` and the start of `run` install each enabled agent's pinned package with
 *    `npm install --prefix <state>/adapters/<pkg>@<ver>` (in a fresh directory that is renamed into place when the
 *    install succeeded, so a half-done install is never used and two connectors installing at once do not collide);
 *    run's install is in the background and does not hold up the connection to Claw;
 *  - an adapter is then started as `node <its bin script>` straight from that directory: no npx, no registry;
 *  - a session that opens while its agent's install is still running waits for it (at most `INSTALL_WAIT_MS`);
 *  - if there is no installed copy (the install failed, or was never allowed) the agent's own npx command runs, as
 *    before, but in the connector's own directory: the session's folder reaches the adapter in `session/new`.
 * Only an agent whose command is exactly the preset form (`npx -y <package>@<exact version>`) is touched; any other
 * command and arguments are started as written.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import { errMessage, isObject } from "./util.js";

/** A package name with an exact version: `@scope/name@1.2.3` or `name@1.2.3-rc.1`. */
const PINNED_RE = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
/** A session waits this long for its agent's install before it falls back to npx. */
export const INSTALL_WAIT_MS = 5 * 60_000;
/** One `npm install` may take this long. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** After a failed install, the next attempt (in the background) waits this long. */
export const RETRY_AFTER_MS = 10 * 60_000;

export interface Pinned { spec: string; name: string; version: string; rest: string[] }

/** The pinned package an agent's command runs through npx, or null when the command is anything else. */
export function pinnedPackage(cfg: Pick<AgentConfig, "command" | "args">): Pinned | null {
  const base = path.basename(cfg.command).replace(/\.(cmd|exe)$/i, "");
  if (base !== "npx") return null;
  const [flag, spec, ...rest] = cfg.args;
  if ((flag !== "-y" && flag !== "--yes") || typeof spec !== "string") return null;
  const m = PINNED_RE.exec(spec);
  if (!m) return null;
  return { spec, name: m[1]!, version: m[2]!, rest };
}

/** What runs `npm install`; tests replace it. Resolves on success, rejects with npm's last words otherwise. */
export type Installer = (o: { dir: string; spec: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<void>;

/** npm from the PATH the agent runs with (the npx beside it is what the preset names), else the one beside this node. */
function npmCommand(env: NodeJS.ProcessEnv): string {
  const exe = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const d of (env.PATH ?? "").split(path.delimiter)) if (d && isExecutable(path.join(d, exe))) return exe;
  const sibling = path.join(path.dirname(process.execPath), exe);
  return isExecutable(sibling) ? sibling : exe;
}

function isExecutable(f: string): boolean {
  try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; }
}

/** Named like a credential (a count of tokens is not one). */
const SECRET_NAME = /KEY|TOKEN(?!S)|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|HEADERS/i;
/** What npm itself may need to reach a private registry: its own settings and the token an ~/.npmrc names. */
const NPM_OWN = /^(?:npm_config_|NPM_CONFIG_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/;

/**
 * The environment npm runs in: the adapter's, without the agents' sign-in variables (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * a gateway token, anything named like a credential that is not npm's own). An install runs the lifecycle scripts of
 * the adapter and every dependency; none of them needs a model key, so none of them is given one.
 */
export function npmEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => NPM_OWN.test(k) || !SECRET_NAME.test(k) || k === "SSH_AUTH_SOCK"));
}

export const npmInstaller: Installer = ({ dir, spec, env: adapterEnv, timeoutMs }) => new Promise((resolve, reject) => {
  const args = ["install", "--prefix", dir, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error", spec];
  let out = "";
  const env = npmEnv(adapterEnv);
  // cwd is the empty install directory: no project .npmrc applies; the user's own ~/.npmrc and npm_config_* do.
  const p = spawn(npmCommand(env), args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", timeout: timeoutMs, killSignal: "SIGKILL" });
  const keep = (d: Buffer) => { out = (out + d.toString("utf8")).slice(-2000); };
  p.stdout!.on("data", keep);
  p.stderr!.on("data", keep);
  p.once("error", (e) => reject(new Error(`could not run npm: ${errMessage(e)}`)));
  p.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`npm install ${spec} ${signal ? `was killed (${signal})` : `exited ${code}`}${out.trim() ? `: ${out.trim().split("\n").slice(-3).join(" | ")}` : ""}`));
  });
});

/** The script a package's bin runs, as npx would pick it: its only bin, or the one named after the package. */
function binOf(pkgDir: string, pkg: Pinned): string | null {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")); } catch { return null; }
  if (!isObject(raw) || raw.version !== pkg.version) return null;
  const short = pkg.name.split("/").pop()!;
  let rel: unknown = null;
  if (typeof raw.bin === "string") rel = raw.bin;
  else if (isObject(raw.bin)) {
    const entries = Object.entries(raw.bin);
    rel = entries.length === 1 ? entries[0]![1] : raw.bin[short];
  }
  if (typeof rel !== "string" || !rel) return null;
  const file = path.resolve(pkgDir, rel);
  if (!file.startsWith(pkgDir + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

/** Whether a bin script is run by node (a `#!...node` line, or a .js file without one). */
function runByNode(file: string): boolean {
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(128); head = b.subarray(0, fs.readSync(fd, b, 0, 128, 0)).toString("utf8"); } finally { fs.closeSync(fd); }
  } catch { return false; }
  if (head.startsWith("#!")) return /\bnode\b/.test(head.split("\n")[0]!);
  return /\.(c|m)?js$/.test(file);
}

export interface Launch { command: string; args: string[]; cwd: string; installed: boolean }

export interface StoreOptions {
  /** Install a missing package on demand (and in the background at `run`); off: use only what is already installed. */
  autoInstall: boolean;
  installer?: Installer;
  waitMs?: number;
  now?: () => number;
}

export class AdapterStore {
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly failedAt = new Map<string, number>();
  private readonly installer: Installer;

  constructor(readonly dir: string, private readonly o: StoreOptions) {
    this.installer = o.installer ?? npmInstaller;
  }

  /** Where a package lives once installed. */
  private finalDir(pkg: Pinned): string {
    return path.join(this.dir, `${pkg.name.replace("/", "+")}@${pkg.version}`);
  }

  /** The installed bin script, or null when there is no complete install. */
  installed(pkg: Pinned): string | null {
    return binOf(path.join(this.finalDir(pkg), "node_modules", ...pkg.name.split("/")), pkg);
  }

  /** Whether an install of this package is running in this process. */
  installing(pkg: Pinned): boolean { return this.pending.has(pkg.spec); }

  /**
   * Install `pkg` unless it is there. Never throws: null when it could not be installed (the reason goes to `say`).
   * One install per package at a time in this process; another process installing the same one is harmless.
   */
  install(pkg: Pinned, env: NodeJS.ProcessEnv, say: (line: string) => void = () => {}): Promise<string | null> {
    const have = this.installed(pkg);
    if (have) return Promise.resolve(have);
    const running = this.pending.get(pkg.spec);
    if (running) return running;
    const p = this.doInstall(pkg, env, say).finally(() => this.pending.delete(pkg.spec));
    this.pending.set(pkg.spec, p);
    return p;
  }

  private async doInstall(pkg: Pinned, env: NodeJS.ProcessEnv, say: (line: string) => void): Promise<string | null> {
    const final = this.finalDir(pkg);
    const started = Date.now();
    let tmp: string | null = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.sweepAbandoned(pkg);
      tmp = fs.mkdtempSync(path.join(this.dir, `.install-${pkg.name.replace("/", "+")}@${pkg.version}-`));
      say(`installing ${pkg.spec} into ${final} (once; an adapter with its dependencies is a few hundred MB, so this can take a few minutes)`);
      await this.installer({ dir: tmp, spec: pkg.spec, env, timeoutMs: INSTALL_TIMEOUT_MS });
      if (!binOf(path.join(tmp, "node_modules", ...pkg.name.split("/")), pkg)) throw new Error(`npm reported success but ${pkg.spec} has no runnable bin in ${tmp}`);
      if (!this.installed(pkg)) {
        // A broken copy in the way (an interrupted manual edit) is moved aside first; a complete one is never replaced.
        if (fs.existsSync(final)) fs.renameSync(final, `${final}.stale-${process.pid}-${Date.now()}`);
        try {
          fs.renameSync(tmp, final);
          tmp = null;
        } catch (e) {
          // Another connector finished the same install first: use its copy.
          if (!this.installed(pkg)) throw e;
        }
      }
      for (const f of fs.readdirSync(this.dir)) if (f.startsWith(`${path.basename(final)}.stale-`)) fs.rmSync(path.join(this.dir, f), { recursive: true, force: true });
      const bin = this.installed(pkg);
      if (!bin) throw new Error(`${pkg.spec} is not runnable after the install`);
      this.failedAt.delete(pkg.spec);
      say(`installed ${pkg.spec} in ${Math.round((Date.now() - started) / 1000)} s`);
      return bin;
    } catch (e) {
      this.failedAt.set(pkg.spec, this.now());
      say(`could not install ${pkg.spec}: ${errMessage(e)}; sessions start it through npx instead (slower, and needs the registry each time)`);
      return null;
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Install directories a killed connector left behind (older than any install can take). */
  private sweepAbandoned(pkg: Pinned): void {
    const prefix = `.install-${pkg.name.replace("/", "+")}@${pkg.version}-`;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.startsWith(prefix)) continue;
      const p = path.join(this.dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 2 * INSTALL_TIMEOUT_MS) fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone already */ }
    }
  }

  private now(): number { return (this.o.now ?? Date.now)(); }

  /**
   * How to start an agent's adapter for a session in `cwd`. A pinned package that is installed runs from here; one
   * whose install is running is waited for (at most `waitMs`); otherwise npx runs as configured, in this directory.
   */
  async launch(cfg: AgentConfig, cwd: string, env: NodeJS.ProcessEnv): Promise<Launch> {
    const pkg = pinnedPackage(cfg);
    if (!pkg) return { command: cfg.command, args: cfg.args, cwd, installed: false };
    let bin = this.installed(pkg);
    if (!bin) {
      const failed = this.failedAt.get(pkg.spec);
      if (failed === undefined) {
        // A first install (started here, or already running at init or run's start) is worth waiting for.
        const job = this.o.autoInstall ? this.install(pkg, env) : this.pending.get(pkg.spec);
        if (job) bin = await raceTimeout(job, this.o.waitMs ?? INSTALL_WAIT_MS);
      } else if (this.o.autoInstall && !this.installing(pkg) && this.now() - failed >= RETRY_AFTER_MS) {
        // After a failure the install is tried again in the background, and no session waits for that retry.
        void this.install(pkg, env);
      }
    }
    if (bin) return runByNode(bin) ? { command: process.execPath, args: [bin, ...pkg.rest], cwd, installed: true } : { command: bin, args: pkg.rest, cwd, installed: true };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return { command: cfg.command, args: cfg.args, cwd: this.dir, installed: false };
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout;
  const t = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// --- the process-wide store ----------------------------------------------------------------

let store: AdapterStore | null = null;

/** Set by the command line (`main`) for this connector's state directory; unset, adapters start as configured. */
export function useAdapterStore(s: AdapterStore | null): void { store = s; }
export function adapterStore(): AdapterStore | null { return store; }

/** The distinct pinned packages of these agents. */
export function pinnedOf(agents: Array<Pick<AgentConfig, "command" | "args" | "env">>, base: NodeJS.ProcessEnv = process.env): Array<{ pkg: Pinned; env: NodeJS.ProcessEnv }> {
  const seen = new Map<string, { pkg: Pinned; env: NodeJS.ProcessEnv }>();
  for (const a of agents) {
    const pkg = pinnedPackage(a);
    if (pkg && !seen.has(pkg.spec)) seen.set(pkg.spec, { pkg, env: { ...base, ...a.env } });
  }
  return [...seen.values()];
}

/** Install every pinned package of these agents now, one after another, saying what happens (init, service install). */
export async function installAll(s: AdapterStore, agents: Array<Pick<AgentConfig, "command" | "args" | "env">>, base: NodeJS.ProcessEnv, say: (line: string) => void): Promise<void> {
  for (const { pkg, env } of pinnedOf(agents, base)) {
    if (s.installed(pkg)) { say(`${pkg.spec} is installed`); continue; }
    await s.install(pkg, env, say);
  }
}

/** The directory the adapters are installed into: under the connector's state directory. */
export const adaptersDir = (stateDir: string): string => path.join(stateDir, "adapters");
