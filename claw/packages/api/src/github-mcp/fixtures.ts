// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Release-gate fixtures: pull requests a release gate opens against its own fixture branches (`release-gate-fixture/base`, heads under
 * `release-gate-fixture/` or `<name>-e2e-fixture/`), titled "..., do not merge". They are nobody's work, and a "merged" one merged into
 * the fixture branch, not into the project: listed with the rest they were counted as "3 still open" and as merged work (2026-11-07
 * 06:09). Lists and searches leave them out unless asked (`include_fixtures`). A person's own "[do not merge]" pull request is theirs:
 * the title alone excludes only together with the word fixture.
 */
export const FIXTURE_BASE = "release-gate-fixture/base";
export const FIXTURE_REF_RE = /^(?:release-gate-fixture|[A-Za-z0-9._-]+-e2e-fixture)\//;

export function isGateFixture(p: Record<string, any>): boolean {
  const refs = [p?.head?.ref, p?.base?.ref].filter((r): r is string => typeof r === "string");
  const title = typeof p?.title === "string" ? p.title : "";
  return refs.some((r) => FIXTURE_REF_RE.test(r)) || (/\bfixture\b/i.test(title) && /\bdo not merge\b/i.test(title));
}
