// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { OBSERVE_TEXT } from "../locales/observe.js";
import { cpHead, pyJsonDumps, pyStr, pyStrip } from "../text/py-text.js";

/**
 * What an observer turn would have done, as a suggestion: which recorded tool calls are suggestions at all, and how one
 * is shown on its card and carried out on Accept (exactly as shown).
 */

/** `pass` (it would do nothing) and the lookups an observer turn makes on its way to a decision: nothing to accept. */
export const NOT_SUGGESTIONS: ReadonlySet<string> = new Set([
  "pass",
  "memory_recall",
  "work_recall",
  "devenv_list",
  "trigger_list",
  "job_watch_list",
  "claw_self_status",
  "brief",
]);

const TOOL_PREFIX = "mcp__assistant__";
const ARGS_SHOWN = 1200;

/** The assistant tool's own name, without the MCP prefix. */
export function toolOf(raw: unknown): string {
  const name = typeof raw === "string" ? raw : "";
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

export interface Suggestion {
  /** What kind of thing it would have done. */
  readonly kind: string;
  /** What exactly: the reply's text, the task's title and brief, else the call's arguments. */
  readonly what: string;
}

/** The suggestion a recorded call `tool(args)` is. */
export function describe(tool: string, args: unknown): Suggestion {
  const a = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (tool === "say") return { kind: OBSERVE_TEXT.replyKind, what: pyStr(a["text"]) };
  if (tool === "work_create") {
    return { kind: OBSERVE_TEXT.taskKind, what: pyStrip(`${pyStr(a["title"])}\n${pyStr(a["brief"])}`) };
  }
  return { kind: tool, what: cpHead(pyJsonDumps(a), ARGS_SHOWN) };
}
