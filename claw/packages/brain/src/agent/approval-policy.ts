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
 *
 * `auto_approve` (or `autoApprove`) is the sibling that lets a session nobody
 * is watching run an explicitly allowlisted, low-risk subset of the held tools
 * without waiting for a person:
 *
 *   "auto_approve": ["workload_get", "x_*"]        those tools, by name or prefix
 *   "auto_approve": [{ "tool": "node_set",         that tool, and only when the
 *                      "when": { "state": "off" } }]  call's top-level scalar
 *                                                     arguments equal these
 *
 * It narrows a hold, never creates one: it matters only to a call that
 * `requires_approval` already holds, and a held tool that is not listed still
 * waits for a person exactly as before. An absent field means today's
 * behaviour. A value that is present but malformed (null, not a list, an empty list,
 * a bare `*`, a bad entry, an empty or non-scalar `when`) fails closed in the
 * other direction: nothing of that server is auto-approved, and a warning is
 * logged. `when` compares top-level scalars only (string, number, boolean,
 * null) with strict equality; a nested argument cannot be matched, so a tool
 * whose danger sits in a nested argument must not be listed with a `when`
 * alone.
 */
import pino from "pino";

const logger = pino({ name: "approval-policy" });

export interface ApprovalPolicy {
  /** True when at least one server declares a rule. */
  readonly active: boolean;
  /** `toolName` is the model-visible name, `mcp__<server>__<tool>`. */
  requiresApproval(toolName: string): boolean;
  /**
   * True when `requires_approval` holds this call and the server's
   * `auto_approve` lists it, so it may run without a decision. Never true for a
   * call that is not held, and never true unless every server whose rule holds
   * the tool also lists it.
   */
  autoApproves(toolName: string, input: Record<string, unknown>): boolean;
}

type Matcher = (bare: string) => boolean;
type AutoMatcher = (bare: string, input: Record<string, unknown>) => boolean;

/** A `when` value: what a top-level argument must strictly equal. */
type Scalar = string | number | boolean | null;

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

/**
 * One `auto_approve` value. `null` means it cannot be read, and the caller
 * approves nothing for that server: this is a safety control, so a typo must
 * leave a tool held, never release one.
 */
function compileAuto(value: unknown): AutoMatcher | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rules: Array<{ exact: string | null; prefix: string | null; when: Array<[string, Scalar]> }> = [];
  for (const raw of value) {
    const entry = typeof raw === "string" ? { tool: raw } : raw;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { tool, when, ...rest } = entry as Record<string, unknown>;
    // An unknown key is a typo we cannot read the intent of (`whn`, `args`).
    if (Object.keys(rest).length > 0) return null;
    if (typeof tool !== "string") return null;
    const name = tool.trim();
    // A bare `*` would turn the whole hold off; say that by dropping requires_approval.
    if (!name || name === "*") return null;
    const conditions: Array<[string, Scalar]> = [];
    if (when !== undefined) {
      if (!when || typeof when !== "object" || Array.isArray(when)) return null;
      const pairs = Object.entries(when as Record<string, unknown>);
      if (pairs.length === 0) return null;
      for (const [key, want] of pairs) {
        const scalar = want === null || typeof want === "string" || typeof want === "boolean"
          || (typeof want === "number" && Number.isFinite(want));
        if (!scalar) return null;
        conditions.push([key, want as Scalar]);
      }
    }
    if (name.endsWith("*")) rules.push({ exact: null, prefix: name.slice(0, -1), when: conditions });
    else rules.push({ exact: name, prefix: null, when: conditions });
  }
  return (bare, input) => rules.some((r) =>
    (r.exact !== null ? bare === r.exact : bare.startsWith(r.prefix!))
    && r.when.every(([key, want]) => Object.hasOwn(input, key) && input[key] === want));
}

interface ServerRule {
  prefix: string;
  /** Null when the server declares no usable hold. */
  holds: Matcher | null;
  /**
   * What the server's `auto_approve` spellings each allow. Empty when the
   * server has none; a spelling that could not be read is `null` and allows
   * nothing.
   */
  autos: Array<AutoMatcher | null>;
}

export function approvalPolicyFromMcp(
  servers: Record<string, Record<string, unknown>>,
): ApprovalPolicy {
  const rules: ServerRule[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    const prefix = `mcp__${name}__`;
    const holds: Matcher[] = [];
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
      if (match) holds.push(match);
    }
    const autos: Array<AutoMatcher | null> = [];
    // Here the safe reading of two spellings is the opposite one: a call is
    // released only when every spelling present releases it.
    for (const key of ["auto_approve", "autoApprove"]) {
      const value = spec?.[key];
      // Only an absent field is "no rule". A present null is a value we cannot
      // read, so it cannot sit beside the other spelling and be outvoted.
      if (value === undefined) continue;
      const match = compileAuto(value);
      if (!match) {
        logger.warn({ server: name, field: key, valueType: Array.isArray(value) ? "array" : typeof value },
          "approval_policy.invalid_auto_approve_ignored");
      }
      autos.push(match);
    }
    if (holds.length === 0) continue;
    rules.push({ prefix, holds: (bare) => holds.some((h) => h(bare)), autos });
  }
  const held = (r: ServerRule, toolName: string): boolean =>
    toolName.startsWith(r.prefix) && r.holds!(toolName.slice(r.prefix.length));
  return {
    active: rules.length > 0,
    requiresApproval(toolName: string): boolean {
      return rules.some((r) => held(r, toolName));
    },
    autoApproves(toolName: string, input: Record<string, unknown>): boolean {
      // Server names may contain "__", so two servers can claim one tool name.
      // Each that holds it has to release it.
      const holding = rules.filter((r) => held(r, toolName));
      if (holding.length === 0) return false;
      return holding.every((r) => r.autos.length > 0
        && r.autos.every((a) => a !== null && a(toolName.slice(r.prefix.length), input ?? {})));
    },
  };
}
