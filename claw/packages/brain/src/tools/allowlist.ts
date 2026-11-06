// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ExecuteRequest.tools_allowlist`: the tools a run may use at all.
 *
 * The API has always been able to send this field and Brain used to ignore it,
 * so a session that was meant to hold only a few tools held all of them. It is
 * enforced in three places, all of which ask the object built here:
 *
 *   - the engine withholds every schema outside it from the model;
 *   - `ToolRouter.route()` refuses a call outside it, so a model that emits a
 *     tool it was never offered (or one a resumed transcript still names) gets
 *     an error and nothing runs;
 *   - a sub-agent starts from the parent's schemas narrowed by it, and its own
 *     loop applies it again to the calls the loop itself handles (`task`,
 *     `todo_write`, ...), which never reach a router.
 *
 * Each entry is an exact tool name or a prefix pattern: a single trailing `*`
 * matches every name that starts with what comes before it, which is how a
 * whole MCP server is named (`mcp__<server>__*`). A `*` anywhere else is an
 * ordinary character, so `mcp__*__ping` names nothing and cannot widen the list.
 *
 * An absent field and an empty list both mean "no restriction": the API stores
 * `[]` on every task row that did not set one and forwards it, so reading `[]`
 * as "nothing is allowed" would strip every tool from every existing task.
 * Anything else restricts, and a value that restricts but cannot be read
 * (not an array, or no usable entry) allows nothing rather than everything.
 */
import pino from "pino";

const logger = pino({ name: "tool-allowlist" });

export interface ToolAllowlist {
  /** The patterns as the request gave them, for logs. Empty only for a list that allows nothing. */
  readonly patterns: readonly string[];
  allows(toolName: string): boolean;
}

function buildAllowlist(patterns: string[]): ToolAllowlist {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of patterns) {
    if (p.endsWith("*")) prefixes.push(p.slice(0, -1));
    else exact.add(p);
  }
  return {
    patterns,
    allows: (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix)),
  };
}

/**
 * Read the request field. Null means the run is unrestricted.
 *
 * Takes `unknown` because the value arrives from a message bus: the type on
 * `ExecuteRequest` is a statement of intent, not something this process checked.
 */
export function parseToolAllowlist(raw: unknown): ToolAllowlist | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    logger.warn({ type: typeof raw }, "tool_allowlist.malformed_allows_nothing");
    return buildAllowlist([]);
  }
  if (raw.length === 0) return null;
  const patterns = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (patterns.length === 0) {
    logger.warn({ entries: raw.length }, "tool_allowlist.no_usable_entry_allows_nothing");
  }
  return buildAllowlist(patterns);
}

/**
 * `ExecuteRequest.read_taint`, read once per run: null when absent or unreadable as a rule with sources. Each call of a run asks
 * `refusal(name)` before it runs: null lets it through, a text refuses it. Every call it let through reports `ran(name, failed)` once
 * it has returned, before its result reaches the model.
 *
 * A call matching `sources` that answered marks the run: from then on only `allow_after` runs. While a source is still running
 * the run counts as marked, so the only call that can pass beside a read is one decided before it. A source that failed (the
 * tool's own error bit, or a call that threw) read nothing anyone wrote, so it marks nothing: the turn can still start the work the
 * lookup could not do.
 */
export interface ReadTaint {
  refusal(toolName: string): string | null;
  ran(toolName: string, failed: boolean): void;
}

export function parseReadTaint(raw: unknown): ReadTaint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { sources?: unknown; allow_after?: unknown };
  const sources = Array.isArray(r.sources) && r.sources.length ? parseToolAllowlist(r.sources) : null;
  if (!sources || !sources.patterns.length) return null;
  const allowAfter = Array.isArray(r.allow_after) && r.allow_after.length ? parseToolAllowlist(r.allow_after) : null;
  /** The first source that answered. */
  let readBy: string | null = null;
  /** Sources let through that have not reported yet. */
  const running: string[] = [];
  return {
    refusal(name) {
      if (sources.allows(name)) { running.push(name); return null; }
      const by = readBy ?? running[0] ?? null;
      if (by === null || allowAfter?.allows(name)) return null;
      return `Error: '${name}' was not run. This turn has read text other people wrote (with ${by}), so it can no longer act for the user. Tell the user what you would do and ask them to confirm it in a new message.`;
    },
    ran(name, failed) {
      if (!sources.allows(name)) return;
      const i = running.indexOf(name);
      if (i >= 0) running.splice(i, 1);
      if (!failed) readBy ??= name;
    },
  };
}

/** The schemas a run may offer its model: all of them when there is no allowlist. */
export function filterToolSchemas<T extends { name: string }>(
  schemas: T[],
  allowlist: ToolAllowlist | null | undefined,
): T[] {
  return allowlist ? schemas.filter((s) => allowlist.allows(s.name)) : schemas;
}

/** What the model is told when it calls a tool outside the list. */
export function toolNotAllowedMessage(toolName: string): string {
  return `Error: the tool '${toolName}' is not available in this session. It is outside the tools this session is allowed to use, so it was not run. Use only the tools you were given.`;
}
