// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review tools' readers of the person's message (`review-tools.ts`) take time in proportion to the message, and read it as
 * they did before they were made to.
 *
 *   L1  each reader answers a long message in a bounded time: `fullRefsIn`, `approvalCommand`, `mentionsItem`
 *   L2  each reader answers exactly as its former version did, on many short random messages and on hand-picked ones
 */
import assert from "node:assert/strict";
import test from "node:test";

import { approvalCommand, fullRefsIn, mentionsItem } from "../src/assistant/review-tools.js";

// --- The former versions, as they were, to compare with ------------------------------------------------------------

function fullRefsInBefore(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)(?:#|\/pull\/)(\d{1,9})(?![0-9])/g)) {
    out.push(`${m[1]}/${m[2]}#${m[3]}`.toLowerCase());
  }
  return out;
}

function approvalCommandBefore(text: string): string | null {
  const m = /^\s*(?:批准|approve)\s*[#＃]\s*([0-9a-f]{6}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*[.。!！]*\s*$/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

function mentionsItemBefore(text: string, seq: number): boolean {
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_.-])#${seq}(?![0-9])`, "g"))) {
    if (!/(?:\bprs?|\bpull(?:\s+request)?|拉取请求|合并请求)[\s:：]*$/i.test(text.slice(0, m.index))) return true;
  }
  return false;
}

// --- L1 -------------------------------------------------------------------------------------------------------------

/**
 * Each long message here took each former reader seconds (it was read once from every place in it); read in one pass it takes
 * about a millisecond, so the bound is generous and still far below the former time.
 */
const BOUND_MS = 1000;

function within(what: string, run: () => unknown): void {
  const start = performance.now();
  run();
  const ms = performance.now() - start;
  assert.ok(ms < BOUND_MS, `${what} took ${ms.toFixed(0)} ms; at most ${BOUND_MS} ms`);
}

test("L1 fullRefsIn answers a long message in a bounded time", () => {
  within("fullRefsIn over 100,000 letters", () => assert.deepEqual(fullRefsIn("a".repeat(100_000)), []));
  within("fullRefsIn over an owner and 100,000 letters", () => assert.deepEqual(fullRefsIn(`a/${"a".repeat(100_000)}`), []));
  within("fullRefsIn over 100,000 hyphenated letters", () => assert.deepEqual(fullRefsIn("a-".repeat(50_000)), []));
  within("fullRefsIn over a long message that names one", () =>
    assert.deepEqual(fullRefsIn(`${"word ".repeat(20_000)}AMD-AGI/PrimusClaw#305`), ["amd-agi/primusclaw#305"]));
});

test("L1 approvalCommand answers a long message in a bounded time", () => {
  within("approvalCommand over 100,000 spaces", () => assert.equal(approvalCommand(`approve #a3f9c2${" ".repeat(100_000)}x`), null));
  within("approvalCommand over 100,000 spaces and a stop", () => assert.equal(approvalCommand(`approve #a3f9c2${" ".repeat(100_000)}.`), "a3f9c2"));
});

test("L1 mentionsItem answers a long message in a bounded time", () => {
  within("mentionsItem over 200,000 characters of pull request numbers", () => assert.equal(mentionsItem("PR #5 ".repeat(33_000), 5), false));
});

// --- L2 -------------------------------------------------------------------------------------------------------------

/** A small seeded generator (mulberry32), so a failure names the case that made it. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const textOf = (r: () => number, pieces: readonly string[], most: number): string =>
  Array.from({ length: Math.floor(r() * (most + 1)) }, () => pick(r, pieces)).join("");

const CASES = 20_000;

test("L2 fullRefsIn names what it named before", () => {
  const pieces = ["a", "Z", "q9", "0", "7", "123", "1234567890", "-", "_", ".", "/", "#", "/pull/", "pull", " ", ",", ":", "é", "中",
    "https://github.com/", "AMD-AGI/PrimusClaw#", "x/y", "o/r#4", "\n"];
  for (const s of [
    "", "see a/b#1, https://github.com/C/D/pull/22 and e/f#333x", "a/b#1234567890", "a/b#123456789", "-a/b#1", "a_/b#1", "a/b#1x-y/z#2",
    "a/b/c#1", "a/b/pull/7", "a//b#1", "a/#1", "a.b/c#1", "1/2#3", "a/b#1#2", "a/b.c-d_e#9/pull/8", "a/b#01",
  ]) assert.deepEqual(fullRefsIn(s), fullRefsInBefore(s), JSON.stringify(s));
  for (let seed = 1; seed <= CASES; seed++) {
    const s = textOf(random(seed), pieces, 14);
    assert.deepEqual(fullRefsIn(s), fullRefsInBefore(s), `seed ${seed}: ${JSON.stringify(s)}`);
  }
});

test("L2 approvalCommand lets through what it let through before", () => {
  const space = [" ", "  ", "\t", "\n", "\u00a0", "\u3000", ""];
  const close = [".", "。", "!", "！", "..", "x", "#", ""];
  const ids = ["a3f9c2", "A3F9C2", "a3f9c2d1-5b7e-4c1a-9f00-000000000224", "a3f9c", "a3f9c2d", "g3f9c2"];
  for (const s of [
    "批准 #a3f9c2", "approve #a3f9c2", "APPROVE＃A3F9C2 。", "approve #a3f9c2 ! ", "approve #a3f9c2 . !", "approve #a3f9c2 ! .",
    "approve #a3f9c2 ! x", "approve #a3f9c2d1-5b7e-4c1a-9f00-000000000224", "approve #a3f9c2d1", "yes approve #a3f9c2", "",
  ]) assert.equal(approvalCommand(s), approvalCommandBefore(s), JSON.stringify(s));
  for (let seed = 1; seed <= CASES; seed++) {
    const r = random(seed);
    // Mostly the shape of a command with its parts varied, so that many of them are one; and some text with no shape at all.
    const s = r() < 0.8
      ? [pick(r, space), pick(r, ["批准", "approve", "Approve", "approv", ""]), pick(r, space), pick(r, ["#", "＃", ""]), pick(r, space),
        pick(r, ids), textOf(r, [...space, ...close], 6)].join("")
      : textOf(r, [...space, ...close, ...ids, "approve", "批准", "#"], 10);
    assert.equal(approvalCommand(s), approvalCommandBefore(s), `seed ${seed}: ${JSON.stringify(s)}`);
  }
});

test("L2 mentionsItem points where it pointed before", () => {
  const pieces = ["#", "#5", "#12", "#1", "5", "12", "pr", "PR", "prs", "Prs", "pull", "Pull", "request", "REQUEST", " ", "  ", "\t", "\n",
    ":", "：", "拉取请求", "合并请求", "a", "_", ".", "-", "中", "x", "repo", "\u00a0", "#NaN", "#nan", "#Infinity", "#INFINITY"];
  for (const [s, seq] of [
    ["PR #5 and #12", 12], ["PR #12", 12], ["pull request #12", 12], ["pull   request:#12", 12], ["xpr #12", 12], ["中pr #12", 12],
    ["拉取请求 #12", 12], ["合并请求：#12", 12], ["repo#12", 12], ["#123", 12], ["#12", 12], ["prs: #12", 12], ["pullrequest #12", 12],
    ["pull request\n#12", 12], ["PULL #12", 12], ["pr#12", 12], ["", 12],
    ["#NaN", NaN], ["#NAN", NaN], ["#Infinity", Infinity], ["#infinity", Infinity], ["#1e+21", 1e21], ["#1E21", 1e21],
  ] as const) assert.equal(mentionsItem(s, seq), mentionsItemBefore(s, seq), `${JSON.stringify(s)} #${seq}`);
  for (let seed = 1; seed <= CASES; seed++) {
    const r = random(seed);
    const s = textOf(r, pieces, 12);
    const seq = pick(r, [1, 5, 12, NaN, Infinity]);
    assert.equal(mentionsItem(s, seq), mentionsItemBefore(s, seq), `seed ${seed}: ${JSON.stringify(s)} #${seq}`);
  }
});
