// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a pull request's head commit is green, as the merge gate reads it.
 *
 * Only the head commit counts (a success on an older head says nothing), a pull
 * request with no check at all is not green however clean GitHub calls it, an
 * infrastructure failure is a failure, and a required check that never reported
 * is a missing one. Nothing here re-runs anything.
 */
export interface CheckRunInput {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CommitStatusInput {
  context: string;
  state: string;
}

export interface ChecksVerdict {
  green: boolean;
  reasons: string[];
  summary: { passed: number; failed: number; pending: number; total: number; required: number; requiredMissing: string[] };
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export function evaluateChecks(input: {
  checkRuns: CheckRunInput[];
  statuses: CommitStatusInput[];
  /** Contexts the base branch requires; null when the rules could not be read. */
  required: string[] | null;
  /** More checks exist than were read. */
  truncated: boolean;
}): ChecksVerdict {
  const reasons: string[] = [];
  const state = new Map<string, "pass" | "fail" | "pending">();
  for (const run of input.checkRuns) {
    const v = run.status !== "completed" ? "pending" : PASSING_CONCLUSIONS.has(run.conclusion ?? "") ? "pass" : "fail";
    // The same name twice: the worse one stands, so a failure is never hidden by another job's success.
    const prior = state.get(run.name);
    if (prior === undefined || rank(v) > rank(prior)) state.set(run.name, v);
  }
  for (const s of input.statuses) {
    const v = s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail";
    const prior = state.get(s.context);
    if (prior === undefined || rank(v) > rank(prior)) state.set(s.context, v);
  }
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const v of state.values()) {
    if (v === "pass") passed++;
    else if (v === "fail") failed++;
    else pending++;
  }
  const required = input.required ?? [];
  const requiredMissing = required.filter((name) => !state.has(name));

  if (input.required === null) reasons.push("the required checks of the base branch could not be read");
  if (input.truncated) reasons.push("more checks exist than were read");
  if (state.size === 0) reasons.push("no check has reported on the head commit");
  if (failed > 0) reasons.push(`${failed} check(s) failed`);
  if (pending > 0) reasons.push(`${pending} check(s) are not finished`);
  for (const name of required) {
    if (!state.has(name)) reasons.push(`required check ${name} has not reported on the head commit`);
    else if (state.get(name) !== "pass") reasons.push(`required check ${name} has not passed`);
  }
  return {
    green: reasons.length === 0,
    reasons,
    summary: { passed, failed, pending, total: state.size, required: required.length, requiredMissing },
  };
}

function rank(v: "pass" | "fail" | "pending"): number {
  return v === "pass" ? 0 : v === "pending" ? 1 : 2;
}

/** The status-check contexts that a ruleset list of the base branch requires. */
export function requiredContextsFromRules(rules: unknown): string[] | null {
  if (!Array.isArray(rules)) return null;
  const out: string[] = [];
  for (const rule of rules) {
    const r = rule as { type?: unknown; parameters?: { required_status_checks?: unknown } } | null;
    if (!r || typeof r !== "object" || r.type !== "required_status_checks") continue;
    const list = r.parameters?.required_status_checks;
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      const context = (item as { context?: unknown } | null)?.context;
      if (typeof context !== "string" || !context) return null;
      if (!out.includes(context)) out.push(context);
    }
  }
  return out;
}
