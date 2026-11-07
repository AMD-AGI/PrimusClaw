// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the connector gets Claude Code's ACP adapter (claude-agent-acp 0.99.0) to offer, or withhold, the one mode that
 * never asks: `bypassPermissions`.
 *
 * Measured on that adapter:
 *  - it offers `bypassPermissions` only when `!IS_ROOT || IS_SANDBOX`, and never when the merged settings set
 *    `permissions.disableBypassPermissionsMode` to `"disable"`; an agent with `approval = "never"` runs in that mode, so
 *    as root without IS_SANDBOX each of its sessions was refused with `mode_unavailable` (applyRootSandbox);
 *  - a session starts in the merged settings' `permissions.defaultMode`, and in `bypassPermissions` the SDK warns that it
 *    will not ask, which closes a session of an agent that must ask (`mode_not_enforced`); with
 *    `_meta.claudeCode.options.allowDangerouslySkipPermissions = false` on `session/new|resume|load` the adapter leaves
 *    bypass out and starts such a session in `default` instead (claudeSessionMeta).
 * Codex (codex-acp 2.3.0) offers the same four modes to root and to anyone else. Cursor is checked by `doctor`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "./config.js";
import { isObject } from "./util.js";

export function managedSettingsFile(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
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

/** Any agent that runs the Claude adapter, including one that takes over existing sessions. */
export const runsClaudeAdapter = (a: AgentConfig): boolean => [a.command, ...a.args].some((s) => s.includes("claude-agent-acp"));

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

/**
 * What a Claude agent that asks before every step sends with `session/new|resume|load`: claude-agent-acp 0.99.0 then
 * leaves bypassPermissions out entirely (`allowBypass` is false when `_meta.claudeCode.options.allowDangerouslySkipPermissions`
 * is false), so a user whose own Claude settings default to bypassPermissions gets a session that starts in `default`
 * and asks, instead of one the connector has to close (`mode_not_enforced`). Not for an agent the owner let run without
 * approval (it needs the mode), nor for `claude-attach`, which takes over a conversation in the mode its terminal chose.
 */
export function claudeSessionMeta(a: AgentConfig): Record<string, unknown> {
  if (!runsClaudeAdapter(a) || a.attach || a.allowUnsafeModes) return {};
  return { _meta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } } };
}
