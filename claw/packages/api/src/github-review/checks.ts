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
  /** GitHub's id of the run: a later run of the same check has a larger one. */
  id?: number | null;
  /** The app that reported the run (its id or slug), which with the name says which check it is. */
  app?: string | null;
}

/** The app of a check run as GitHub answers it (`app.id`, else `app.slug`), for `latestCheckRuns`. */
export function appOfRun(run: unknown): string | null {
  const app = (run as { app?: { id?: unknown; slug?: unknown } | null } | null)?.app;
  if (typeof app?.id === "number") return String(app.id);
  return typeof app?.slug === "string" ? app.slug : null;
}

/**
 * The check runs on the head without those a later run of the same check superseded, as GitHub's required checks read a re-run. A
 * workflow started twice on the same head (a re-push, a base change) runs every job twice, and its concurrency group cancels the older
 * run; that CANCELLED run is not a failure of the head (2026-11-25: code-metrics and pr-hygiene, each one CANCELLED run and a later
 * SUCCESS one, were called failing).
 *
 * Only a CANCELLED run is ever superseded, and only by a later run (a larger id) of the same name and the same app that was not skipped.
 * A name and an app do not say which workflow a run belongs to (every GitHub Actions job reports as one app, two workflows may each have
 * a job `build`, and a fork's pull request may add a workflow of its own), so a failed, timed-out or otherwise finished run is never
 * hidden by a later one of the same name: the worse one stands, as before. A run skipped by its `if:` (a later `labeled` or `edited`
 * event) did not run the job, so it supersedes nothing. A cancelled LATEST run is still not green, and a run without an id or an app is
 * kept as it is.
 */
export function latestCheckRuns<T extends CheckRunInput>(runs: readonly T[]): T[] {
  const known = (run: T): boolean => typeof run.id === "number" && Number.isFinite(run.id) && typeof run.app === "string" && run.app !== "";
  const keyOf = (run: T): string => JSON.stringify([run.name, run.app]);
  const newestRan = new Map<string, number>();
  for (const run of runs) {
    if (!known(run) || run.conclusion === "skipped") continue;
    const key = keyOf(run);
    const prior = newestRan.get(key);
    if (prior === undefined || (run.id as number) > prior) newestRan.set(key, run.id as number);
  }
  return runs.filter((run) => {
    if (!known(run) || run.conclusion !== "cancelled") return true;
    const newest = newestRan.get(keyOf(run));
    return newest === undefined || newest <= (run.id as number);
  });
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
  /**
   * Whether a failed check outside `required` may be advisory: false when the classic branch protection's required checks could not be read
   * (`required` then lists only the rulesets'), so a check only it requires is never taken for one that is not required. Default true.
   */
  advisory?: boolean;
}): ChecksVerdict {
  const reasons: string[] = [];
  const state = new Map<string, "pass" | "fail" | "pending">();
  for (const run of latestCheckRuns(input.checkRuns)) {
    // A run with a conclusion is finished whatever its status says: GitHub has been seen to keep a finished job's run at `in_progress`
    // with `conclusion: success` and a `completed_at` (PrimusClaw#712, 2026-11-11, run 130456274919), and a review then waited for ever on
    // "1 check(s) are not finished". A conclusion GitHub gives only for a finished run, so it is read as the run's result.
    const finished = run.status === "completed" || (run.conclusion !== null && run.conclusion !== "");
    const v = !finished ? "pending" : PASSING_CONCLUSIONS.has(run.conclusion ?? "") ? "pass" : "fail";
    // The same name twice once superseded runs are dropped (a failed run and a later one, another app's check, a run without an id):
    // the worse one stands, so a failure is never hidden by another job's success.
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
  const advisoryFailed = required.length > 0 && input.advisory !== false ? failedNames.filter((name) => !required.includes(name)) : [];
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

/**
 * The status-check contexts the base branch's classic branch protection requires, from `GET /repos/{o}/{r}/branches/{branch}` (readable by
 * anyone who can read the repository, unlike the protection endpoint): `[]` when it requires none (enforcement off, or no protection), null
 * when the answer does not say. The rulesets read (`requiredContextsFromRules`) does not see these.
 */
export function requiredContextsFromBranch(branch: unknown): string[] | null {
  const b = branch as { protected?: unknown; protection?: { required_status_checks?: { enforcement_level?: unknown; contexts?: unknown; checks?: unknown } } } | null;
  if (!b || typeof b !== "object") return null;
  if (b.protected === false) return [];
  const rsc = b.protection?.required_status_checks;
  if (!rsc || typeof rsc !== "object") return null;
  if (rsc.enforcement_level === "off") return [];
  const out: string[] = [];
  for (const c of Array.isArray(rsc.contexts) ? rsc.contexts : []) if (typeof c === "string" && c && !out.includes(c)) out.push(c);
  for (const c of Array.isArray(rsc.checks) ? rsc.checks : []) {
    const context = (c as { context?: unknown } | null)?.context;
    if (typeof context === "string" && context && !out.includes(context)) out.push(context);
  }
  if (!Array.isArray(rsc.contexts) && !Array.isArray(rsc.checks)) return null;
  return out;
}

/** Whether the rules of the base branch say it is merged through a merge queue (GitHub's rule type `merge_queue`). */
export function hasMergeQueueRule(rules: unknown): boolean {
  return Array.isArray(rules) && rules.some((rule) => (rule as { type?: unknown } | null)?.type === "merge_queue");
}
