// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `config.review_target` of a session: the one pull request its review tools may touch, `{owner, repo, number}`. Written by whoever
 * creates the session, which is the only time it can be written (no route changes a session's config afterwards), and enforced by the
 * tools on every call (service.ts), so a model that was talked into naming another pull request, in the same repository or another, is
 * refused before any credential is fetched. A reference, never a credential.
 */
import { isValidPrRef, type PrRef } from "./github.js";

export type ReviewTargetParse = { ok: true; target: PrRef | null } | { ok: false; error: string };

const BAD = "config.review_target must be {owner, repo, number}: a GitHub owner, a repository name and a pull request number";

export function parseReviewTarget(value: unknown): ReviewTargetParse {
  if (value === undefined || value === null) return { ok: true, target: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: BAD };
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => k !== "owner" && k !== "repo" && k !== "number");
  if (extra.length > 0 || typeof v.owner !== "string" || typeof v.repo !== "string" || typeof v.number !== "number") return { ok: false, error: BAD };
  const ref: PrRef = { owner: v.owner, repo: v.repo, number: v.number };
  return isValidPrRef(ref) ? { ok: true, target: ref } : { ok: false, error: BAD };
}

/** The target a session's stored config names: null when it names none, an error when it names one that is not well formed (the caller refuses). */
export function reviewTargetOf(config: unknown): ReviewTargetParse {
  const value = config !== null && typeof config === "object" ? (config as Record<string, unknown>).review_target : undefined;
  return parseReviewTarget(value);
}

/** Whether a pull request is the bound one; GitHub names are not case sensitive. */
export function isReviewTarget(ref: PrRef, target: PrRef): boolean {
  return ref.owner.toLowerCase() === target.owner.toLowerCase() && ref.repo.toLowerCase() === target.repo.toLowerCase() && ref.number === target.number;
}
