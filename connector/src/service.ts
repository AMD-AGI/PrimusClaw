// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `service install|uninstall|status`: keep `run` up without a person. It is started at login or boot, restarted
 * 5 s after it dies for any reason but one, and never restarted after exit 78 (revoked, sign-in refused, no usable
 * config), which only a new sign-in fixes. Three supervisors:
 *  - systemd: a `systemd --user` unit, `Restart=on-failure`, `RestartSec=5`, `RestartPreventExitStatus=78`.
 *  - launchd: a LaunchAgent with `KeepAlive.SuccessfulExit=false`. launchd cannot exempt one exit code, so a run
 *    it starts after a 78 sees needs-login.json and exits 0, which launchd does not restart.
 *  - script: for containers without systemd. `supervise` (this file) is a small foreground loop doing what the
 *    systemd unit does, and `keepalive.sh` starts it detached unless it is already alive; a startup hook and a
 *    5-minute cron line call that script, so a killed supervisor or a restarted container is back within minutes.
 *    `install` adds the two cron lines itself when a cron daemon runs, and says plainly when none does.
 *
 * The environment: a service starts with almost nothing, so `install` carries over what the agents read from the shell
 * that ran it. Plain settings (PATH, proxies, model gateways) go into the unit; the agents' own sign-in variables
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY...) go into `service-env.json` next to the sign-in (0600, never into a unit), which
 * every `run` reads. Without that, a connector that worked in the foreground loses its agents' sign-in as a service.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { Ctx, ServiceHelpers } from "./commands.js";
import { isAlive, processStart } from "./children.js";
import { loadCredentials, reconnectFix, reconnectStep } from "./credentials.js";
import { needsLogin, recordDisconnect, recentDisconnects } from "./health.js";
import { credentialsFile, keepaliveFile, keepaliveStampFile, runLogFile, serviceEnvFile, serviceFile, supervisorPidFile } from "./paths.js";
import { errMessage, isObject, sleep } from "./util.js";

export type Supervisor = "systemd" | "launchd" | "script";
export const SUPERVISORS: readonly Supervisor[] = ["systemd", "launchd", "script"];
export const UNIT = "claw-connector.service";
export const LABEL = "com.primusclaw.connector";
export const RESTART_SEC = 5;
export const NEEDS_PERSON = 78;

/**
 * Variables a unit carries over from the shell that ran `service install`. A service starts with an almost empty
 * environment, and the agents it spawns need PATH (to find claude, codex, npx), the same config directories the
 * terminal uses, and the settings that point them at a model: a gateway URL, a cloud provider, the npm registry.
 * No credential variable (CLAW_CONNECTOR_KEY, API keys) ever lands in a unit; the agents' own go to service-env.json.
 */
export const CARRIED_ENV = [
  "PATH", "CLAW_CONNECTOR_HOME", "CLAW_CONNECTOR_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "LANG",
  "IS_SANDBOX", "npm_config_registry", "NPM_CONFIG_REGISTRY", "npm_config_proxy", "npm_config_https_proxy",
  "AWS_REGION", "AWS_PROFILE", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS",
] as const;
/** Every non-secret setting of the agents themselves (ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, CLAUDE_CODE_USE_BEDROCK, OPENAI_BASE_URL...). */
const AGENT_SETTING = /^(?:ANTHROPIC|CLAUDE_CODE|OPENAI|CODEX|CURSOR)_/;
/**
 * What a Claude Code or Codex terminal sets for its own session (install may run inside one): never carried, or every
 * agent of the service would believe it runs inside that session (terminals.ts reads CLAUDE_CODE_ENTRYPOINT).
 */
const TERMINAL_SESSION = /^(?:CLAUDE_CODE_(?:ENTRYPOINT|SSE_PORT|SESSION|CHILD_SESSION|MESSAGING|EXECPATH|IDE|GIT_BASH)|CODEX_(?:SANDBOX|THREAD|SESSION|MANAGED|INTERNAL|CI))/;
/** Named like a credential. `_TOKENS` (CLAUDE_CODE_MAX_OUTPUT_TOKENS) is a count, not a token. */
const SECRET_NAME = /KEY|TOKEN(?!S)|SECRET|PASSWORD|CREDENTIAL/i;
/**
 * The agents' own sign-in variables. When set in the shell that runs `install`, they are kept in service-env.json
 * (0600, beside credentials.json) for the service, never in a unit. ANTHROPIC_CUSTOM_HEADERS usually carries one.
 */
export const AGENT_SECRETS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
  "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
] as const;
/** The connector's own credential: it lives in credentials.json and is never copied anywhere. */
const NEVER_CARRIED = new Set(["CLAW_CONNECTOR_KEY"]);

/**
 * libuv's thread pool size for the connector's run. File system calls and DNS lookups share that pool, four threads by
 * default. A state or Claude config directory on a network disk that stops answering holds a thread for every call made
 * to it (statefile.ts keeps that to about one per file); four of them would leave no thread for the DNS lookup of the
 * next heartbeat, and the machine would drop off Claw although its network is fine.
 *
 * The pool reads the variable once, when it starts, and Node's ES module loader has already started it (reading the
 * program's own files) before any line of the program runs. So it is set where the run is started, never by the run
 * itself: the systemd unit, the launchd plist, and the supervisor's spawn of each run. A value the user set is kept.
 */
export const THREADPOOL_SIZE = "16";
export function withThreadPool(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.UV_THREADPOOL_SIZE ? env : { ...env, UV_THREADPOOL_SIZE: THREADPOOL_SIZE };
}
const poolVars = (vars: Array<[string, string]>): Array<[string, string]> =>
  vars.some(([k]) => k === "UV_THREADPOOL_SIZE") ? vars : [...vars, ["UV_THREADPOOL_SIZE", THREADPOOL_SIZE]];

export interface ExecResult { code: number | null; out: string }

export interface ServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  user: string;
  /** systemctl, launchctl, loginctl. */
  exec: (cmd: string, args: string[]) => ExecResult;
  /** The program a unit starts: node and this package's cli.js. */
  node: string;
  cli: string;
  /** Whether systemd is this machine's init (sd_booted: /run/systemd/system exists). */
  systemdBooted: () => boolean;
  /** The user's crontab: null when there is no usable cron (no `crontab` program, or no cron daemon running). */
  readCrontab: () => string | null;
  writeCrontab: (text: string) => boolean;
}

/**
 * The account's name for loginctl, never a crash: a uid with no /etc/passwd entry (a container started with an
 * arbitrary runAsUser) makes os.userInfo() throw ENOENT, and only the systemd branch needs a name at all.
 */
export function accountName(env: NodeJS.ProcessEnv, uid: number, userInfo: () => { username: string } = os.userInfo): string {
  if (env.USER) return env.USER;
  if (env.LOGNAME) return env.LOGNAME;
  try { return userInfo().username; } catch { return String(uid); }
}

/**
 * Whether a cron daemon that reads this container's crontab is running: a container often has the `crontab` program and
 * no daemon to read it, and one that shares the host's process list (hostPID) sees the host's cron, which reads the
 * host's crontab, not this one. So a cron process counts only in this process's own mount namespace.
 */
export function cronDaemonRunning(proc = "/proc"): boolean {
  let self: string;
  let pids: string[];
  try {
    self = fs.readlinkSync(`${proc}/self/ns/mnt`);
    pids = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch { return false; }
  for (const pid of pids) {
    try {
      if (!/^(?:cron|crond|busybox)$/.test(fs.readFileSync(`${proc}/${pid}/comm`, "utf8").trim())) continue;
      if (!/cron/.test(fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8"))) continue;
      if (fs.readlinkSync(`${proc}/${pid}/ns/mnt`) === self) return true;
    } catch { /* gone, or not ours to read */ }
  }
  return false;
}

function systemCrontab(): Pick<ServiceDeps, "readCrontab" | "writeCrontab"> {
  return {
    readCrontab: () => {
      if (!cronDaemonRunning()) return null;
      const r = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      if (r.error) return null;
      // "no crontab for me" (exit 1) is an empty crontab, not a missing cron.
      return r.status === 0 ? r.stdout : /no crontab/i.test(r.stderr ?? "") ? "" : null;
    },
    writeCrontab: (text) => {
      const r = spawnSync("crontab", ["-"], { input: text, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
      return !r.error && r.status === 0;
    },
  };
}

function deps(ctx: Ctx): ServiceDeps {
  const d = ctx.service ?? {};
  const uid = d.uid ?? (process.getuid?.() ?? 0);
  const cron = d.readCrontab && d.writeCrontab ? null : systemCrontab();
  return {
    platform: d.platform ?? process.platform,
    home: d.home ?? os.homedir(),
    uid,
    user: d.user ?? accountName(ctx.env, uid),
    readCrontab: d.readCrontab ?? cron!.readCrontab,
    writeCrontab: d.writeCrontab ?? cron!.writeCrontab,
    exec: d.exec ?? ((cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      return { code: r.error ? null : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
    }),
    node: d.node ?? ctx.node ?? process.execPath,
    cli: d.cli ?? fileURLToPath(import.meta.url),
    systemdBooted: d.systemdBooted ?? (() => fs.existsSync("/run/systemd/system")),
  };
}

const systemdUnitPath = (ctx: Ctx, d: ServiceDeps) =>
  path.join(ctx.env.XDG_CONFIG_HOME?.trim() || path.join(d.home, ".config"), "systemd", "user", UNIT);
const launchdPlistPath = (d: ServiceDeps) => path.join(d.home, "Library", "LaunchAgents", `${LABEL}.plist`);

/**
 * Which supervisor this machine has: launchd on macOS, a running `systemd --user` on Linux, else the script.
 * The exit code of systemctl alone proves nothing: in a container whose PID 1 is not systemd it prints
 * "Running in chroot, ignoring command" and exits 0 for most commands, having done nothing.
 */
export function detectSupervisor(d: ServiceDeps): Supervisor {
  if (d.platform === "darwin") return "launchd";
  if (!d.systemdBooted()) return "script";
  const state = d.exec("systemctl", ["--user", "is-system-running"]).out.trim();
  return ["running", "degraded", "starting", "initializing"].includes(state) ? "systemd" : "script";
}

/** A proxy URL with a user name or password in it (`http://user:pass@host`). */
export const hasUserinfo = (v: string): boolean => {
  try { const u = new URL(v); if (u.username !== "" || u.password !== "") return true; } catch { /* not one URL */ }
  return /\/\/[^/\s]*@/.test(v);
};

/**
 * The names of the variables Codex's own config.toml reads a key from (`env_key` of a `model_providers` entry), which
 * a Codex agent needs as much as OPENAI_API_KEY. Unreadable or absent: none.
 */
export async function codexEnvKeys(env: NodeJS.ProcessEnv, home: string, timeoutMs = 5_000): Promise<string[]> {
  const dir = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  try {
    // Bounded: CODEX_HOME may sit on a network mount that stopped answering, and install must not hang on it.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); timer.unref?.(); });
    const text = await Promise.race([fs.promises.readFile(path.join(dir, "config.toml"), "utf8"), late]).finally(() => clearTimeout(timer));
    const doc = parseToml(text) as Record<string, unknown>;
    const providers = isObject(doc.model_providers) ? doc.model_providers : {};
    return Object.values(providers).flatMap((p) => (isObject(p) && typeof p.env_key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.env_key) ? [p.env_key] : []));
  } catch { return []; }
}

export interface Carried {
  /** Written into the unit (or keepalive.sh, or the LaunchAgent). */
  vars: Array<[string, string]>;
  /** The agents' sign-in variables: written into service-env.json (0600), never into a unit. */
  secrets: Array<[string, string]>;
  /** Asked for with --env and never carried (the connector's own key). */
  refused: string[];
  /** A proxy URL with a password in it, left out unless asked for with --env. */
  withheld: string[];
}

/**
 * What the service gets from this shell: the carried variables and the agents' plain settings that are set here, for
 * the unit; the agents' sign-in variables (AGENT_SECRETS, Codex's `env_key` names, anything named like a credential
 * that `--env` asks for), for service-env.json. A proxy URL that carries a password is left out (`withheld`) unless
 * named with `--env`: the unit file is 0600, but a password is not written into it without being asked.
 */
export function carriedEnv(env: NodeJS.ProcessEnv, extra: string[] = [], secretNames: readonly string[] = AGENT_SECRETS): Carried {
  const vars: Array<[string, string]> = [];
  const secrets: Array<[string, string]> = [];
  const refused: string[] = [];
  const withheld: string[] = [];
  const settings = Object.keys(env).filter((k) => AGENT_SETTING.test(k) && !TERMINAL_SESSION.test(k)).sort();
  for (const name of new Set([...CARRIED_ENV, ...settings, ...secretNames, ...extra])) {
    if (NEVER_CARRIED.has(name)) { if (extra.includes(name)) refused.push(name); continue; }
    const v = env[name];
    if (v === undefined || v === "") continue;
    const proxy = /proxy$/i.test(name);
    // A URL with a user name or password in it (`https://user:pass@gateway`) is a credential whatever the name says.
    const secret = (!(CARRIED_ENV as readonly string[]).includes(name) && (SECRET_NAME.test(name) || secretNames.includes(name))) || (!proxy && hasUserinfo(v));
    if (secret) { secrets.push([name, v]); continue; }
    // A proxy is read by the connector itself, not only by the agents, so it stays in the unit: with a password only
    // when asked for by name (`--env HTTPS_PROXY`), into a unit file that is 0600 (unchanged from before).
    if (proxy && hasUserinfo(v) && !extra.includes(name)) { withheld.push(name); continue; }
    // One line per variable in a unit or a script: a value with a line break in it cannot be written there safely.
    if (/[\r\n]/.test(v)) { withheld.push(name); continue; }
    vars.push([name, v]);
  }
  return { vars, secrets, refused, withheld };
}

/**
 * Give each agent the sign-in variables `service install` kept, where neither the connector's own environment nor the
 * agent's `[agents.env]` sets them: a service starts without the shell's ANTHROPIC_API_KEY, and an agent that signs in
 * with it would otherwise start, say it is ready, and fail at the first message. Returns the names it filled in.
 */
export function applyServiceEnv(agents: Array<{ env: Record<string, string> }>, kept: Record<string, string>, env: NodeJS.ProcessEnv): string[] {
  const used = new Set<string>();
  for (const a of agents) {
    for (const [k, v] of Object.entries(kept)) {
      if (env[k] !== undefined || Object.hasOwn(a.env, k)) continue;
      a.env = { ...a.env, [k]: v };
      used.add(k);
    }
  }
  return [...used].sort();
}

/** The agents' sign-in variables the service keeps (service-env.json), by name. Unreadable or absent: none. */
export function loadServiceEnv(file: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string" && !NEVER_CARRIED.has(e[0])));
  } catch { return {}; }
}

/**
 * systemd quoting, double-quoted with `%` (specifiers) kept literal. Only ExecStart= expands `$VAR`, so only an
 * ExecStart= word doubles `$`; an Environment= value is taken as written.
 */
const sdEnv = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
const sdQuote = (s: string) => sdEnv(s).replace(/\$/g, "$$$$");
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function systemdUnit(d: ServiceDeps, vars: Array<[string, string]>): string {
  return `# Written by "claw-connector service install"; remove with "claw-connector service uninstall".
[Unit]
Description=Claw connector (claw-connector run)
Wants=network-online.target
After=network-online.target
# Never give up: a machine that was offline for an hour must still come back by itself.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${sdQuote(d.node)} ${sdQuote(d.cli)} run --supervised
ExecStop=${sdQuote(d.node)} ${sdQuote(d.cli)} stop
${poolVars(vars).map(([k, v]) => `Environment=${sdEnv(`${k}=${v}`)}`).join("\n")}
Restart=on-failure
RestartSec=${RESTART_SEC}
# 78: revoked, sign-in refused, or no usable config. Restarting cannot help; "claw-connector login" can.
RestartPreventExitStatus=${NEEDS_PERSON}
# "claw-connector stop" and "systemctl --user stop" (through ExecStop) both end it cleanly (exit 0), which is not
# restarted. Any other SIGTERM ends a supervised run with exit 75, which is.
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(d: ServiceDeps, vars: Array<[string, string]>, log: string): string {
  const env = [...poolVars(vars), ["CLAW_CONNECTOR_SUPERVISOR", "launchd"] as [string, string]];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by "claw-connector service install"; remove with "claw-connector service uninstall". -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(d.node)}</string><string>${xml(d.cli)}</string><string>run</string><string>--supervised</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restarted after any exit but a clean one. After a revocation a restarted run sees needs-login.json and exits 0. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>${RESTART_SEC}</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function keepaliveScript(d: ServiceDeps, vars: Array<[string, string]>): string {
  return `#!/bin/sh
# Written by "claw-connector service install --supervisor script". Idempotent: starts the connector's supervisor
# unless it is already running, and does nothing after a revocation until "claw-connector login".
# Call it from the container's startup hook and every 5 minutes, for example:
#   @reboot  sh ${"$"}HOME/.../keepalive.sh        */5 * * * *  sh ${"$"}HOME/.../keepalive.sh
${vars.map(([k, v]) => `export ${k}=${sh(v)}`).join("\n")}
exec ${sh(d.node)} ${sh(d.cli)} service ensure
`;
}

// --- the supervisor loop (script mode) ---------------------------------------------------

interface PidRec { pid: number; start: string }
function readPidRec(file: string): PidRec | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isObject(raw) && typeof raw.pid === "number" && typeof raw.start === "string" && raw.start !== "") return { pid: raw.pid, start: raw.start };
  } catch { /* none */ }
  return null;
}
/** Whether `pid` is a zombie: ended, but not reaped by its parent (Linux /proc; false where that cannot be read). */
function isZombie(pid: number): boolean {
  try { return /^\d+ \(.*\) Z /s.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}

/**
 * The supervisor recorded in supervisor.pid, if that very process (same start time) still lives. A zombie does not: the
 * supervisor is detached, so in a container it is a child of PID 1, which there is often `tail -f /dev/null` or `sleep` and
 * never reaps it, and an ended supervisor would otherwise be taken for a running one for good (keepalive.sh would start none).
 */
export function supervisorPid(ctx: Ctx): number | null {
  const r = readPidRec(supervisorPidFile(ctx.dirs));
  return r && processStart(r.pid) === r.start && !isZombie(r.pid) ? r.pid : null;
}

export interface SuperviseOptions {
  restartMs?: number;
  /** The command a round runs (default: this cli.js run --supervised). */
  command?: [string, string[]];
  signal?: AbortSignal;
}

/**
 * Run `run --supervised` in the foreground, again 5 s after it ends with anything but 0 (stopped on purpose) or 78
 * (needs a person). A supervised run exits 0 only for `claw-connector stop`; a signal from anywhere else ends it with
 * 75, which is restarted. A signal to the supervisor is passed to the run and ends the loop.
 */
export async function supervise(ctx: Ctx, o: SuperviseOptions = {}): Promise<number> {
  const d = deps(ctx);
  const [cmd, args] = o.command ?? [d.node, [d.cli, "run", "--supervised"]];
  const restartMs = o.restartMs ?? RESTART_SEC * 1000;
  const pidf = supervisorPidFile(ctx.dirs);
  const other = supervisorPid(ctx);
  if (other !== null && other !== process.pid) { ctx.err(`a supervisor is already running (pid ${other})`); return 1; }
  fs.mkdirSync(ctx.dirs.state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidf, JSON.stringify({ pid: process.pid, start: processStart(process.pid) ?? "" }), { mode: 0o600 });
  let stopping = false;
  let child: ReturnType<typeof spawn> | null = null;
  const wake = new AbortController();
  const onSig = (sig: NodeJS.Signals) => { stopping = true; wake.abort(); child?.kill(sig); };
  const sigs = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const handlers = sigs.map((s) => [s, () => onSig(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  o.signal?.addEventListener("abort", () => onSig("SIGTERM"), { once: true });
  try {
    for (let round = 0; !stopping; round++) {
      child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], env: withThreadPool(ctx.env) });
      const c = child;
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        c.once("exit", (code, signal) => resolve({ code, signal }));
        c.once("error", (e) => { ctx.err(`supervisor: cannot start the connector: ${errMessage(e)}`); resolve({ code: 1, signal: null }); });
      });
      child = null;
      const at = new Date().toISOString();
      if (stopping) return 0;
      if (code === 0) { ctx.err(`${at} supervisor: the connector stopped on purpose (exit 0); not restarting`); return 0; }
      if (code === NEEDS_PERSON) { ctx.err(`${at} supervisor: the connector needs a new sign-in (exit 78); not restarting until: ${reconnectFix(credentialsFile(ctx.dirs))}`); return NEEDS_PERSON; }
      const how = signal ? `killed by ${signal}` : `exit ${code}`;
      // A run killed outright never wrote why; say it here, so status shows it.
      if (signal) await recordDisconnect(ctx.dirs, { reason: "process_died", detail: `the connector was ${how}; restarted by the supervisor` });
      ctx.err(`${at} supervisor: the connector ended (${how}); restarting in ${restartMs / 1000} s`);
      await sleep(restartMs, wake.signal);
    }
    return 0;
  } finally {
    for (const [s, h] of handlers) process.off(s, h);
    const rec = readPidRec(pidf);
    if (rec?.pid === process.pid) fs.rmSync(pidf, { force: true });
  }
}

export async function cmdSupervise(_args: string[], ctx: Ctx): Promise<number> {
  return supervise(ctx);
}

/** `service ensure` (what keepalive.sh runs): start the supervisor, detached, unless it lives or a sign-in is needed. */
async function ensure(ctx: Ctx, d: ServiceDeps, h: ServiceHelpers, o: { byInstall?: boolean } = {}): Promise<number> {
  // The stamp says that something (cron, a startup hook) calls keepalive.sh; `install` starting it once is not that.
  if (!o.byInstall) stampKeepalive(ctx);
  const sup = supervisorPid(ctx);
  if (sup !== null) { ctx.out(`supervisor running (pid ${sup})`); return 0; }
  // Not started while only a person can help (no config, no sign-in, revoked): it would exit 78 every time.
  const problem = h.preflight(ctx);
  if (problem) { ctx.err(`not starting: ${problem}`); return NEEDS_PERSON; }
  const run = h.runningPid(ctx);
  if (run !== null) {
    // A run started by hand: leave it, the next check after it ends starts the supervisor.
    ctx.out(`the connector is running (pid ${run}) without the supervisor; leaving it`);
    return 0;
  }
  fs.mkdirSync(ctx.dirs.state, { recursive: true, mode: 0o700 });
  const log = fs.openSync(runLogFile(ctx.dirs), "a", 0o600);
  try {
    // Started in the user's home, never in a directory that may later be removed (a worktree).
    const p = spawn(d.node, [d.cli, "supervise"], { detached: true, cwd: d.home, stdio: ["ignore", log, log], env: ctx.env });
    p.unref();
    ctx.out(`started the supervisor (pid ${p.pid}); log: ${runLogFile(ctx.dirs)}`);
  } finally { fs.closeSync(log); }
  return 0;
}

/** Each `ensure` leaves its time, so `doctor` can tell that something (cron, a startup hook, a CronJob) calls keepalive.sh. */
function stampKeepalive(ctx: Ctx): void {
  try {
    fs.mkdirSync(ctx.dirs.state, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keepaliveStampFile(ctx.dirs), new Date().toISOString() + "\n", { mode: 0o600 });
  } catch { /* best effort: only doctor reads it */ }
}

// --- install / uninstall / status ----------------------------------------------------

export async function cmdService(args: string[], ctx: Ctx, h: ServiceHelpers): Promise<number> {
  const [sub, ...rest] = args;
  const usage = "usage: claw-connector service install|uninstall|status [--supervisor systemd|launchd|script] [--env NAME ...]";
  if (!["install", "uninstall", "status", "ensure"].includes(sub ?? "")) { ctx.err(usage); return 2; }
  const { values } = parseArgs({ args: rest, strict: true, options: { supervisor: { type: "string" }, env: { type: "string", multiple: true }, json: { type: "boolean" } } });
  const d = deps(ctx);
  if (sub === "ensure") return ensure(ctx, d, h);
  let sup: Supervisor;
  if (values.supervisor !== undefined) {
    if (!(SUPERVISORS as readonly string[]).includes(values.supervisor)) { ctx.err(usage); return 2; }
    sup = values.supervisor as Supervisor;
  } else {
    sup = sub === "install" ? detectSupervisor(d) : installedSupervisor(ctx) ?? detectSupervisor(d);
  }
  if (sub === "install") return install(ctx, d, h, sup, values.env ?? []);
  if (sub === "uninstall") return uninstall(ctx, d, sup);
  return status(ctx, d, h, values.json === true);
}

/**
 * The supervisor `install` set up for this state directory, as it recorded in service.json. Read from the state
 * directory, never guessed from the home directory: another connector home (or a test) on the same account must
 * not act on a unit that is not its own.
 */
export function installedSupervisor(ctx: Ctx): Supervisor | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(serviceFile(ctx.dirs), "utf8"));
    if (isObject(raw) && typeof raw.supervisor === "string" && (SUPERVISORS as readonly string[]).includes(raw.supervisor)) return raw.supervisor as Supervisor;
  } catch { /* not installed */ }
  return null;
}

/**
 * After a successful `login`: a service that stopped at exit 78 (systemd does not restart it, launchd saw a clean
 * exit, the script supervisor ended) is started again, so signing in is the whole fix.
 */
export function startAfterLogin(ctx: Ctx, h: ServiceHelpers): void {
  const sup = installedSupervisor(ctx);
  if (!sup) return;
  const d = deps(ctx);
  if (h.runningPid(ctx) !== null) return;
  let r: ExecResult;
  if (sup === "systemd") r = d.exec("systemctl", ["--user", "restart", UNIT]);
  else if (sup === "launchd") r = d.exec("launchctl", ["kickstart", "-k", `gui/${d.uid}/${LABEL}`]);
  else { void ensure(ctx, d, h); return; }
  ctx.out(r.code === 0 ? `started the ${sup} service again` : `could not start the ${sup} service (${r.out || `exit ${r.code}`}); run: claw-connector service install`);
}

export class UnsafeDirError extends Error {}

/**
 * Write a file that holds secrets: only into a directory this account owns, closed to its group and others first (made
 * under umask 0002 it is 0775), through a new temporary file created exclusively. On Linux every step after the check
 * goes through the directory as it was opened (`/proc/self/fd/N/...`, the opened inode), so a directory renamed or
 * swapped for a link in the meantime cannot redirect the chmod or the write.
 */
export function writeSecretFile(file: string, body: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let dfd: number;
  try {
    dfd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    throw new UnsafeDirError(`${dir} cannot be opened as a directory of its own (${(e as NodeJS.ErrnoException).code ?? errMessage(e)}; a link is not followed): the agents' sign-in variables are not written there (set CLAW_CONNECTOR_CONFIG_DIR to a directory of your own)`);
  }
  try {
    const st = fs.fstatSync(dfd);
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
      throw new UnsafeDirError(`${dir} is ${!st.isDirectory() ? "not a directory" : "owned by another account"}: the agents' sign-in variables are not written there (set CLAW_CONNECTOR_CONFIG_DIR to a directory of your own)`);
    }
    // It is about to hold secrets, and only this account uses it.
    if ((st.mode & 0o077) !== 0) fs.fchmodSync(dfd, 0o700);
    let anchored: string;
    if (fs.existsSync(`/proc/self/fd/${dfd}`)) anchored = `/proc/self/fd/${dfd}`;
    else {
      // No descriptor-relative path here (macOS): a path is used again, so it must be one nobody else can change. Its
      // canonical form (no links left in it) must name the very directory that was checked, and every directory on
      // the way to it must be this account's or root's and closed to others (or sticky). Otherwise nothing is written.
      const real = fs.realpathSync(dir);
      const rs = fs.statSync(real);
      if (rs.dev !== st.dev || rs.ino !== st.ino) throw new UnsafeDirError(`${dir} changed while it was being checked; the agents' sign-in variables are not written there`);
      const weak = renamableAncestor(real);
      if (weak) throw new UnsafeDirError(`${weak} can be changed by other accounts, so ${dir} could be swapped while the agents' sign-in variables are written; they are not written there (set CLAW_CONNECTOR_CONFIG_DIR to a directory of your own)`);
      anchored = real;
    }
    const tmp = path.join(anchored, `${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, body); fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, path.join(anchored, path.basename(file)));
  } finally { fs.closeSync(dfd); }
}

/**
 * The first directory on the way to `dir` (its parent and up, `dir` being a canonical path) in which another account
 * could rename or replace an entry: a link, one that is not this account's or root's, or one its group or others may
 * write without the sticky bit. Null when there is none.
 */
export function renamableAncestor(dir: string, uid: number | undefined = process.getuid?.()): string | null {
  for (let p = path.dirname(path.resolve(dir)); ; p = path.dirname(p)) {
    let st: fs.Stats;
    // lstat: a link on the way is itself something that could point elsewhere; only plain directories pass.
    try { st = fs.lstatSync(p); } catch { return p; }
    if (!st.isDirectory()) return p;
    const owner = st.uid === 0 || uid === undefined || st.uid === uid;
    const sticky = (st.mode & 0o1000) !== 0;
    if (!owner || ((st.mode & 0o022) !== 0 && !sticky)) return p;
    if (p === path.dirname(p)) return null;
  }
}

function writeFile600(file: string, body: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode });
  fs.renameSync(tmp, file);
}

async function install(ctx: Ctx, d: ServiceDeps, h: ServiceHelpers, sup: Supervisor, extra: string[]): Promise<number> {
  const problem = h.preflight(ctx);
  if (problem) { ctx.err(`cannot install the service yet: ${problem}`); return NEEDS_PERSON; }
  if (!fs.existsSync(d.cli)) { ctx.err(`${d.cli} does not exist (a source checkout needs "npm run build" first)`); return 1; }
  const { vars, secrets, refused, withheld } = carriedEnv(ctx.env, extra, [...AGENT_SECRETS, ...await codexEnvKeys(ctx.env, d.home)]);
  for (const r of refused) ctx.err(`--env ${r}: not carried into the service (it is the connector's own key, kept in credentials.json)`);
  for (const w of withheld) {
    ctx.err(/[\r\n]/.test(ctx.env[w] ?? "")
      ? `${w}: not carried into the service because its value spans several lines`
      : `${w}: not carried into the service because it holds a password; if the connector needs it, install again with --env ${w} (it is then written into the 0600 unit file)`);
  }
  try { saveServiceEnv(ctx, secrets); } catch (e) {
    if (!(e instanceof UnsafeDirError)) throw e;
    ctx.err(`cannot install the service: ${e.message}`);
    return 1;
  }
  // The service must be the one run: one started by hand would make every start of the service fail "already running".
  const manual = h.runningPid(ctx);
  if (manual !== null && supervisorPid(ctx) === null) {
    await h.stop(ctx);
    ctx.out(`stopped the connector that was running by hand (pid ${manual}) so the service takes over`);
  }
  ctx.out(`carrying into the service: ${vars.map(([k]) => k).join(", ") || "nothing"}`);
  if (sup === "systemd") {
    const unit = systemdUnitPath(ctx, d);
    writeFile600(unit, systemdUnit(d, vars));
    // Recorded before the first start, which may already end in 78: `login` must still find the unit to restart.
    recordInstalled(ctx, "systemd", vars);
    if (!d.systemdBooted()) { ctx.err("systemd is not this machine's init (no /run/systemd/system): use --supervisor script"); return 1; }
    for (const a of [["--user", "daemon-reload"], ["--user", "enable", UNIT], ["--user", "restart", UNIT]]) {
      const r = d.exec("systemctl", a);
      if (r.code !== 0) { ctx.err(`systemctl ${a.join(" ")} failed: ${r.out || `exit ${r.code}`}`); return 1; }
    }
    // Believe the unit is up only when systemd says so.
    const st = d.exec("systemctl", ["--user", "is-active", UNIT]).out.trim();
    if (st !== "active" && st !== "activating") { ctx.err(`the unit did not start (is-active: ${st || "nothing"}); see: journalctl --user -u ${UNIT}`); return 1; }
    ctx.out(`installed ${unit} and started it (systemctl --user status ${UNIT}; logs: journalctl --user -u ${UNIT})`);
    const linger = d.exec("loginctl", ["show-user", d.user, "-p", "Linger", "--value"]);
    if (linger.out.trim() !== "yes") ctx.out(`to keep it running when you are not logged in and start it at boot, run once: loginctl enable-linger ${d.user}`);
  } else if (sup === "launchd") {
    const plist = launchdPlistPath(d);
    // 0600: the proxy URLs it carries may hold a password. launchd reads a LaunchAgent as its owner.
    writeFile600(plist, launchdPlist(d, vars, runLogFile(ctx.dirs)));
    recordInstalled(ctx, "launchd", vars);
    d.exec("launchctl", ["bootout", `gui/${d.uid}/${LABEL}`]);
    const r = d.exec("launchctl", ["bootstrap", `gui/${d.uid}`, plist]);
    if (r.code !== 0) { ctx.err(`launchctl bootstrap failed: ${r.out || `exit ${r.code}`}`); return 1; }
    ctx.out(`installed ${plist} and started it (launchctl print gui/${d.uid}/${LABEL}; log: ${runLogFile(ctx.dirs)})`);
  } else {
    const script = keepaliveFile(ctx.dirs);
    writeFile600(script, keepaliveScript(d, vars), 0o700);
    recordInstalled(ctx, "script", vars);
    // As `systemctl --user restart` does above: a supervisor that is already running keeps the agents.toml and the
    // environment it was started with, so after an edit of either (a root added, a key renewed) an install that left it
    // be would change nothing. It is stopped (it passes the signal to its run) and started again.
    const old = supervisorPid(ctx);
    if (old !== null) {
      if (!await stopSupervisor(ctx, old)) {
        ctx.err(`the running supervisor (pid ${old}) did not stop within 20 s; run "claw-connector stop", then install again`);
        return 1;
      }
      ctx.out(`stopped the running supervisor (pid ${old}) so the connector starts again with this agents.toml and environment`);
    }
    const code = await ensure(ctx, d, h, { byInstall: true });
    if (code !== 0) return code;
    ctx.out(`wrote ${script}. This machine has no systemd: the supervisor restarts the connector 5 s after it dies.`);
    scheduleKeepalive(ctx, d, script);
  }
  return 0;
}

/**
 * SIGTERM to a script supervisor (it passes the signal to its run, ends its loop and removes its pid file); whether it ended
 * within 20 s. Ended is: its pid file no longer names it, or the process is gone or a zombie (see `supervisorPid`; kill(pid, 0)
 * still succeeds on a zombie).
 */
async function stopSupervisor(ctx: Ctx, pid: number): Promise<boolean> {
  const running = () => supervisorPid(ctx) === pid && isAlive(pid);
  try { process.kill(pid, "SIGTERM"); } catch { return true; }   // (gone already)
  const end = Date.now() + 20_000;
  while (Date.now() < end && running()) await sleep(100);
  return !running();
}

/** The two crontab lines that call keepalive.sh: at boot, and every 5 minutes (it does nothing while the supervisor lives). */
export const cronLines = (script: string): string[] => [`@reboot sh ${sh(script)} >/dev/null 2>&1`, `*/5 * * * * sh ${sh(script)} >/dev/null 2>&1`];

/**
 * Something must call keepalive.sh after a reboot or a container restart. Where a cron daemon runs, the two lines are
 * added to the user's crontab (once; `uninstall` takes them out). Where none runs, which is the usual container, that
 * is said plainly, with the one line a startup hook (or ~/.bashrc) needs: otherwise the connector is silently offline
 * after the next restart.
 */
function scheduleKeepalive(ctx: Ctx, d: ServiceDeps, script: string): void {
  const tab = d.readCrontab();
  const want = cronLines(script);
  if (tab !== null) {
    // The user's lines as they were (blank ones too), without ours; ours go at the end.
    const lines = tab.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const kept = lines.filter((l) => !want.includes(l.trim()));
    if (d.writeCrontab([...kept, ...want].join("\n") + "\n")) {
      ctx.out(`added to your crontab, so it comes back after a reboot and within 5 minutes of the supervisor dying:`);
      for (const l of want) ctx.out(`  ${l}`);
      return;
    }
    ctx.err("could not write your crontab (crontab - failed): until these lines are in it, NOTHING starts the connector again after a reboot. Add them by hand (crontab -e):");
    for (const l of want) ctx.err(`  ${l}`);
  } else {
    ctx.out("No cron daemon runs here: after a reboot or a container restart NOTHING starts the connector again.");
    ctx.out("Run this from the container's startup command (it does nothing while the connector is up; ~/.bashrc works too, then it");
    ctx.out("comes back when you next open a shell):");
    ctx.out(`  sh ${sh(script)} >/dev/null 2>&1`);
  }
  const where = ephemeralWhere(ctx.dirs.config, readMounts(), signedInByPairing(ctx));
  if (where) ctx.out(`Note: ${where}`);
}

/** Lines of the user's crontab without the ones that call this keep-alive script; null when there is no cron. */
function withoutOurCron(d: ServiceDeps, script: string): { tab: string; removed: number } | null {
  const tab = d.readCrontab();
  if (tab === null) return null;
  // Only the exact lines `install` wrote: a line of the user's own that mentions the script is theirs.
  const ours = cronLines(script);
  const lines = tab.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((l) => !ours.includes(l.trim()));
  return { tab: kept.length ? kept.join("\n") + "\n" : "", removed: lines.length - kept.length };
}

// --- where the configuration lives ------------------------------------------------------

/** File systems a container throws away with itself. */
const EPHEMERAL_FS = new Set(["overlay", "overlayfs", "aufs", "tmpfs"]);
/** Network file systems a pod usually mounts from storage that outlives it. */
const PERSISTENT_FS = /^(?:ceph|nfs|nfs4|lustre|wekafs|gpfs|beegfs|cifs|smb3|fuse\.(?:ceph|juicefs|s3fs|gcsfuse|sshfs|rclone))$/;

interface Mount { point: string; fstype: string }

export function readMounts(text?: string): Mount[] {
  let raw = text;
  if (raw === undefined) { try { raw = fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { return []; } }
  const out: Mount[] = [];
  for (const line of raw.split("\n")) {
    // "36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw": the mount point is field 5, the type follows " - ".
    const dash = line.indexOf(" - ");
    if (dash < 0) continue;
    const fields = line.slice(0, dash).split(" ");
    const point = fields[4]?.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
    const fstype = line.slice(dash + 3).split(" ")[0];
    if (point && fstype) out.push({ point, fstype });
  }
  return out;
}

/** The mount a path lives on: the longest mount point that is a prefix of it. */
function mountOf(p: string, mounts: Mount[]): Mount | null {
  let best: Mount | null = null;
  for (const m of mounts) {
    const inside = p === m.point || p.startsWith(m.point.endsWith("/") ? m.point : `${m.point}/`);
    if (inside && (!best || m.point.length >= best.point.length)) best = m;
  }
  return best;
}

/**
 * When the connector's configuration (agents.toml and the sign-in) is on a file system the container throws away
 * (overlay, tmpfs), the sentence that says so and where to keep it instead; null when it is not (or cannot be told).
 * A dev pod's home directory is often such a place: everything in it is gone when the pod is recreated.
 */
export function ephemeralWhere(configDir: string, mounts: Mount[] = readMounts(), paired = false): string | null {
  // Only /proc/self/mountinfo is read: a look at a network mount (a stalled one) could hang init or install. The path
  // is taken as written; a configuration reached through a link onto another disk is rare and only misses this note.
  const m = mountOf(path.resolve(configDir), mounts);
  if (!m || !EPHEMERAL_FS.has(m.fstype)) return null;
  const persistent = [...new Set(mounts.filter((x) => PERSISTENT_FS.test(x.fstype) && !x.point.startsWith("/proc") && !x.point.startsWith("/sys")).map((x) => x.point))].slice(0, 3);
  return `agents.toml and the sign-in are in ${configDir}, on the container's own file system (${m.fstype}), which is lost when the container is recreated. `
    + `Keep them on storage that outlives it: export CLAW_CONNECTOR_CONFIG_DIR=<a directory of yours on ${persistent.length ? persistent.join(" or ") : "a persistent volume"}>/claw-connector `
    + `in your shell profile and the container's startup command, then `
    + (paired
      // A paired machine never ran init or login: what connects it again is a new pairing command from the chat.
      ? `ask Clawy for a new pairing command ("连接我的开发环境") and run it in that shell (the state directory, with its pid and lock files, stays where it is).`
      : `run init and login again (the state directory, with its pid and lock files, stays where it is).`);
}

/** Whether this machine's sign-in came from `pair` (a connector grant): it never ran init or login. */
function signedInByPairing(ctx: Ctx): boolean {
  try { return loadCredentials(credentialsFile(ctx.dirs))?.kind === "grant"; } catch { return false; }
}

// --- service-env.json ---------------------------------------------------------------------

/**
 * The agents' sign-in variables the service needs, kept in service-env.json (0600) beside credentials.json. Merged
 * with what an earlier install kept: installing again from a shell without the variable does not take it away.
 */
function saveServiceEnv(ctx: Ctx, secrets: Array<[string, string]>): void {
  const file = serviceEnvFile(ctx.dirs);
  const before = loadServiceEnv(file);
  const merged = { ...before, ...Object.fromEntries(secrets) };
  const names = Object.keys(merged).sort();
  if (names.length === 0) return;
  writeSecretFile(file, JSON.stringify(merged, null, 2) + "\n");
  const fresh = secrets.map(([k]) => k);
  const kept = names.filter((n) => !fresh.includes(n));
  ctx.out(`the agents' sign-in for the service (in ${file}, mode 0600, never in a unit): ${[...fresh, ...kept.map((k) => `${k} (kept from before)`)].join(", ")}`);
}

/** `path`: the PATH the service starts the connector with (absent: none carried), which `doctor` checks the agents against. */
function recordInstalled(ctx: Ctx, sup: Supervisor, vars: Array<[string, string]>): void {
  const p = vars.find(([k]) => k === "PATH")?.[1];
  writeFile600(serviceFile(ctx.dirs), JSON.stringify({ supervisor: sup, installed_at: new Date().toISOString(), ...(p !== undefined ? { path: p } : {}) }));
}

async function uninstall(ctx: Ctx, d: ServiceDeps, sup: Supervisor): Promise<number> {
  fs.rmSync(serviceFile(ctx.dirs), { force: true });
  if (sup === "systemd") {
    const unit = systemdUnitPath(ctx, d);
    d.exec("systemctl", ["--user", "disable", "--now", UNIT]);
    const had = fs.existsSync(unit);
    fs.rmSync(unit, { force: true });
    d.exec("systemctl", ["--user", "daemon-reload"]);
    ctx.out(had ? `stopped and removed ${unit}` : `no unit at ${unit}`);
  } else if (sup === "launchd") {
    const plist = launchdPlistPath(d);
    d.exec("launchctl", ["bootout", `gui/${d.uid}/${LABEL}`]);
    const had = fs.existsSync(plist);
    fs.rmSync(plist, { force: true });
    ctx.out(had ? `stopped and removed ${plist}` : `no LaunchAgent at ${plist}`);
  } else {
    const pid = supervisorPid(ctx);
    if (pid !== null) await stopSupervisor(ctx, pid);
    const script = keepaliveFile(ctx.dirs);
    const had = fs.existsSync(script);
    fs.rmSync(script, { force: true });
    const cron = withoutOurCron(d, script);
    const cronGone = cron !== null && cron.removed > 0 && d.writeCrontab(cron.tab);
    ctx.out(`${pid !== null ? `stopped the supervisor (pid ${pid}) and the connector; ` : ""}${had ? `removed ${script}` : "no keep-alive script"}${cronGone ? " and its crontab lines" : ". Remove any startup-hook or cron line that calls it."}`);
  }
  if (fs.existsSync(serviceEnvFile(ctx.dirs))) {
    fs.rmSync(serviceEnvFile(ctx.dirs), { force: true });
    ctx.out(`removed ${serviceEnvFile(ctx.dirs)} (the agents' sign-in variables kept for the service)`);
  }
  return 0;
}

function status(ctx: Ctx, d: ServiceDeps, h: ServiceHelpers, json: boolean): number {
  const sup = installedSupervisor(ctx);
  let active: string | null = null;
  if (sup === "systemd") active = d.exec("systemctl", ["--user", "is-active", UNIT]).out.trim() || null;
  else if (sup === "launchd") active = d.exec("launchctl", ["print", `gui/${d.uid}/${LABEL}`]).code === 0 ? "loaded" : "not loaded";
  else if (sup === "script") { const p = supervisorPid(ctx); active = p !== null ? `supervisor pid ${p}` : "supervisor not running"; }
  const st = {
    installed: sup,
    active,
    /** The names (never the values) of the agents' sign-in variables the service keeps. */
    agent_env: Object.keys(loadServiceEnv(serviceEnvFile(ctx.dirs))).sort(),
    running: h.runningPid(ctx),
    needs_login: needsLogin(ctx.dirs),
    recent_disconnects: recentDisconnects(ctx.dirs, 5),
  };
  if (json) { ctx.out(JSON.stringify(st, null, 2)); return 0; }
  ctx.out(`service:    ${sup ? `${sup} (${active})` : "not installed; run: claw-connector service install"}`);
  ctx.out(`connector:  ${st.running !== null ? `running (pid ${st.running})` : "not running"}`);
  if (st.agent_env.length) ctx.out(`agent env:  ${st.agent_env.join(", ")} (from ${serviceEnvFile(ctx.dirs)})`);
  if (st.needs_login) ctx.out(`problem:    needs a new sign-in: ${st.needs_login.reason}; ${reconnectStep(credentialsFile(ctx.dirs))}`);
  for (const x of st.recent_disconnects) ctx.out(`down:       ${x.at} ${x.reason}${x.detail ? ` (${x.detail})` : ""}`);
  return 0;
}
