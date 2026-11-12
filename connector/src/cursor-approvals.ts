// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Cursor's side of the approvals asked in a terminal (approvals.ts holds the broker; this file is what is particular to Cursor).
 *
 * What Cursor's hooks can do decides what this can do. Measured on the Cursor Agent CLI 2026.11.11-b912975 (and read in the
 * agent-exec code the 3.27 IDE ships, which is the same):
 *
 * - `beforeShellExecution` and `beforeMCPExecution` run before Cursor decides whether to ask, and Cursor waits for them (60 s
 *   unless the entry sets `timeout`; no upper limit; a hook that fails or times out changes nothing). While one runs the
 *   terminal shows only "Working": its own question appears after the hook has returned, never at the same time.
 * - Of the answers a hook may give, `deny` blocks the call (the agent is told why) and `ask` makes Cursor ask even for a command
 *   on its allow list. `allow` changes nothing: a command not on the allow list is still asked about at the terminal. So a hook
 *   can turn a call down, or let Cursor ask, but it cannot approve one.
 * - Ctrl-C during the wait ends the turn (`stop`, status `aborted`) and leaves the hook running; what it prints later is ignored.
 *
 * So for Cursor the phone goes first and the terminal second: a call Cursor would ask about is put on the phone, and Cursor
 * waits for up to `hold` seconds while it is there. "No" from the phone blocks it; "Ask me at the terminal", or no answer
 * within the hold, lets Cursor ask at the terminal as it always does. There is no "Yes" on the phone, because Cursor would
 * ask at the terminal anyway. A call Cursor would not ask about (on the allow list, run in the sandbox, or with Run
 * Everything on) is not put on the phone and not held, as far as the configuration files say (see {@link cursorWouldAsk}).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardSpec, Mapping } from "./approvals.js";
import { shownInput } from "./approvals.js";
import { redactDeep } from "./redact.js";

/** What a Cursor before-hook prints (`permission` etc.); nothing printed lets Cursor go on as it would have. */
export interface CursorDecision { permission: "deny"; user_message: string; agent_message: string }

/** The hold Cursor waits for the phone when nothing else says (and the bounds `--hold` may set). */
export const CURSOR_HOLD_DEFAULT_S = 60;
export const CURSOR_HOLD_MIN_S = 5;
export const CURSOR_HOLD_MAX_S = 3600;
/** What the agent and the terminal read when the owner turns a call down from the phone. */
export const CURSOR_DENIED_USER = "Declined from your phone (Claw).";
export const CURSOR_DENIED_AGENT = "The user declined this from their phone (Claw).";

/** A Cursor before-hook's request, as far as it is used here. */
export interface CursorEvent {
  event: "beforeShellExecution" | "beforeMCPExecution";
  /** The conversation (Cursor's `conversation_id`): one Claw session each. */
  ref: string;
  cwd: string;
  toolUseId: string | null;
  workspaceRoots: string[];
  /** Shell. */
  command?: string;
  sandbox?: boolean;
  /** MCP. */
  server?: string;
  tool?: string;
  /** MCP: the arguments, parsed when Cursor sent them as JSON text. */
  args?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const oneLine = (s: unknown, max: number): string => {
  const t = typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Parse what Cursor handed a before-hook; null for anything else (the hook then prints nothing and Cursor goes on). */
export function parseCursorEvent(raw: unknown): CursorEvent | null {
  if (!isObject(raw)) return null;
  const event = raw.hook_event_name;
  if (event !== "beforeShellExecution" && event !== "beforeMCPExecution") return null;
  const ref = raw.conversation_id;
  if (typeof ref !== "string" || !REF_RE.test(ref)) return null;
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots.filter((r): r is string => typeof r === "string" && path.isAbsolute(r)) : [];
  const cwd = typeof raw.cwd === "string" && path.isAbsolute(raw.cwd) ? raw.cwd : roots[0];
  if (!cwd) return null;
  const toolUseId = typeof raw.tool_use_id === "string" && raw.tool_use_id !== "" ? raw.tool_use_id : null;
  if (event === "beforeShellExecution") {
    if (typeof raw.command !== "string" || raw.command.trim() === "") return null;
    return { event, ref, cwd, toolUseId, workspaceRoots: roots, command: raw.command, sandbox: raw.sandbox === true };
  }
  if (typeof raw.tool_name !== "string" || raw.tool_name === "") return null;
  let args: unknown = raw.tool_input;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* shown as the text it is */ } }
  return {
    event, ref, cwd, toolUseId, workspaceRoots: roots, tool: raw.tool_name, args,
    server: typeof raw.mcp_server_name === "string" ? raw.mcp_server_name : "",
  };
}

// --- whether Cursor would ask -------------------------------------------------------------

/** The parts of Cursor's configuration that decide whether it asks before a call. */
export interface CursorRules {
  /** `approvalMode` of the CLI configuration: `unrestricted` is Run Everything. */
  approvalMode: string | null;
  allow: string[];
  deny: string[];
}

/** Where the Cursor CLI keeps its configuration (and reads `hooks.json`): as the CLI resolves it. */
export function cursorConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.CURSOR_CONFIG_DIR?.trim()) return path.resolve(env.CURSOR_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME?.trim()) return path.resolve(env.XDG_CONFIG_HOME, "cursor");
  return path.join(home, ".cursor");
}

function readPermissions(file: string): { approvalMode: string | null; allow: string[]; deny: string[] } {
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { approvalMode: null, allow: [], deny: [] }; }
  if (!isObject(doc)) return { approvalMode: null, allow: [], deny: [] };
  const perms = isObject(doc.permissions) ? doc.permissions : {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { approvalMode: typeof doc.approvalMode === "string" ? doc.approvalMode : null, allow: list(perms.allow), deny: list(perms.deny) };
}

/** The user's rules (`cli-config.json`) and each workspace root's (`.cursor/cli.json`). A file that cannot be read adds nothing. */
export function loadCursorRules(configDir: string, workspaceRoots: string[]): CursorRules {
  const user = readPermissions(path.join(configDir, "cli-config.json"));
  const rules: CursorRules = { approvalMode: user.approvalMode, allow: [...user.allow], deny: [...user.deny] };
  for (const root of workspaceRoots) {
    const p = readPermissions(path.join(root, ".cursor", "cli.json"));
    rules.allow.push(...p.allow);
    rules.deny.push(...p.deny);
  }
  return rules;
}

/** A glob as Cursor's rules use it: `*` within one path segment, `**` across, `?` one character; anything else literal. */
function globRe(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}
const glob = (pattern: string, s: string): boolean => globRe(pattern).test(s);

/** Whether one simple command matches a `Shell(...)` (or `Bash(...)`) rule, the way Cursor's `matchesShell` does. */
export function matchesShellRule(rule: string, command: string): boolean {
  const m = /^\s*(?:Shell|Bash)\s*\((.*)\)\s*$/s.exec(rule);
  if (!m) return false;
  const full = (m[1] ?? "").trim();
  const form = command.trim();
  const sp = form.indexOf(" ");
  const base = sp < 0 ? form : form.slice(0, sp);
  const colon = full.indexOf(":");
  if (colon >= 0) {
    const cmdPat = full.slice(0, colon).trim();
    const argsPat = full.slice(colon + 1).trim();
    const args = sp < 0 ? "" : form.slice(sp + 1).trim();
    if ((glob(cmdPat, base) || glob(cmdPat, form)) && glob(argsPat, args)) return true;
  }
  return glob(full, form) || form.startsWith(`${full} `) || glob(full, base) || base === full;
}

/**
 * The simple commands of a command line, or null when this cannot tell them apart for sure (a substitution, an unbalanced
 * quote): then it is taken as one Cursor asks about. Leading `NAME=value` assignments are dropped from each.
 */
export function simpleCommands(line: string): string[] | null {
  if (/\$\(|`|<\(|>\(/.test(line)) return null;
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < line.length) { cur += c + line[++i]; continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) { cur += c + line[++i]; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      // `2>&1`, `>&2`, `&>`: a redirection, not a separator.
      if (c === "&" && (line[i - 1] === ">" || line[i + 1] === ">")) { cur += c; continue; }
      parts.push(cur);
      cur = "";
      if ((c === "|" || c === "&") && line[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (quote) return null;
  parts.push(cur);
  return parts
    .map((p) => p.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]*)\s+)+/, "").trim())
    .filter((p) => p !== "");
}

/** Whether an MCP call matches an `Mcp(server:tool)` rule (either side a glob; a bare pattern names the server). */
export function matchesMcpRule(rule: string, server: string, tool: string): boolean {
  const m = /^\s*Mcp\s*\((.*)\)\s*$/s.exec(rule);
  if (!m) return false;
  const pattern = (m[1] ?? "").trim();
  const colon = pattern.indexOf(":");
  if (colon < 0) return glob(pattern, server);
  return glob(pattern.slice(0, colon).trim(), server) && glob(pattern.slice(colon + 1).trim(), tool);
}

/**
 * Whether Cursor will ask about this call, as far as its configuration files say: Run Everything, a sandboxed command, a
 * command every part of which is on an allow list, or one a deny rule refuses, is not asked about. When this cannot tell (a
 * command it cannot split for sure), it says yes: the call is then put on the phone and held, and Cursor goes on as it would
 * have once it is let go. Cursor's own checks that ask even for an allowed command (a recursive delete outside the sandbox,
 * an administrator's list) are not seen here: such a call is asked about at the terminal only.
 */
export function cursorWouldAsk(e: CursorEvent, rules: CursorRules): boolean {
  if (rules.approvalMode === "unrestricted") return false;
  if (e.event === "beforeMCPExecution") {
    const server = e.server ?? "";
    const tool = e.tool ?? "";
    // A deny rule: Cursor refuses it itself, without asking.
    if (rules.deny.some((r) => matchesMcpRule(r, server, tool))) return false;
    return !rules.allow.some((r) => matchesMcpRule(r, server, tool));
  }
  if (e.sandbox) return false;
  const parts = simpleCommands(e.command ?? "");
  if (!parts || parts.length === 0) return true;
  if (parts.some((p) => rules.deny.some((r) => matchesShellRule(r, p)))) return false;
  return !parts.every((p) => rules.allow.some((r) => matchesShellRule(r, p)));
}

// --- the card -------------------------------------------------------------------------------

/** The option that lets Cursor ask at the terminal now instead of waiting out the hold. */
export const CURSOR_TERMINAL_OPTION = "terminal";

/** The card for a Cursor call, and what each choice makes the hook print. */
export function mapCursorRequest(e: CursorEvent): Mapping<CursorDecision> {
  const shell = e.event === "beforeShellExecution";
  const input = shell ? { command: e.command, cwd: e.cwd } : { server: e.server, tool: e.tool, arguments: e.args ?? null };
  const masked = redactDeep(input) as Record<string, unknown>;
  const shown = shownInput(masked);
  // The title is built from the masked request too: a credential typed into a command never reaches Claw in it.
  const title = shell ? `Run: ${oneLine(masked.command, 160)}` : `MCP tool ${oneLine(masked.server, 60)} / ${oneLine(masked.tool, 60)}`;
  const card: CardSpec = {
    tool: oneLine(title, 200),
    kind: shell ? "execute" : "mcp",
    input: shown.input,
    options: [
      { optionId: "deny", name: "No", kind: "reject_once" },
      { optionId: CURSOR_TERMINAL_OPTION, name: "Ask me at the terminal", kind: "allow_once" },
    ],
  };
  return {
    cards: [card],
    decide([c]) {
      if (c === "deny") return { permission: "deny", user_message: CURSOR_DENIED_USER, agent_message: CURSOR_DENIED_AGENT };
      // "Ask me at the terminal": no decision, so Cursor asks as it would have.
      return null;
    },
  };
}

/** What the Cursor hook prints for a decision. */
export function cursorHookOutput(d: CursorDecision): string {
  return JSON.stringify(d);
}
