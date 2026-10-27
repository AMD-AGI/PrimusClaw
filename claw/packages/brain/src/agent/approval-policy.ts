// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Per-MCP-server "requires approval" policy.
 *
 * An MCP server spec (tool config `mcpServers.<name>`) may carry
 *
 *   "requires_approval": true                      every tool of the server
 *   "requires_approval": ["workload_stop", "x_*"]  those tools; a trailing `*`
 *                                                  matches a name prefix
 *
 * Tool names are the server's own names, without the `mcp__<server>__` prefix
 * the model sees. A tool matched here is held for an explicit user decision
 * before it runs, whatever HITL_ENABLED / HITL_AUTO_ALLOW say. An absent field
 * means no rule, so existing configs behave as before. A value that is present
 * but malformed (a string, an empty list, wrong entry types) fails closed: it
 * holds every tool of that server, and a warning is logged. `false` is the
 * explicit way to say no rule.
 */
import pino from "pino";

const logger = pino({ name: "approval-policy" });

export interface ApprovalPolicy {
  /** True when at least one server declares a rule. */
  readonly active: boolean;
  /** `toolName` is the model-visible name, `mcp__<server>__<tool>`. */
  requiresApproval(toolName: string): boolean;
}

type Matcher = (bare: string) => boolean;

const HOLD_ALL: Matcher = () => true;

/**
 * `null` means "explicitly no rule" (`false`). A value that is present but not
 * usable returns HOLD_ALL: this is a safety control, so a typo must hold more
 * than intended, never less. The caller logs it.
 */
function compile(value: unknown): { match: Matcher | null; invalid: boolean } {
  if (value === true) return { match: HOLD_ALL, invalid: false };
  if (value === false) return { match: null, invalid: false };
  if (!Array.isArray(value)) return { match: HOLD_ALL, invalid: true };
  const exact = new Set<string>();
  const prefixes: string[] = [];
  let invalid = false;
  for (const raw of value) {
    const p = typeof raw === "string" ? raw.trim() : "";
    if (!p) { invalid = true; continue; }
    if (p === "*") return { match: HOLD_ALL, invalid: false };
    if (p.endsWith("*")) prefixes.push(p.slice(0, -1));
    else exact.add(p);
  }
  // An empty list, or one with a non-string entry, is a mistake we cannot read
  // the intent of.
  if (invalid || (!exact.size && !prefixes.length)) return { match: HOLD_ALL, invalid: true };
  return { match: (bare) => exact.has(bare) || prefixes.some((pre) => bare.startsWith(pre)), invalid: false };
}

export function approvalPolicyFromMcp(
  servers: Record<string, Record<string, unknown>>,
): ApprovalPolicy {
  const rules: Array<{ prefix: string; match: Matcher }> = [];
  for (const [name, spec] of Object.entries(servers)) {
    // Both spellings are read and a rule from either applies, so one cannot
    // hide the other.
    for (const key of ["requires_approval", "requiresApproval"]) {
      const value = spec?.[key];
      if (value === undefined || value === null) continue;
      const { match, invalid } = compile(value);
      if (invalid) {
        logger.warn({ server: name, field: key, valueType: Array.isArray(value) ? "array" : typeof value },
          "approval_policy.invalid_holding_all_tools");
      }
      if (match) rules.push({ prefix: `mcp__${name}__`, match });
    }
  }
  return {
    active: rules.length > 0,
    requiresApproval(toolName: string): boolean {
      return rules.some((r) => toolName.startsWith(r.prefix) && r.match(toolName.slice(r.prefix.length)));
    },
  };
}
