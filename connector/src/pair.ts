// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `claw-connector pair <code> --server URL`: connect this machine with the one-time code a person's chat client gave them.
 *
 * Running it is the approval: the code is traded at Claw (`POST /v1/remote-agents/pairings/claim`, anonymous, the code is
 * the credential) for a connector grant, saved like any sign-in (0600). With no `agents.toml` yet, one is written for the
 * agents found on this machine that can sign in (one installed but not signed in is written commented out, with the command
 * that makes it usable), working in the folder the command was run in. The Claude Code hooks are offered as `init` offers
 * them (at a terminal, one question whose default is yes; the session hooks and the approval hooks, so a question a terminal
 * asks also reaches the chat). Then the connector is started as a service
 * (`service install`; a container without systemd gets the keep-alive supervisor), so the machine is online seconds later
 * and stays so. A connector already running here is stopped first: it holds the previous sign-in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseConfig, type ConnectorConfig } from "./config.js";
import { saveCredentials } from "./credentials.js";
import { defaultDeps, presetSignInProblem } from "./doctor.js";
import { clearNeedsLogin } from "./health.js";
import { configFile, credentialsFile, forgetIdentity } from "./paths.js";
import { errMessage, isObject, secureUrl } from "./util.js";
import type { Ctx, HookChoice } from "./commands.js";

/** Agents `pair` offers when it writes `agents.toml`: the preset, and the program on PATH that shows it is installed. */
export const DETECTED_AGENTS: ReadonlyArray<{ preset: string; binary: string }> = [
  { preset: "claude", binary: "claude" },
  { preset: "codex", binary: "codex" },
  { preset: "cursor", binary: "cursor-agent" },
];

export interface PairDeps {
  /** Stop a connector running here (it holds the previous sign-in). */
  stop: (ctx: Ctx) => Promise<unknown>;
  /** Start it as a service: `service install`, or the installed service again. */
  start: (ctx: Ctx) => Promise<number>;
  runningPid: (ctx: Ctx) => number | null;
  /** Offer the Claude Code hooks (commands.ts `setupHooks`); never fails the pairing. */
  hooks?: (ctx: Ctx, o: HookChoice) => Promise<void>;
}

const USAGE = "usage: claw-connector pair <code> --server <Claw API URL> [--name <machine name>] [--no-start] [--hooks | --no-hooks] [--no-approval-hooks]";

/** The account the command runs as, for {@link alternateName}. */
function userName(env: NodeJS.ProcessEnv): string | null {
  try { return env.USER ?? env.LOGNAME ?? os.userInfo().username; } catch { return null; }
}

/** Which of `DETECTED_AGENTS` have their program on `PATH`. */
export function detectAgents(env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const found = (bin: string) => dirs.some((d) => exts.some((x) => {
    try { return fs.statSync(path.join(d, bin + x)).isFile(); } catch { return false; }
  }));
  return DETECTED_AGENTS.filter((a) => found(a.binary)).map((a) => a.preset);
}

/** An agent installed here that cannot be used yet: what is missing, and the one command that fixes it. */
export interface ParkedAgent { id: string; why: string; fix: string }

/**
 * The `agents.toml` pairing writes: the server, the machine's name, and each agent asking before it acts, in `root`. An agent in
 * `parked` (installed, not signed in) is written commented out, with what to run before it is turned on.
 */
export function pairedConfig(o: { server: string; name: string; agents: string[]; root: string; parked?: ParkedAgent[] }): string {
  const q = (s: string) => JSON.stringify(s);
  const one = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const block = (id: string) => `[[agents]]\nid = ${q(id)}\npreset = ${q(id)}\nroots = [${q(o.root)}]`;
  const blocks = [
    ...o.agents.map(block),
    ...(o.parked ?? []).map((p) => [
      `# ${p.id} is installed here but cannot be used yet: ${one(p.why)}.`,
      `# To offer it: ${one(p.fix)}; then remove the "# " in front of the four lines below and run: claw-connector service install`,
      ...block(p.id).split("\n").map((l) => `# ${l}`),
    ].join("\n")),
  ];
  return `# Written by "claw-connector pair". Everything that limits an agent lives here, on your machine; nothing Claw sends can
# widen it. Each agent asks before it writes a file or runs a command, and your phone answers each question.
# roots: the directories an agent may work in. Add more, then run: claw-connector service install
# See "claw-connector init" for a sample with every option.

server = ${q(o.server)}
name = ${q(o.name)}

${blocks.join("\n\n")}
`;
}

/**
 * Which agents `pair` turns on: those installed here that can sign in (or of which that cannot be told). An installed one that
 * cannot is parked, unless none can: an agents.toml needs one, so the first installed (else claude) is turned on anyway and
 * `unready` says what it needs.
 */
export async function chooseAgents(env: NodeJS.ProcessEnv, signIn: (preset: string) => Promise<{ detail: string; fix: string } | null>): Promise<{
  installed: string[]; agents: string[]; parked: ParkedAgent[]; unready: ParkedAgent[];
}> {
  const installed = detectAgents(env);
  const checked = await Promise.all(installed.map(async (id) => ({ id, problem: await signIn(id).catch(() => null) })));
  const ready = checked.filter((c) => !c.problem).map((c) => c.id);
  const agents = ready.length ? ready : [installed[0] ?? "claude"];
  const notReady = checked.flatMap((c) => (c.problem ? [{ id: c.id, why: c.problem.detail, fix: c.problem.fix }] : []));
  return { installed, agents, parked: notReady.filter((p) => !agents.includes(p.id)), unready: notReady.filter((p) => agents.includes(p.id)) };
}

/**
 * The name to pair under when the hostname is already another of the person's machines (Claw decides; `alternate_name`): the
 * hostname and the folder the agents work in, or the user when that folder is the home directory. Two folders on one machine,
 * or two containers with one hostname, would otherwise be two machines of one name.
 */
export function alternateName(host: string, root: string, user: string | null): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 24);
  const atHome = path.resolve(root) === path.resolve(os.homedir());
  const tail = clean(atHome ? (user ?? "") : path.basename(root)) || clean(user ?? "");
  return tail ? `${host.slice(0, 63 - tail.length)}-${tail}` : host;
}

/** The folder agents get: where the command was run, unless that is the root of the filesystem. */
export function defaultRoot(cwd: string): string {
  const abs = path.resolve(cwd);
  return abs === path.parse(abs).root ? os.homedir() : abs;
}

export async function cmdPair(args: string[], ctx: Ctx, deps: PairDeps): Promise<number> {
  let values: { server?: string; name?: string; "no-start"?: boolean; hooks?: boolean; "no-hooks"?: boolean; "no-approval-hooks"?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args, strict: true, allowPositionals: true,
      options: {
        server: { type: "string" }, name: { type: "string" }, "no-start": { type: "boolean" },
        hooks: { type: "boolean" }, "no-hooks": { type: "boolean" }, "no-approval-hooks": { type: "boolean" },
      },
    }));
  } catch (e) { ctx.err(`${errMessage(e)}\n${USAGE}`); return 2; }
  if (values.hooks && values["no-hooks"]) { ctx.err(`pair: --hooks and --no-hooks contradict each other; pass one\n${USAGE}`); return 2; }
  const code = positionals[0]?.trim();
  if (!code || positionals.length > 1) { ctx.err(USAGE); return 2; }
  const cfgFile = configFile(ctx.dirs);
  // Read once, with no separate existence check: whatever is there now is what `pair` keeps.
  let cfg: ConnectorConfig | null = null;
  let text: string | null = null;
  try { text = fs.readFileSync(cfgFile, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (text !== null) {
    try { cfg = parseConfig(text, { hostname: ctx.hostname ?? os.hostname() }); } catch (e) { ctx.err(`${cfgFile}: ${errMessage(e)}`); return 78; }
  }
  const rawServer = values.server ?? ctx.env.CLAW_URL ?? cfg?.server ?? null;
  if (!rawServer) { ctx.err(`pair needs --server <Claw API URL>\n${USAGE}`); return 2; }
  const server = secureUrl(rawServer.trim(), "the Claw server URL");
  // `run` takes CLAW_URL, then agents.toml, before the sign-in's own server: one that names another Claw would send this
  // grant there. Refused before the code is spent.
  for (const [where, other] of [["CLAW_URL", ctx.env.CLAW_URL], [cfgFile, cfg?.server]] as const) {
    if (other && secureUrl(other.trim(), "the Claw server URL") !== server) {
      ctx.err(`${where} names another Claw (${other.trim()}) than ${server}; the connector would use that one. Change or remove it, then run the same command again.`);
      return 2;
    }
  }
  let name = (values.name ?? cfg?.name ?? ctx.hostname ?? os.hostname()).trim().slice(0, 64);
  // A name nobody chose (the hostname) may be taken by another of their machines: Claw then pairs it under the alternate.
  const root = defaultRoot(ctx.cwd ?? process.cwd());
  const chosen = values.name !== undefined || cfg !== null;
  const alternate = chosen ? null : alternateName(name, root, userName(ctx.env));

  // 1. The code, traded for a grant. Nothing is written before Claw has said yes.
  const f = ctx.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${server}/v1/remote-agents/pairings/claim`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, name, ...(alternate && alternate !== name ? { alternate_name: alternate } : {}) }), signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    ctx.err(`could not reach Claw at ${server} (${errMessage(e)}); check the address and the network, then run the same command again`);
    return 1;
  }
  const body: unknown = await res.json().catch(() => null);
  const err = isObject(body) && typeof body.error === "string" ? body.error : "";
  if (res.status === 400 && err === "invalid_code") {
    ctx.err("that pairing code is not valid: it is wrong, expired (codes last 10 minutes) or already used. Ask for a new one in the chat (\"连接我的开发环境\") and run the new command.");
    return 78;
  }
  if (res.status === 429) { ctx.err("too many pairing attempts from this address; wait a minute and run the same command again"); return 1; }
  const data = isObject(body) && isObject(body.data) ? body.data : null;
  const token = data && typeof data.token === "string" ? data.token : "";
  if (!res.ok || !token) {
    ctx.err(`Claw did not accept the pairing (${err || `HTTP ${res.status}`}); is ${server} the Claw API address the chat gave?`);
    return 1;
  }
  // The name Claw paired it under: the hostname, or the alternate when the hostname is another machine of theirs.
  const given = data && typeof data.name === "string" ? data.name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 64) : "";
  if (!chosen && given && given !== name) {
    ctx.out(`another of your machines is already called "${name}": this one is "${given}" (choose another with --name)`);
    name = given;
  }

  // 2. What may run here: an agents.toml of its own when there is none.
  if (!cfg) {
    // An agent installed but not signed in would only fail every session (and make the machine's health red): left out.
    const doctorDeps = ctx.doctor ?? defaultDeps(ctx.env);
    const { installed, agents, parked, unready } = await chooseAgents(ctx.env, (id) => presetSignInProblem(id, ctx.env, doctorDeps));
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true, mode: 0o700 });
    try {
      // "wx": created only if it is still not there, in one step.
      fs.writeFileSync(cfgFile, pairedConfig({ server, name, agents, root, parked }), { mode: 0o600, flag: "wx" });
      ctx.out(`wrote ${cfgFile}: ${agents.join(", ")}, working in ${root}, asking before every write and command`);
      if (installed.length === 0) ctx.out("no claude, codex or cursor-agent on PATH: claude is offered; install Claude Code, or edit the file for another agent");
      for (const p of parked) {
        ctx.out(`${p.id} is installed but cannot be used yet (${p.why}), so it was left out: its block in ${cfgFile} is commented out. To offer it: ${p.fix}; then uncomment that block and run: claw-connector service install`);
      }
      for (const p of unready) ctx.out(`${p.id}: ${p.why}; its sessions fail until you run: ${p.fix}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Written by something else since it was read: kept, but held to the same rule as one that was there before.
      let appeared: ConnectorConfig;
      try { appeared = parseConfig(fs.readFileSync(cfgFile, "utf8"), { hostname: ctx.hostname ?? os.hostname() }); } catch (err) {
        ctx.err(`${cfgFile} appeared while pairing and cannot be used (${errMessage(err)}); nothing was saved. Fix it, ask for a new code and run the new command.`);
        return 78;
      }
      if (appeared.server && secureUrl(appeared.server.trim(), "the Claw server URL") !== server) {
        ctx.err(`${cfgFile} appeared while pairing and names another Claw (${appeared.server.trim()}); nothing was saved. Change or remove it, ask for a new code and run the new command.`);
        return 78;
      }
      ctx.out(`${cfgFile} appeared meanwhile; left as it is`);
    }
  } else {
    ctx.out(`kept ${cfgFile} as it is (${cfg.agents.map((a) => a.id).join(", ") || "no agents"})`);
  }

  // 3. The grant, as the sign-in. A connector running here holds the previous one: it is stopped first.
  if (deps.runningPid(ctx) !== null) {
    await deps.stop(ctx);
    ctx.out("stopped the connector that was running with the previous sign-in");
  }
  saveCredentials(credentialsFile(ctx.dirs), { v: 1, server, kind: "grant", token, device_name: name, saved_at: new Date().toISOString() });
  // A connector id from an earlier sign-in is not this grant's: the next run registers this machine anew.
  forgetIdentity(ctx.dirs);
  clearNeedsLogin(ctx.dirs);
  ctx.out(`paired "${name}" with ${server}`);

  // 4. The Claude Code hooks, as init offers them: a terminal's questions reach the chat once the connector runs.
  if (deps.hooks) {
    try { await deps.hooks(ctx, { hooks: !!values.hooks, noHooks: !!values["no-hooks"], noApprovals: !!values["no-approval-hooks"] }); } catch (e) {
      ctx.err(`hooks: ${errMessage(e)} (the machine is paired; run: claw-connector hooks install --approvals)`);
    }
  }

  // 5. Started, and kept up.
  if (values["no-start"]) { ctx.out("not started (--no-start). Start it with: claw-connector service install   (or: claw-connector run)"); return 0; }
  const rc = await deps.start(ctx);
  if (rc !== 0) {
    ctx.err("paired, but the connector could not be started as a service; run it in the foreground with: claw-connector run");
    return rc;
  }
  ctx.out(`"${name}" is coming online; the chat will tell you when it is connected.`);
  return 0;
}
