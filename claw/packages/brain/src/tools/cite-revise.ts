// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A research report whose check found too many of its cited statements unverified goes back to its writer before it is delivered
 * (`ExecuteRequest.cite_check.revise`), a bounded number of times.
 *
 * The check (`cite-check.ts`) runs as before. When more than `unverified_ratio` of the report's cited statements are unverified and
 * the run still has a round left, nothing is delivered: the call is refused with the statements the check marked, and the writer
 * re-reads their pages and corrects, relabels or removes each before it delivers again. Each refusal takes one round; with none left,
 * the delivery is made whatever the check finds, so a report is never held back for good. The rounds belong to the run's check, so a
 * sub-agent that is handed the same check (`sub-agent.ts`) shares them. Without `revise`, every checked delivery is made at once.
 */
import type { CiteCheck, CiteCheckResult } from "./cite-check.js";

/** The most rounds a request may ask for: each is another full check of the report. */
export const CITE_REVISE_MAX_ROUNDS = 2;
/** How many marked statements the refusal lists, and how much of each line. */
export const CITE_REVISE_LISTED = 30;
export const CITE_REVISE_LINE_CHARS = 300;

/** The marks the check writes for a statement no source supports (`checkReport`). */
const UNVERIFIED_MARK = /（未证实）| \(unverified\)/;
/** The check's closing line, which names the mark in its counts. */
const CLOSING_LINE = /^(引用核对|Citation check)/;

export class CiteRevise {
  private left: number;

  constructor(rounds: number, readonly unverifiedRatio: number) {
    this.left = rounds;
  }

  /** Rounds still to give. */
  get roundsLeft(): number {
    return this.left;
  }

  /**
   * Null: deliver the checked text. Otherwise the refusal to answer the call with, nothing delivered; it takes one round.
   * Only a checked report with more than the ratio of its cited statements unverified, while a round is left, is sent back.
   */
  review(result: CiteCheckResult): string | null {
    if (this.left <= 0 || !result.checked || result.claims <= 0) return null;
    if (result.unverified / result.claims <= this.unverifiedRatio) return null;
    this.left -= 1;
    return reviseRequest(result, this.unverifiedRatio, this.left);
  }
}

/** The lines of the checked text that carry the unverified mark, as the check wrote them. */
export function unverifiedLines(checked: string): string[] {
  return checked.split("\n")
    .map((l) => l.trim())
    .filter((l) => UNVERIFIED_MARK.test(l) && !CLOSING_LINE.test(l))
    .map((l) => (l.length > CITE_REVISE_LINE_CHARS ? `${l.slice(0, CITE_REVISE_LINE_CHARS)}…` : l));
}

function reviseRequest(result: CiteCheckResult, ratio: number, left: number): string {
  const lines = unverifiedLines(result.text);
  const listed = lines.slice(0, CITE_REVISE_LISTED).map((l) => `- ${l}`);
  if (lines.length > listed.length) listed.push(`- … and ${lines.length - listed.length} more lines with the same mark`);
  const pct = Math.round(ratio * 1000) / 10;
  return `Error: not delivered. The citation check found ${result.unverified} of ${result.claims} cited statements unverified `
    + `(more than ${pct}%), so the report comes back to you before anything reaches the user. For each statement marked below, `
    + "open its cited page again and: correct the statement to what the page says (numbers, versions and dates exactly as the page "
    + "writes them); or cite the page you read that does state it; or, when it is your own conclusion, label it as an inference "
    + "(推断 / Inference) and give it no citation number; or remove it. Put no citation on a pointer, a note about your own work or "
    + "a summary of earlier findings. Then deliver the revised report again the same way (a report in a file: change the file, then "
    + `deliver_file it again). ${left > 0 ? `${left} more round${left > 1 ? "s" : ""} like this may follow.` : "That delivery is made whatever the check finds."} `
    + "Nothing has been delivered yet: do not report the item done before the report is.\n\n"
    + `Statements marked unverified, by line:\n${listed.join("\n")}`;
}

/** `ExecuteRequest.cite_check.revise`: null when absent or not a whole number of rounds from 1 and a ratio in [0, 1). */
export function parseCiteRevise(raw: unknown): CiteRevise | null {
  if (!raw || typeof raw !== "object") return null;
  const revise = (raw as { revise?: unknown }).revise;
  if (!revise || typeof revise !== "object") return null;
  const { rounds, unverified_ratio: ratio } = revise as { rounds?: unknown; unverified_ratio?: unknown };
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) return null;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio >= 1) return null;
  return new CiteRevise(Math.min(rounds, CITE_REVISE_MAX_ROUNDS), ratio);
}

/** Each run's rounds, kept with its check so whatever is handed the check shares them. */
const revisions = new WeakMap<CiteCheck, CiteRevise>();

export function bindCiteRevise(check: CiteCheck | null, revise: CiteRevise | null): void {
  if (check && revise) revisions.set(check, revise);
}

export function citeReviseFor(check: CiteCheck): CiteRevise | undefined {
  return revisions.get(check);
}
