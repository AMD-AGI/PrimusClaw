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
import { HooksError, hooksStatus, installHooks, settingsFile, uninstallHooks } from "./hooks.js";
import { Connector, type ConnectorTiming } from "./connector.js";
import {
  auditFile, childrenFile, configFile, credentialsFile, identityFile, pauseFile, pidFile, type Dirs,
} from "./paths.js";
import { UrlError, errMessage, isObject, secureUrl, sleep, stderrLogger } from "./util.js";
import { VERSION } from "./version.js";

export interface Ctx {
  dirs: Dirs;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  hostname?: string;
  timing?: Partial<ConnectorTiming>;
  /** Called with the connector once it exists, so a signal handler can stop it. */
  onConnector?: (c: Connector) => void;
  /** The file the terminal hooks run (default: `terminal-hook.js` next to this program) and the node that runs it. */
  hookScript?: string;
  node?: string;
}

export const EXIT = { ok: 0, failure: 1, usage: 2, revoked: 3 } as const;

const HELP = `claw-connector ${VERSION}: connect the coding agents on this machine to Claw (outbound HTTPS only).

Usage: claw-connector <command> [options]

  init [--approval ask|never | --approval AGENT=ask|never ...] [--no-hooks]
                           write a sample agents.toml, and install the Claude Code session hooks (see "hooks"; --no-hooks
                           skips that). Agents ask before every write and command by default;
                           "--approval never" (or "--approval claude=never") lets phone sessions run like your
                           terminal, with no per-step approval. Agents are: ${SAMPLE_AGENTS.join(", ")}.
  hooks install|uninstall|status [--config-dir DIR]
                           the SessionStart/SessionEnd hooks that tell this connector which Claude Code sessions are open
                           in a terminal; merged into DIR/settings.json (default: the claude-attach agents' config
                           directories, else $CLAUDE_CONFIG_DIR or ~/.claude); only its own entries are ever changed
  login                    sign in (device flow); --server URL --identity-url URL [--name HOST]
                           development only: --key <api key>  (or CLAW_CONNECTOR_KEY)
  run                      connect and serve (Ctrl-C or SIGTERM stops it and every agent it started)
  status [--json]          what is running, signed in, paused
  pause                    stop every agent now and stay offline until "resume"
  resume                   undo "pause"
  stop                     stop the running connector and every agent it started
  logout                   stop, revoke the sign-in and delete it
  --version, --help

Files: ${"$"}XDG_CONFIG_HOME/claw-connector (agents.toml, credentials.json) and ${"$"}XDG_STATE_HOME/claw-connector
(audit.jsonl, logs, outbox); set CLAW_CONNECTOR_HOME to keep everything under one directory.
`;

function loadCfg(ctx: Ctx): ConnectorConfig {
  return loadConfig(configFile(ctx.dirs), { hostname: ctx.hostname ?? os.hostname() });
}

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
      case "run": return await cmdRun(rest, ctx);
      case "status": return cmdStatus(rest, ctx);
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
  const { values } = parseArgs({ args, strict: true, options: { approval: { type: "string", multiple: true }, "no-hooks": { type: "boolean" } } });
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
  return EXIT.ok;
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
 * is alive is kept: every registration takes one of the few connector rows a user may have (and `logout` cannot
 * delete a row), so a sign-in that registered a new row each time would use them up and then `run` would fail with
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
    ctx.out("saved a development key. This is for trying things out: a device sign-in is the normal way (omit --key).");
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
  ctx.out(`signed in as ${deviceName}. Next: claw-connector run`);
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

async function cmdRun(_args: string[], ctx: Ctx): Promise<number> {
  const cfg = loadCfg(ctx);
  if (cfg.agents.length === 0) { ctx.err("agents.toml defines no agents; add an [[agents]] table"); return EXIT.failure; }
  const creds = loadCredentials(credentialsFile(ctx.dirs));
  if (!creds) { ctx.err("not signed in: run  claw-connector login"); return EXIT.failure; }
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
  try {
    const result = await connector.run();
    if (result === "revoked") { ctx.err("this connector was revoked: every agent was stopped. Run login again to connect it anew."); return EXIT.revoked; }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof HttpError || e instanceof TransportError || e instanceof RevokedError || e instanceof GrantRevokedError) { ctx.err(`error: ${e.message}`); return EXIT.failure; }
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
  try { const cfg = loadCfg(ctx); agents = cfg.agents.map((a) => a.id); unattended = cfg.agents.filter((a) => a.unattended).map((a) => a.id); } catch (e) { configProblem = errMessage(e); }
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
  };
  if (values.json) { ctx.out(JSON.stringify(status, null, 2)); return EXIT.ok; }
  ctx.out(`connector:  ${status.running ? `running (pid ${status.running})` : "not running"}${status.paused ? ", PAUSED" : ""}`);
  ctx.out(`signed in:  ${creds ? `${creds.kind} to ${creds.server}` : "no"}`);
  ctx.out(`agents:     ${agents.map((a) => (unattended.includes(a) ? `${a} (no per-step approval)` : a)).join(", ") || "none configured"}`);
  ctx.out(`adapters:   ${status.adapters.length ? status.adapters.map((a) => `${a.agent} pid ${a.pid}`).join(", ") : "none running"}`);
  for (const p of status.problems) ctx.out(`problem:    ${p}`);
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
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && isAlive(pid) && processStart(pid) !== null) await sleep(100);
    if (isAlive(pid) && runningPid(ctx) === pid) {
      process.kill(pid, "SIGKILL");
      if (!quiet) ctx.out(`the connector (pid ${pid}) did not stop in 15 s and was killed`);
    }
  }
  const left = await new ChildRegistry(childrenFile(ctx.dirs)).killAll();
  if (!quiet) ctx.out(pid === null ? `no connector running${left.killed.length ? `; stopped ${left.killed.length} leftover agent process group(s)` : ""}` : `stopped the connector${left.killed.length ? ` and ${left.killed.length} leftover agent process group(s)` : ""}`);
  return EXIT.ok;
}

async function cmdLogout(ctx: Ctx): Promise<number> {
  await cmdStop(ctx, true);
  const file = credentialsFile(ctx.dirs);
  let creds: Credentials | null = null;
  try { creds = loadCredentials(file); } catch { /* an unreadable file is removed anyway */ }
  if (creds?.kind === "device" && creds.identity_url && creds.refresh_token) {
    try {
      const f = ctx.fetch ?? fetch;
      await f(`${creds.identity_url}/oauth/revoke`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: creds.refresh_token, token_type_hint: "refresh_token", client_id: creds.client_id ?? DEFAULT_CLIENT_ID }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      ctx.err(`could not revoke the sign-in at the identity service (${errMessage(e)}); it was removed from this machine`);
    }
  }
  fs.rmSync(file, { force: true });
  forgetRevokedIdentity(ctx);
  ctx.out("signed out");
  return EXIT.ok;
}
