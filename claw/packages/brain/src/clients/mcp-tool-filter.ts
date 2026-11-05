// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `enabled_tools` / `disabled_tools` on an MCP server spec: which of that
 * server's tools a run offers the model.
 *
 * A server that lists 50 tools sends 50 schemas on every model call. A tool or
 * plugin config can cut that down, per server, without the API or the request
 * knowing anything about it:
 *
 *   - `enabled_tools`: only these are offered;
 *   - `disabled_tools`: these are not, whatever `enabled_tools` says.
 *
 * Names are the server's own (no `mcp__<server>__` prefix), as for
 * `requires_approval`; a trailing `*` matches a name prefix and a bare `*`
 * matches every tool. `camelCase` spellings (`enabledTools`, `disabledTools`)
 * are read too, and when both spellings are present a tool must pass both.
 *
 * Absent fields mean every tool, which is how every existing config behaves.
 * A field that is present but cannot be read (not a list, an empty list, an
 * entry that is not a non-empty string) is a mistake whose intent is unknown,
 * and ignoring an unreadable `disabled_tools` would offer exactly the tools
 * someone meant to remove, so it fails closed: the server is not connected and
 * is reported as unavailable, with the reason, like a server that is down.
 *
 * The filter decides what is offered and what may be called: a call to a tool
 * the filter removed is refused by the client, so a model that names it anyway
 * (from an older transcript, or a guess) runs nothing.
 */

export interface McpToolFilter {
  /** Whether the server's own tool `bare` is offered and callable. */
  allows(bare: string): boolean;
  /** Entries that name a tool exactly, for checking against what the server lists. */
  readonly exactNames: readonly string[];
}

type Matcher = { exact: Set<string>; prefixes: string[]; all: boolean };

function compile(value: unknown): Matcher | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const m: Matcher = { exact: new Set(), prefixes: [], all: false };
  for (const raw of value) {
    const p = typeof raw === "string" ? raw.trim() : "";
    if (!p) return null;
    if (p === "*") m.all = true;
    else if (p.endsWith("*")) m.prefixes.push(p.slice(0, -1));
    else m.exact.add(p);
  }
  return m;
}

const matches = (m: Matcher, bare: string): boolean =>
  m.all || m.exact.has(bare) || m.prefixes.some((p) => bare.startsWith(p));

const ENABLED_KEYS = ["enabled_tools", "enabledTools"] as const;
const DISABLED_KEYS = ["disabled_tools", "disabledTools"] as const;

/**
 * The filter a server spec declares: null when it declares none (every tool is
 * offered), or the name of the field that cannot be read.
 */
export function mcpToolFilter(spec: Record<string, unknown> | null | undefined): McpToolFilter | null | { invalid: string } {
  const enabled: Matcher[] = [];
  const disabled: Matcher[] = [];
  for (const [keys, into] of [[ENABLED_KEYS, enabled], [DISABLED_KEYS, disabled]] as const) {
    for (const key of keys) {
      // Only an absent field is "no rule"; a present null is a value we cannot read.
      if (spec?.[key] === undefined) continue;
      const m = compile(spec[key]);
      if (!m) return { invalid: key };
      into.push(m);
    }
  }
  if (!enabled.length && !disabled.length) return null;
  return {
    allows: (bare) => enabled.every((m) => matches(m, bare)) && !disabled.some((m) => matches(m, bare)),
    exactNames: [...enabled, ...disabled].flatMap((m) => [...m.exact]),
  };
}
