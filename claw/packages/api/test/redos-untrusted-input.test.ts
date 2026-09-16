// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The string normalizers that run on attacker-sized input have to stay linear.
 *
 * Every one of these used to be a regular expression of the shape `X+$` or
 * `${...}`, and every one of those is quadratic in the length of the run it is
 * scanning: nothing anchors where the run may begin, so the engine restarts at
 * each offset in the string and, at each one, consumes the whole run before the
 * trailing assertion fails and it backtracks a character at a time.
 *
 * That only matters because of where the strings come from. Three of these
 * normalize zip entry names -- chosen by whoever uploaded the archive, legal up
 * to 64 KB each, and normalized once *per entry* in several of the scan loops.
 * `trimOuterWhitespace` gets both a request `name`/`display_name`/`version`
 * field (bounded only by the API's 4 MiB `bodyLimit`) and whole `SKILL.md`
 * bodies pulled out of an archive. `collectRefsFromValue`, reached here through
 * `validateDag`, gets a DAG node's `prompt` during admission -- before anything
 * about the DAG has been accepted.
 *
 * At the old cost, 80 KB of the right character blocked the event loop for 2.5s
 * and the next doubling cost four times that, so a single request was an API
 * outage rather than a slow request. This test feeds each one 2 MB of that
 * character. The ceiling is deliberately loose -- it is there to catch a
 * reintroduced quadratic (which cannot finish 2 MB this side of a day), not to
 * measure anything. Both halves matter: the timing, and the assertions that the
 * rewritten scanners still answer exactly what the regexes answered.
 *
 * Coverage:
 *   D1 trimOuterWhitespace is linear and trims the same character set
 *   D2 the archive-path normalizers are linear and normalize identically
 *   D3 sanitizeToolNameSegment is linear and folds identically
 *   D4 DAG template-ref extraction is linear on unclosed `${` openers
 *   D5 DAG template-ref extraction still finds the refs it is there to find
 *   D6 stripOuterQuotes is linear and peels the same runs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import {
  sanitizeToolNameSegment,
  stripOuterQuotes,
  stripOuterSlashes,
  stripTrailingSlashes,
  toPosixPath,
  trimOuterWhitespace,
} from "../src/marketplace/plugins.js";
import { validateDag } from "../src/tasks/dags/admission.js";
import type { TaskDagDef } from "../src/tasks/dags/types.js";

// An `llm` node needs no tool-meta lookup, so admission must not reach a
// database here. The stub below is present only so a lookup that did happen
// fails loudly instead of quietly opening a connection.
const originalQuery = db.query;

function refuseDb(): void {
  db.query = (async () => {
    throw new Error("admission must not need the database here");
  }) as typeof db.query;
}

/** Length of the pathological run. Quadratic code cannot finish this. */
const RUN = 2_000_000;

/**
 * Loose enough that a slow CI box never flakes, tight enough that nothing
 * quadratic gets through: the old regexes needed ~2.5s for an 80 000-character
 * run, which puts 2 000 000 at roughly a day.
 */
const CEILING_MS = 5_000;

function timed(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

test("D1 trimOuterWhitespace is linear, and trims what it always trimmed", () => {
  // The leading non-space is what makes this the bad case: it stops the `^...+`
  // alternative from swallowing the run, which is what left the old regex
  // re-scanning the tail from every offset.
  const pathological = `a${"\t".repeat(RUN)}!`;
  const ms = timed(() => trimOuterWhitespace(pathological));
  assert.ok(ms < CEILING_MS, `trimOuterWhitespace took ${ms.toFixed(0)}ms on ${RUN} tabs`);

  // The character set is JS `\s` widened by the zero-width joiners: ASCII
  // whitespace, NBSP, the BOM, the U+2000 block, the line/paragraph separators,
  // and U+200b/c/d.
  const invisibles = "\t\r\n\f\v \u00a0\u1680\u2000\u200a\u200b\u200c\u200d"
    + "\u2028\u2029\u202f\u205f\u3000\ufeff";
  assert.equal(trimOuterWhitespace(`${invisibles}x${invisibles}`), "x");
  assert.equal(trimOuterWhitespace("a b"), "a b", "inner whitespace is untouched");
  assert.equal(trimOuterWhitespace(invisibles), "");
  assert.equal(trimOuterWhitespace("\u2060x\u2060"), "\u2060x\u2060", "U+2060 is not \\s");
  assert.equal(trimOuterWhitespace(""), "");
});

test("D2 the archive-path normalizers are linear, and normalize identically", () => {
  // A zip entry name may legally be 64 KB, and several scan loops normalize
  // every entry in the archive, so this is one crafted member, not a flood.
  const pathological = `a${"/".repeat(RUN)}b`;
  for (const [name, fn] of [
    ["stripOuterSlashes", stripOuterSlashes],
    ["stripTrailingSlashes", stripTrailingSlashes],
    ["toPosixPath", toPosixPath],
  ] as const) {
    const ms = timed(() => fn(pathological));
    assert.ok(ms < CEILING_MS, `${name} took ${ms.toFixed(0)}ms on ${RUN} slashes`);
  }

  assert.equal(toPosixPath("a\\b\\\\c"), "a/b//c");
  assert.equal(toPosixPath("a/b"), "a/b");
  assert.equal(stripOuterSlashes("//a/b//"), "a/b");
  assert.equal(stripOuterSlashes("///"), "", "an all-slash path still collapses to empty");
  assert.equal(stripOuterSlashes(""), "");
  assert.equal(stripTrailingSlashes("//a/b//"), "//a/b", "leading slashes are kept");
  assert.equal(stripTrailingSlashes("///"), "");
  assert.equal(stripOuterSlashes(toPosixPath("\\\\a\\b\\")), "a/b", "the composed form is unchanged");
});

test("D3 sanitizeToolNameSegment is linear, and folds identically", () => {
  const pathological = `a${"-".repeat(RUN)}b`;
  const ms = timed(() => sanitizeToolNameSegment(pathological));
  assert.ok(ms < CEILING_MS, `sanitizeToolNameSegment took ${ms.toFixed(0)}ms on ${RUN} dashes`);

  assert.equal(sanitizeToolNameSegment("--a b/c__"), "a_b_c", "outer joiners go, inner fold to _");
  assert.equal(sanitizeToolNameSegment("._-"), "", "joiners only leaves nothing");
  assert.equal(sanitizeToolNameSegment("  ok.name-1_2  "), "ok.name-1_2");
  assert.equal(sanitizeToolNameSegment("abcdef", 3), "abc", "maxLen still applies");
  assert.equal(sanitizeToolNameSegment(""), "");
});

test("D4 DAG admission is linear on a prompt of unclosed template openers", async () => {
  refuseDb();
  try {
    // No `}` anywhere, so `[^}]+` could never complete -- the case the old
    // `/\$\{([^}]+)\}/g` restarted and re-consumed at every opener.
    const dag = dagWithPrompt("${".repeat(RUN));
    const started = process.hrtime.bigint();
    await validateDag(dag);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < CEILING_MS, `validateDag took ${ms.toFixed(0)}ms on ${RUN} openers`);
  } finally {
    db.query = originalQuery;
  }
});

test("D5 template refs are still resolved, and still checked", async () => {
  refuseDb();
  try {
    // `${}` was never a ref (the old `+` required a non-empty expression),
    // `${nodot}` has no dot and is skipped, `task` is a non-node root.
    await assert.doesNotReject(() => validateDag(dagWithPrompt("${} ${nodot} ${task.id}")));

    // A real ref against an unknown upstream must still be refused -- if the
    // scanner silently stopped finding refs, every check above would pass
    // vacuously and this suite would be saying nothing at all.
    await assert.rejects(
      () => validateDag(dagWithPrompt("${ghost.out}")),
      /references unknown upstream 'ghost'/,
    );
    // The first `}` closes the token, exactly as `[^}]+` did.
    await assert.rejects(
      () => validateDag(dagWithPrompt("${ghost.out}more}")),
      /references unknown upstream 'ghost'/,
    );
    // Whitespace inside the braces was trimmed before and still is.
    await assert.rejects(
      () => validateDag(dagWithPrompt("${  ghost.out  }")),
      /references unknown upstream 'ghost'/,
    );
  } finally {
    db.query = originalQuery;
  }
});

test("D6 stripOuterQuotes is linear, and peels the same runs", () => {
  // Reached from a `title:` / `name:` line in an uploaded SKILL.md, where
  // nothing bounds the length of a line.
  const pathological = `a${"\"".repeat(RUN)}b`;
  const ms = timed(() => stripOuterQuotes(pathological));
  assert.ok(ms < CEILING_MS, `stripOuterQuotes took ${ms.toFixed(0)}ms on ${RUN} quotes`);

  // Python's `str.strip("\"\'")` peels runs, not matched pairs -- which is the
  // behaviour this mirrors and must keep.
  assert.equal(stripOuterQuotes(`""foo""`), "foo");
  assert.equal(stripOuterQuotes(`'"foo"'`), "foo", "the two quote kinds are one set");
  assert.equal(stripOuterQuotes(`"foo`), "foo", "an unmatched quote still peels");
  assert.equal(stripOuterQuotes(`a"b`), `a"b`, "inner quotes stay");
  assert.equal(stripOuterQuotes(`"'"`), "");
  assert.equal(stripOuterQuotes(""), "");
});

/** A one-node `llm` DAG whose prompt is the string under test. */
function dagWithPrompt(prompt: string): TaskDagDef {
  return {
    dag_id: "dag-redos",
    name: "redos",
    nodes: [{
      id: "n1",
      executor: "brain",
      mode: "llm",
      sandbox: { handle: "w" },
      prompt,
    }],
  } as unknown as TaskDagDef;
}
