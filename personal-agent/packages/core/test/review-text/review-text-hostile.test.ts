// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review readings on texts dense with white space of every kind Python knows (the shapes whose patterns used to
 * backtrack polynomially), against the Python worker on 6,000 seeded texts, and their time on long hostile texts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { asksReviewOnly, bareGroups, strayNumbers } from "../../src/index.js";

interface Row {
  readonly t: string;
  readonly g: Array<[number[], string, boolean]>;
  readonly s: number[];
  readonly ro: [string, string] | null;
}

const rows = readFileSync(new URL("review-text-hostile.jsonl", import.meta.url), "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as Row);

describe("review readings on white-space-dense texts", () => {
  it("read every text as the Python worker does", () => {
    assert.equal(rows.length, 6000);
    assert.ok(rows.filter((r) => r.ro !== null).length > 300 && rows.filter((r) => r.g.length > 0).length > 300);
    const differences = rows
      .filter((r) => {
        const groups = bareGroups(r.t);
        const ask = asksReviewOnly(r.t);
        const got = {
          g: groups.map((x) => [[...x.numbers], x.repo, x.explicit]),
          s: strayNumbers(r.t, groups),
          ro: ask === undefined ? null : [ask.who, ask.rest],
        };
        return JSON.stringify(got) !== JSON.stringify({ g: r.g, s: r.s, ro: r.ro });
      })
      .slice(0, 5)
      .map((r) => r.t);
    assert.deepEqual(differences, []);
  });

  // Each took seconds before (and longer in Python's re): one long run of white space after "PR", many 帮 in an ask.
  const hostile: Record<string, () => unknown> = {
    "PR and a long run of ideographic spaces": () => {
      const text = "PR" + "　".repeat(30_000);
      return strayNumbers(text, bareGroups(text));
    },
    "an ask with fifty thousand 帮": () => asksReviewOnly("请 " + "帮".repeat(50_000)),
  };
  for (const [what, run] of Object.entries(hostile)) {
    it(`within a bound: ${what}`, () => {
      const started = performance.now();
      run();
      const ms = performance.now() - started;
      assert.ok(ms < 400, `${what}: ${ms.toFixed(0)} ms`);
    });
  }
});
