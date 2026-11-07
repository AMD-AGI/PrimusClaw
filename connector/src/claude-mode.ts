// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether Claude Code on this machine starts a session in `bypassPermissions`, read from the same settings files the
 * Claude adapter reads, so `status` and `run` can say so before a phone session is closed with `mode_not_enforced`.
 *
 * In that mode the Claude Agent SDK warns that its permission callback will not be invoked, and the connector closes
 * the session (session.ts, `onUnsafeWarning`) unless the owner opted the agent out of per-step approval. Measured on
 * claude-agent-acp 0.99.0 with claude-agent-sdk 0.3.312:
 *  - the start mode is `permissions.defaultMode` of the merged settings: user `settings.json` in the Claude config
 *    directory ($CLAUDE_CONFIG_DIR, else ~/.claude), `.claude/settings.json` and `.claude/settings.local.json` of the
 *    session's directory, and the managed settings file, a later one of these winning;
 *  - `bypassPermissions` is dropped when it comes from the project or local file (the session then starts in
 *    `default`, even when the user file says `bypassPermissions` too);
 *  - only the exact spelling counts (`Bypass` or `bypass` start the session in `default`), and `bypassPermissions`
 *    turns into `default` for root unless IS_SANDBOX is set, or when `permissions.disableBypassPermissionsMode` is
 *    `"disable"`;
 *  - only `bypassPermissions` makes the SDK print the warning. Other modes that do not ask (`acceptEdits`, `auto`)
 *    are switched back to the agent's ask mode when the session opens, so they do not close it.
 * Codex and Cursor print no such warning: their own settings are overridden by the mode the connector sets and reads back.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import { isObject } from "./util.js";

/**
 * The agents this applies to: those that run the Claude adapter (the `claude` preset, or any agent whose command line
 * names claude-agent-acp), recognised by what they run, since `kind` is only a label. A `claude-attach` agent takes over
 * a conversation whose mode was chosen in a terminal, and accepts the adapter's warning while it starts (session.ts,
 * `inheritedWarningOk`), so its sessions are not closed for it.
 */
const isClaude = (a: AgentConfig): boolean => !a.attach && [a.command, ...a.args].some((s) => s.includes("claude-agent-acp"));

type Source = "user" | "project" | "local" | "managed";

export function managedSettingsFile(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

export interface StartModeInput {
  /** The adapter's environment: the connector's own, with the agent's `[agents.env]` over it. */
  env: NodeJS.ProcessEnv;
  /** The session's working directory; null reads only the files that apply in every directory (user, managed). */
  cwd: string | null;
  managedFile?: string;
  euid?: number | null;
}

export interface StartMode {
  /** Whether a new session starts in `bypassPermissions`, as the adapter resolves it. */
  bypass: boolean;
  /** The file that set it, when it does. */
  file: string | null;
  /** Files that exist but could not be read as JSON: the answer may be wrong. */
  unreadable: string[];
}

function readSettings(file: string, unreadable: string[]): Record<string, unknown> | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(file);
    return null;
  }
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch { unreadable.push(file); return null; }
}

/** Whether a new Claude session in `cwd` starts in `bypassPermissions`, read the way claude-agent-acp reads it. */
export function claudeStartMode(o: StartModeInput): StartMode {
  const home = o.env.HOME?.trim() || os.homedir();
  const configDir = o.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const files: [Source, string][] = [
    ["user", path.join(configDir, "settings.json")],
    ...(o.cwd === null ? [] : [
      ["project", path.join(o.cwd, ".claude", "settings.json")] as [Source, string],
      ["local", path.join(o.cwd, ".claude", "settings.local.json")] as [Source, string],
    ]),
    ["managed", o.managedFile ?? managedSettingsFile()],
  ];
  const unreadable: string[] = [];
  let raw: unknown;
  let from: [Source, string] | null = null;
  let disable: unknown;
  for (const [source, file] of files) {
    const s = readSettings(file, unreadable);
    const perms = s && isObject(s.permissions) ? s.permissions : null;
    if (!perms) continue;
    if (perms.defaultMode !== undefined) { raw = perms.defaultMode; from = [source, file]; }
    if (perms.disableBypassPermissionsMode !== undefined) disable = perms.disableBypassPermissionsMode;
  }
  // The SDK ignores this value from a file in the repository; it does not fall back to a lower file then.
  let bypass = raw === "bypassPermissions" && from !== null && from[0] !== "project" && from[0] !== "local";
  if (bypass) {
    const euid = o.euid === undefined ? (process.geteuid?.() ?? null) : o.euid;
    if ((euid === 0 && !o.env.IS_SANDBOX) || disable === "disable") bypass = false;
  }
  return { bypass, file: bypass ? from![1] : null, unreadable };
}

/**
 * For each Claude agent that has no opt-out of per-step approval, a sentence saying that its sessions will be refused,
 * or that the settings could not be read. Only the files that apply wherever a session starts are read (the user's and
 * the managed settings): a repository's `.claude` files cannot switch bypass on, and a session may start in any
 * directory below a root, where a file that switches it off at the root does not apply.
 */
export function noAskWarnings(agents: AgentConfig[], env: NodeJS.ProcessEnv, opts: { managedFile?: string; euid?: number | null } = {}): string[] {
  const out: string[] = [];
  for (const a of agents) {
    if (!isClaude(a) || a.allowUnsafeModes) continue;
    const r = claudeStartMode({ env: { ...env, ...a.env }, cwd: null, ...opts });
    if (r.bypass) {
      out.push(`${a.id}: sessions will be refused (mode_not_enforced): Claude defaults to bypassPermissions here (permissions.defaultMode in ${r.file}); set approval = "never" on this agent or change defaultMode`);
    }
    for (const f of r.unreadable) out.push(`${a.id}: cannot tell whether Claude defaults to bypassPermissions: ${f} is not readable JSON`);
  }
  return out;
}

/** Any agent that runs the Claude adapter, including one that takes over existing sessions. */
const runsClaudeAdapter = (a: AgentConfig): boolean => [a.command, ...a.args].some((s) => s.includes("claude-agent-acp"));

const currentEuid = (euid: number | null | undefined): number | null => (euid === undefined ? (process.geteuid?.() ?? null) : euid);

/**
 * Claude Code withholds `bypassPermissions` from root unless IS_SANDBOX is set (claude-agent-acp 0.99.0:
 * `ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX`): the mode is missing from the adapter's catalog, and a session
 * the owner set to run without per-step approval is refused with `mode_unavailable`. Root is the normal user in a
 * container, where the owner who wrote `approval = "never"` has already chosen not to be asked; so for such a Claude
 * agent the connector sets IS_SANDBOX=1 in that agent's adapter environment, and only there. An agent that names
 * IS_SANDBOX in its own `env` (even as an empty string) is left as the owner wrote it.
 *
 * Mutates `agents` and returns one sentence per agent it changed, for `run` to print.
 */
export function applyRootSandbox(agents: AgentConfig[], env: NodeJS.ProcessEnv, opts: { euid?: number | null } = {}): string[] {
  if (currentEuid(opts.euid) !== 0 || env.IS_SANDBOX) return [];
  const out: string[] = [];
  for (const a of agents) {
    if (!runsClaudeAdapter(a) || !a.allowUnsafeModes || Object.hasOwn(a.env, "IS_SANDBOX")) continue;
    a.env = { ...a.env, IS_SANDBOX: "1" };
    out.push(`${a.id}: running as root, where Claude Code offers bypassPermissions only with IS_SANDBOX set; set IS_SANDBOX=1 for this agent's adapter because it runs without per-step approval`);
  }
  return out;
}

/**
 * For each Claude agent the owner let run without per-step approval, a sentence saying that its sessions will be
 * refused with `mode_unavailable` because Claude Code will not offer `bypassPermissions` here, and how to fix it.
 * Read after `applyRootSandbox`, so root without IS_SANDBOX is reported only where the owner kept IS_SANDBOX unset.
 */
export function bypassUnavailableWarnings(agents: AgentConfig[], env: NodeJS.ProcessEnv, opts: { managedFile?: string; euid?: number | null } = {}): string[] {
  const out: string[] = [];
  const euid = currentEuid(opts.euid);
  for (const a of agents) {
    if (!runsClaudeAdapter(a) || !a.allowUnsafeModes || a.askMode !== "bypassPermissions") continue;
    const merged = { ...env, ...a.env };
    if (euid === 0 && !merged.IS_SANDBOX) {
      out.push(`${a.id}: sessions will be refused (mode_unavailable): Claude Code offers bypassPermissions to root only with IS_SANDBOX set, and this agent's env sets IS_SANDBOX to an empty value; remove IS_SANDBOX from its env, or set approval = "ask"`);
      continue;
    }
    const home = merged.HOME?.trim() || os.homedir();
    const configDir = merged.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
    const unreadable: string[] = [];
    for (const file of [path.join(configDir, "settings.json"), opts.managedFile ?? managedSettingsFile()]) {
      const s = readSettings(file, unreadable);
      const perms = s && isObject(s.permissions) ? s.permissions : null;
      if (perms?.disableBypassPermissionsMode === "disable") {
        out.push(`${a.id}: sessions will be refused (mode_unavailable): permissions.disableBypassPermissionsMode is "disable" in ${file}, so Claude Code does not offer bypassPermissions; remove that setting, or set approval = "ask" on this agent`);
        break;
      }
    }
  }
  return out;
}
