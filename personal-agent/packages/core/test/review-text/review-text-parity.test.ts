// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reading of a review request against the Python worker's on 7671 seeded texts (random pieces of requests, and
 * 3,000 shaped like "请 XX 帮我 review ..." with dotted and dotless i, full-width space and fictional names): bare numbers,
 * pull requests, the review-only ask, "review 合入", words, flattening, brackets, and where each of four members is
 * named. Every expected value is what the Python functions returned.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  asksReviewOnly,
  bareGroups,
  flat,
  memberKeys,
  namedIn,
  pullsIn,
  saysReviewAndMerge,
  strayNumbers,
  tokens,
  withoutParens,
  writtenIn,
  writtenRepos,
  type RosterMember,
} from "../../src/index.js";

interface Row {
  readonly t: string;
  readonly g: Array<[number[], string, boolean]>;
  readonly s: number[];
  readonly w: string[];
  readonly p: Array<[string, string, number]>;
  readonly ro: [string, string] | null;
  readonly rm: boolean;
  readonly tok: string[];
  readonly flat: string;
  readonly paren: string;
  readonly wi: boolean[];
  readonly nin: string[][];
}

/** One JSON object per line: the members and their keys first, then one row per text. */
const [head = "{}", ...lines] = readFileSync(new URL("review-text-parity.jsonl", import.meta.url), "utf8")
  .trimEnd()
  .split("\n");
const corpus = {
  ...(JSON.parse(head) as {
    members: Array<Omit<RosterMember, "channelUserId" | "userId"> & { id: string }>;
    keys: string[][];
  }),
  rows: lines.map((line) => JSON.parse(line) as Row),
};
const members: RosterMember[] = corpus.members.map((m) => ({ ...m, channelUserId: "", userId: m.id }));
const where = (place: ReadonlySet<string>): string[] => [...place].sort();

/** The rows where `read` differs from what Python gave, at most five, for the failure message. */
function differences(read: (row: Row) => unknown, expected: (row: Row) => unknown): unknown[] {
  return corpus.rows
    .filter((row) => {
      try {
        assert.deepEqual(read(row), expected(row));
        return false;
      } catch {
        return true;
      }
    })
    .slice(0, 5)
    .map((row) => [row.t, read(row), expected(row)]);
}

describe("review text parity with the Python worker", () => {
  it("covers asks, pull requests and bare numbers", () => {
    assert.equal(corpus.rows.length, 7671);
    assert.ok(corpus.rows.filter((r) => r.ro !== null).length > 500);
    assert.ok(corpus.rows.filter((r) => r.p.length > 0).length > 1000);
    assert.ok(corpus.rows.filter((r) => r.g.length > 0).length > 500);
  });

  it("bare numbers, stray numbers, written repositories and pull requests", () => {
    const read = (r: Row): unknown => {
      const groups = bareGroups(r.t);
      return {
        g: groups.map((x) => [[...x.numbers], x.repo, x.explicit]),
        s: strayNumbers(r.t, groups),
        w: writtenRepos(r.t),
        p: pullsIn(r.t).map((x) => [x.owner, x.repo, x.number]),
      };
    };
    assert.deepEqual(
      differences(read, (r) => ({ g: r.g, s: r.s, w: r.w, p: r.p })),
      [],
    );
  });

  it("the review-only ask and review and merge", () => {
    const read = (r: Row): unknown => {
      const ask = asksReviewOnly(r.t);
      return { ro: ask === undefined ? null : [ask.who, ask.rest], rm: saysReviewAndMerge(r.t) };
    };
    assert.deepEqual(
      differences(read, (r) => ({ ro: r.ro, rm: r.rm })),
      [],
    );
  });

  it("words, flattening, brackets, and where each member is named", () => {
    const read = (r: Row): unknown => {
      const words = tokens(r.t);
      return {
        tok: words,
        flat: flat(r.t),
        paren: withoutParens(r.t),
        wi: members.map((m) => writtenIn(m.name, r.t)),
        nin: members.map((m) => where(namedIn(words, m))),
      };
    };
    assert.deepEqual(
      differences(read, (r) => ({ tok: r.tok, flat: r.flat, paren: r.paren, wi: r.wi, nin: r.nin })),
      [],
    );
    assert.deepEqual(
      members.map((m) => [...memberKeys(m)].sort()),
      corpus.keys,
    );
  });
});
