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
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Ctx, ServiceHelpers } from "./commands.js";
import { isAlive, processStart } from "./children.js";
import { needsLogin, recordDisconnect, recentDisconnects } from "./health.js";
import { keepaliveFile, runLogFile, serviceFile, supervisorPidFile } from "./paths.js";
import { errMessage, isObject, sleep } from "./util.js";

export type Supervisor = "systemd" | "launchd" | "script";
export const SUPERVISORS: readonly Supervisor[] = ["systemd", "launchd", "script"];
export const UNIT = "claw-connector.service";
export const LABEL = "com.primusclaw.connector";
export const RESTART_SEC = 5;
export const NEEDS_PERSON = 78;

/**
 * Variables a unit carries over from the shell that ran `service install`. A service starts with an almost empty
 * environment, and the agents it spawns need PATH (to find claude, codex, npx) and the same config directories the
 * terminal uses. Nothing else is copied: no credential variable (CLAW_CONNECTOR_KEY, API keys) ever lands in a unit.
 */
export const CARRIED_ENV = [
  "PATH", "CLAW_CONNECTOR_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "LANG",
] as const;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

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
}

function deps(ctx: Ctx): ServiceDeps {
  const d = ctx.service ?? {};
  return {
    platform: d.platform ?? process.platform,
    home: d.home ?? os.homedir(),
    uid: d.uid ?? (process.getuid?.() ?? 0),
    user: d.user ?? (ctx.env.USER || os.userInfo().username),
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
  try { const u = new URL(v); return u.username !== "" || u.password !== ""; } catch { return /\/\/[^/]*@/.test(v); }
};

/**
 * The variables a unit sets: the carried ones that are set here, plus any `--env NAME`, never one that looks like a
 * secret. A proxy URL that carries a password is left out (`withheld`) unless named with `--env`: the unit file is
 * 0600, but a password is not written into it without being asked.
 */
export function carriedEnv(env: NodeJS.ProcessEnv, extra: string[] = []): { vars: Array<[string, string]>; refused: string[]; withheld: string[] } {
  const vars: Array<[string, string]> = [];
  const refused: string[] = [];
  const withheld: string[] = [];
  for (const name of new Set([...CARRIED_ENV, ...extra])) {
    if (!(CARRIED_ENV as readonly string[]).includes(name) && SECRET_NAME.test(name)) { refused.push(name); continue; }
    const v = env[name];
    if (v === undefined || v === "") continue;
    if (/proxy$/i.test(name) && hasUserinfo(v) && !extra.includes(name)) { withheld.push(name); continue; }
    vars.push([name, v]);
  }
  return { vars, refused, withheld };
}

/** systemd: a word in ExecStart= or a value in Environment=, double-quoted, with `%` (specifiers) and `$` (variables) kept literal. */
const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
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
${vars.map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join("\n")}
Restart=on-failure
RestartSec=${RESTART_SEC}
# 78: revoked, sign-in refused, or no usable config. Restarting cannot help; "claw-connector login" can.
RestartPreventExitStatus=${NEEDS_PERSON}
# "claw-connector stop" and "systemctl --user stop" both end it cleanly (exit 0), which is not restarted.
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(d: ServiceDeps, vars: Array<[string, string]>, log: string): string {
  const env = [...vars, ["CLAW_CONNECTOR_SUPERVISOR", "launchd"] as [string, string]];
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
/** The supervisor recorded in supervisor.pid, if that very process (same start time) still lives. */
export function supervisorPid(ctx: Ctx): number | null {
  const r = readPidRec(supervisorPidFile(ctx.dirs));
  return r && processStart(r.pid) === r.start ? r.pid : null;
}

export interface SuperviseOptions {
  restartMs?: number;
  /** The command a round runs (default: this cli.js run --supervised). */
  command?: [string, string[]];
  signal?: AbortSignal;
}

/**
 * Run `run --supervised` in the foreground, again 5 s after it ends with anything but 0 (stopped on purpose) or 78
 * (needs a person). A signal to the supervisor is passed to the run and ends the loop.
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
      child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], env: ctx.env });
      const c = child;
      const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        c.once("exit", (code, signal) => resolve({ code, signal }));
        c.once("error", (e) => { ctx.err(`supervisor: cannot start the connector: ${errMessage(e)}`); resolve({ code: 1, signal: null }); });
      });
      child = null;
      const at = new Date().toISOString();
      if (stopping) return 0;
      if (code === 0) { ctx.err(`${at} supervisor: the connector stopped on purpose (exit 0); not restarting`); return 0; }
      if (code === NEEDS_PERSON) { ctx.err(`${at} supervisor: the connector needs a new sign-in (exit 78); not restarting until: claw-connector login`); return NEEDS_PERSON; }
      const how = signal ? `killed by ${signal}` : `exit ${code}`;
      // A run killed outright never wrote why; say it here, so status shows it.
      if (signal) recordDisconnect(ctx.dirs, { reason: "process_died", detail: `the connector was ${how}; restarted by the supervisor` });
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
async function ensure(ctx: Ctx, d: ServiceDeps, h: ServiceHelpers): Promise<number> {
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
  const { vars, refused, withheld } = carriedEnv(ctx.env, extra);
  for (const r of refused) ctx.err(`--env ${r}: not carried into the service (it looks like a credential)`);
  for (const w of withheld) ctx.err(`${w}: not carried into the service because it holds a password; if the connector needs it, install again with --env ${w} (it is then written into the 0600 unit file)`);
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
    recordInstalled(ctx, "systemd");
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
    recordInstalled(ctx, "launchd");
    d.exec("launchctl", ["bootout", `gui/${d.uid}/${LABEL}`]);
    const r = d.exec("launchctl", ["bootstrap", `gui/${d.uid}`, plist]);
    if (r.code !== 0) { ctx.err(`launchctl bootstrap failed: ${r.out || `exit ${r.code}`}`); return 1; }
    ctx.out(`installed ${plist} and started it (launchctl print gui/${d.uid}/${LABEL}; log: ${runLogFile(ctx.dirs)})`);
  } else {
    const script = keepaliveFile(ctx.dirs);
    writeFile600(script, keepaliveScript(d, vars), 0o700);
    recordInstalled(ctx, "script");
    const code = await ensure(ctx, d, h);
    if (code !== 0) return code;
    ctx.out(`wrote ${script}. This machine has no systemd: the supervisor restarts the connector 5 s after it dies, but`);
    ctx.out("nothing starts the supervisor after a reboot or a container restart. Add both of these (crontab -e, or your container's startup hook):");
    ctx.out(`  @reboot sh ${script}`);
    ctx.out(`  */5 * * * * sh ${script}`);
  }
  return 0;
}

function recordInstalled(ctx: Ctx, sup: Supervisor): void {
  writeFile600(serviceFile(ctx.dirs), JSON.stringify({ supervisor: sup, installed_at: new Date().toISOString() }));
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
    if (pid !== null) {
      process.kill(pid, "SIGTERM");
      const end = Date.now() + 20_000;
      while (Date.now() < end && isAlive(pid) && processStart(pid) !== null) await sleep(100);
    }
    const script = keepaliveFile(ctx.dirs);
    const had = fs.existsSync(script);
    fs.rmSync(script, { force: true });
    ctx.out(`${pid !== null ? `stopped the supervisor (pid ${pid}) and the connector; ` : ""}${had ? `removed ${script}` : "no keep-alive script"}. Remove the @reboot and */5 lines that call it.`);
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
    running: h.runningPid(ctx),
    needs_login: needsLogin(ctx.dirs),
    recent_disconnects: recentDisconnects(ctx.dirs, 5),
  };
  if (json) { ctx.out(JSON.stringify(st, null, 2)); return 0; }
  ctx.out(`service:    ${sup ? `${sup} (${active})` : "not installed; run: claw-connector service install"}`);
  ctx.out(`connector:  ${st.running !== null ? `running (pid ${st.running})` : "not running"}`);
  if (st.needs_login) ctx.out(`problem:    needs a new sign-in: ${st.needs_login.reason}; run: claw-connector login`);
  for (const x of st.recent_disconnects) ctx.out(`down:       ${x.at} ${x.reason}${x.detail ? ` (${x.detail})` : ""}`);
  return 0;
}
