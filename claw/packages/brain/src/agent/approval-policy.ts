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
 * before it runs, whatever HITL_ENABLED / HITL_AUTO_ALLOW say. Absent or
 * malformed means no rule, so existing configs behave as before.
 */

export interface ApprovalPolicy {
  /** True when at least one server declares a rule. */
  readonly active: boolean;
  /** `toolName` is the model-visible name, `mcp__<server>__<tool>`. */
  requiresApproval(toolName: string): boolean;
}

type Matcher = (bare: string) => boolean;

function compile(value: unknown): Matcher | null {
  if (value === true) return () => true;
  if (!Array.isArray(value)) return null;
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (!p) continue;
    if (p === "*") return () => true;
    if (p.endsWith("*")) prefixes.push(p.slice(0, -1));
    else exact.add(p);
  }
  if (!exact.size && !prefixes.length) return null;
  return (bare) => exact.has(bare) || prefixes.some((pre) => bare.startsWith(pre));
}

export function approvalPolicyFromMcp(
  servers: Record<string, Record<string, unknown>>,
): ApprovalPolicy {
  const rules: Array<{ prefix: string; match: Matcher }> = [];
  for (const [name, spec] of Object.entries(servers)) {
    const match = compile(spec?.requires_approval ?? spec?.requiresApproval);
    if (match) rules.push({ prefix: `mcp__${name}__`, match });
  }
  return {
    active: rules.length > 0,
    requiresApproval(toolName: string): boolean {
      return rules.some((r) => toolName.startsWith(r.prefix) && r.match(toolName.slice(r.prefix.length)));
    },
  };
}
