// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `claw-connector pair <code> --server URL`: connect this machine with the one-time code a person's chat client gave them.
 *
 * Running it is the approval: the code is traded at Claw (`POST /v1/remote-agents/pairings/claim`, anonymous, the code is
 * the credential) for a connector grant, saved like any sign-in (0600). With no `agents.toml` yet, one is written for the
 * agents found on this machine, working in the folder the command was run in. Then the connector is started as a service
 * (`service install`; a container without systemd gets the keep-alive supervisor), so the machine is online seconds later
 * and stays so. A connector already running here is stopped first: it holds the previous sign-in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseConfig, type ConnectorConfig } from "./config.js";
import { saveCredentials } from "./credentials.js";
import { clearNeedsLogin } from "./health.js";
import { configFile, credentialsFile, identityFile } from "./paths.js";
import { errMessage, isObject, secureUrl } from "./util.js";
import type { Ctx } from "./commands.js";

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
}

const USAGE = "usage: claw-connector pair <code> --server <Claw API URL> [--name <machine name>] [--no-start]";

/** Which of `DETECTED_AGENTS` have their program on `PATH`. */
export function detectAgents(env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const found = (bin: string) => dirs.some((d) => exts.some((x) => {
    try { return fs.statSync(path.join(d, bin + x)).isFile(); } catch { return false; }
  }));
  return DETECTED_AGENTS.filter((a) => found(a.binary)).map((a) => a.preset);
}

/** The `agents.toml` pairing writes: the server, the machine's name, and each agent asking before it acts, in `root`. */
export function pairedConfig(o: { server: string; name: string; agents: string[]; root: string }): string {
  const q = (s: string) => JSON.stringify(s);
  const blocks = o.agents.map((id) => `[[agents]]\nid = ${q(id)}\npreset = ${q(id)}\nroots = [${q(o.root)}]`);
  return `# Written by "claw-connector pair". Everything that limits an agent lives here, on your machine; nothing Claw sends can
# widen it. Each agent asks before it writes a file or runs a command, and your phone answers each question.
# roots: the directories an agent may work in. Add more, then run: claw-connector service install
# See "claw-connector init" for a sample with every option.

server = ${q(o.server)}
name = ${q(o.name)}

${blocks.join("\n\n")}
`;
}

/** The folder agents get: where the command was run, unless that is the root of the filesystem. */
export function defaultRoot(cwd: string): string {
  const abs = path.resolve(cwd);
  return abs === path.parse(abs).root ? os.homedir() : abs;
}

export async function cmdPair(args: string[], ctx: Ctx, deps: PairDeps): Promise<number> {
  let values: { server?: string; name?: string; "no-start"?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args, strict: true, allowPositionals: true,
      options: { server: { type: "string" }, name: { type: "string" }, "no-start": { type: "boolean" } },
    }));
  } catch (e) { ctx.err(`${errMessage(e)}\n${USAGE}`); return 2; }
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
  const name = (values.name ?? cfg?.name ?? ctx.hostname ?? os.hostname()).trim().slice(0, 64);

  // 1. The code, traded for a grant. Nothing is written before Claw has said yes.
  const f = ctx.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${server}/v1/remote-agents/pairings/claim`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, name }), signal: AbortSignal.timeout(20_000),
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

  // 2. What may run here: an agents.toml of its own when there is none.
  if (!cfg) {
    let agents = detectAgents(ctx.env);
    const none = agents.length === 0;
    if (none) agents = ["claude"];
    const root = defaultRoot(ctx.cwd ?? process.cwd());
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true, mode: 0o700 });
    try {
      // "wx": created only if it is still not there, in one step.
      fs.writeFileSync(cfgFile, pairedConfig({ server, name, agents, root }), { mode: 0o600, flag: "wx" });
      ctx.out(`wrote ${cfgFile}: ${agents.join(", ")}, working in ${root}, asking before every write and command`);
      if (none) ctx.out("no claude, codex or cursor-agent on PATH: claude is offered; install Claude Code, or edit the file for another agent");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
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
  fs.rmSync(identityFile(ctx.dirs), { force: true });
  clearNeedsLogin(ctx.dirs);
  ctx.out(`paired "${name}" with ${server}`);

  // 4. Started, and kept up.
  if (values["no-start"]) { ctx.out("not started (--no-start). Start it with: claw-connector service install   (or: claw-connector run)"); return 0; }
  const rc = await deps.start(ctx);
  if (rc !== 0) {
    ctx.err("paired, but the connector could not be started as a service; run it in the foreground with: claw-connector run");
    return rc;
  }
  ctx.out(`"${name}" is coming online; the chat will tell you when it is connected.`);
  return 0;
}
