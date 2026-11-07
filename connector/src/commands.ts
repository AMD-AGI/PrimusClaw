// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The subcommands. Each takes its inputs explicitly (directories, environment, output, fetch) so a test can run it against a temporary home. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fileAudit } from "./audit.js";
import { ChildRegistry, isAlive, processStart } from "./children.js";
import { ClawClient, HttpError, RevokedError, TransportError } from "./claw-client.js";
import { ConfigError, SAMPLE_AGENTS, loadConfig, sampleApprovals, sampleConfig, type Approval, type ConnectorConfig } from "./config.js";
import {
  CredentialsError, DEFAULT_CLIENT_ID, GrantRevokedError, loadCredentials, providerFor, saveCredentials, type Credentials,
} from "./credentials.js";
import { DeviceFlowError, deviceLogin } from "./deviceflow.js";
import { applyRootSandbox, bypassUnavailableWarnings } from "./claude-mode.js";
import { HooksError, hooksStatus, installHooks, settingsFile, uninstallHooks } from "./hooks.js";
import { Connector, isAuthRefusal, type ConnectorTiming } from "./connector.js";
import { clearNeedsLogin, markNeedsLogin, needsLogin, recentDisconnects } from "./health.js";
import { cmdService, cmdSupervise, startAfterLogin, type ServiceDeps } from "./service.js";
import { cmdPair } from "./pair.js";
import {
  auditFile, childrenFile, configFile, credentialsFile, identityFile, logDir, pauseFile, pidFile, stopRequestFile, type Dirs,
} from "./paths.js";
import { UrlError, errMessage, isObject, secureUrl, sleep, stderrLogger } from "./util.js";
import { VERSION } from "./version.js";
import { probeAgents, probeLines, type ProbeFn } from "./probe.js";

export interface Ctx {
  dirs: Dirs;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  hostname?: string;
  timing?: Partial<ConnectorTiming>;
  /** The working directory `pair` gives agents when it writes agents.toml (default: the process's). */
  cwd?: string;
  /** Called with the connector once it exists, so a signal handler can stop it. */
  onConnector?: (c: Connector) => void;
  /** The file the terminal hooks run (default: `terminal-hook.js` next to this program) and the node that runs it. */
  hookScript?: string;
  node?: string;
  /** Claude Code's managed settings file and the effective uid, as the Claude adapter sees them (tests set them). */
  claudeManagedSettings?: string;
  euid?: number | null;
  /**
   * How `doctor` starts each agent's adapter and asks it for a session (default: the real adapters). `init` probes only
   * when this is set, which the command line does, so a test of `init` does not start the sample agents' adapters.
   */
  probe?: ProbeFn;
  /** How `service` runs systemctl/launchctl, which program a unit starts, and where the units go (tests set them). */
  service?: Partial<ServiceDeps>;
}

/**
 * `needsPerson` (78, EX_CONFIG) means "starting again will not help": the connector was revoked, Claw or the identity
 * service refused the sign-in, or there is no usable config or sign-in. A supervisor (the units `service install`
 * writes) restarts on any other failure and never on this one. `revoked` is the same code, kept as its own name.
 */
/**
 * `terminated`: a supervised run ended by a signal that did not come from `stop` (a bare `kill`, the OOM killer's
 * SIGTERM, a container runtime). It is not a stop on purpose, so every supervisor restarts it.
 */
export const EXIT = { ok: 0, failure: 1, usage: 2, terminated: 75, needsPerson: 78, revoked: 78 } as const;

const HELP = `claw-connector ${VERSION}: connect the coding agents on this machine to Claw (outbound HTTPS only).

Usage: claw-connector <command> [options]

  init [--approval ask|never | --approval AGENT=ask|never ...] [--no-hooks] [--no-probe]
                           write a sample agents.toml, and install the Claude Code session hooks (see "hooks"; --no-hooks
                           skips that). Agents ask before every write and command by default;
                           "--approval never" (or "--approval claude=never") lets phone sessions run like your
                           terminal, with no per-step approval. Agents are: ${SAMPLE_AGENTS.join(", ")}.
  hooks install|uninstall|status [--config-dir DIR]
                           the SessionStart/SessionEnd hooks that tell this connector which Claude Code sessions are open
                           in a terminal; merged into DIR/settings.json (default: the claude-attach agents' config
                           directories, else $CLAUDE_CONFIG_DIR or ~/.claude); only its own entries are ever changed
  pair CODE --server URL   connect this machine with the one-time code your chat gave you ("连接我的开发环境"): writes
                           agents.toml if there is none (the agents found here, working in this folder), saves the
                           sign-in and starts the service. [--name HOST] [--no-start]
  login                    sign in (device flow); --server URL --identity-url URL [--name HOST]
                           development only: --key <api key>  (or CLAW_CONNECTOR_KEY)
  run                      connect and serve (Ctrl-C or SIGTERM stops it and every agent it started). Exit code 78:
                           revoked, sign-in refused, or no usable config; starting it again will not help
  service install|uninstall|status [--supervisor systemd|launchd|script] [--env NAME ...]
                           keep "run" up: started at login/boot, restarted 5 s after it dies, never restarted
                           after exit 78. systemd --user on Linux, launchd on macOS; "script" (containers without
                           systemd) writes a keep-alive script for a startup hook and a 5-minute cron line
  status [--json]          what is running, signed in, paused, the last disconnect and why
  doctor [--agent ID] [--json]
                           start each agent's adapter, open a session (no prompt) and check that it offers the
                           modes agents.toml needs, so a phone session is not refused; init runs it too
  pause                    stop every agent now and stay offline until "resume"
  resume                   undo "pause"
  stop                     stop the running connector and every agent it started
  logout                   stop, revoke this connector at Claw and the sign-in, and delete the sign-in
  --version, --help

Files: ${"$"}XDG_CONFIG_HOME/claw-connector (agents.toml, credentials.json) and ${"$"}XDG_STATE_HOME/claw-connector
(audit.jsonl, logs, outbox); set CLAW_CONNECTOR_HOME to keep everything under one directory.
`;

/** The configuration as the agents will run it: with IS_SANDBOX set for unattended Claude agents under root (claude-mode.ts). */
function loadCfg(ctx: Ctx, notes: string[] = []): ConnectorConfig {
  const cfg = loadConfig(configFile(ctx.dirs), { hostname: ctx.hostname ?? os.hostname() });
  notes.push(...applyRootSandbox(cfg.agents, ctx.env, { euid: ctx.euid }));
  return cfg;
}

/** Agents whose sessions the connector will close: Claude will not offer the mode an unattended agent runs in. */
const noAsk = (ctx: Ctx, cfg: ConnectorConfig): string[] =>
  bypassUnavailableWarnings(cfg.agents, ctx.env, { managedFile: ctx.claudeManagedSettings, euid: ctx.euid });

function serverUrl(ctx: Ctx, flag: string | undefined, cfg: ConnectorConfig | null, creds: Credentials | null): string | null {
  const v = flag ?? ctx.env.CLAW_URL ?? cfg?.server ?? creds?.server ?? null;
  return v ? secureUrl(v.trim(), "the Claw server URL") : null;
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined: case "help": case "--help": case "-h": ctx.out(HELP); return cmd ? EXIT.ok : EXIT.usage;
      case "--version": case "-v": case "version": ctx.out(VERSION); return EXIT.ok;
      case "init": return await cmdInit(rest, ctx);
      case "hooks": return cmdHooks(rest, ctx);
      case "login": return await cmdLogin(rest, ctx);
      case "pair": return await cmdPair(rest, ctx, {
        runningPid, stop: (c) => cmdStop(c, true), start: (c) => cmdService(["install"], c, serviceHelpers),
      });
      case "run": {
        const code = await cmdRun(rest, ctx);
        // launchd cannot be told "never restart on 78"; it does not restart a clean exit. The reason was printed.
        return code === EXIT.needsPerson && ctx.env.CLAW_CONNECTOR_SUPERVISOR === "launchd" ? EXIT.ok : code;
      }
      case "service": return await cmdService(rest, ctx, serviceHelpers);
      case "supervise": return await cmdSupervise(rest, ctx);
      case "status": return cmdStatus(rest, ctx);
      case "doctor": return await cmdDoctor(rest, ctx);
      case "pause": return await cmdPause(ctx);
      case "resume": return cmdResume(ctx);
      case "stop": return await cmdStop(ctx);
      case "logout": return await cmdLogout(ctx);
      default: ctx.err(`unknown command ${JSON.stringify(cmd)}\n\n${HELP}`); return EXIT.usage;
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof CredentialsError || e instanceof DeviceFlowError || e instanceof UrlError) { ctx.err(e.message); return EXIT.failure; }
    ctx.err(`error: ${errMessage(e)}`);
    return EXIT.failure;
  }
}

// --- init ------------------------------------------------------------------------------

/** `--approval never`, `--approval ask`, or `--approval claude=never`, any number of them; a later one wins. */
function parseApproval(values: string[]): Partial<Record<string, Approval>> | string {
  const out: Partial<Record<string, Approval>> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    const who = eq < 0 ? null : v.slice(0, eq);
    const how = eq < 0 ? v : v.slice(eq + 1);
    if (how !== "ask" && how !== "never") return `--approval takes ask or never (or AGENT=ask|never), not ${JSON.stringify(v)}`;
    const targets = who === null ? [...SAMPLE_AGENTS] : [who];
    for (const t of targets) {
      if (!(SAMPLE_AGENTS as readonly string[]).includes(t)) return `--approval: no sample agent ${JSON.stringify(t)} (agents are: ${SAMPLE_AGENTS.join(", ")})`;
      out[t] = how;
    }
  }
  return out;
}

async function cmdInit(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { approval: { type: "string", multiple: true }, "no-hooks": { type: "boolean" }, "no-probe": { type: "boolean" } } });
  const approval = parseApproval(values.approval ?? []);
  if (typeof approval === "string") { ctx.err(approval); return EXIT.usage; }
  const file = configFile(ctx.dirs);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    // "wx": create it only if it is not there, in one step: no check that could be raced.
    fs.writeFileSync(file, sampleConfig(approval), { mode: 0o600, flag: "wx" });
    ctx.out(`wrote ${file}: edit the roots (the directories an agent may work in), then run: claw-connector login`);
    // Say what the file just written does, not what was asked: an agent whose block is commented out is not on.
    const { unattended, parked } = sampleApprovals(approval);
    ctx.out(unattended.length
      ? `no per-step approval for: ${unattended.join(", ")}. Those agents write files and run commands without asking; the phone shows such a session as unattended. To go back, set approval = "ask" on the agent.`
      : `every agent in this file asks before it writes a file or runs a command. To let phone sessions run like your terminal instead: claw-connector init --approval never (on a new file), or set approval = "never" on an agent.`);
    if (parked.length) ctx.out(`${parked.join(", ")}: not enabled in this file (the block is commented out), so approval = "never" does nothing there until you uncomment the block.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    ctx.out(`${file} already exists; left alone${values.approval?.length ? ` (to change an agent's approval, set approval = "ask" or "never" in its [[agents]] table)` : ""}`);
  }
  // The hooks are a convenience: a Claude Code settings file that cannot be merged into is reported, and init still succeeded.
  if (!values["no-hooks"]) {
    const dir = defaultClaudeDir(ctx);
    if (!fs.existsSync(dir)) ctx.out(`no Claude Code directory at ${dir}; once you use Claude Code, run: claw-connector hooks install`);
    else installForInit(ctx, dir);
  }
  if (ctx.probe && !values["no-probe"]) {
    try {
      const cfg = loadCfg(ctx);
      ctx.out("checking each agent's adapter (claw-connector doctor; skip with --no-probe):");
      for (const l of probeLines(await ctx.probe(cfg.agents, { logDir: logDir(ctx.dirs), version: VERSION }))) ctx.out(l);
    } catch (e) { ctx.out(`could not check the agents yet: ${errMessage(e)}; after editing agents.toml run: claw-connector doctor`); }
  }
  return EXIT.ok;
}

// --- doctor ----------------------------------------------------------------------------

async function cmdDoctor(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { agent: { type: "string" }, json: { type: "boolean" } } });
  const notes: string[] = [];
  const cfg = loadCfg(ctx, notes);
  const agents = values.agent ? cfg.agents.filter((a) => a.id === values.agent) : cfg.agents;
  if (agents.length === 0) { ctx.err(values.agent ? `no agent ${JSON.stringify(values.agent)} in agents.toml` : "agents.toml defines no agents; add an [[agents]] table"); return EXIT.failure; }
  const warnings = noAsk(ctx, { ...cfg, agents });
  const results = await (ctx.probe ?? probeAgents)(agents, { logDir: logDir(ctx.dirs), version: VERSION });
  const ok = results.every((r) => r.ok);
  if (values.json) {
    ctx.out(JSON.stringify({ version: VERSION, ok, notes, warnings, agents: results }, null, 2));
  } else {
    for (const n of notes) ctx.out(`note: ${n}`);
    for (const w of warnings) ctx.out(`warning: ${w}`);
    for (const l of probeLines(results)) ctx.out(l);
  }
  return ok ? EXIT.ok : EXIT.failure;
}

function installForInit(ctx: Ctx, dir: string): void {
  try { ctx.out(describeInstall(dir, installOne(ctx, dir).changed)); } catch (e) { ctx.err(`hooks: ${errMessage(e)} (everything else is set up; fix it and run: claw-connector hooks install)`); }
}

// --- hooks -----------------------------------------------------------------------------

const defaultClaudeDir = (ctx: Ctx): string => path.resolve(ctx.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"));

/** The Claude config directories the connector looks at: those of its claude-attach agents, else the default one. */
function claudeDirs(ctx: Ctx, flag: string | undefined): string[] {
  if (flag !== undefined) return [path.resolve(flag)];
  let dirs: string[] = [];
  try {
    dirs = loadCfg(ctx).agents.filter((a) => a.attach).map((a) => path.resolve(a.env.CLAUDE_CONFIG_DIR ?? ctx.env.CLAUDE_CONFIG_DIR?.trim() ?? path.join(os.homedir(), ".claude")));
  } catch { /* no usable agents.toml yet: the default directory */ }
  return dirs.length ? [...new Set(dirs)] : [defaultClaudeDir(ctx)];
}

function hookScript(ctx: Ctx): string {
  const script = ctx.hookScript ?? fileURLToPath(new URL("./terminal-hook.js", import.meta.url));
  if (!fs.existsSync(script)) throw new HooksError(`${script} does not exist (a source checkout needs "npm run build" first)`);
  return script;
}

function installOne(ctx: Ctx, dir: string) {
  return installHooks(dir, ctx.node ?? process.execPath, hookScript(ctx));
}

const describeInstall = (dir: string, changed: boolean): string =>
  changed ? `installed the Claude Code session hooks in ${settingsFile(dir)}` : `the Claude Code session hooks are already in ${settingsFile(dir)}`;

function cmdHooks(args: string[], ctx: Ctx): number {
  const [sub, ...rest] = args;
  if (sub !== "install" && sub !== "uninstall" && sub !== "status") { ctx.err("usage: claw-connector hooks install|uninstall|status [--config-dir DIR]"); return EXIT.usage; }
  const { values } = parseArgs({ args: rest, strict: true, options: { "config-dir": { type: "string" }, json: { type: "boolean" } } });
  const dirs = claudeDirs(ctx, values["config-dir"]);
  let code: number = EXIT.ok;
  const report: Array<Record<string, unknown>> = [];
  for (const dir of dirs) {
    try {
      if (sub === "install") {
        if (values["config-dir"] === undefined && !fs.existsSync(dir)) { ctx.err(`no Claude Code directory at ${dir}; pass --config-dir to name one`); code = EXIT.failure; continue; }
        ctx.out(describeInstall(dir, installOne(ctx, dir).changed));
      } else if (sub === "uninstall") {
        ctx.out(uninstallHooks(dir).changed ? `removed the Claude Code session hooks from ${settingsFile(dir)}` : `no session hooks of ours in ${settingsFile(dir)}`);
      } else {
        const st = hooksStatus(dir);
        report.push({ dir, ...st });
        if (!values.json) ctx.out(`${dir}: ${st.installed ? (st.healthy ? "installed" : "installed, but broken") : st.events.length ? `partly installed (${st.events.join(", ")})` : "not installed"}${st.problem ? `; ${st.problem}` : ""}`);
      }
    } catch (e) {
      ctx.err(e instanceof HooksError ? e.message : `error: ${errMessage(e)}`);
      code = EXIT.failure;
    }
  }
  if (sub === "status" && values.json) ctx.out(JSON.stringify(report, null, 2));
  return code;
}

// --- login -----------------------------------------------------------------------------

/**
 * Forget the stored connector id, but only when `run` recorded that Claw revoked that row. A revoked row stays
 * revoked for good, so keeping its id would send every later `run` back to exit 3 after a new sign-in. A row that
 * is alive is kept: every registration takes one of the few live connector rows a user may have (`logout` revokes
 * its row and forgets it), so a sign-in that registered a new row each time would use them up and then `run` would fail with
 * `connector_limit_reached`. A re-login as another account is not a problem either way: Claw answers 404 for a
 * row that is not the caller's and `run` registers anew, and an id stored for another server is never used.
 * Never called for a revocation itself: if `run` forgot its id when it was revoked, the next `run` would register
 * a fresh connector with the same still-valid sign-in and the owner's kill switch would be undone.
 */
function forgetRevokedIdentity(ctx: Ctx): void {
  const file = identityFile(ctx.dirs);
  let revoked = false;
  try { const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8")); revoked = isObject(raw) && raw.revoked === true; } catch { /* none, or unreadable: run starts over from it */ }
  if (revoked) fs.rmSync(file, { force: true });
}

async function cmdLogin(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parseArgs({
    args, strict: true,
    options: { server: { type: "string" }, "identity-url": { type: "string" }, key: { type: "string" }, name: { type: "string" } },
  });
  let cfg: ConnectorConfig | null = null;
  try { cfg = loadCfg(ctx); } catch (e) { if (!(e instanceof ConfigError)) throw e; }
  const server = serverUrl(ctx, values.server, cfg, null);
  if (!server) { ctx.err("login needs --server <Claw API URL> (or CLAW_URL, or server = in agents.toml)"); return EXIT.usage; }
  const file = credentialsFile(ctx.dirs);
  const key = values.key ?? ctx.env.CLAW_CONNECTOR_KEY;
  if (key) {
    saveCredentials(file, { v: 1, server, kind: "key", key, saved_at: new Date().toISOString() });
    forgetRevokedIdentity(ctx);
    clearNeedsLogin(ctx.dirs);
    ctx.out("saved a development key. This is for trying things out: a device sign-in is the normal way (omit --key).");
    startAfterLogin(ctx, serviceHelpers);
    return EXIT.ok;
  }
  const identityRaw = (values["identity-url"] ?? ctx.env.CLAW_IDENTITY_URL ?? cfg?.identityUrl ?? "").trim();
  const identityUrl = identityRaw ? secureUrl(identityRaw, "the identity service URL") : "";
  if (!identityUrl) { ctx.err("login needs --identity-url <identity service URL> (or CLAW_IDENTITY_URL, or identity_url = in agents.toml)"); return EXIT.usage; }
  const deviceName = values.name ?? cfg?.name ?? ctx.hostname ?? os.hostname();
  const tok = await deviceLogin({ identityUrl, deviceName, fetch: ctx.fetch, print: ctx.out });
  saveCredentials(file, {
    v: 1, server, kind: "device", identity_url: identityUrl, client_id: DEFAULT_CLIENT_ID,
    refresh_token: tok.refresh_token, device_name: deviceName, saved_at: new Date().toISOString(),
  });
  forgetRevokedIdentity(ctx);
  clearNeedsLogin(ctx.dirs);
  ctx.out(`signed in as ${deviceName}. Next: claw-connector service install (or run)`);
  startAfterLogin(ctx, serviceHelpers);
  return EXIT.ok;
}

// --- run -------------------------------------------------------------------------------

function runningPid(ctx: Ctx): number | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pidFile(ctx.dirs), "utf8"));
    if (isObject(raw) && typeof raw.pid === "number" && typeof raw.start === "string" && raw.start !== "" && processStart(raw.pid) === raw.start) return raw.pid;
  } catch { /* no pid file */ }
  return null;
}

async function cmdRun(args: string[], ctx: Ctx): Promise<number> {
  // --supervised only names a run a supervisor started (`service install`), in `ps` and the log. Every run honours
  // needs-login.json, which only `login` clears: a revoked or refused connector is not started again and again, by
  // these units or by a unit written by hand earlier for the old revoked code 3 (it now restarts on 78, and each
  // restart ends here without contacting Claw).
  const { values: runFlags } = parseArgs({ args, strict: true, options: { supervised: { type: "boolean" } } });
  {
    const nl = needsLogin(ctx.dirs);
    if (nl) {
      ctx.err(`not starting: ${nl.reason}${nl.at ? ` (${nl.at})` : ""}. Sign in again (claw-connector login); the service then starts it.`);
      return EXIT.needsPerson;
    }
  }
  let cfg: ConnectorConfig;
  let creds: Credentials | null;
  const notes: string[] = [];
  try {
    cfg = loadCfg(ctx, notes);
    creds = loadCredentials(credentialsFile(ctx.dirs));
  } catch (e) {
    if (e instanceof ConfigError || e instanceof CredentialsError) { ctx.err(e.message); return EXIT.needsPerson; }
    throw e;
  }
  if (cfg.agents.length === 0) { ctx.err("agents.toml defines no agents; add an [[agents]] table"); return EXIT.needsPerson; }
  if (!creds) { ctx.err("not signed in: run  claw-connector login"); return EXIT.needsPerson; }
  const running = runningPid(ctx);
  if (running !== null) { ctx.err(`already running (pid ${running}); use "claw-connector stop" first`); return EXIT.failure; }
  const server = serverUrl(ctx, undefined, cfg, creds)!;
  const tokens = providerFor(creds, (c) => saveCredentials(credentialsFile(ctx.dirs), c), { fetch: ctx.fetch });
  const client = new ClawClient({ server, tokens, fetch: ctx.fetch });
  const log = stderrLogger();
  const audit = fileAudit(auditFile(ctx.dirs));
  const connector = new Connector({ config: cfg, dirs: ctx.dirs, client, server, audit, log, version: VERSION, timing: ctx.timing });
  ctx.onConnector?.(connector);
  ctx.out(`connecting ${cfg.agents.map((a) => (a.unattended ? `${a.id} (no per-step approval)` : a.id)).join(", ")} to ${server} as "${cfg.name}"`);
  for (const n of notes) ctx.out(`note: ${n}`);
  for (const w of noAsk(ctx, cfg)) ctx.out(`warning: ${w}`);
  try {
    const result = await connector.run();
    if (result === "revoked") {
      markNeedsLogin(ctx.dirs, "this connector was revoked");
      ctx.err("this connector was revoked: every agent was stopped. Run login again to connect it anew.");
      return EXIT.revoked;
    }
    if (result === "auth_failed") {
      markNeedsLogin(ctx.dirs, `Claw refused the sign-in (${connector.authFailure})`);
      ctx.err(`Claw keeps refusing this sign-in (${connector.authFailure}): every agent was stopped. Run login again.`);
      return EXIT.needsPerson;
    }
    if (runFlags.supervised && !takeStopRequest(ctx)) {
      ctx.err(`${new Date().toISOString()} stopped by a signal that did not come from "claw-connector stop"; exit ${EXIT.terminated}, so the supervisor starts it again`);
      return EXIT.terminated;
    }
    return EXIT.ok;
  } catch (e) {
    // Refused at start (a deleted key, a sign-in the identity service ended): retrying cannot help.
    if (isAuthRefusal(e) || e instanceof RevokedError || e instanceof GrantRevokedError || e instanceof CredentialsError) {
      markNeedsLogin(ctx.dirs, e instanceof GrantRevokedError || e instanceof RevokedError ? e.message : `Claw refused the sign-in (${errMessage(e)})`);
      ctx.err(`error: ${errMessage(e)}. Run login again.`);
      return EXIT.needsPerson;
    }
    if (e instanceof HttpError || e instanceof TransportError) { ctx.err(`error: ${e.message}`); return EXIT.failure; }
    throw e;
  }
}

// --- status / pause / resume / stop / logout -------------------------------------------

function cmdStatus(args: string[], ctx: Ctx): number {
  const { values } = parseArgs({ args, strict: true, options: { json: { type: "boolean" } } });
  let creds: Credentials | null = null;
  let credsProblem: string | null = null;
  try { creds = loadCredentials(credentialsFile(ctx.dirs)); } catch (e) { credsProblem = errMessage(e); }
  let agents: string[] = [];
  let unattended: string[] = [];
  let configProblem: string | null = null;
  let warnings: string[] = [];
  try {
    const cfg = loadCfg(ctx);
    agents = cfg.agents.map((a) => a.id);
    unattended = cfg.agents.filter((a) => a.unattended).map((a) => a.id);
    warnings = noAsk(ctx, cfg);
  } catch (e) { configProblem = errMessage(e); }
  let connectorId: string | null = null;
  try { const raw: unknown = JSON.parse(fs.readFileSync(identityFile(ctx.dirs), "utf8")); if (isObject(raw) && typeof raw.connector_id === "string") connectorId = raw.connector_id; } catch { /* not registered yet */ }
  const reg = new ChildRegistry(childrenFile(ctx.dirs));
  const status = {
    version: VERSION,
    running: runningPid(ctx),
    paused: fs.existsSync(pauseFile(ctx.dirs)),
    signed_in: creds ? { kind: creds.kind, server: creds.server, device_name: creds.device_name ?? null } : null,
    connector_id: connectorId,
    agents,
    /** Agents whose sessions start without asking before a write or a command. */
    unattended,
    adapters: reg.list().filter((r) => reg.isOurs(r)).map((r) => ({ pid: r.pid, agent: r.agent_id, session: r.session_id })),
    problems: [credsProblem, configProblem].filter((x): x is string => !!x),
    /** Agents whose sessions will be refused as things stand (Claude's own settings start them in a mode that never asks). */
    warnings,
    /** Why the connection last went down, and whether only a new sign-in can bring it back. */
    last_disconnect: recentDisconnects(ctx.dirs, 1)[0] ?? null,
    needs_login: needsLogin(ctx.dirs),
  };
  if (values.json) { ctx.out(JSON.stringify(status, null, 2)); return EXIT.ok; }
  ctx.out(`connector:  ${status.running ? `running (pid ${status.running})` : "not running"}${status.paused ? ", PAUSED" : ""}`);
  ctx.out(`signed in:  ${creds ? `${creds.kind} to ${creds.server}` : "no"}`);
  ctx.out(`agents:     ${agents.map((a) => (unattended.includes(a) ? `${a} (no per-step approval)` : a)).join(", ") || "none configured"}`);
  ctx.out(`adapters:   ${status.adapters.length ? status.adapters.map((a) => `${a.agent} pid ${a.pid}`).join(", ") : "none running"}`);
  if (status.last_disconnect) ctx.out(`last down:  ${status.last_disconnect.at} ${status.last_disconnect.reason}${status.last_disconnect.detail ? ` (${status.last_disconnect.detail})` : ""}`);
  if (status.needs_login) ctx.out(`problem:    needs a new sign-in: ${status.needs_login.reason}; run: claw-connector login`);
  for (const p of status.problems) ctx.out(`problem:    ${p}`);
  for (const w of status.warnings) ctx.out(`warning:    ${w}`);
  return EXIT.ok;
}

async function cmdPause(ctx: Ctx): Promise<number> {
  fs.mkdirSync(ctx.dirs.state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pauseFile(ctx.dirs), new Date().toISOString() + "\n", { mode: 0o600 });
  if (runningPid(ctx) === null) {
    // Nothing is watching the marker: stop whatever a dead run left behind.
    const left = await new ChildRegistry(childrenFile(ctx.dirs)).killAll();
    ctx.out(`paused (the connector is not running${left.killed.length ? `; stopped ${left.killed.length} leftover agent process group(s)` : ""})`);
  } else {
    ctx.out("paused: the running connector stops every agent within a second and stays offline until: claw-connector resume");
  }
  return EXIT.ok;
}

function cmdResume(ctx: Ctx): number {
  fs.rmSync(pauseFile(ctx.dirs), { force: true });
  ctx.out(runningPid(ctx) === null ? "resumed; start it with: claw-connector run" : "resumed: the running connector reconnects now");
  return EXIT.ok;
}

/** SIGTERM the connector this directory's pid file names (verified by start time), wait, then stop any recorded adapter that is left. */
async function cmdStop(ctx: Ctx, quiet = false): Promise<number> {
  const pid = runningPid(ctx);
  if (pid !== null) {
    // Said before the signal: the run reads it as it ends, and a supervised run that finds it exits 0 (not restarted).
    fs.mkdirSync(ctx.dirs.state, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stopRequestFile(ctx.dirs), JSON.stringify({ pid, start: processStart(pid) ?? "", at: new Date().toISOString() }), { mode: 0o600 });
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && isAlive(pid) && processStart(pid) !== null) await sleep(100);
    if (isAlive(pid) && runningPid(ctx) === pid) {
      process.kill(pid, "SIGKILL");
      if (!quiet) ctx.out(`the connector (pid ${pid}) did not stop in 15 s and was killed`);
    }
    // A run that ended reads it as it ends; one that never did (killed, or gone before the signal) leaves nothing behind.
    fs.rmSync(stopRequestFile(ctx.dirs), { force: true });
  }
  const left = await new ChildRegistry(childrenFile(ctx.dirs)).killAll();
  if (!quiet) ctx.out(pid === null ? `no connector running${left.killed.length ? `; stopped ${left.killed.length} leftover agent process group(s)` : ""}` : `stopped the connector${left.killed.length ? ` and ${left.killed.length} leftover agent process group(s)` : ""}`);
  return EXIT.ok;
}

/** Whether `stop` asked this process to end; the request is used up either way. */
function takeStopRequest(ctx: Ctx): boolean {
  const file = stopRequestFile(ctx.dirs);
  let mine = false;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    // The start time too: a request left behind for a process that is gone must not match a later one with its pid.
    mine = isObject(raw) && raw.pid === process.pid && raw.start === (processStart(process.pid) ?? "");
  } catch { return false; }
  if (mine) fs.rmSync(file, { force: true });
  return mine;
}

/** The connector row `run` stored, as it stored it: which server, which id, and whether Claw revoked it. */
function storedConnector(ctx: Ctx): { server: string; connector_id: string; revoked: boolean } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(identityFile(ctx.dirs), "utf8"));
    if (isObject(raw) && typeof raw.server === "string" && typeof raw.connector_id === "string") {
      return { server: raw.server, connector_id: raw.connector_id, revoked: raw.revoked === true };
    }
  } catch { /* never registered, or unreadable */ }
  return null;
}

/** What a person runs to revoke a connector at Claw by hand, with a credential of their own (never one printed here). */
const revokeByHand = (server: string, cid: string): string =>
  `curl -fsS -X DELETE -H "Authorization: Bearer <your Claw API key>" ${server}/v1/remote-agents/connectors/${encodeURIComponent(cid)}`;

/**
 * Stop, revoke this machine's connector at Claw, revoke the sign-in at the identity service, and delete it here.
 *
 * The connector row is revoked first, with the sign-in that is about to be deleted: once it is gone nothing on this
 * machine can. A row left alive is still the user's connector at Claw, and instructions sent to it wait there for the
 * next sign-in on this machine. So when it cannot be revoked (Claw unreachable, the sign-in already refused, a Claw
 * from before the connector-side route) the sign-in is still deleted, the person is told the row is alive and how to
 * revoke it, the stored id is kept (a later `login` reuses the live row instead of taking another), and the exit code
 * is not 0. A row Claw revoked is forgotten, so the next `run` registers a new one.
 */
async function cmdLogout(ctx: Ctx): Promise<number> {
  await cmdStop(ctx, true);
  const file = credentialsFile(ctx.dirs);
  let creds: Credentials | null = null;
  let credsProblem: string | null = null;
  try { creds = loadCredentials(file); } catch (e) { credsProblem = errMessage(e); /* an unreadable file is removed anyway */ }
  const row = storedConnector(ctx);
  let latest = creds;
  /** Why the live row was not revoked at Claw; null when it was, or when there is none. */
  let notRevoked: string | null = null;
  let rowGone = false;
  if (row && !row.revoked) {
    if (!creds) {
      notRevoked = credsProblem ? `the sign-in on this machine is unreadable (${credsProblem})` : "this machine is not signed in";
    } else {
      // Only to the server this sign-in is for, as `run` resolves it (and `run` ignores a stored id for another server):
      // a key or an access token sent to the server of an earlier sign-in would hand it a credential for this one.
      let server: string | null = null;
      try {
        let cfg: ConnectorConfig | null = null;
        try { cfg = loadCfg(ctx); } catch (e) { if (!(e instanceof ConfigError)) throw e; }
        server = serverUrl(ctx, undefined, cfg, creds);
      } catch { /* no usable server: nothing is sent */ }
      if (server !== row.server) {
        notRevoked = `it was registered at ${row.server}, but this sign-in is for ${server ?? "no usable server"}, so nothing was sent to either`;
      } else try {
        const tokens = providerFor(creds, (c) => { latest = c; saveCredentials(file, c); }, { fetch: ctx.fetch });
        const client = new ClawClient({ server: row.server, tokens, fetch: ctx.fetch, requestTimeoutMs: 15_000 });
        await client.revoke(row.connector_id, creds.kind);
        rowGone = true;
        ctx.out(`revoked connector ${row.connector_id} at ${row.server}: Claw sends it nothing more`);
      } catch (e) {
        if (e instanceof RevokedError || (e instanceof HttpError && e.status === 404 && e.code === "not_found")) {
          rowGone = true;
          ctx.out(`Claw has no live connector ${row.connector_id} for this sign-in (already revoked, or registered by another account)`);
        } else {
          notRevoked = errMessage(e);
        }
      }
    }
  }
  if (latest?.kind === "device" && latest.identity_url && latest.refresh_token) {
    try {
      const f = ctx.fetch ?? fetch;
      await f(`${latest.identity_url}/oauth/revoke`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: latest.refresh_token, token_type_hint: "refresh_token", client_id: latest.client_id ?? DEFAULT_CLIENT_ID }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      ctx.err(`could not revoke the sign-in at the identity service (${errMessage(e)}); it was removed from this machine`);
    }
  }
  fs.rmSync(file, { force: true });
  if (rowGone) fs.rmSync(identityFile(ctx.dirs), { force: true });
  else forgetRevokedIdentity(ctx);
  if (row && notRevoked !== null) {
    ctx.err(`signed out on this machine, but connector ${row.connector_id} was NOT revoked at Claw (${notRevoked}).`);
    ctx.err("It is still your connector there, and instructions sent to it wait for the next sign-in on this machine. Revoke it with:");
    ctx.err(`  ${revokeByHand(row.server, row.connector_id)}`);
    ctx.err("or sign in again and run logout once Claw is reachable.");
    return EXIT.failure;
  }
  ctx.out("signed out");
  return EXIT.ok;
}

/** What `service` borrows from the other commands. */
const serviceHelpers = {
  runningPid,
  stop: (ctx: Ctx) => cmdStop(ctx, true),
  preflight: (ctx: Ctx): string | null => {
    try {
      const cfg = loadCfg(ctx);
      if (cfg.agents.length === 0) return "agents.toml defines no agents; add an [[agents]] table";
      if (!loadCredentials(credentialsFile(ctx.dirs))) return "not signed in: run  claw-connector login";
    } catch (e) { return errMessage(e); }
    const nl = needsLogin(ctx.dirs);
    return nl ? `${nl.reason}: run  claw-connector login  first` : null;
  },
};
export type ServiceHelpers = typeof serviceHelpers;
