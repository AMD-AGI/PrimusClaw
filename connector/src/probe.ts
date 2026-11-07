// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `doctor` (and `init` from the command line): start each agent's adapter the way a phone session would, ask it for a
 * session (`initialize` and `session/new`, no prompt, so no model is called), and compare the modes it offers with the
 * modes this machine's agents.toml needs. A mismatch is said here, with the fix, instead of on the phone as a refused
 * session (`mode_unavailable`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdapterProcess, type AcpParams } from "./adapter.js";
import { ChildRegistry } from "./children.js";
import type { AgentConfig } from "./config.js";
import { errMessage, isObject } from "./util.js";

export interface ProbeResult {
  agent: string;
  /** The directory the probe session was opened in. */
  cwd: string;
  /** Whether a phone session of this agent would open in its ask mode. */
  ok: boolean;
  /** The modes the adapter offered; null when it never answered `session/new`. */
  modes: string[] | null;
  problems: string[];
  notes: string[];
}

export type ProbeFn = (agents: AgentConfig[], o: { logDir: string; version: string; timeoutMs?: number }) => Promise<ProbeResult[]>;

/** Why Claude Code leaves bypassPermissions out, and what fixes it, for the sentence that says it is missing. */
const BYPASS_FIX = `Claude Code offers bypassPermissions to root only with IS_SANDBOX set (the connector sets it for an agent with approval = "never" unless its env names IS_SANDBOX), and never when permissions.disableBypassPermissionsMode is "disable" in its settings; fix that, or set approval = "ask" on this agent`;

function modesOf(res: AcpParams): string[] | null {
  const m = isObject(res.modes) ? res.modes : null;
  if (m && Array.isArray(m.availableModes)) return m.availableModes.filter((x: unknown) => isObject(x) && typeof x.id === "string").map((x: AcpParams) => x.id as string);
  const opt = Array.isArray(res.configOptions) ? res.configOptions.find((o: unknown) => isObject(o) && o.category === "mode") : null;
  if (isObject(opt) && Array.isArray(opt.options)) return opt.options.filter((x: unknown) => isObject(x) && typeof x.value === "string").map((x: AcpParams) => x.value as string);
  return null;
}

/** The first root that exists: a session's directory is always one of them or below. */
const probeDir = (a: AgentConfig): string => a.roots.find((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } }) ?? os.homedir();

export async function probeAgent(a: AgentConfig, o: { logDir: string; version: string; timeoutMs?: number }): Promise<ProbeResult> {
  const cwd = probeDir(a);
  const out: ProbeResult = { agent: a.id, cwd, ok: false, modes: null, problems: [], notes: [] };
  if (!a.roots.includes(cwd)) out.notes.push(`no root of this agent exists yet (${a.roots.join(", ")}); probed in ${cwd}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-probe-"));
  const registry = new ChildRegistry(path.join(tmp, "children.json"));
  const timeoutMs = o.timeoutMs ?? 120_000;
  let adapter: AdapterProcess | null = null;
  try {
    adapter = await AdapterProcess.start({
      cfg: a, registry, sessionId: `probe-${a.id}`, cwd, logFile: path.join(o.logDir, `adapter-${a.id}.log`), version: o.version, initTimeoutMs: timeoutMs,
      hooks: {
        onUpdate: () => {}, onNotification: () => {}, onStderr: () => {}, onExit: () => {},
        // No prompt is sent, so nothing should ask; anything that does is refused.
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onExtension: async () => ({}),
      },
    });
    const res = await adapter.request("session/new", { cwd, mcpServers: [] }, timeoutMs);
    out.modes = modesOf(res);
    if (out.modes === null || out.modes.length === 0) {
      out.notes.push("the adapter lists no modes; the connector sets the ask mode and reads it back when a session opens");
      out.ok = true;
      return out;
    }
    if (!out.modes.includes(a.askMode)) {
      out.problems.push(`sessions will be refused (mode_unavailable): this agent's sessions run in ${a.askMode}${a.unattended ? ` (approval = "never")` : ""}, but the adapter offers only ${out.modes.join(", ")}${a.askMode === "bypassPermissions" ? `. ${BYPASS_FIX}` : ""}`);
    }
    const missing = a.safeModes.filter((m) => m !== a.askMode && !out.modes!.includes(m));
    if (missing.length) out.notes.push(`safe_modes lists ${missing.join(", ")}, which the adapter does not offer here; a phone that picks one is refused`);
    out.ok = out.problems.length === 0;
  } catch (e) {
    out.problems.push(`the adapter did not open a session: ${errMessage(e)} (its log: ${path.join(o.logDir, `adapter-${a.id}.log`)})`);
  } finally {
    await adapter?.kill().catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

export const probeAgents: ProbeFn = async (agents, o) => {
  const out: ProbeResult[] = [];
  for (const a of agents) out.push(await probeAgent(a, o));
  return out;
};

/** The lines `doctor` and `init` print for the results. */
export function probeLines(results: ProbeResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.agent}: ${r.ok ? "ok" : "PROBLEM"}${r.modes ? ` (modes: ${r.modes.join(", ")})` : ""}`);
    for (const p of r.problems) lines.push(`  problem: ${p}`);
    for (const n of r.notes) lines.push(`  note: ${n}`);
  }
  return lines;
}
