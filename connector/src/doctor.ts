// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `claw-connector doctor`, and the health a running connector reports with every heartbeat.
 *
 * A first session that fails on a phone fails far from the machine that caused it: the agent is not signed in, its
 * program is not on the PATH the service runs with, the folder it was given cannot be written, nothing restarts the
 * connector after a reboot. Each check here names one such cause, says it in one line and gives the one command or
 * edit that fixes it. The same checks run in two places:
 *  - `doctor`, in a terminal on the machine: everything, including whether Claw answers and whether the PATH the
 *    service was installed with finds each agent; it prints one fix per problem and writes the report to doctor.json.
 *  - the running connector (`run`), with its own environment, which is the one its agents get: the agents, the
 *    folders, Node, the supervisor and the proxy variables. Every agent's heartbeat descriptor carries the result as
 *    `capabilities.health`, so the chat can say "Codex is not signed in: run codex login on that machine" before a
 *    session is opened. It checks again every `RECHECK_MS`, and at once when a `doctor` run signals it (SIGWINCH). It runs
 *    them in a child process (`health-check`), so a check stuck on a stalled disk never reaches the connection.
 *
 * Nothing here changes the machine. A check that cannot tell (no `claude` program to ask, a macOS keychain) reports
 * nothing rather than a guess: a false "not signed in" would send a person to fix what is not broken.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AgentConfig } from "./config.js";
import { blindHolders } from "./attach.js";
import { doctorFile, keepaliveFile, keepaliveStampFile, serviceFile, type Dirs } from "./paths.js";
import { systemCaOutcome, type SystemCaOutcome } from "./system-ca.js";
import { errMessage, isObject } from "./util.js";

/**
 * The file system, asked off the event loop with a time limit. A running connector checks the machine in the same process
 * that keeps its connection: a stalled mount (a root or the state directory on a shared disk that hangs) must cost it a
 * thread of the pool for a while, never its heartbeats or a stop. `null`: no answer in time, treated as "cannot tell".
 */
export const FS_TIMEOUT_MS = 5_000;
async function within<T>(p: Promise<T>, ms = FS_TIMEOUT_MS): Promise<T | null> {
  let t: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => { t = setTimeout(() => resolve(null), ms); t.unref?.(); });
  p.catch(() => undefined);
  try { return await Promise.race([p, late]); } finally { clearTimeout(t); }
}
/** The errno code of a failed check, "" when it passed, null when the file system did not answer. */
const errnoOf = async (p: Promise<unknown>): Promise<string | null> =>
  within(p.then(() => "", (e: NodeJS.ErrnoException) => e.code ?? "EIO"));
const fileExists = async (f: string): Promise<boolean> => (await errnoOf(fsp.access(f))) === "";
async function readText(f: string): Promise<string | null> {
  return within(fsp.readFile(f, "utf8").catch(() => null));
}
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const t = await readText(file);
  if (t === null) return null;
  try { const v: unknown = JSON.parse(t); return isObject(v) ? v : null; } catch { return null; }
}

/** `fail`: sessions will not work until it is fixed. `warn`: they work now, but something will bite later. */
export type Severity = "fail" | "warn";

export interface Problem {
  /** Stable code a chat client translates (see docs/remote-agents.md, "Health"). */
  code: string;
  severity: Severity;
  /** The agent it is about; absent for the machine as a whole. */
  agent?: string;
  /** One line, in English, of what is wrong. */
  detail: string;
  /** The one command or edit that fixes it. */
  fix: string;
}

export interface Report {
  checked_at: string;
  /** Which checks ran: `run` (the connector's own) or `doctor` (all of them). */
  by: "run" | "doctor";
  /** What passed, one short line each: the terminal shows them, the heartbeat does not carry them. */
  ok: string[];
  problems: Problem[];
}

/** Node versions older than this are refused by the package (engines) and lack APIs the connector uses. */
export const NODE_MIN_MAJOR = 22;
/** How often a running connector checks again on its own. */
export const RECHECK_MS = 15 * 60_000;
/** A keep-alive script that has not run for this long is not scheduled by anything. */
export const KEEPALIVE_STALE_MS = 15 * 60_000;
/** One external check (`claude auth status`, `codex login status`) may take this long before it counts as no answer. */
export const PROBE_TIMEOUT_MS = 15_000;
/** After a probe exits, how long its output may still be read from pipes another process holds open. */
const PIPE_GRACE_MS = 500;
/** At most this many problems travel in a heartbeat descriptor; capabilities are capped at 4 KiB. */
export const MAX_REPORTED = 6;

export interface ProbeResult { code: number | null; out: string }

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  user: string;
  nodeVersion: string;
  now: () => number;
  /** Run a program with a timeout; never throws (a program that cannot start answers code null). */
  probe: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<ProbeResult>;
  /** The installed supervisor (service.json) and, for the script one, whether a crontab line calls it. */
  crontab: () => Promise<string | null>;
  /** systemctl / loginctl, for the systemd supervisor. */
  exec: (cmd: string, args: string[]) => Promise<ProbeResult>;
  /** This process's user id (null where there is none): a folder of another user's cannot be fixed with chmod. */
  uid: number | null;
  /** Whether this process may write into a directory: null when it may, else the errno code (ENOENT, EACCES, EROFS), or
   *  "ETIMEDOUT" when the file system did not answer in time. */
  writable: (dir: string) => Promise<string | null> | string | null;
  /** How long one file-system question may take before it counts as no answer (default FS_TIMEOUT_MS). */
  fsTimeoutMs?: number;
  /** GET a URL with a timeout: the HTTP status, or the error. */
  get: (url: string) => Promise<{ status: number } | { error: string }>;
  /** Whether this process added the machine's CA store to the CAs it trusts (system-ca.ts); null: it was not asked to. */
  systemCa?: SystemCaOutcome | null;
}

/**
 * Run one program in a process group of its own and answer when it exits: after `PROBE_TIMEOUT_MS`, or when `signal` aborts
 * (the connector stopping), the whole group is killed (SIGKILL, which cannot be ignored), so no probe outlives its check or
 * holds a stop up, and a grandchild that keeps the output pipes open does not hold the answer up either.
 */
export function runProbe(cmd: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS, input?: string,
  ownGroup = true): Promise<ProbeResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: null, out: "stopped" });
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { env, cwd: os.homedir(), detached: ownGroup, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) { return resolve({ code: null, out: errMessage(e) }); }
    if (input !== undefined) { child.stdin?.on("error", () => undefined); child.stdin?.end(input); }
    const take = (b: Buffer) => { if (out.length < 256 * 1024) out += b.toString("utf8"); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    // Its own group is killed whole; one that shares ours (`ownGroup` false) only by its pid: our group dies with us anyway.
    const killGroup = () => { try { if (child.pid) process.kill(ownGroup ? -child.pid : child.pid, "SIGKILL"); } catch { /* gone */ } };
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      killGroup();   // (whatever it started that is still there)
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, out: out.trim() });
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (e) => { out = errMessage(e); finish(null); });
    // 'exit', not 'close': the program's own end, whoever else holds its pipes. What it wrote may still be in the pipes then:
    // read on until both are at their end, or for at most PIPE_GRACE_MS (a grandchild holding them open ends that wait).
    const ended = (st: NodeJS.ReadableStream | null) => new Promise<void>((res) => { if (!st || (st as { readableEnded?: boolean }).readableEnded) res(); else { st.once("end", () => res()); st.once("close", () => res()); } });
    const drained = Promise.all([ended(child.stdout), ended(child.stderr)]);
    child.once("exit", (code) => {
      const grace = setTimeout(() => finish(code), PIPE_GRACE_MS);
      void drained.then(() => { clearTimeout(grace); finish(code); });
    });
  });
}

/**
 * `ownGroup: false` is for the `health-check` child of a running connector: its probes stay in the child's process group, which
 * the connector kills whole at a stop or a timeout, so none can outlive it (in a group of their own they would, with the
 * child's timers gone).
 */
export function defaultDeps(env: NodeJS.ProcessEnv, over: Partial<DoctorDeps> & { signal?: AbortSignal; ownGroup?: boolean } = {}): DoctorDeps {
  const signal = over.signal;
  const ownGroup = over.ownGroup ?? true;
  const run = (cmd: string, args: string[], e: NodeJS.ProcessEnv): Promise<ProbeResult> => runProbe(cmd, args, e, signal, PROBE_TIMEOUT_MS, undefined, ownGroup);
  return {
    env,
    platform: process.platform,
    home: os.homedir(),
    user: env.USER || (() => { try { return os.userInfo().username; } catch { return ""; } })(),
    nodeVersion: process.versions.node,
    systemCa: systemCaOutcome(),
    uid: process.getuid?.() ?? null,
    now: () => Date.now(),
    probe: run,
    crontab: async () => {
      const r = await run("crontab", ["-l"], env);
      return r.code === 0 ? r.out : null;
    },
    exec: (cmd, args) => run(cmd, args, env),
    writable: async (dir) => { const code = await errnoOf(fsp.access(dir, fs.constants.W_OK)); return code === "" ? null : code ?? "ETIMEDOUT"; },
    get: async (url) => {
      try {
        const r = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000), redirect: "manual" });
        await r.body?.cancel().catch(() => undefined);
        return { status: r.status };
      } catch (e) {
        const cause = (e as { cause?: unknown }).cause;
        return { error: cause instanceof Error ? `${errMessage(e)} (${cause.message})` : errMessage(e) };
      }
    },
    ...over,
  };
}

// --- finding programs ------------------------------------------------------------------------

/** Where `cmd` resolves on `pathVar`, as a shell would find it; a command with a slash is taken as a path. Null: not found. */
export async function which(cmd: string, pathVar: string | undefined): Promise<string | null> {
  const executable = async (p: string) => (await within(fsp.stat(p).then(async (st) => st.isFile() && (await fsp.access(p, fs.constants.X_OK).then(() => true, () => false)), () => false))) === true;
  if (cmd.includes("/")) return (await executable(cmd)) ? cmd : null;
  for (const dir of (pathVar ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (await executable(p)) return p;
  }
  return null;
}

/** The environment an agent's program runs in: the connector's own, with the agent's `[agents.env]` over it (adapter.ts). */
const agentEnv = (env: NodeJS.ProcessEnv, a: AgentConfig): NodeJS.ProcessEnv => ({ ...env, ...a.env });

type Family = "claude" | "codex" | "cursor" | "other";
/** What an agent runs, from its command line (the kind is only a label). */
export function familyOf(a: AgentConfig): Family {
  const words = [a.command, ...a.args].map((s) => path.basename(s));
  if (words.some((s) => s.includes("claude-agent-acp") || s.includes("claude-code-acp"))) return "claude";
  if (words.some((s) => s.includes("codex-acp"))) return "codex";
  if (path.basename(a.command) === "agent" || path.basename(a.command) === "cursor-agent") return "cursor";
  return "other";
}

const LOGIN_FIX: Record<Exclude<Family, "other">, string> = {
  claude: "claude auth login",
  codex: "codex login",
  cursor: "agent login",
};

function installFix(cmd: string, family: Family): string {
  const base = path.basename(cmd);
  if (base === "npx" || base === "node") return "install Node.js 22 or newer (it brings npx): https://nodejs.org";
  if (family === "cursor") return "install the Cursor CLI: curl https://cursor.com/install -fsS | bash";
  return `install ${base}, or set this agent's command in agents.toml to its full path`;
}

// --- sign-in -----------------------------------------------------------------------------------

const set = (env: NodeJS.ProcessEnv, name: string) => typeof env[name] === "string" && env[name] !== "";


/**
 * Whether Claude Code is signed in for this agent, null when it cannot tell. Asked of `claude auth status` when the
 * program is there (it reads the same config directory and environment the adapter does); otherwise the signs it
 * leaves: an API key or token in the environment, `.credentials.json`, or an `apiKeyHelper` / key in settings.json.
 * On macOS a sign-in lives in the keychain, which only `claude` can read, so without it the answer is null.
 */
async function claudeSignedIn(env: NodeJS.ProcessEnv, d: DoctorDeps): Promise<boolean | null> {
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
  // A key or a cloud provider in the environment works whatever `claude auth status` says about an account sign-in.
  if (keys.some((k) => set(env, k))) return true;
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(d.home, ".claude");
  // An apiKeyHelper or a key in Claude's own settings works whatever `claude auth status` says about an account sign-in.
  const settings = await readJson(path.join(dir, "settings.json"));
  if (settings && (typeof settings.apiKeyHelper === "string" || (isObject(settings.env) && keys.some((k) => typeof (settings.env as Record<string, unknown>)[k] === "string")))) return true;
  const claude = await which("claude", env.PATH);
  if (claude) {
    const r = await d.probe(claude, ["auth", "status", "--json"], env);
    try {
      const v: unknown = JSON.parse(r.out.slice(r.out.indexOf("{")));
      if (isObject(v) && typeof v.loggedIn === "boolean") return v.loggedIn;
    } catch { /* an older claude without `auth status`: fall through to the files */ }
  }
  if (await fileExists(path.join(dir, ".credentials.json"))) return true;
  if (d.platform === "darwin") return null;
  return false;
}

/**
 * Whether Codex can authenticate for this agent: `{ ok }`, or what is missing, or null when it cannot tell. A
 * `model_provider` other than OpenAI that names an `env_key` needs that variable; one that does not sign in at all
 * needs nothing; OpenAI needs `codex login` (asked of `codex login status`, else `auth.json`) or OPENAI_API_KEY.
 */
async function codexAuth(env: NodeJS.ProcessEnv, d: DoctorDeps): Promise<{ ok: true } | { ok: false; detail: string; fix: string } | null> {
  const home = env.CODEX_HOME?.trim() || path.join(d.home, ".codex");
  let cfg: Record<string, unknown> = {};
  try { const t = await readText(path.join(home, "config.toml")); if (t !== null) cfg = parseToml(t) as Record<string, unknown>; } catch { /* unreadable: the defaults */ }
  const name = typeof cfg.model_provider === "string" ? cfg.model_provider : "openai";
  const providers = isObject(cfg.model_providers) ? cfg.model_providers : {};
  const provider = isObject(providers[name]) ? providers[name] as Record<string, unknown> : null;
  if (name !== "openai" && provider && provider.requires_openai_auth !== true) {
    const key = typeof provider.env_key === "string" ? provider.env_key : null;
    if (!key || set(env, key)) return { ok: true };
    // A value that is not a variable name (a key pasted in by mistake) is never repeated into a report.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) return { ok: false, detail: `Codex's model provider "${name.slice(0, 64)}" has an env_key that is not a variable name`, fix: `set env_key in ${path.join(home, "config.toml")} to the NAME of the variable that holds the key` };
    return { ok: false, detail: `Codex uses the model provider "${name}", which reads ${key}, and ${key} is not set where the connector runs`, fix: `set ${key} for this agent: add it to the agent's env in agents.toml, or export it before starting the connector` };
  }
  if (set(env, "OPENAI_API_KEY")) return { ok: true };
  const codex = await which("codex", env.PATH);
  if (codex) {
    const r = await d.probe(codex, ["login", "status"], env);
    if (r.code === 0 && !/not logged in/i.test(r.out)) return { ok: true };
    // Only its own words count: an older codex without `login status` also exits non-zero.
    if (/not logged in/i.test(r.out)) return { ok: false, detail: "Codex is not signed in on this machine", fix: LOGIN_FIX.codex };
  }
  if (await fileExists(path.join(home, "auth.json"))) return { ok: true };
  // A codex that could not say (too old for `login status`), or a sign-in kept in the keyring: no verdict rather than a wrong one.
  if (codex || (typeof cfg.cli_auth_credentials_store === "string" && cfg.cli_auth_credentials_store !== "file")) return null;
  return { ok: false, detail: "Codex is not signed in on this machine", fix: "npm install -g @openai/codex, then: codex login" };
}

/**
 * What keeps the agent `pair` would write for `preset` from signing in here, asked as `doctor` asks: null when it can, or when that
 * cannot be told (a false "not signed in" would leave a working agent out), else what is missing and the one command that fixes it.
 */
export async function presetSignInProblem(preset: string, env: NodeJS.ProcessEnv, d: DoctorDeps): Promise<{ detail: string; fix: string } | null> {
  if (preset === "claude") return (await claudeSignedIn(env, d)) === false ? { detail: "Claude Code is not signed in on this machine", fix: LOGIN_FIX.claude } : null;
  if (preset === "codex") {
    const auth = await codexAuth(env, d);
    return auth && !auth.ok ? { detail: auth.detail, fix: auth.fix } : null;
  }
  return null;
}

// --- the checks --------------------------------------------------------------------------------

export interface CheckInput {
  dirs: Dirs;
  agents: AgentConfig[];
  /** `doctor`: everything; `run`: what the running connector can see of itself (no server probe, no service PATH). */
  by: "run" | "doctor";
  /** For `doctor`: the Claw URL to probe, when one is known. */
  server?: string | null;
  /** For `doctor`: problems found before the checks (config, sign-in), reported first. */
  before?: Problem[];
}

export async function checkAll(input: CheckInput, d: DoctorDeps): Promise<Report> {
  const ok: string[] = [];
  const problems: Problem[] = [...(input.before ?? [])];
  const add = (p: Problem) => problems.push(p);

  const major = Number(d.nodeVersion.split(".")[0]);
  if (!Number.isFinite(major) || major < NODE_MIN_MAJOR) {
    add({ code: "node_too_old", severity: "fail", detail: `Node.js ${d.nodeVersion} is older than ${NODE_MIN_MAJOR}`, fix: `install Node.js ${NODE_MIN_MAJOR} or newer (https://nodejs.org), then: npm install -g @primusclaw/connector` });
  } else ok.push(`Node.js ${d.nodeVersion}`);
  if (d.systemCa?.kind === "applied") ok.push(`Node.js trusts this machine's CA store (${d.systemCa.count} certificate${d.systemCa.count === 1 ? "" : "s"}) as well as its own list`);

  // Each agent: its program, its sign-in, its folders. In parallel: each sign-in check may start a program.
  const servicePath = input.by === "doctor" ? await installedServicePath(input.dirs) : null;
  // An agent that takes over existing conversations with the same program and folders as another (the one a `claude` agent
  // brings by itself, config.ts existingSessionAgents) has that agent's problems: said once, on the agent that starts sessions.
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  const checked = input.agents.filter((a) => !(a.attach && input.agents.some((b) => !b.attach && b.command === a.command && same(b.args, a.args) && same(b.roots, a.roots))));
  const perAgent = await Promise.all(checked.map(async (a) => {
    const env = agentEnv(d.env, a);
    const family = familyOf(a);
    const out: { ok: string[]; problems: Problem[] } = { ok: [], problems: [] };
    const found = await which(a.command, env.PATH);
    if (!found) {
      out.problems.push({ code: "agent_cli_missing", severity: "fail", agent: a.id, detail: `${a.command} (the program agent ${a.id} runs) is not on PATH`, fix: installFix(a.command, family) });
    } else {
      out.ok.push(`${a.id}: ${a.command} is ${found}`);
      // The service starts the agents with the PATH it was installed with, not this shell's.
      if (servicePath !== null && a.env.PATH === undefined && !(await which(a.command, servicePath))) {
        out.problems.push({ code: "service_path_missing", severity: "fail", agent: a.id, detail: `the installed service's PATH does not find ${a.command}, so the service cannot start agent ${a.id}`, fix: "claw-connector service install  (run it again from this shell: it carries this shell's PATH into the service)" });
      }
    }
    if (family === "claude") {
      const signed = await claudeSignedIn(env, d);
      if (signed === false) out.problems.push({ code: "agent_not_signed_in", severity: "fail", agent: a.id, detail: "Claude Code is not signed in on this machine", fix: LOGIN_FIX.claude });
      else if (signed) out.ok.push(`${a.id}: Claude Code is signed in`);
      // A running Claude Code whose registry row is unreadable: the conversations in its folder are shown as "cannot tell"
      // and cannot be taken over while its row stays unreadable (Claude Code never writes a torn row again).
      const configDir = path.resolve(env.CLAUDE_CONFIG_DIR?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".claude"));
      // (a stalled disk gives no answer within FS_TIMEOUT_MS: nothing said, as for every other file the check reads)
      for (const b of (await within(blindHolders(configDir).catch(() => []))) ?? []) {
        out.problems.push({ code: "claude_registry_row_unreadable", severity: "warn", agent: a.id,
          detail: `Claude Code process ${b.pid}${b.cwd ? ` (in ${b.cwd})` : ""} is running, but ${path.join(configDir, "sessions", `${b.pid}.json`)} cannot be read: the conversations in its folder are shown as "cannot tell" and are not offered to take over`,
          fix: "exit that Claude Code and start it again there (claude --resume): it never writes a torn row again" });
      }
    } else if (family === "codex") {
      const auth = await codexAuth(env, d);
      if (auth && !auth.ok) out.problems.push({ code: "agent_not_signed_in", severity: "fail", agent: a.id, detail: auth.detail, fix: auth.fix });
      else if (auth?.ok) out.ok.push(`${a.id}: Codex can sign in`);
    }
    for (const root of a.roots) {
      const why = (await within(Promise.resolve(d.writable(root)), d.fsTimeoutMs)) ?? "ETIMEDOUT";
      if (why === "ETIMEDOUT") continue;   // (the disk did not answer: no verdict, and the check did not wait on it)
      if (why === null) out.ok.push(`${a.id}: ${root} is writable`);
      else {
        out.problems.push(why === "ENOENT"
          ? { code: "root_missing", severity: "fail", agent: a.id, detail: `${root} (a root of agent ${a.id}) does not exist`, fix: `mkdir -p ${shq(root)}  (or change roots in agents.toml)` }
          : { code: "root_not_writable", severity: "fail", agent: a.id, detail: `${root} (a root of agent ${a.id}) is not writable by ${d.user || "this user"}${why === "EROFS" ? " (a read-only file system)" : ""}`, fix: await rootFix(root, why, d) });
      }
    }
    return out;
  }));
  for (const r of perAgent) { ok.push(...r.ok); problems.push(...r.problems); }

  // Proxy variables. git and curl read the lower-case ones first; one set to something else (or to "") wins silently.
  for (const [upper, lower] of [["HTTPS_PROXY", "https_proxy"], ["HTTP_PROXY", "http_proxy"], ["NO_PROXY", "no_proxy"]] as const) {
    const u = d.env[upper];
    const l = d.env[lower];
    if (u !== undefined && l !== undefined && u !== l) {
      add({ code: "proxy_mismatch", severity: "warn", detail: `${upper} and ${lower} are set to different values${l === "" || u === "" ? " (one of them is empty)" : ""}; agents that read ${lower} (git, curl) take ${l === "" ? "no proxy" : "the other one"}`, fix: `export ${lower}="$${upper}"  (or unset the one you do not mean)` });
    }
  }
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const v = d.env[name];
    if (!v) continue;
    try { new URL(v); } catch { add({ code: "proxy_invalid", severity: "warn", detail: `${name} is not a URL`, fix: `export ${name}=http://HOST:PORT  (or unset it)` }); }
  }

  // Something must bring the connector back after it dies and after the machine restarts.
  await checkSupervisor(input, d, ok, add);

  if (input.by === "doctor" && input.server) {
    const r = await d.get(`${input.server.replace(/\/+$/, "")}/health`);
    const shown = withoutUserinfo(input.server);
    if ("status" in r && r.status < 500) ok.push(`Claw answers at ${shown}`);
    else {
      const why = "status" in r ? `HTTP ${r.status}` : r.error;
      const proxied = ["HTTPS_PROXY", "https_proxy"].some((k) => set(d.env, k));
      // A Claw behind a company CA: the connector trusts this machine's CA store as well as Node's own list (system-ca.ts),
      // so what is left to say depends on whether it could.
      const untrusted = /certificate|self[- ]signed|UNABLE_TO_GET_ISSUER|CERT_/i.test(why);
      if (untrusted) {
        const { detail, fix } = untrustedAdvice(d.systemCa ?? null, d.nodeVersion);
        add({ code: "claw_tls_untrusted", severity: "fail", detail: `Node.js does not trust the certificate of ${shown} (${why.split(input.server).join(shown)})${detail}`, fix });
      } else add({
        code: "claw_unreachable", severity: "fail", detail: `${shown} does not answer (${why.split(input.server).join(shown)})`,
        fix: proxied && !set(d.env, "NODE_USE_ENV_PROXY")
          ? "export NODE_USE_ENV_PROXY=1  (Node.js only uses HTTPS_PROXY when it is set; needs Node 22.21+ or 24+), then run the connector again"
          : `check that this machine reaches it: curl -sS ${shown.replace(/\/+$/, "")}/health`,
      });
    }
  }
  return { checked_at: new Date(d.now()).toISOString(), by: input.by, ok, problems: dedupe(problems) };
}

const AGAIN = "then run the connector again; an installed service: claw-connector service install again so it carries it";

/** What to say about a certificate Node.js does not trust, given what the connector did about the machine's CA store. */
function untrustedAdvice(ca: SystemCaOutcome | null, nodeVersion: string): { detail: string; fix: string } {
  switch (ca?.kind) {
    case "applied":
      return {
        detail: `, although the connector trusts this machine's CA store (${ca.count} certificate${ca.count === 1 ? "" : "s"}) as well as Node.js's own list`,
        fix: "add the CA that signed Claw's certificate to this machine's trusted CAs (Debian/Ubuntu: copy it to /usr/local/share/ca-certificates/ and run update-ca-certificates), or export NODE_EXTRA_CA_CERTS=/path/to/ca.pem; " + AGAIN,
      };
    case "disabled":
      return { detail: "; NODE_USE_SYSTEM_CA=0 keeps the connector from trusting this machine's CA store", fix: `unset NODE_USE_SYSTEM_CA  (the connector then trusts the CAs this machine trusts; or NODE_EXTRA_CA_CERTS=/path/to/ca.pem), ${AGAIN}` };
    case "unsupported":
      return {
        detail: `; Node.js ${nodeVersion} cannot add this machine's CA store from inside the connector (22.19+ and 24.5+ can)`,
        fix: ca.flag
          ? `install Node.js 22.19+ or 24.5+ (the connector then trusts the CAs this machine trusts by itself), or export NODE_OPTIONS=--use-system-ca, or NODE_EXTRA_CA_CERTS=/path/to/ca.pem; ${AGAIN}`
          : `install Node.js 22.19+ or 24.5+ (the connector then trusts the CAs this machine trusts by itself), or export NODE_EXTRA_CA_CERTS=/path/to/ca.pem; ${AGAIN}`,
      };
    case "empty":
      return {
        detail: `; this machine's CA store ${ca.error ? `could not be read (${ca.error})` : "is empty"}`,
        fix: `install the CA certificates (Debian/Ubuntu: apt-get install ca-certificates) and add the CA that signed Claw's certificate, or export NODE_EXTRA_CA_CERTS=/path/to/ca.pem; ${AGAIN}`,
      };
    default:
      return { detail: "", fix: `export NODE_USE_SYSTEM_CA=1  (Node.js then trusts the CAs this machine trusts; or NODE_EXTRA_CA_CERTS=/path/to/ca.pem), ${AGAIN}` };
  }
}

/** A URL as it may be shown: its scheme, host and path only (a user name, password, query or fragment may hold a credential). */
function withoutUserinfo(v: string): string {
  try { const u = new URL(v); return `${u.protocol}//${u.host}${u.pathname === "/" && !v.endsWith("/") ? "" : u.pathname}`; } catch { return v.replace(/\/\/[^/@]*@/, "//").replace(/[?#].*$/, ""); }
}

/** The same problem found twice (two agents sharing a root): reported once. */
function dedupe(ps: Problem[]): Problem[] {
  const seen = new Set<string>();
  return ps.filter((p) => { const k = `${p.code}\u0000${p.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** What makes a root writable: another disk, chmod of one's own folder, or another folder when it is someone else's. */
async function rootFix(root: string, why: string, d: DoctorDeps): Promise<string> {
  if (why === "EROFS") return "pick a root on a writable disk in agents.toml";
  const owner = await within(fsp.stat(root).then((st) => st.uid, () => null));
  if (owner !== null && d.uid !== null && owner !== d.uid) return `pick a root you own in agents.toml (${root} belongs to uid ${owner})`;
  return `chmod u+w ${shq(root)}  (or pick a root you own in agents.toml)`;
}

export const shq = (s: string) => (/^[A-Za-z0-9_./~:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

async function installedSupervisorOf(dirs: Dirs): Promise<string | null> {
  const v = await readJson(serviceFile(dirs));
  return v && typeof v.supervisor === "string" ? v.supervisor : null;
}

async function checkSupervisor(input: CheckInput, d: DoctorDeps, ok: string[], add: (p: Problem) => void): Promise<void> {
  const sup = await installedSupervisorOf(input.dirs);
  if (sup === null) {
    // A connector run by hand is fine until the machine restarts; then nothing starts it.
    add({ code: "no_service", severity: "warn", detail: "the connector is not installed as a service: nothing starts it again after it dies or the machine restarts", fix: "claw-connector service install" });
    return;
  }
  if (sup === "systemd") {
    if (d.platform !== "linux") return;
    const linger = await d.exec("loginctl", ["show-user", d.user, "-p", "Linger", "--value"]);
    if (linger.code === 0 && linger.out.trim() !== "yes") {
      add({ code: "linger_off", severity: "warn", detail: "the systemd user service stops when you log out and does not start at boot", fix: `loginctl enable-linger ${d.user}` });
    } else ok.push("service: systemd --user");
    return;
  }
  if (sup === "script") {
    // Measured, not guessed: keepalive.sh records each run. A recent run means something calls it (cron, a startup
    // hook, a Kubernetes CronJob); only when none is recent is the crontab read, which misses the other two.
    const last = (await within(fsp.stat(keepaliveStampFile(input.dirs)).then((st) => st.mtimeMs, () => 0))) ?? 0;
    if (d.now() - last <= KEEPALIVE_STALE_MS) { ok.push("service: keep-alive script, called recently"); return; }
    const script = keepaliveFile(input.dirs);
    const tab = await d.crontab();
    if (tab !== null && tab.split("\n").some((l) => !l.trim().startsWith("#") && l.includes(script))) { ok.push("service: keep-alive script in crontab"); return; }
    add({
      code: "keepalive_not_scheduled", severity: "warn",
      detail: `nothing has run ${script} in the last ${KEEPALIVE_STALE_MS / 60_000} minutes: after a restart the connector stays offline`,
      fix: `add to crontab -e (or the container's startup hook): */5 * * * * sh ${script}`,
    });
    return;
  }
  ok.push(`service: ${sup}`);
}

/**
 * The PATH the installed service starts the connector (and so its agents) with, read from what `service install`
 * wrote: the keep-alive script, the systemd unit or the LaunchAgent. Null when no service is installed or the file
 * carries no PATH (the supervisor's default then applies, which this cannot know).
 */
export async function installedServicePath(dirs: Dirs, home: string = os.homedir(), xdgConfig?: string): Promise<string | null> {
  const v = await readJson(serviceFile(dirs));
  if (!v) return null;
  if (typeof v.path === "string") return v.path;
  if (v.supervisor === "script") {
    const m = (await readText(keepaliveFile(dirs)))?.match(/^export PATH='((?:[^']|'\\'')*)'$/m);
    return m ? m[1].replace(/'\\''/g, "'") : null;
  }
  if (v.supervisor === "systemd") {
    const unit = await readText(path.join(xdgConfig?.trim() || path.join(home, ".config"), "systemd", "user", "claw-connector.service"));
    const m = unit?.match(/^Environment="PATH=((?:[^"\\]|\\.)*)"$/m);
    return m ? m[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%") : null;
  }
  if (v.supervisor === "launchd") {
    const plist = await readText(path.join(home, "Library", "LaunchAgents", "com.primusclaw.connector.plist"));
    const m = plist?.match(/<key>PATH<\/key><string>([^<]*)<\/string>/);
    return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&") : null;
  }
  return null;
}

// --- the report a heartbeat carries ------------------------------------------------------------

export interface AgentHealth {
  checked_at: string;
  problems: Array<{ code: string; severity: Severity; scope: "agent" | "machine"; detail: string; fix: string }>;
}

/**
 * What one agent's descriptor carries: its own problems and the machine's, the failures first, at most `MAX_REPORTED`,
 * each line cut short. `capabilities` are relayed unchanged by Claw (at most 4 KiB with everything else in them).
 */
export function agentHealth(report: Report, agentId: string): AgentHealth {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const mine = report.problems.filter((p) => p.agent === undefined || p.agent === agentId);
  mine.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
  return {
    checked_at: report.checked_at,
    problems: mine.slice(0, MAX_REPORTED).map((p) => ({ code: p.code, severity: p.severity, scope: p.agent === undefined ? "machine" : "agent", detail: cut(p.detail, 200), fix: cut(p.fix, 200) })),
  };
}

export function writeReport(dirs: Dirs, report: Report): void {
  try {
    fs.mkdirSync(dirs.state, { recursive: true, mode: 0o700 });
    const file = doctorFile(dirs);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* best effort: the terminal already shows it */ }
}


/** The terminal's text: what passed, then one block per problem with its fix. */
export function formatReport(r: Report): string[] {
  const lines = r.ok.map((l) => `ok    ${l}`);
  for (const p of r.problems) {
    lines.push(`${p.severity === "fail" ? "FAIL" : "warn"}  ${p.agent ? `${p.agent}: ` : ""}${p.detail}`);
    lines.push(`      fix: ${p.fix}`);
  }
  const fails = r.problems.filter((p) => p.severity === "fail").length;
  const warns = r.problems.length - fails;
  lines.push("");
  lines.push(r.problems.length === 0 ? "No problems found." : `${fails} problem${fails === 1 ? " that stops" : "s that stop"} sessions, ${warns} warning${warns === 1 ? "" : "s"}.`);
  return lines;
}
