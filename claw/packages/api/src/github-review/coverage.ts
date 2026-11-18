// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Coverage as data, not as a promise: on the deep review every changed file the review can read gets a conclusion in
 * `gh_review_submit` (`coverage`: reviewed, or skipped and why), and the service checks the list against the pull request's files.
 * A file with no conclusion refuses the review (nothing is posted); a skipped file is named in the posted body and an approval is
 * refused. Files there is nothing to read in (a lock file, a binary, a diff GitHub did not send, a Git LFS pointer) are not asked
 * for. The idea is the coverage manifest of alibaba/open-code-review (`agent.go` registerCoverage/finalizeManifest).
 */
import { LOCKS, diffNotSent, type RiskFile } from "./risk.js";

export interface CoverageEntry { path: string; status: "reviewed" | "skipped"; note: string }

export interface CoverageCheck {
  /** Files that need a conclusion and have none. */
  missing: string[];
  /** Files the review says it skipped, with why. */
  skipped: Array<{ path: string; note: string }>;
  /** Files with nothing to read, and why: they need no conclusion. */
  exempt: Array<{ path: string; why: string }>;
  /** Entries that name no changed file, or are malformed. */
  problems: string[];
}

/** The files a review must conclude on, and the ones it need not (nothing to read in them). */
export function coverageFiles(files: readonly Pick<RiskFile, "path" | "patch" | "previousPath">[]): { required: string[]; exempt: CoverageCheck["exempt"] } {
  const required: string[] = [];
  const exempt: CoverageCheck["exempt"] = [];
  for (const f of files) {
    if (LOCKS.test(f.path)) exempt.push({ path: f.path, why: "lock file" });
    else if (diffNotSent(f)) exempt.push({ path: f.path, why: "no diff to read (binary, too large or a Git LFS pointer)" });
    else required.push(f.path);
  }
  return { required, exempt };
}

/** Reads `coverage` as the model passed it, against the files that need a conclusion. */
export function checkCoverage(files: readonly Pick<RiskFile, "path" | "patch" | "previousPath">[], raw: unknown): CoverageCheck {
  const { required, exempt } = coverageFiles(files);
  const known = new Set(files.map((f) => f.path));
  const problems: string[] = [];
  const seen = new Map<string, CoverageEntry>();
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) problems.push("coverage must be a list");
  (Array.isArray(raw) ? raw : []).forEach((e, i) => {
    const item = (e ?? {}) as Record<string, unknown>;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const status = item.status;
    const note = typeof item.note === "string" ? item.note.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    if (!path || (status !== "reviewed" && status !== "skipped")) { problems.push(`coverage ${i}: path and a status of reviewed or skipped are required`); return; }
    if (!known.has(path)) { problems.push(`coverage ${i}: ${path} is not a changed file of this pull request`); return; }
    if (status === "skipped" && !note) { problems.push(`coverage ${i}: say why ${path} was skipped (note)`); return; }
    seen.set(path, { path, status, note });
  });
  return {
    missing: required.filter((p) => !seen.has(p)),
    skipped: [...seen.values()].filter((e) => e.status === "skipped").map((e) => ({ path: e.path, note: e.note })),
    exempt,
    problems,
  };
}

/** What the posted body says of the coverage: nothing when every file that needs a conclusion was reviewed. */
export function coverageText(c: CoverageCheck, requiredCount: number): string {
  if (!c.skipped.length) return "";
  const reviewed = requiredCount - c.skipped.length;
  return `**Not reviewed** (${reviewed} of ${requiredCount} changed files were):\n${c.skipped.map((s) => `- \`${s.path}\`: ${s.note}`).join("\n")}`;
}
