// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector upgrading itself to the version Claw recommends.
 *
 * Claw answers every heartbeat of a connector older than its recommended version with that version (`connector_version`:
 * `minimum_version`, `recommended_version`). A supervised run (`run --supervised`, which systemd, launchd or the script
 * supervisor keeps up) then upgrades itself, unless its owner turned that off (`auto_upgrade = false` in agents.toml,
 * `claw-connector auto-upgrade off`, or CLAW_CONNECTOR_AUTO_UPGRADE=0):
 *
 *  - only to exactly that version, never to "latest" and never down; only within the same major version, and below 1.0.0
 *    only within the range of minor versions Claw itself takes (its minimum); a prerelease is never installed by itself;
 *  - only while nothing is going on: no turn running, nothing queued for a terminal, no approval waiting, not paused, and
 *    that for a while (`idleMs`); otherwise it looks again `retryMs` later;
 *  - only where it can: a global npm install whose prefix this process may write, with the npm that belongs to the node
 *    running it, and a registry that has the version. Anything else changes nothing and is reported once, with the exact
 *    command that upgrades this machine by hand (the chat shows it beside the machine);
 *  - with the old version kept: the package directory is copied aside, `npm install -g --prefix <prefix>` puts the new
 *    one in place, its `--version` must name the version asked for, and a trial run of it (TRIAL_ENV) must connect to
 *    Claw within `trialMs`. Three failed trials restore the copy and pin that version as failed here: it is not tried
 *    again until Claw recommends a newer one. Only then does the run end (EXIT_UPGRADED), and its supervisor starts the
 *    new version (the script supervisor starts itself again on the new code first).
 *
 * The first run of the new version does the setup a new version may need (commands.ts `postUpgradeSetup`): hooks that are
 * installed are brought up to date; hooks that are not are never added, only mentioned once. The outcome travels to Claw
 * with every heartbeat (`capabilities.auto_upgrade`, and a health problem while it cannot upgrade).
 *
 * A connector from before this file cannot be reached this way: its first upgrade to a version with it is done by hand.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { CONNECTOR_PACKAGE, compareConnectorVersions } from "./protocol.js";
import { autoUpgradeFile, configFile, type Dirs } from "./paths.js";
import type { Problem } from "./doctor.js";
import { within } from "./statefile.js";
import { errMessage, isObject, sleep, type Logger } from "./util.js";

/**
 * How long one file-system question of a running connector may take (the configuration, its state or the install prefix may be on
 * a network disk that stopped answering): it is asked off the event loop, and no answer in time counts as "cannot tell".
 */
const FS_WAIT_MS = 5_000;

/** Set to 0 (or false, off, no) to keep this connector from upgrading itself, whatever agents.toml says. */
export const AUTO_UPGRADE_ENV = "CLAW_CONNECTOR_AUTO_UPGRADE";
/**
 * Set by an upgrading run for the trial run of the new version (its value: the version expected). Every version honours it:
 * such a run connects to Claw (identify and one heartbeat), prints {@link TRIAL_OK_LINE} and its version, and exits 0,
 * without taking a command, starting an agent or touching what the running connector owns (its pid file, its sessions).
 */
export const TRIAL_ENV = "CLAW_CONNECTOR_UPGRADE_TRIAL";
export const TRIAL_OK_LINE = "claw-connector upgrade trial: connected";
/** A supervised run that upgraded the package ends with this; every supervisor restarts it (the script one, on the new code). */
export const EXIT_UPGRADED = 79;
/** Test timings, as `checkMs=200,idleMs=300,...` (only for tests: a real connector keeps the defaults). */
export const TIMING_ENV = "CLAW_CONNECTOR_UPGRADE_TIMING";

export interface UpgradeTiming {
  /** How often a running connector looks at whether it should upgrade. */
  checkMs: number;
  /** Idle for this long before an upgrade starts (a person who just finished may send the next message). */
  idleMs: number;
  /** Busy, or refused (no npm, a prefix it may not write, a registry that does not answer): looked at again this much later. */
  retryMs: number;
  /** A trial run of the new version must connect within this. */
  trialMs: number;
  trialAttempts: number;
  /** Between two trials. */
  trialGapMs: number;
  /** One npm command may take this long. */
  npmMs: number;
}

export const DEFAULT_UPGRADE_TIMING: UpgradeTiming = {
  checkMs: 30_000, idleMs: 60_000, retryMs: 15 * 60_000, trialMs: 60_000, trialAttempts: 3, trialGapMs: 5_000, npmMs: 5 * 60_000,
};

/** The timings, with what TIMING_ENV sets (whole milliseconds, at least 10; `trialAttempts` at least 1). */
export function upgradeTiming(env: NodeJS.ProcessEnv): UpgradeTiming {
  const t: UpgradeTiming = { ...DEFAULT_UPGRADE_TIMING };
  for (const part of (env[TIMING_ENV] ?? "").split(",")) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(\d{1,9})\s*$/.exec(part);
    if (!m || !Object.hasOwn(t, m[1]!)) continue;
    const key = m[1] as keyof UpgradeTiming;
    t[key] = Math.max(key === "trialAttempts" ? 1 : 10, Number(m[2]));
  }
  return t;
}

// --- whether it is on ----------------------------------------------------------------------------------

export interface Setting { enabled: boolean; source: "env" | "config" | "default" }

function envSetting(env: NodeJS.ProcessEnv): boolean | null {
  const v = (env[AUTO_UPGRADE_ENV] ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(v)) return false;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  return null;
}

/** agents.toml's top-level `auto_upgrade`, or null when it does not say (or cannot be read). */
export function configSetting(text: string | null): boolean | null {
  if (text === null) return null;
  try {
    const doc = parseToml(text) as Record<string, unknown>;
    return typeof doc.auto_upgrade === "boolean" ? doc.auto_upgrade : null;
  } catch { return null; }
}

const readText = (f: string): string | null => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const readTextOff = (f: string): Promise<string | null> => within(fsp.readFile(f, "utf8"), FS_WAIT_MS, null);

const settingOf = (env: NodeJS.ProcessEnv, text: string | null): Setting => {
  const e = envSetting(env);
  if (e !== null) return { enabled: e, source: "env" };
  const c = configSetting(text);
  if (c !== null) return { enabled: c, source: "config" };
  return { enabled: true, source: "default" };
};

/** On unless CLAW_CONNECTOR_AUTO_UPGRADE or agents.toml turns it off. */
export function autoUpgradeSetting(dirs: Dirs, env: NodeJS.ProcessEnv): Setting {
  return settingOf(env, readText(configFile(dirs)));
}

/** The same, read off the event loop: a running connector reads it afresh at each check, so a change applies without a restart. */
export async function readAutoUpgradeSetting(dirs: Dirs, env: NodeJS.ProcessEnv): Promise<Setting> {
  return settingOf(env, await readTextOff(configFile(dirs)));
}

/**
 * `auto_upgrade = true|false` in agents.toml: the line that is there is changed; else one is added after the comment that
 * heads the file (before any table, where a top-level key must be). Nothing else in the file changes.
 */
export function writeConfigSetting(dirs: Dirs, enabled: boolean): string {
  const file = configFile(dirs);
  const text = readText(file);
  if (text === null) throw new Error(`there is no ${file} yet: run claw-connector init (or pair) first`);
  const lines = text.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const head = firstTable < 0 ? lines.length : firstTable;
  const line = `auto_upgrade = ${enabled}`;
  const at = lines.slice(0, head).findIndex((l) => /^\s*auto_upgrade\s*=/.test(l));
  if (at >= 0) lines[at] = line;
  else {
    let i = 0;
    while (i < head && lines[i]!.startsWith("#")) i++;
    lines.splice(i, 0, ...(i > 0 ? [""] : []), "# Whether this connector upgrades itself to the version Claw recommends (claw-connector auto-upgrade on|off).", line, ...(i < lines.length && lines[i] !== "" ? [""] : []));
  }
  const out = lines.join("\n");
  if (configSetting(out) !== enabled) throw new Error(`could not set auto_upgrade in ${file}; set it there by hand: ${line}`);
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* keep 0600 */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, { mode });
  fs.renameSync(tmp, file);
  return file;
}

// --- which version ----------------------------------------------------------------------------------

export interface Recommendation { minimum: string; recommended: string }

const SEMVER = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const parts = (v: string) => {
  const m = SEMVER.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), pre: m[4] ?? null } : null;
};

export type Eligibility =
  | { target: string }
  | { skip: "current" | "invalid" | "prerelease" | "major" | "minor" | "failed_before"; detail: string };

/**
 * What this connector (`current`) may upgrade itself to, given what Claw recommends and the version that already failed here
 * (`failed`): exactly the recommended version, when it is newer, a release, of the same major version, and, below 1.0.0
 * (where a new minor version may break things), of the same minor version unless Claw's minimum is no newer than this
 * connector's minor line (Claw then takes both lines, so moving between them is what it asks for).
 */
export function upgradeTarget(current: string, rec: Recommendation, failed: string | null = null): Eligibility {
  const cur = parts(current);
  const to = parts(rec.recommended);
  const min = parts(rec.minimum);
  if (!cur || !to) return { skip: "invalid", detail: `cannot compare ${current} with ${rec.recommended}` };
  if ((compareConnectorVersions(rec.recommended, current) ?? 0) <= 0) return { skip: "current", detail: `${current} is not older than ${rec.recommended}` };
  if (to.pre !== null) return { skip: "prerelease", detail: `${rec.recommended} is a prerelease` };
  if (to.major !== cur.major) return { skip: "major", detail: `${rec.recommended} is a new major version` };
  if (to.major === 0 && to.minor !== cur.minor && !(min && min.major === 0 && min.minor <= cur.minor)) {
    return { skip: "minor", detail: `${rec.recommended} is a new 0.x minor version that Claw's minimum (${rec.minimum}) does not put in one range with ${current}` };
  }
  if (failed !== null && (compareConnectorVersions(rec.recommended, failed) ?? 1) <= 0) {
    return { skip: "failed_before", detail: `${failed} failed here before; waiting for a newer recommended version` };
  }
  return { target: rec.recommended.trim().replace(/^v/, "") };
}

// --- where it is installed ----------------------------------------------------------------------------

export interface Layout {
  /** This package's directory: `<prefix>/lib/node_modules/@primusclaw/connector`. */
  pkgDir: string;
  prefix: string;
  /** The program a supervisor starts (`<pkgDir>/dist/cli.js`). */
  cli: string;
  node: string;
  /** How npm is run with the same node (`[node, npm-cli.js]`, or the `npm` found on PATH), or null when there is none. */
  npm: string[] | null;
  /** What a person types for that npm (the `npm` beside node, else plain `npm`). */
  npmShown: string;
}

const isFile = (f: string): boolean => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const isFileOff = (f: string): Promise<boolean> => within(fsp.stat(f).then((st) => st.isFile()), FS_WAIT_MS, false);

async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, name);
    if (await within(fsp.access(f, fs.constants.X_OK).then(() => true), FS_WAIT_MS, false) && await isFileOff(f)) return f;
  }
  return null;
}

/**
 * Where this connector is installed, from the path of its own program, or why it cannot upgrade itself: only a global npm
 * install (`npm install -g`, with or without `--prefix`) does; a source checkout or an npx cache is someone else's to update.
 */
export async function installLayout(cli: string, node: string, env: NodeJS.ProcessEnv): Promise<Layout | { unmanaged: string }> {
  const real = await within(fsp.realpath(cli), FS_WAIT_MS, null);
  if (real === null) return { unmanaged: `cannot resolve ${cli}` };
  const pkgDir = path.dirname(path.dirname(real));
  const scope = path.dirname(pkgDir);
  const modules = path.dirname(scope);
  const lib = path.dirname(modules);
  const [scopeName, pkgName] = CONNECTOR_PACKAGE.split("/");
  if (path.basename(real) !== "cli.js" || path.basename(pkgDir) !== pkgName || path.basename(scope) !== scopeName
    || path.basename(modules) !== "node_modules" || path.basename(lib) !== "lib" || real.includes(`${path.sep}_npx${path.sep}`)) {
    return { unmanaged: `${real} is not in a global npm install (<prefix>/lib/node_modules/${CONNECTOR_PACKAGE})` };
  }
  const text = await readTextOff(path.join(pkgDir, "package.json"));
  let pkg: unknown = null;
  try { pkg = text === null ? null : JSON.parse(text); } catch { /* below */ }
  if (!isObject(pkg) || pkg.name !== CONNECTOR_PACKAGE) return { unmanaged: `${pkgDir}/package.json is not ${CONNECTOR_PACKAGE}'s, or cannot be read` };
  const nodeDir = path.dirname(node);
  const npmCli = path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const beside = path.join(nodeDir, "npm");
  const hasCli = await isFileOff(npmCli);
  const onPath = hasCli ? null : await findOnPath("npm", env);
  return {
    pkgDir, prefix: path.dirname(lib), cli: path.join(pkgDir, "dist", "cli.js"), node,
    npm: hasCli ? [node, path.resolve(npmCli)] : onPath ? [onPath] : null,
    npmShown: (await isFileOff(beside)) ? beside : "npm",
  };
}

const shq = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The command that upgrades this machine by hand, and restarts the connector on it. */
export function manualCommand(layout: Layout | null, version: string, sudo = false): string {
  const pkg = `${CONNECTOR_PACKAGE}@${version}`;
  if (!layout) return `npm install -g ${pkg} && claw-connector stop && claw-connector service install`;
  const bin = shq(path.join(layout.prefix, "bin", "claw-connector"));
  return `${sudo ? "sudo " : ""}${shq(layout.npmShown)} install -g --prefix ${shq(layout.prefix)} ${pkg} && ${bin} stop && ${bin} service install`;
}

/** The directories `npm install -g --prefix` writes: errno code of the first this process may not write, or null. */
export async function unwritable(layout: Layout): Promise<{ dir: string; code: string } | null> {
  const scope = path.dirname(layout.pkgDir);
  for (const dir of [scope, path.join(layout.prefix, "bin")]) {
    const code = await within(fsp.access(dir, fs.constants.W_OK).then(() => "", (e: NodeJS.ErrnoException) => e.code ?? "EACCES"), FS_WAIT_MS, "ETIMEDOUT");
    if (code) return { dir, code };
  }
  return null;
}

/** Whether a directory belongs to another user (then the manual command needs sudo). */
const othersDir = async (dir: string): Promise<boolean> =>
  typeof process.getuid === "function" && (await within(fsp.stat(dir).then((st) => st.uid !== process.getuid!()), FS_WAIT_MS, false));

// --- what it left behind --------------------------------------------------------------------------------

export type Outcome = "upgraded" | "rolled_back" | "blocked";

export interface UpgradeState {
  failed?: { version: string; at: string; reason: string };
  last?: { from: string; to: string; outcome: Outcome; at: string; detail?: string };
  /** Not before this (an ISO time): after a refusal that only time can fix (npm offline, a lock held). */
  next_try_at?: string;
  /** The version whose first run still has to do its setup (commands.ts `postUpgradeSetup`). */
  setup_pending?: string;
  /** The command a person can run instead, for the last refusal. */
  command?: string;
}

const stateOf = (t: string | null): UpgradeState => {
  if (t === null) return {};
  try { const v: unknown = JSON.parse(t); return isObject(v) ? (v as UpgradeState) : {}; } catch { return {}; }
};

export function readUpgradeState(dirs: Dirs): UpgradeState {
  return stateOf(readText(autoUpgradeFile(dirs)));
}

/** The same, off the event loop (a running connector's check). */
export async function readUpgradeStateOff(dirs: Dirs): Promise<UpgradeState> {
  return stateOf(await readTextOff(autoUpgradeFile(dirs)));
}

export function writeUpgradeState(dirs: Dirs, st: UpgradeState): void {
  try {
    fs.mkdirSync(dirs.state, { recursive: true, mode: 0o700 });
    const file = autoUpgradeFile(dirs);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* best effort: the next run looks again */ }
}

// --- running programs ---------------------------------------------------------------------------------------

interface Ran { code: number | null; out: string; err: string; timedOut: boolean }

/** Run a program in a process group of its own, killed whole at `timeoutMs` or when `signal` aborts. */
function run(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal, onOut?: (chunk: string) => void): Promise<Ran> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout!.setEncoding("utf8").on("data", (c: string) => { if (out.length < 64 * 1024) out += c; onOut?.(c); });
    child.stderr!.setEncoding("utf8").on("data", (c: string) => { if (err.length < 64 * 1024) err += c; });
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* gone */ } };
    let hard: NodeJS.Timeout | undefined;
    const stop = () => { kill("SIGTERM"); hard = setTimeout(() => kill("SIGKILL"), 10_000); hard.unref?.(); };
    const t = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => stop();
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(t);
      if (hard) clearTimeout(hard);
      signal.removeEventListener("abort", onAbort);
      // Whatever it started goes with it.
      kill("SIGKILL");
      resolve({ code, out, err, timedOut });
    };
    child.once("error", (e) => { err += errMessage(e); done(null); });
    child.once("exit", (code) => done(code));
  });
}

/** npm's environment: the node that runs it first on PATH, so whatever npm starts uses it too. */
const npmEnv = (layout: Layout, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env, PATH: [path.dirname(layout.node), env.PATH ?? ""].filter(Boolean).join(path.delimiter), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false",
});

const tail = (s: string, n = 300): string => { const t = s.trim().replace(/\s+/g, " "); return t.length > n ? `…${t.slice(-n)}` : t; };

export interface Blocked { reason: string; detail: string; command: string }

/**
 * Whether an upgrade to `target` can be done here, asked while the connector is still connected (nothing changes): npm is
 * there, the prefix may be written, and the registry has that version.
 */
export async function preflight(layout: Layout, target: string, env: NodeJS.ProcessEnv, timing: UpgradeTiming, signal: AbortSignal): Promise<Blocked | null> {
  if (!layout.npm) return { reason: "npm_missing", detail: `there is no npm beside ${layout.node} nor on PATH`, command: manualCommand(layout, target) };
  const no = await unwritable(layout);
  if (no) return { reason: "prefix_not_writable", detail: `${no.dir} cannot be written by this user (${no.code})`, command: manualCommand(layout, target, await othersDir(no.dir)) };
  const r = await run([...layout.npm, "view", `${CONNECTOR_PACKAGE}@${target}`, "version"], npmEnv(layout, env), Math.min(timing.npmMs, 120_000), signal);
  if (signal.aborted) return { reason: "stopped", detail: "the connector is stopping", command: manualCommand(layout, target) };
  if (r.code !== 0 || r.out.trim().split(/\s+/).pop() !== target) {
    return { reason: "registry_unavailable", detail: `npm view ${CONNECTOR_PACKAGE}@${target} ${r.timedOut ? "did not answer" : `failed (exit ${r.code}): ${tail(r.err || r.out)}`}`, command: manualCommand(layout, target) };
  }
  return null;
}

// --- the upgrade itself -------------------------------------------------------------------------------------

export interface PerformOptions {
  layout: Layout;
  from: string;
  to: string;
  dirs: Dirs;
  env: NodeJS.ProcessEnv;
  log: Logger;
  timing: UpgradeTiming;
  /** A stop from outside (`claw-connector stop`, a signal): the upgrade ends where it is, the old version back in place. */
  signal: AbortSignal;
}

export type PerformResult = { outcome: Outcome; detail: string } | { outcome: "stopped"; detail: string };

const backupName = (version: string) => `.connector-backup-${version}`;
const LOCK = ".connector-upgrade.lock";
/** A lock older than this was left by an upgrade that died. */
const LOCK_STALE_MS = 30 * 60_000;

/** One upgrade at a time per prefix (two connector homes may share one install): a directory made atomically. */
function takeLock(scope: string): (() => void) | null {
  const dir = path.join(scope, LOCK);
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "owner"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
      let stale = false;
      try {
        const o: unknown = JSON.parse(fs.readFileSync(path.join(dir, "owner"), "utf8"));
        const pid = isObject(o) && typeof o.pid === "number" ? o.pid : 0;
        const at = isObject(o) && typeof o.at === "string" ? Date.parse(o.at) : 0;
        let alive = pid > 0;
        try { if (alive) process.kill(pid, 0); } catch { alive = false; }
        stale = !alive || !(Date.now() - at < LOCK_STALE_MS);
      } catch { stale = (Date.now() - (fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0)) > LOCK_STALE_MS; }
      if (!stale) return null;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return null;
}

/** Put the copy back where the package was (the new version, or what is left of it, goes). */
function restore(pkgDir: string, backup: string): void {
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.cpSync(backup, pkgDir, { recursive: true, verbatimSymlinks: true });
}

/** One trial run of the installed version: did it connect to Claw, as that version, within `trialMs`? */
async function trial(o: PerformOptions): Promise<{ ok: true } | { ok: false; why: string }> {
  const env = { ...o.env, [TRIAL_ENV]: o.to, UV_THREADPOOL_SIZE: o.env.UV_THREADPOOL_SIZE ?? "16" };
  let seen = false;
  let buf = "";
  const r = await run([o.layout.node, o.layout.cli, "run", "--supervised"], env, o.timing.trialMs, o.signal, (c) => {
    buf = (buf + c).slice(-4096);
    if (buf.includes(`${TRIAL_OK_LINE} ${o.to}`)) seen = true;
  });
  for (const l of r.err.trim().split("\n").slice(-5)) if (l) o.log.info("trial run", { line: l.slice(0, 300) });
  if (r.code === 0 && seen) return { ok: true };
  return { ok: false, why: r.timedOut ? `did not connect within ${Math.round(o.timing.trialMs / 1000)} s` : `exit ${r.code}${seen ? "" : " without connecting"}: ${tail(r.err, 200)}` };
}

/**
 * Upgrade the package from `from` to `to` (the connector itself is stopped meanwhile: the caller's run ended first). Returns
 * `upgraded` with the new version in place and proven to connect, `rolled_back` with the old one back and `to` pinned as failed,
 * `blocked` with nothing changed (npm failed: offline, a registry that refused), or `stopped` (asked to stop; the old version is
 * back unless the new one was already proven). Records the outcome (auto-upgrade.json) for the next run to report.
 */
export async function performUpgrade(o: PerformOptions): Promise<PerformResult> {
  const { layout, from, to, dirs, log } = o;
  const at = () => new Date().toISOString();
  const st = readUpgradeState(dirs);
  const scope = path.dirname(layout.pkgDir);
  const record = (outcome: Outcome, detail: string, extra: Partial<UpgradeState> = {}) => {
    const next: UpgradeState = { ...st, last: { from, to, outcome, at: at(), ...(detail ? { detail: detail.slice(0, 300) } : {}) }, ...extra };
    if (outcome !== "blocked") { delete next.next_try_at; delete next.command; }
    if (outcome === "upgraded") delete next.failed;
    writeUpgradeState(dirs, next);
  };
  const blocked = (reason: string, detail: string): PerformResult => {
    record("blocked", `${reason}: ${detail}`, { next_try_at: new Date(Date.now() + o.timing.retryMs).toISOString(), command: manualCommand(layout, to) });
    log.warn("the connector could not upgrade itself; nothing was changed", { to, reason, detail, by_hand: manualCommand(layout, to) });
    return { outcome: "blocked", detail: `${reason}: ${detail}` };
  };
  const unlock = takeLock(scope);
  if (!unlock) return blocked("busy", `another upgrade holds ${path.join(scope, LOCK)}`);
  const backup = path.join(scope, backupName(from));
  try {
    log.info("upgrading the connector", { from, to, prefix: layout.prefix });
    // The old version, kept: a copy, so the package directory itself is never missing (a supervisor may start it any time).
    const tmp = `${backup}.${process.pid}.tmp`;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(layout.pkgDir, tmp, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(backup, { recursive: true, force: true });
      fs.renameSync(tmp, backup);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return blocked("backup_failed", `cannot copy ${layout.pkgDir} aside: ${errMessage(e)}`);
    }
    const npm = await run([...layout.npm!, "install", "-g", "--prefix", layout.prefix, `${CONNECTOR_PACKAGE}@${to}`], npmEnv(layout, o.env), o.timing.npmMs, o.signal);
    const installed = (() => { try { const p: unknown = JSON.parse(fs.readFileSync(path.join(layout.pkgDir, "package.json"), "utf8")); return isObject(p) ? p.version : null; } catch { return null; } })();
    if (o.signal.aborted) {
      if (installed !== from) restore(layout.pkgDir, backup);
      return { outcome: "stopped", detail: "stopped while installing; the old version is in place" };
    }
    if (npm.code !== 0) {
      // npm puts the old directory back itself when it fails; if it did not, the copy does.
      if (installed !== from) restore(layout.pkgDir, backup);
      return blocked("npm_failed", npm.timedOut ? "npm install did not finish in time" : `npm install exited ${npm.code}: ${tail(npm.err || npm.out)}`);
    }
    const failed = (reason: string): PerformResult => {
      restore(layout.pkgDir, backup);
      record("rolled_back", reason, { failed: { version: to, at: at(), reason: reason.slice(0, 300) } });
      log.error("the new connector version did not work here; the old one is back, and this version is not tried again", { from, to, reason });
      return { outcome: "rolled_back", detail: reason };
    };
    const v = await run([layout.node, layout.cli, "--version"], o.env, 30_000, o.signal);
    if (o.signal.aborted) { restore(layout.pkgDir, backup); return { outcome: "stopped", detail: "stopped while checking the new version; the old version is in place" }; }
    if (v.code !== 0 || v.out.trim() !== to) return failed(`the installed program says ${JSON.stringify(tail(v.out || v.err, 80))}, not ${to}`);
    let why = "";
    for (let i = 1; i <= o.timing.trialAttempts; i++) {
      const t = await trial(o);
      if (o.signal.aborted) { restore(layout.pkgDir, backup); return { outcome: "stopped", detail: "stopped during the trial; the old version is in place" }; }
      if (t.ok) {
        // Older copies than this one go; this one stays until the next upgrade.
        for (const n of fs.readdirSync(scope)) if (n.startsWith(".connector-backup-") && n !== backupName(from)) fs.rmSync(path.join(scope, n), { recursive: true, force: true });
        record("upgraded", "", { setup_pending: to });
        log.info("the connector is upgraded; restarting on the new version", { from, to, backup });
        return { outcome: "upgraded", detail: "" };
      }
      why = t.why;
      log.warn("a trial run of the new connector version failed", { to, attempt: i, why });
      if (i < o.timing.trialAttempts) await sleep(o.timing.trialGapMs, o.signal);
    }
    return failed(`${o.timing.trialAttempts} trial runs failed; the last: ${why}`);
  } catch (e) {
    // Something unforeseen (a disk that refused the copy back): said, and the next run looks again.
    try { if (fs.existsSync(backup) && !isFile(path.join(layout.pkgDir, "dist", "cli.js"))) restore(layout.pkgDir, backup); } catch { /* reported below */ }
    return blocked("error", errMessage(e));
  } finally {
    unlock();
  }
}

// --- the running connector's side -------------------------------------------------------------------------

export type UpgradeStateName = "off" | "unsupervised" | "unmanaged" | "current" | "manual" | "waiting_idle" | "blocked" | "failed" | "upgrading";

export interface AutoUpgraderOptions {
  dirs: Dirs;
  env: NodeJS.ProcessEnv;
  version: string;
  /** Started by a supervisor (`run --supervised`): only then does anything start it again on the new version. */
  supervised: boolean;
  cli: string;
  node: string;
  log: Logger;
  timing?: UpgradeTiming;
  /** Tests replace them. */
  layout?: () => Promise<Layout | { unmanaged: string }>;
  preflight?: (layout: Layout, target: string, signal: AbortSignal) => Promise<Blocked | null>;
  now?: () => number;
}

/**
 * What a running connector keeps about upgrading: Claw's last recommendation (from the heartbeat's answer), and whether, now,
 * it should end the run to upgrade (`decide`). Its `report` is what every heartbeat carries.
 */
export class AutoUpgrader {
  readonly timing: UpgradeTiming;
  private rec: Recommendation | null = null;
  private state: UpgradeStateName = "current";
  private target: string | null = null;
  private blocked: Blocked | null = null;
  private idleSince: number | null = null;
  private nextAt = 0;
  private said = "";
  private enabled = true;
  /** auto-upgrade.json as last read, and the command for this machine (both kept for `report`, which never touches the disk). */
  private st: UpgradeState;
  private command: string | undefined;
  private readonly now: () => number;

  constructor(private readonly o: AutoUpgraderOptions) {
    this.timing = o.timing ?? upgradeTiming(o.env);
    this.now = o.now ?? Date.now;
    const st = readUpgradeState(o.dirs);
    this.st = st;
    const until = st.next_try_at ? Date.parse(st.next_try_at) : NaN;
    if (Number.isFinite(until)) this.nextAt = until;
    if (st.last?.outcome === "blocked" && st.command && Number.isFinite(until) && until > this.now()) {
      this.state = "blocked";
      this.target = st.last.to;
      this.blocked = { reason: (st.last.detail ?? "").split(":")[0] || "blocked", detail: st.last.detail ?? "", command: st.command };
    }
  }

  /** The heartbeat's answer: `connector_version` when this connector is older than Claw recommends, absent when it is not. */
  observe(cv: unknown): void {
    if (isObject(cv) && typeof cv.recommended_version === "string" && typeof cv.minimum_version === "string") {
      this.rec = { minimum: cv.minimum_version, recommended: cv.recommended_version };
    } else {
      this.rec = null;
    }
  }

  private layout(): Promise<Layout | { unmanaged: string }> {
    return this.o.layout ? this.o.layout() : installLayout(this.o.cli, this.o.node, this.o.env);
  }

  /** The command that does it by hand here, for a state in which the connector does not upgrade itself. */
  private async byHand(target: string): Promise<void> {
    const l = await this.layout();
    this.command = manualCommand("unmanaged" in l ? null : l, target);
  }

  private set(state: UpgradeStateName, target: string | null, note?: Record<string, unknown>): void {
    this.state = state;
    this.target = target;
    if (state !== "blocked") this.blocked = null;
    const key = `${state}|${target ?? ""}|${this.blocked?.reason ?? ""}`;
    if (key === this.said) return;
    this.said = key;
    if (state === "blocked" && this.blocked) {
      this.o.log.warn("the connector cannot upgrade itself here", { to: target, reason: this.blocked.reason, detail: this.blocked.detail, by_hand: this.blocked.command });
    } else if (state !== "current") {
      this.o.log.info("auto-upgrade", { state, ...(target ? { to: target } : {}), ...note });
    }
  }

  /**
   * Whether the run should end now to upgrade, and to which version (`idle`: nothing is going on in it at this moment).
   * Never throws. The preflight (npm, the prefix, the registry) runs only when everything else says yes.
   */
  async decide(idle: boolean, signal: AbortSignal): Promise<string | null> {
    try {
      const setting = await readAutoUpgradeSetting(this.o.dirs, this.o.env);
      this.enabled = setting.enabled;
      this.command = undefined;
      if (!setting.enabled) { this.set("off", null); return null; }
      if (!this.rec) { this.set("current", null); return null; }
      const st = await readUpgradeStateOff(this.o.dirs);
      this.st = st;
      const e = upgradeTarget(this.o.version, this.rec, st.failed?.version ?? null);
      if ("skip" in e) {
        if (e.skip === "current") this.set("current", null);
        else {
          await this.byHand(this.rec.recommended);
          if (e.skip === "failed_before") this.set("failed", this.rec.recommended);
          else this.set("manual", this.rec.recommended, { why: e.detail });
        }
        return null;
      }
      if (!this.o.supervised) { await this.byHand(e.target); this.set("unsupervised", e.target); return null; }
      const layout = await this.layout();
      if ("unmanaged" in layout) { this.command = manualCommand(null, e.target); this.set("unmanaged", e.target, { why: layout.unmanaged }); return null; }
      const now = this.now();
      if (now < this.nextAt) return null;
      if (!idle) {
        this.idleSince = null;
        this.nextAt = now + this.timing.retryMs;
        this.set("waiting_idle", e.target);
        return null;
      }
      this.idleSince ??= now;
      if (now - this.idleSince < this.timing.idleMs) { if (this.state !== "blocked") this.set("waiting_idle", e.target); return null; }
      const blocked = await (this.o.preflight ? this.o.preflight(layout, e.target, signal) : preflight(layout, e.target, this.o.env, this.timing, signal));
      if (signal.aborted) return null;
      if (blocked) {
        this.blocked = blocked;
        this.nextAt = this.now() + this.timing.retryMs;
        this.set("blocked", e.target);
        return null;
      }
      this.set("upgrading", e.target);
      return e.target;
    } catch (err) {
      this.o.log.warn("auto-upgrade check failed", { error: errMessage(err) });
      return null;
    }
  }

  /** Lost its idleness (a command came): the quiet period starts again. */
  busy(): void { this.idleSince = null; }

  /** What every agent's heartbeat descriptor carries (`capabilities.auto_upgrade`), and the health problem while it cannot upgrade. */
  report(): { caps: Record<string, unknown>; problem: Problem | null } {
    const st = this.st;
    const command = this.blocked?.command ?? this.command;
    const caps: Record<string, unknown> = {
      enabled: this.enabled, state: this.state,
      ...(this.target ? { target: this.target } : {}),
      ...(st.last ? { last: { from: st.last.from, to: st.last.to, outcome: st.last.outcome, at: st.last.at } } : {}),
      ...(st.failed ? { failed_version: st.failed.version } : {}),
      ...(this.blocked ? { reason: this.blocked.reason } : {}),
      ...(command ? { command: command.slice(0, 600) } : {}),
    };
    let problem: Problem | null = null;
    if (this.state === "blocked" && this.blocked && this.target) {
      problem = { code: "connector_upgrade_blocked", severity: "warn", detail: `the connector cannot upgrade itself to ${this.target}: ${this.blocked.detail}`, fix: this.blocked.command.length <= 200 ? this.blocked.command : "run the upgrade_command shown for this machine" };
    } else if (this.state === "failed" && this.target && st.failed) {
      problem = { code: "connector_upgrade_failed", severity: "warn", detail: `connector ${st.failed.version} did not start here (${st.failed.reason}); ${this.o.version} was put back`, fix: "see the connector's log on that machine; it upgrades again when a newer version is recommended" };
    }
    return { caps, problem };
  }
}
