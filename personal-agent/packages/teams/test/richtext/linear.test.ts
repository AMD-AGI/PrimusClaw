// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Matching stays linear in the line. Each line-level pattern used to have two parts that could take the same run of
 * characters, so a line built to fail after a long run made the engine try every split of it: quadratic. The checks
 * measure how the time grows when the run gets 8 times longer (about 8x when linear, about 64x when quadratic), never
 * an absolute time, and compare the rewritten patterns with the originals on every short line over the characters
 * that matter.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SeededRandom } from "../../../../test-support/random.js";
import { TAG } from "../../src/richtext/check.js";
import { END, S } from "../../src/richtext/escape.js";
import { toTeamsHtml } from "../../src/richtext/index.js";
import { BULLET, FENCE, headingText, NUMBERED, QUOTE, TABLE_SEP } from "../../src/richtext/lines.js";

type Groups = readonly (string | undefined)[];
type Span = readonly [number, number, Groups];

function span(m: RegExpExecArray | RegExpMatchArray | null): Span | null {
  return m ? [m.index ?? 0, (m.index ?? 0) + m[0].length, m.slice(1)] : null;
}

/** The original patterns, with Python's `.` and `$` spelled out. */
const OLD: Readonly<Record<string, RegExp>> = {
  fence: new RegExp(`^( {0,3})(\`{3,}|~{3,})([^\\n]*)${END}`, "u"),
  heading: new RegExp(`^ {0,3}#{1,6}[ \\t]+([^\\n]+?)(?:[ \\t]+#+)?[ \\t]*${END}`, "u"),
  bullet: new RegExp(`^([ \\t]*)[-*+][ \\t]+([^\\n]*)${END}`, "u"),
  numbered: new RegExp(`^([ \\t]*)(\\p{Nd}{1,9}[.)])[ \\t]+([^\\n]*)${END}`, "u"),
  quote: new RegExp(`^ {0,3}>[ \\t]?([^\\n]*)${END}`, "u"),
  table_sep: new RegExp(`^${S}*\\|?(?:${S}*:?-+:?${S}*\\|)+(?:${S}*:?-+:?${S}*)?${END}`, "u"),
  tag: /<(\/?)([A-Za-z0-9]+)([^<>]*)>/gu,
};

const NEW: Readonly<Record<string, (line: string) => unknown>> = {
  fence: (s) => FENCE.exec(s),
  heading: headingText,
  bullet: (s) => BULLET.exec(s),
  numbered: (s) => NUMBERED.exec(s),
  quote: (s) => QUOTE.exec(s),
  table_sep: (s) => TABLE_SEP.exec(s),
  tag: (s) => Array.from(s.matchAll(TAG)),
};

/**
 * A run that the old pattern split every way before failing. A newline is never inside a line the converter reads,
 * but the patterns are checked on their own as well.
 */
const HOSTILE: Readonly<Record<string, (n: number) => string>> = {
  fence: (n) => "```" + "`".repeat(n) + "\n\n",
  heading: (n) => "# a" + " ".repeat(n) + "b",
  bullet: (n) => "-" + " ".repeat(n) + "\n\n",
  numbered: (n) => "1." + " ".repeat(n) + "\n\n",
  quote: (n) => ">" + " ".repeat(n) + "\n\n",
  table_sep: (n) => " ".repeat(n) + "x",
  tag: (n) => "<a" + "a".repeat(n),
};

/**
 * How many times longer `fn` takes on make(n * factor) than on make(n): best of several timed batches, each batch long
 * enough that the clock's resolution does not matter.
 */
function growth(fn: (text: string) => unknown, make: (n: number) => string, n = 500, factor = 8): number {
  const small = make(n);
  const large = make(n * factor);
  let calls = 1;
  for (;;) {
    const started = performance.now();
    for (let c = 0; c < calls; c++) fn(small);
    if (performance.now() - started >= 5 || calls >= 1 << 16) break;
    calls *= 2;
  }
  const best = (text: string): number => {
    const times: number[] = [];
    for (let r = 0; r < 5; r++) {
      const started = performance.now();
      for (let c = 0; c < calls; c++) fn(text);
      times.push(performance.now() - started);
    }
    return Math.min(...times);
  };
  return best(large) / best(small);
}

for (const name of Object.keys(HOSTILE).sort()) {
  test(`each line pattern is linear on the run that made it quadratic: ${name}`, () => {
    const fn = NEW[name];
    const make = HOSTILE[name];
    assert.ok(fn && make);
    const ratio = growth(fn, make);
    assert.ok(ratio < 24, `${name} ${String(ratio)}`);
  });
}

const CONVERTER_HOSTILE: readonly (readonly [string, (n: number) => string])[] = [
  ["heading", (n) => "# a" + " ".repeat(n) + "b"],
  ["table-separator", (n) => "| a | b |\n" + " ".repeat(n) + "x"],
  ["list-item", (n) => "-" + " ".repeat(n) + "x"],
];

for (const [name, make] of CONVERTER_HOSTILE) {
  test(`the converter is linear on a hostile line: ${name}`, () => {
    const ratio = growth((text) => toTeamsHtml(text), make, 1000, 8);
    assert.ok(ratio < 24, `${name} ${String(ratio)}`);
  });
}

function oldHeading(line: string): string | null {
  return OLD.heading?.exec(line)?.[1] ?? null;
}

function same(name: string, line: string): boolean {
  const old = OLD[name];
  const fresh = NEW[name];
  assert.ok(old && fresh);
  if (name === "heading") return oldHeading(line) === fresh(line);
  if (name === "tag") {
    const before = Array.from(line.matchAll(old), span);
    const after = (fresh(line) as RegExpMatchArray[]).map(span);
    return JSON.stringify(before) === JSON.stringify(after);
  }
  return JSON.stringify(span(old.exec(line))) === JSON.stringify(span(fresh(line) as RegExpExecArray | null));
}

const ALPHABET: Readonly<Record<string, string>> = {
  fence: " `~a",
  heading: " \t#a",
  bullet: " \t-*+a",
  numbered: " \t1.)a",
  quote: " \t>a",
  table_sep: " \t|:-a",
  tag: '<>/ a="',
};

/** Every string of `length` characters from `alphabet`. */
function* product(alphabet: string, length: number): Generator<string> {
  if (length === 0) {
    yield "";
    return;
  }
  for (const head of product(alphabet, length - 1)) for (const ch of alphabet) yield head + ch;
}

for (const name of Object.keys(ALPHABET).sort()) {
  test(`the rewritten pattern reads every short line as before: ${name}`, () => {
    const alphabet = ALPHABET[name] ?? "";
    for (let length = 0; length < (alphabet.length <= 5 ? 7 : 6); length++) {
      for (const line of product(alphabet, length)) assert.ok(same(name, line), `${name} ${JSON.stringify(line)}`);
    }
    const rng = new SeededRandom(11);
    for (let r = 0; r < 20_000; r++) {
      const length = 7 + rng.int(17);
      const line = Array.from({ length }, () => alphabet.charAt(rng.int(alphabet.length))).join("");
      assert.ok(same(name, line), `${name} ${JSON.stringify(line)}`);
    }
  });
}
