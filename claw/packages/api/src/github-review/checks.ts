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
  summary: {
    passed: number; failed: number; pending: number; total: number; required: number; requiredMissing: string[];
    /** The names of the checks that failed and of those not finished, sorted; advisory failures are in `failedNames` too. */
    failedNames: string[]; pendingNames: string[];
    /** Failed checks the base branch does not require, which do not make the head red (see the header). */
    advisoryFailed: string[];
  };
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
    // A run with a conclusion is finished whatever its status says: GitHub has been seen to keep a finished job's run at `in_progress`
    // with `conclusion: success` and a `completed_at` (PrimusClaw#712, 2026-11-11, run 130456274919), and a review then waited for ever on
    // "1 check(s) are not finished". A conclusion GitHub gives only for a finished run, so it is read as the run's result.
    const finished = run.status === "completed" || (run.conclusion !== null && run.conclusion !== "");
    const v = !finished ? "pending" : PASSING_CONCLUSIONS.has(run.conclusion ?? "") ? "pass" : "fail";
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
  const failedNames: string[] = [];
  const pendingNames: string[] = [];
  for (const [name, v] of state) {
    if (v === "pass") passed++;
    else if (v === "fail") failedNames.push(name);
    else pendingNames.push(name);
  }
  failedNames.sort();
  pendingNames.sort();
  const failed = failedNames.length;
  const pending = pendingNames.length;
  const required = input.required ?? [];
  const requiredMissing = required.filter((name) => !state.has(name));
  const advisoryFailed = required.length > 0 ? failedNames.filter((name) => !required.includes(name)) : [];
  const blockingFailed = failedNames.filter((name) => !advisoryFailed.includes(name));

  if (input.required === null) reasons.push("the required checks of the base branch could not be read");
  if (input.truncated) reasons.push("more checks exist than were read");
  if (state.size === 0) reasons.push("no check has reported on the head commit");
  if (blockingFailed.length > 0) reasons.push(`${blockingFailed.length} check(s) failed: ${blockingFailed.join(", ")}`);
  if (pending > 0) reasons.push(`${pending} check(s) are not finished: ${pendingNames.join(", ")}`);
  for (const name of required) {
    if (!state.has(name)) reasons.push(`required check ${name} has not reported on the head commit`);
    else if (state.get(name) !== "pass") reasons.push(`required check ${name} has not passed`);
  }
  return {
    green: reasons.length === 0,
    reasons,
    summary: { passed, failed, pending, total: state.size, required: required.length, requiredMissing, failedNames, pendingNames, advisoryFailed },
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

/** Whether the rules of the base branch say it is merged through a merge queue (GitHub's rule type `merge_queue`). */
export function hasMergeQueueRule(rules: unknown): boolean {
  return Array.isArray(rules) && rules.some((rule) => (rule as { type?: unknown } | null)?.type === "merge_queue");
}
