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

/** The agent kinds that run the Claude adapter (the `claude` and `claude-attach` presets). */
const CLAUDE_KINDS = new Set(["claude", "attach"]);

type Source = "user" | "project" | "local" | "managed";

export function managedSettingsFile(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

export interface StartModeInput {
  /** The adapter's environment: the connector's own, with the agent's `[agents.env]` over it. */
  env: NodeJS.ProcessEnv;
  /** The session's working directory. */
  cwd: string;
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
    ["project", path.join(o.cwd, ".claude", "settings.json")],
    ["local", path.join(o.cwd, ".claude", "settings.local.json")],
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
 * or that the settings could not be read. Checked with each root as the session's directory.
 */
export function noAskWarnings(agents: AgentConfig[], env: NodeJS.ProcessEnv, opts: { managedFile?: string; euid?: number | null } = {}): string[] {
  const out: string[] = [];
  for (const a of agents) {
    if (!CLAUDE_KINDS.has(a.kind) || a.allowUnsafeModes) continue;
    const agentEnv = { ...env, ...a.env };
    const files = new Set<string>();
    const unreadable = new Set<string>();
    for (const root of a.roots) {
      const r = claudeStartMode({ env: agentEnv, cwd: root, ...opts });
      if (r.bypass && r.file) files.add(r.file);
      for (const f of r.unreadable) unreadable.add(f);
    }
    if (files.size) {
      out.push(`${a.id}: sessions will be refused (mode_not_enforced): Claude defaults to bypassPermissions here (permissions.defaultMode in ${[...files].join(", ")}); set approval = "never" on this agent or change defaultMode`);
    }
    for (const f of unreadable) out.push(`${a.id}: cannot tell whether Claude defaults to bypassPermissions: ${f} is not readable JSON`);
  }
  return out;
}
