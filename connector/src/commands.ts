// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The subcommands. Each takes its inputs explicitly (directories, environment, output, fetch) so a test can run it against a temporary home. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AdapterStore, adapterStore, adaptersDir, installAll, pinnedOf, useAdapterStore } from "./adapter-install.js";
import { fileAudit } from "./audit.js";
import { ChildRegistry, isAlive, processStart } from "./children.js";
import { ClawClient, HttpError, RevokedError, TransportError } from "./claw-client.js";
import { ConfigError, PRESETS, SAMPLE_ACTIVE, SAMPLE_AGENTS, loadConfig, sampleApprovals, sampleConfig, type AgentConfig, type Approval, type ConnectorConfig } from "./config.js";
import {
  CredentialsError, DEFAULT_CLIENT_ID, GrantRevokedError, loadCredentials, providerFor, reconnectAdvice, reconnectFix, reconnectStep, saveCredentials, type Credentials,
} from "./credentials.js";
import { DeviceFlowError, deviceLogin } from "./deviceflow.js";
import { applyRootSandbox, bypassUnavailableWarnings } from "./claude-mode.js";
import { approvalHooksStatus, HooksError, hooksStatus, type HooksStatus, installApprovalHooks, installHooks, settingsFile, uninstallApprovalHooks, uninstallHooks } from "./hooks.js";
import { approvalSocketFile } from "./approvals.js";
import { Connector, isAuthRefusal, type ConnectorTiming } from "./connector.js";
import { clearNeedsLogin, markNeedsLogin, needsLogin, recentDisconnects } from "./health.js";
import { checkAll, defaultDeps, formatReport, runProbe, shq, writeReport, type DoctorDeps, type Problem, type Report } from "./doctor.js";
import { applyServiceEnv, cmdService, cmdSupervise, ephemeralWhere, loadServiceEnv, startAfterLogin, type ServiceDeps } from "./service.js";
import { cmdPair } from "./pair.js";
import {
  auditFile, childrenFile, configFile, credentialsFile, doctorFile, forgetIdentity, identityFile, logDir, pauseFile, pidFile, serviceEnvFile, stopRequestFile, type Dirs,
} from "./paths.js";
import { UrlError, errMessage, isObject, secureUrl, sleep, stderrLogger } from "./util.js";
import { VERSION } from "./version.js";
import { redactDeep } from "./redact.js";
import { probeAgents, probeLines, type ProbeFn } from "./probe.js";
import { rootProblems } from "./roots.js";

export interface Ctx {
  dirs: Dirs;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  hostname?: string;
  timing?: Partial<ConnectorTiming>;
  /** What `doctor` and a running connector's health checks use to look at the machine (tests replace it, and then a
   *  running connector checks in place instead of in a child process). */
  doctor?: DoctorDeps;
  /** This program's entry point (`cli.js`), which a running connector starts again for `health-check`. */
  cli?: string;
  /** What `health-check` reads its agents from (default: this process's stdin). */
  stdin?: () => Promise<string>;
  /** How `doctor` asks a running connector (its pid) to check again (default: SIGWINCH). */
  askRecheck?: (pid: number) => void;
  /** The working directory `pair` gives agents when it writes agents.toml (default: the process's). */
  cwd?: string;
  /** Called with the connector once it exists, so a signal handler can stop it. */
  onConnector?: (c: Connector) => void;
  /** The file the terminal hooks run (default: `terminal-hook.js` next to this program) and the node that runs it. */
  hookScript?: string;
  /** The file the approval hooks run (default: `approval-hook.js` next to this program). */
  approvalHookScript?: string;
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
  /**
   * Asks the person at the terminal a yes/no question, `dflt` being what an empty answer (Enter) means; absent when nobody
   * can answer (stdin or stdout is not a terminal: a script, a pipe, CI). `init` and `pair` ask before they change Claude
   * Code's own settings, and without this they change nothing there and print the command that would.
   */
  ask?: (question: string, dflt?: boolean) => Promise<boolean>;
  /**
   * Install the pinned adapters into the state directory (adapter-install.ts): at init, service install, the start of
   * run, and when a session needs one. The command line sets it; a test leaves it off, so nothing is downloaded.
   */
  installAdapters?: boolean;
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

/**
 * One subcommand: how it is called (`usage`, after "claw-connector"), what it does (`about`, wrapped at the width the
 * overall help prints it), and what runs it. Every entry answers `-h`/`--help` with its own help, before `run` sees
 * anything (main); `noArgs` commands take nothing after their name, so a stray option is a usage error rather than
 * ignored. `hidden` ones are started by the connector itself, not by people, and stay out of the overall help.
 */
interface Command {
  usage: string;
  about: string;
  hidden?: boolean;
  noArgs?: boolean;
  run: (rest: string[], ctx: Ctx) => Promise<number> | number;
}

/** Every subcommand, in the order the overall help lists them. The single source for dispatch and for help. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  init: {
    usage: "init [--approval ask|never | --approval AGENT=ask|never ...] [--hooks | --no-hooks] [--no-approval-hooks] [--no-probe]",
    about: `write a sample agents.toml. In a terminal it then asks (default yes) whether to add the Claude
Code hooks to Claude's settings.json: the session hooks and the approval hooks (see "hooks");
--hooks adds them without asking, --no-hooks does not, --no-approval-hooks leaves the approval
hooks out, and when nobody can answer nothing is added. Agents ask before every write and command by default;
"--approval never" (or "--approval claude=never") lets phone sessions run like your
terminal, with no per-step approval. Agents are: ${SAMPLE_AGENTS.join(", ")}.`,
    run: (rest, ctx) => cmdInit(rest, ctx),
  },
  hooks: {
    usage: "hooks install|uninstall|status [--approvals] [--config-dir DIR]",
    about: `the SessionStart/SessionEnd hooks that tell this connector which Claude Code sessions are open
in a terminal; merged into DIR/settings.json (default: the claude-attach agents' config
directories, else $CLAUDE_CONFIG_DIR or ~/.claude); only its own entries are ever changed.
--approvals also adds the approval hooks: a question Claude Code asks in a terminal (run a command,
edit a file, approve a plan, a multiple-choice question) is also put to you in the chat, and the
first answer, there or at the terminal, wins; "hooks uninstall --approvals" takes out only those`,
    run: (rest, ctx) => cmdHooks(rest, ctx),
  },
  pair: {
    usage: "pair CODE --server URL",
    about: `connect this machine with the one-time code your chat gave you ("连接我的开发环境"): writes
agents.toml if there is none (the agents found here, working in this folder), saves the
sign-in, offers the Claude Code hooks as init does, and starts the service.
[--name HOST] [--no-start] [--hooks | --no-hooks] [--no-approval-hooks]`,
    run: (rest, ctx) => cmdPair(rest, ctx, {
      runningPid, stop: (c) => cmdStop(c, true), start: (c) => cmdService(["install"], c, serviceHelpers), hooks: setupHooks,
    }),
  },
  login: {
    usage: "login",
    about: `sign in (device flow); --server URL --identity-url URL [--name HOST]
development only: --key <api key>  (or CLAW_CONNECTOR_KEY)`,
    run: (rest, ctx) => cmdLogin(rest, ctx),
  },
  run: {
    usage: "run",
    about: `connect and serve (Ctrl-C or SIGTERM stops it and every agent it started). Exit code 78:
revoked, sign-in refused, or no usable config; starting it again will not help`,
    run: async (rest, ctx) => {
      const code = await cmdRun(rest, ctx);
      // launchd cannot be told "never restart on 78"; it does not restart a clean exit. The reason was printed.
      return code === EXIT.needsPerson && ctx.env.CLAW_CONNECTOR_SUPERVISOR === "launchd" ? EXIT.ok : code;
    },
  },
  service: {
    usage: "service install|uninstall|status [--supervisor systemd|launchd|script] [--env NAME ...]",
    about: `keep "run" up: started at login/boot, restarted 5 s after it dies, never restarted
after exit 78. systemd --user on Linux, launchd on macOS; "script" (containers without
systemd) writes a keep-alive script and adds it to crontab, or says what must call it.
The agents' settings in this shell (PATH, proxies, ANTHROPIC_BASE_URL...) go into the
service; their sign-in variables (ANTHROPIC_API_KEY, OPENAI_API_KEY...) and any --env
named like a credential go into service-env.json (0600), never into the unit`,
    run: async (rest, ctx) => {
      if (rest[0] === "install") await installAdapters(ctx, false);
      return await cmdService(rest, ctx, serviceHelpers);
    },
  },
  status: {
    usage: "status [--json]",
    about: "what is running, signed in, paused, the last disconnect and why",
    run: (rest, ctx) => cmdStatus(rest, ctx),
  },
  doctor: {
    usage: "doctor [--agent ID] [--json]",
    about: `check this machine before a phone session fails on it, one fix per problem: Node, each
agent's program on PATH (and on the installed service's PATH), Claude Code / Codex signed
in, the roots writable, the proxy variables, Claw's certificate, the service and Claw
itself; then start each agent's adapter, open a session (no prompt) and check that it
offers the modes agents.toml needs. Exit 1 when something stops sessions. A running
connector repeats the machine checks and shows them in the chat; init runs the adapter check`,
    run: (rest, ctx) => cmdDoctor(rest, ctx),
  },
  pause: { usage: "pause", about: `stop every agent now and stay offline until "resume"`, noArgs: true, run: (_, ctx) => cmdPause(ctx) },
  resume: { usage: "resume", about: `undo "pause"`, noArgs: true, run: (_, ctx) => cmdResume(ctx) },
  stop: { usage: "stop", about: "stop the running connector and every agent it started", noArgs: true, run: (_, ctx) => cmdStop(ctx) },
  logout: {
    usage: "logout",
    about: "stop, revoke this connector at Claw and the sign-in, and delete the sign-in",
    noArgs: true,
    run: (_, ctx) => cmdLogout(ctx),
  },
  supervise: {
    usage: "supervise",
    about: `(started by "service install --supervisor script", not by people) keep "run" up in the
background where there is no systemd or launchd`,
    hidden: true,
    noArgs: true,
    run: (rest, ctx) => cmdSupervise(rest, ctx),
  },
  "health-check": {
    usage: "health-check",
    about: `(started by a running connector, not by people) check the agents given as JSON on stdin and
print the result as JSON`,
    hidden: true,
    noArgs: true,
    run: (_, ctx) => cmdHealthCheck(ctx, ctx.stdin ?? readStdin),
  },
};

const DESC_COL = 27;
/** One command as the overall help lists it: usage, then its description from column 27 (on the next line when the usage is too long). */
function helpEntry(c: Command): string {
  const [first, ...more] = c.about.split("\n");
  const head = c.usage.length <= DESC_COL - 4 ? `  ${c.usage.padEnd(DESC_COL - 2)}${first}` : `  ${c.usage}\n${" ".repeat(DESC_COL)}${first}`;
  return [head, ...more.map((l) => " ".repeat(DESC_COL) + l)].join("\n");
}

/** What `claw-connector CMD --help` prints. */
export function commandHelp(name: string): string {
  const c = COMMANDS[name];
  return `Usage: claw-connector ${c.usage}\n\n${c.about.split("\n").map((l) => "  " + l).join("\n")}\n\nclaw-connector --help lists every command, and where the connector keeps its files.`;
}

/** `-h` or `--help` among a command's arguments, before a `--` that ends the options. */
const asksForHelp = (rest: string[]): boolean => {
  const end = rest.indexOf("--");
  return (end < 0 ? rest : rest.slice(0, end)).some((a) => a === "-h" || a === "--help");
};

const HELP = `claw-connector ${VERSION}: connect the coding agents on this machine to Claw (outbound HTTPS only).

Usage: claw-connector <command> [options]

${Object.values(COMMANDS).filter((c) => !c.hidden).map(helpEntry).join("\n")}
  --version, --help

Files: ${"$"}XDG_CONFIG_HOME/claw-connector (agents.toml, credentials.json) and ${"$"}XDG_STATE_HOME/claw-connector
(audit.jsonl, logs, outbox); set CLAW_CONNECTOR_HOME to keep everything under one directory, and
CLAW_CONNECTOR_CONFIG_DIR to keep only the configuration and sign-in elsewhere (storage that outlives a container).
`;

/**
 * The configuration as the agents will run it: with the sign-in variables `service install` kept (service.ts), and
 * IS_SANDBOX set for unattended Claude agents under root (claude-mode.ts).
 */
function loadCfg(ctx: Ctx, notes: string[] = []): ConnectorConfig {
  const cfg = loadConfig(configFile(ctx.dirs), { hostname: ctx.hostname ?? os.hostname() });
  applyServiceEnv(cfg.agents, loadServiceEnv(serviceEnvFile(ctx.dirs)), ctx.env);
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
  useAdapterStore(new AdapterStore(adaptersDir(ctx.dirs.state), { autoInstall: ctx.installAdapters === true }));
  try {
    switch (cmd) {
      case undefined: ctx.out(HELP); return EXIT.usage;
      case "--help": case "-h": ctx.out(HELP); return EXIT.ok;
      case "help": ctx.out(rest[0] !== undefined && Object.hasOwn(COMMANDS, rest[0]) ? commandHelp(rest[0]) : HELP); return EXIT.ok;
      case "--version": case "-v": case "version": ctx.out(VERSION); return EXIT.ok;
    }
    if (!Object.hasOwn(COMMANDS, cmd)) { ctx.err(`unknown command ${JSON.stringify(cmd)}\n\n${HELP}`); return EXIT.usage; }
    const command = COMMANDS[cmd];
    if (asksForHelp(rest)) { ctx.out(commandHelp(cmd)); return EXIT.ok; }
    if (command.noArgs && rest.length > 0) { ctx.err(`${cmd} takes no arguments, not ${JSON.stringify(rest[0])}\n\n${commandHelp(cmd)}`); return EXIT.usage; }
    return await command.run(rest, ctx);
  } catch (e) {
    // A command's own option parser (node:util parseArgs, strict) refused the arguments: a usage error, with that command's help.
    const code = (e as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_") && cmd !== undefined && Object.hasOwn(COMMANDS, cmd)) {
      ctx.err(`${cmd}: ${errMessage(e)}\n\n${commandHelp(cmd)}`);
      return EXIT.usage;
    }
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
  const { values } = parseArgs({ args, strict: true, options: { approval: { type: "string", multiple: true }, hooks: { type: "boolean" }, "no-hooks": { type: "boolean" }, "no-approval-hooks": { type: "boolean" }, "no-probe": { type: "boolean" } } });
  if (values.hooks && values["no-hooks"]) { ctx.err("init: --hooks and --no-hooks contradict each other; pass one"); return EXIT.usage; }
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
  // A dev pod's home directory is often thrown away with the pod: say so now, not after the first restart.
  const where = ephemeralWhere(ctx.dirs.config);
  if (where) ctx.out(`note: ${where}`);
  await setupHooks(ctx, { hooks: !!values.hooks, noHooks: !!values["no-hooks"], noApprovals: !!values["no-approval-hooks"] });
  // Installed first, so the probe below (and the first phone session) starts the adapter without a download.
  await installAdapters(ctx, true);
  if (ctx.probe && !values["no-probe"]) {
    try {
      const cfg = loadCfg(ctx);
      ctx.out("checking each agent's adapter (claw-connector doctor; skip with --no-probe):");
      for (const l of probeLines(await ctx.probe(cfg.agents, { logDir: logDir(ctx.dirs), version: VERSION }))) ctx.out(l);
    } catch (e) { ctx.out(`could not check the agents yet: ${errMessage(e)}; after editing agents.toml run: claw-connector doctor`); }
  }
  return EXIT.ok;
}

/** What `init` and `pair` were told about the Claude Code hooks: add them without asking, leave them out, leave out the approval hooks. */
export interface HookChoice { hooks: boolean; noHooks: boolean; noApprovals: boolean }

/**
 * `init` and `pair`: the Claude Code hooks, the session hooks and (unless `--no-approval-hooks`) the approval hooks. They live in
 * Claude Code's own settings file, which is the user's, not ours: they are added when asked for (`--hooks`) or agreed to at the
 * terminal (one question, Enter is yes), and never when nobody can answer, which prints the command instead. Hooks of ours
 * already there were agreed to before: they are brought up to date (a moved program) without asking again, and only what is
 * missing is asked about. A file that cannot be merged into is reported, and the command still succeeds.
 */
export async function setupHooks(ctx: Ctx, o: HookChoice): Promise<void> {
  if (o.noHooks) return;
  const dir = defaultClaudeDir(ctx);
  const later = o.noApprovals ? "claw-connector hooks install" : "claw-connector hooks install --approvals";
  if (!fs.existsSync(dir)) { ctx.out(`no Claude Code directory at ${dir}; once you use Claude Code, run: ${later}`); return; }
  let session = o.hooks || present(hooksStatus, dir);
  let approvals = !o.noApprovals && (o.hooks || present(approvalHooksStatus, dir));
  const askSession = !session;
  const askApprovals = !o.noApprovals && !approvals;
  if (askSession || askApprovals) {
    let yes = false;
    if (ctx.ask) {
      ctx.out(`Claude Code hooks for ${settingsFile(dir)} (only entries marked --managed-by claw-connector; nothing else in it changes):`);
      if (askSession) ctx.out("  session hooks (SessionStart, SessionEnd): Claw can tell which Claude Code sessions are open in a terminal");
      if (askApprovals) ctx.out("  approval hooks: a question Claude Code asks in a terminal (run a command, edit a file, approve a plan, a multiple-choice question) also comes to your chat; the terminal keeps asking and the first answer wins");
      yes = await ctx.ask("Add them? [Y/n] ", true);
    }
    if (yes) { session = true; approvals ||= askApprovals; } else {
      const left = askSession && askApprovals ? "the Claude Code hooks" : askSession ? "the session hooks" : "the approval hooks";
      const without = [
        askSession ? "a Claude Code session open in a terminal is found by listing processes only" : "",
        askApprovals ? "a question it asks waits for you at that terminal only" : "",
      ].filter(Boolean).join(", and ");
      ctx.out(`did not add ${left} to ${settingsFile(dir)}${ctx.ask ? "" : " (no terminal to ask in)"}. Without them, ${without}; to add them: ${later}`);
    }
  }
  try {
    if (session) ctx.out(describeInstall(dir, installOne(ctx, dir).changed));
    if (approvals) ctx.out(describeApprovals(dir, installApprovalsOne(ctx, dir).changed));
  } catch (e) { ctx.err(`hooks: ${errMessage(e)} (everything else is set up; fix it and run: ${later})`); }
}

/** Whether any hook of that set is in this directory's settings already; a settings file that cannot be read counts as no. */
function present(status: (dir: string) => HooksStatus, dir: string): boolean {
  try { return status(dir).events.length > 0; } catch { return false; }
}

/**
 * `init` and `service install`: install the pinned adapters of the configured agents now, in the foreground, so the
 * first phone session does not wait for a download. `init` falls back to the sample's enabled presets while the roots
 * in agents.toml do not exist yet. Only from the command line (`ctx.installAdapters`); a failure is said, not fatal.
 */
async function installAdapters(ctx: Ctx, initFallback: boolean): Promise<void> {
  const store = adapterStore();
  if (!store || !ctx.installAdapters) return;
  let agents: Array<{ command: string; args: string[]; env: Record<string, string> }>;
  // The configuration as written, without the sign-in variables the service keeps: npm is never given those.
  try { agents = loadConfig(configFile(ctx.dirs), { hostname: ctx.hostname ?? os.hostname() }).agents; } catch {
    if (!initFallback) return;
    agents = SAMPLE_ACTIVE.map((id) => ({ command: PRESETS[id]!.command, args: PRESETS[id]!.args, env: {} }));
  }
  await installAll(store, agents, ctx.env, (l) => ctx.out(`adapters: ${l}`));
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

function approvalScript(ctx: Ctx): string {
  const script = ctx.approvalHookScript ?? fileURLToPath(new URL("./approval-hook.js", import.meta.url));
  if (!fs.existsSync(script)) throw new HooksError(`${script} does not exist (a source checkout needs "npm run build" first)`);
  return script;
}

function installApprovalsOne(ctx: Ctx, dir: string) {
  return installApprovalHooks(dir, ctx.node ?? process.execPath, approvalScript(ctx), approvalSocketFile(ctx.dirs.state));
}

const describeInstall = (dir: string, changed: boolean): string =>
  changed ? `installed the Claude Code session hooks in ${settingsFile(dir)}` : `the Claude Code session hooks are already in ${settingsFile(dir)}`;
const describeApprovals = (dir: string, changed: boolean): string => changed
  ? `installed the approval hooks in ${settingsFile(dir)}: questions Claude Code asks in a terminal also go to your chat, and the first answer wins ("claw-connector hooks uninstall --approvals" takes them out)`
  : `the approval hooks are already in ${settingsFile(dir)}`;

function cmdHooks(args: string[], ctx: Ctx): number {
  const [sub, ...rest] = args;
  if (sub !== "install" && sub !== "uninstall" && sub !== "status") { ctx.err("usage: claw-connector hooks install|uninstall|status [--config-dir DIR]"); return EXIT.usage; }
  const { values } = parseArgs({ args: rest, strict: true, options: { "config-dir": { type: "string" }, json: { type: "boolean" }, approvals: { type: "boolean" } } });
  const dirs = claudeDirs(ctx, values["config-dir"]);
  const approvals = !!values.approvals;
  let code: number = EXIT.ok;
  const report: Array<Record<string, unknown>> = [];
  for (const dir of dirs) {
    try {
      if (sub === "install") {
        if (values["config-dir"] === undefined && !fs.existsSync(dir)) { ctx.err(`no Claude Code directory at ${dir}; pass --config-dir to name one`); code = EXIT.failure; continue; }
        ctx.out(describeInstall(dir, installOne(ctx, dir).changed));
        // The approval hooks are added only when asked for: they put what a terminal asks on the owner's phone.
        if (approvals) ctx.out(describeApprovals(dir, installApprovalsOne(ctx, dir).changed));
      } else if (sub === "uninstall") {
        // `--approvals` takes out only the approval hooks; without it, both sets go.
        if (!approvals) ctx.out(uninstallHooks(dir).changed ? `removed the Claude Code session hooks from ${settingsFile(dir)}` : `no session hooks of ours in ${settingsFile(dir)}`);
        ctx.out(uninstallApprovalHooks(dir).changed ? `removed the approval hooks from ${settingsFile(dir)}` : `no approval hooks of ours in ${settingsFile(dir)}`);
      } else {
        const st = hooksStatus(dir);
        const ap = approvalHooksStatus(dir);
        report.push({ dir, ...st, approvals: ap });
        const say = (s: typeof st) => (s.installed ? (s.healthy ? "installed" : "installed, but broken") : s.events.length ? `partly installed (${s.events.join(", ")})` : "not installed");
        if (!values.json) ctx.out(`${dir}: ${say(st)}${st.problem ? `; ${st.problem}` : ""}; approvals: ${say(ap)}${ap.problem ? `; ${ap.problem}` : ""}`);
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
  if (revoked) forgetIdentity(ctx.dirs);
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
      ctx.err(`not starting: ${nl.reason}${nl.at ? ` (${nl.at})` : ""}. ${reconnectAdvice(credentialsFile(ctx.dirs))} The service then starts it.`);
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
  const connector = new Connector({ config: cfg, dirs: ctx.dirs, client, server, audit, log, version: VERSION, timing: ctx.timing, health: runHealth(ctx, cfg) });
  // In the background: the connection to Claw does not wait for a download; a session that needs one does.
  if (ctx.installAdapters) for (const { pkg, env } of pinnedOf(cfg.agents, ctx.env)) void adapterStore()?.install(pkg, env, (l) => ctx.out(`adapters: ${l}`));
  ctx.onConnector?.(connector);
  ctx.out(`connecting ${cfg.agents.map((a) => (a.unattended ? `${a.id} (no per-step approval)` : a.id)).join(", ")} to ${server} as "${cfg.name}"`);
  for (const n of notes) ctx.out(`note: ${n}`);
  for (const w of noAsk(ctx, cfg)) ctx.out(`warning: ${w}`);
  for (const a of cfg.agents) if (a.readOnlyModes.includes(a.askMode)) ctx.out(`note: ${a.id}: its sessions start read-only (${a.askMode} mode changes no file); to let phone sessions write code, set approval = "never" on it in agents.toml`);
  // A root that is missing or stalled is reported, not fatal: a network mount may come back, and its sessions with it.
  void rootProblems(cfg.agents).then((ps) => { for (const p of ps) ctx.out(`warning: ${p}`); }, () => undefined);
  try {
    const result = await connector.run();
    // A machine paired from the chat has no login to run again: a new pairing code is what connects it.
    const again = reconnectAdvice(credentialsFile(ctx.dirs));
    if (result === "revoked") {
      markNeedsLogin(ctx.dirs, "this connector was revoked");
      ctx.err(`this connector was revoked: every agent was stopped. ${again}`);
      return EXIT.revoked;
    }
    if (result === "auth_failed") {
      markNeedsLogin(ctx.dirs, `Claw refused the sign-in (${connector.authFailure})`);
      ctx.err(`Claw keeps refusing this sign-in (${connector.authFailure}): every agent was stopped. ${again}`);
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
      ctx.err(`error: ${errMessage(e)}. ${reconnectAdvice(credentialsFile(ctx.dirs))}`);
      return EXIT.needsPerson;
    }
    if (e instanceof HttpError || e instanceof TransportError) { ctx.err(`error: ${e.message}`); return EXIT.failure; }
    throw e;
  }
}

// --- doctor -------------------------------------------------------------------------------

async function cmdDoctor(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { agent: { type: "string" }, json: { type: "boolean" } } });
  const before: Problem[] = [];
  const notes: string[] = [];
  let cfg: ConnectorConfig | null = null;
  let creds: Credentials | null = null;
  try { cfg = loadCfg(ctx, notes); } catch (e) {
    const missing = !fs.existsSync(configFile(ctx.dirs));
    // A root that is gone is the one problem of agents.toml whose fix is not an edit of it: say which folder to create.
    const roots = e instanceof ConfigError ? e.problems.map((p) => /^agent (\S+): root (.+) does not exist$/.exec(p)) : [];
    if (roots.length && roots.every((m) => m !== null)) {
      for (const m of roots) before.push({ code: "root_missing", severity: "fail", agent: m![1], detail: `${m![2]} (a root of agent ${m![1]}) does not exist`, fix: `mkdir -p ${shq(m![2])}  (or change roots in ${configFile(ctx.dirs)})` });
    } else before.push({ code: "config_invalid", severity: "fail", detail: errMessage(e), fix: missing ? "claw-connector init" : `edit ${configFile(ctx.dirs)}` });
  }
  const agents = cfg ? (values.agent ? cfg.agents.filter((a) => a.id === values.agent) : cfg.agents) : [];
  if (cfg && agents.length === 0) {
    if (values.agent) { ctx.err(`no agent ${JSON.stringify(values.agent)} in agents.toml`); return EXIT.failure; }
    before.push({ code: "config_invalid", severity: "fail", detail: "agents.toml defines no agents", fix: `add an [[agents]] table to ${configFile(ctx.dirs)}  (claw-connector init writes a sample)` });
  }
  try { creds = loadCredentials(credentialsFile(ctx.dirs)); } catch (e) { before.push({ code: "not_signed_in", severity: "fail", detail: errMessage(e), fix: "claw-connector login" }); }
  if (!creds && !before.some((p) => p.code === "not_signed_in")) before.push({ code: "not_signed_in", severity: "fail", detail: "this connector is not signed in to Claw", fix: "claw-connector login" });
  const nl = needsLogin(ctx.dirs);
  if (nl) before.push({ code: "needs_login", severity: "fail", detail: `needs a new sign-in: ${nl.reason}`, fix: reconnectFix(credentialsFile(ctx.dirs)) });
  let server: string | null = null;
  try { server = serverUrl(ctx, undefined, cfg, creds); } catch { /* an invalid URL: the sign-in or config problem above says so */ }
  // First the machine (quick), then each agent's adapter (starts it: slower).
  const report = await checkAll({ dirs: ctx.dirs, agents, by: "doctor", server, before }, ctx.doctor ?? defaultDeps(ctx.env));
  writeReport(ctx.dirs, report);
  const warnings = cfg ? noAsk(ctx, { ...cfg, agents }) : [];
  // (an adapter's own error text may carry a credential: masked before it is printed)
  const results = agents.length ? redactDeep(await (ctx.probe ?? probeAgents)(agents, { logDir: logDir(ctx.dirs), version: VERSION })) : [];
  const adaptersOk = results.every((r) => r.ok);
  const machineOk = !report.problems.some((p) => p.severity === "fail");
  if (values.json) {
    // `ok`: every adapter opens a session in the mode agents.toml needs; `environment`: the machine checks (doctor.ts).
    ctx.out(JSON.stringify({ version: VERSION, ok: adaptersOk, machine_ok: machineOk, notes, warnings, agents: results, environment: report }, null, 2));
  } else {
    ctx.out(`claw-connector ${VERSION} doctor${cfg ? ` (${cfg.name})` : ""}`);
    for (const l of formatReport(report)) ctx.out(l);
    if (results.length) {
      ctx.out("");
      ctx.out("each agent's adapter (a session opened without a prompt):");
      for (const n of notes) ctx.out(`note: ${n}`);
      for (const w of warnings) ctx.out(`warning: ${w}`);
      for (const l of probeLines(results)) ctx.out(l);
    }
  }
  const running = runningPid(ctx);
  if (running !== null) {
    // Ask the running connector to check again (SIGWINCH: an older connector that does not listen ignores it).
    try { (ctx.askRecheck ?? ((pid: number) => process.kill(pid, "SIGWINCH")))(running); if (!values.json) ctx.out("The running connector checks the machine again now and shows the result in the chat."); } catch { /* gone meanwhile */ }
  }
  return adaptersOk && machineOk ? EXIT.ok : EXIT.failure;
}

/** How long the child that checks the machine for a running connector may take. */
const HEALTH_CHILD_MS = 60_000;

/**
 * The checks a running connector repeats with its own environment (what its agents get), for the chat. They run in a child
 * process (`health-check`) in a process group of its own, killed at HEALTH_CHILD_MS or at a stop: a check that hangs on a
 * stalled disk hangs there, never in this process's event loop or thread pool. (A test passes `ctx.doctor` and checks in place.)
 */
function runHealth(ctx: Ctx, cfg: ConnectorConfig): (signal: AbortSignal) => Promise<Report> {
  if (ctx.doctor) return () => checkAll({ dirs: ctx.dirs, agents: cfg.agents, by: "run" }, ctx.doctor!);
  // The entry point this process runs (cli.ts sets it); in the bundle every module's import.meta.url is dist/cli.js too.
  const cli = ctx.cli ?? ctx.service?.cli ?? fileURLToPath(import.meta.url);
  const node = ctx.node ?? process.execPath;
  return async (signal) => {
    // The agents as this run loaded them (a root removed since is what the check is for: agents.toml read afresh would refuse it).
    const r = await runProbe(node, [cli, "health-check"], ctx.env, signal, HEALTH_CHILD_MS, JSON.stringify({ agents: cfg.agents }));
    const v: unknown = JSON.parse(r.out.slice(r.out.indexOf("{")));
    if (!isObject(v) || typeof v.checked_at !== "string" || !Array.isArray(v.problems)) throw new Error(`health-check answered ${r.code === null ? "nothing in time" : `exit ${r.code}`}`);
    return v as unknown as Report;
  };
}

/**
 * `health-check` (not for people: what `runHealth` starts): the running connector's checks of the agents it sends on stdin
 * (`{agents}`, as that run loaded them), as JSON on stdout.
 */
async function cmdHealthCheck(ctx: Ctx, stdin: () => Promise<string>): Promise<number> {
  const v: unknown = JSON.parse(await stdin());
  const agents = isObject(v) && Array.isArray(v.agents) ? (v.agents as AgentConfig[]) : [];
  // (its probes stay in this process's group, which the connector kills whole: see defaultDeps)
  ctx.out(JSON.stringify(await checkAll({ dirs: ctx.dirs, agents, by: "run" }, defaultDeps(ctx.env, { ownGroup: false }))));
  return EXIT.ok;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
    /** The last `doctor` report's problems (null: doctor never ran). */
    doctor: lastDoctor(ctx),
  };
  if (values.json) { ctx.out(JSON.stringify(status, null, 2)); return EXIT.ok; }
  ctx.out(`connector:  ${status.running ? `running (pid ${status.running})` : "not running"}${status.paused ? ", PAUSED" : ""}`);
  ctx.out(`signed in:  ${creds ? `${creds.kind} to ${creds.server}` : "no"}`);
  ctx.out(`agents:     ${agents.map((a) => (unattended.includes(a) ? `${a} (no per-step approval)` : a)).join(", ") || "none configured"}`);
  ctx.out(`adapters:   ${status.adapters.length ? status.adapters.map((a) => `${a.agent} pid ${a.pid}`).join(", ") : "none running"}`);
  if (status.last_disconnect) ctx.out(`last down:  ${status.last_disconnect.at} ${status.last_disconnect.reason}${status.last_disconnect.detail ? ` (${status.last_disconnect.detail})` : ""}`);
  if (status.needs_login) ctx.out(`problem:    needs a new sign-in: ${status.needs_login.reason}; ${reconnectStep(credentialsFile(ctx.dirs))}`);
  for (const p of status.problems) ctx.out(`problem:    ${p}`);
  for (const w of status.warnings) ctx.out(`warning:    ${w}`);
  if (status.doctor) ctx.out(`doctor:     ${status.doctor.problems.length ? `${status.doctor.problems.length} problem(s) at ${status.doctor.checked_at}; run: claw-connector doctor` : `no problems at ${status.doctor.checked_at}`}`);
  else ctx.out("doctor:     never run; run: claw-connector doctor");
  return EXIT.ok;
}

function lastDoctor(ctx: Ctx): { checked_at: string; problems: Array<{ code: string; agent?: string; fix: string }> } | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(doctorFile(ctx.dirs), "utf8"));
    if (!isObject(raw) || typeof raw.checked_at !== "string" || !Array.isArray(raw.problems)) return null;
    return { checked_at: raw.checked_at, problems: raw.problems.filter(isObject).map((p) => ({ code: String(p.code), ...(typeof p.agent === "string" ? { agent: p.agent } : {}), fix: String(p.fix) })) };
  } catch { return null; }
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
  if (rowGone) forgetIdentity(ctx.dirs);
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
    return nl ? `${nl.reason}; first ${reconnectStep(credentialsFile(ctx.dirs))}` : null;
  },
};
export type ServiceHelpers = typeof serviceHelpers;
