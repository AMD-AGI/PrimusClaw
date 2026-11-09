// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  PY_B_END,
  PY_B_START,
  PY_D,
  PY_W,
  PY_W_CHARS,
  isAsciiAlpha,
  pyFullmatch,
  pyIsAlnum,
  pyRegExp,
} from "../../src/text/py-regex.js";
import { InvariantError } from "../../src/errors.js";

/**
 * (pattern, flags, text, what Python 3's re.fullmatch said). Two spellings are JavaScript's, accepted as extensions for
 * hand-built patterns and checked in Python in Python's spelling: `(?<name>...)` as `(?P<name>...)`, and `\\p{Lu}` as
 * the class of the capitals in the text (Python's re has no \\p).
 */
const CASES: readonly (readonly [string, string, string, boolean])[] = [
  ["[a._-]", "i", "-", true],
  ["[a._-]", "i", "\u0131", false],
  ["(?<m>[A-Za-z0-9][A-Za-z0-9._-]{0,62})", "i", "robin-dev-pod", true],
  ["[^a._-]", "i", "-", false],
  ["[^a-z-]", "i", "\u0130", false],
  ["a\\sb", "", "a\u001cb", true],
  ["a\\sb", "", "a\ufeffb", false],
  ["a\\sb", "", "a\u0085b", true],
  ["x[\\s-]*y", "", "x - \u001fy", true],
  ["\\d+", "", "\u0661\u0662", true],
  ["\\d+", "", "\uff11\uff12", true],
  ["ab", "", "abc", false],
  ["a\\.b", "i", "A.B", true],
  ["\\S+", "", "a\u001cb", false],
  ["\\S+", "", "a\ufeffb", true],
  ["\\D+", "", "ab", true],
  ["\\D+", "", "a\u0661", false],
  ["\\w+", "", "h\u00e9llo_\u4e2d\u6587\u0661", true],
  ["\\w+", "", "a-b", false],
  ["\\W", "", "-", true],
  ["\\W", "", "\u00e9", false],
  ["a\\b.*", "", "a b", true],
  ["a\\b.*", "", "a\u00e9", false],
  ["\\b\u00e9\\b", "", "\u00e9", true],
  ["a\\B.*", "", "a\u00e9", true],
  ["link", "i", "L\u0130NK", true],
  ["link", "i", "l\u0131nk", true],
  ["[a-z]+", "i", "\u0131\u0130", true],
  ["[^a-z]", "i", "\u0131", false],
  ["[^a-z]", "i", "-", true],
  ["(?<id>i+)", "i", "\u0131I", true],
  ["\\p{Lu}+", "", "AB\u0130", true],
  ["\\x41\\u0042", "", "AB", true],
  ["(\\d{1,2}):(\\d{2})\\s*-\\s*(\\d{1,2}):(\\d{2})", "", "9:00 - 18:30", true],
  ["(\\d{1,4})\\s*([mhd])", "i", "30 M", true],
  ["[\\d:]+", "", "\u0661:\u0662", true],
  ["[\\w]+", "", "\u00e9_1", true],
];

test("pyFullmatch reads \\s and \\d as Python's re does, and matches the whole text only", () => {
  for (const [pattern, flags, text, python] of CASES) {
    assert.equal(pyFullmatch(pattern, flags).test(text), python, `${pattern} /${flags} ${JSON.stringify(text)}`);
  }
});

test("pyFullmatch keeps groups and refuses a negated class escape inside a class", () => {
  assert.deepEqual(
    pyFullmatch(String.raw`(\d{1,2}):(\d{2})`)
      .exec("９:05")
      ?.slice(1),
    ["９", "05"],
  );
  assert.equal(pyFullmatch(String.raw`(?<id>i+)`, "i").exec("ıI")?.groups?.["id"], "ıI");
  assert.throws(() => pyFullmatch(String.raw`[\S]`), /no JavaScript form/);
  assert.equal(pyFullmatch("[]a]").test("]"), true);
  assert.equal(pyFullmatch("[^]a]").test("b"), true);
  assert.equal(pyFullmatch("a", "u").flags, "u");
});

/** (pattern, flags, text, "search" or "full", what Python 3's re.search / re.fullmatch said). */
const MORE: readonly (readonly [string, string, string, string, boolean])[] = [
  ["(?i)\\bis\\b", "", "x \u0130s y", "search", true], // \b's lookbehind is no group name: the i after it still folds
  ["(?i)k", "", "\u212a", "search", true],
  ["(?<=i)x", "i", "\u0130x", "search", true],
  ["(?<!i)x", "i", "\u0130x", "search", false],
  ["(?<id>i+)", "i", "\u0131I", "search", true],
  ["a", "", "a\n", "full", false],
  ["a$", "", "a\n", "search", true],
  ["a", "m", "x\na", "full", false],
  ["^a$", "m", "x\na\ny", "search", true],
  ["^a", "", "x\na", "search", false],
  ["\\Aa", "", "ba", "search", false],
  ["a\\Z", "", "a\n", "search", false],
  ["(?i)abc", "", "ABC", "full", true],
  ["(?i)link", "", "L\u0130NK", "full", true],
  ["a.b", "", "a\nb", "full", false],
  ["a.b", "s", "a\nb", "full", true],
  ["a.b", "", "a\rb", "full", true],
  ["(?P<id>i+)", "i", "II", "full", true],
  ["(?P<x>a)(?P=x)", "", "aa", "full", true],
  ["k+", "i", "\u212a\u212a", "full", true],
  ["s", "i", "\u017f", "full", true],
  ["i", "i", "\u0131", "full", true],
  ["i", "i", "\u0130", "full", true],
  ["bearer [a-z]+", "i", "Bearer \u212axxx", "search", true],
  ["\\b\u00e9", "", "caf\u00e9", "search", false],
  ["\\b\u00e9", "", "\u00e9", "search", true],
  ["\u00e9\\b", "", "\u00e9a", "search", false],
  ["\\bcaf\u00e9\\b", "", "a caf\u00e9.", "search", true],
  ["\\B\u00e9", "", "caf\u00e9", "search", true],
  ["abc", "", "xabcx", "search", true],
  ["abc", "", "xabcx", "full", false],
  ["^a", "m", "b\ra", "search", false],
  ["a$", "m", "a\rb", "search", false],
];

test("anchors, dots, named groups, inline flags and Unicode case and word boundaries are Python's", () => {
  for (const [pattern, flags, text, how, python] of MORE) {
    const regex = how === "search" ? pyRegExp(pattern, flags) : pyFullmatch(pattern, flags);
    assert.equal(regex.test(text), python, `${how} ${pattern} /${flags} ${JSON.stringify(text)}`);
  }
  assert.equal(pyRegExp("(?P<id>\\d+)").exec("ab 12")?.groups?.["id"], "12");
  assert.throws(() => pyRegExp("(?x)a b"), /no JavaScript form/);
  assert.equal(pyRegExp("a", "g").flags, "gu");
});

test("the building blocks of Python's word, digit and boundary are exported for patterns of their own", () => {
  const word = new RegExp(`${PY_B_START}abc${PY_B_END}`, "u");
  assert.equal(word.test("中abc"), false); // Python: re.search(r"(?<![\w])abc(?![\w])", "中abc") is None
  assert.equal(word.test(" abc."), true);
  assert.ok(new RegExp(`^${PY_D}+$`, "u").test("١٢"));
  assert.ok(new RegExp(`^[${PY_W_CHARS}.-]+$`, "u").test("名字.x-1"));
  assert.ok(new RegExp(`^${PY_W}$`, "u").test("é") && !new RegExp(`^${PY_W}$`, "u").test("-"));
  assert.ok(pyIsAlnum("中") && pyIsAlnum("٣") && !pyIsAlnum("_") && !pyIsAlnum(" "));
  assert.ok(isAsciiAlpha("abc") && !isAsciiAlpha("abç") && !isAsciiAlpha("ab1") && !isAsciiAlpha(""));
});

/** Python syntax JavaScript's `u` mode reads otherwise or not at all: (pattern, flags, text, how, what CPython 3 said). */
const PYTHON_SYNTAX: readonly (readonly [string, string, string, string, boolean])[] = [
  ["[\\1]", "", "\u0001", "full", true],
  ["a\\-b", "", "a-b", "full", true],
  ["a\\ b", "", "a b", "full", true],
  ["\\#\\&\\~", "", "#&~", "full", true],
  ["a\\-b\\ c\\#\\&\\~\\.\\*", "", "a-b c#&~.*", "full", true],
  ["[\\-a]+", "", "-a-", "full", true],
  ["[a\\]]+", "", "a]", "full", true],
  ["(?#note)ab", "", "ab", "full", true],
  ["a{,2}", "", "aa", "full", true],
  ["a{,2}", "", "aaa", "full", false],
  ["a{", "", "a{", "full", true],
  ["{abc}", "", "{abc}", "full", true],
  ["a}", "", "a}", "full", true],
  ["]", "", "]", "full", true],
  ["a{2}", "", "aa", "full", true],
  ["a{1,}", "", "aaa", "full", true],
  ["\\012", "", "\n", "full", true],
  ["\\0", "", "\u0000", "full", true],
  ["\\101", "", "A", "full", true],
  ["[\\101]", "", "A", "full", true],
  ["\\a", "", "\u0007", "full", true],
  ["\\U0001F600", "", "\ud83d\ude00", "full", true],
  ["\\x41B", "", "AB", "full", true],
  ["\u0130", "i", "i", "full", true],
  ["\u0131", "i", "I", "full", true],
  ["[\u0131]", "i", "i", "full", true],
  ["[\u0130]", "i", "I", "full", true],
  ["\\x49", "i", "\u0131", "full", true],
  ["\\x69", "i", "\u0131", "full", true],
  ["[^\u0131]", "i", "i", "full", false],
  ["(?P<\u540d>\\w+)", "", "\u4e2d\u6587", "full", true],
  ["(a)\\1", "", "aa", "full", true],
  ["(a)\\1", "", "ab", "full", false],
  ["[\\b]", "", "\b", "full", true],
];

test("identity escapes, comments, braces, octal and named escapes, and the four i's are read as Python reads them", () => {
  for (const [pattern, flags, text, how, python] of PYTHON_SYNTAX) {
    const regex = how === "search" ? pyRegExp(pattern, flags) : pyFullmatch(pattern, flags);
    assert.equal(regex.test(text), python, `${how} ${pattern} /${flags} ${JSON.stringify(text)}`);
  }
});

test("what has no JavaScript form is refused when the pattern is built, never read another way", () => {
  // Python reads each of these (the last but two are its own errors); JavaScript would read them otherwise or not at all.
  for (const [pattern, flags] of [
    ["a(?s:.)b", ""],
    ["(?m:^)b", ""],
    ["(?i:link)", ""],
    ["(?-i:a)", "i"],
    ["(?P<x>i)(?P=x)", "i"],
    ["(a)\\1", "i"],
    ["\\N{LATIN SMALL LETTER A}", ""],
    ["a(?i)b", ""],
    ["\\q", ""],
    ["[\\S]", ""],
    ["a\\", ""],
    ["\\x4g", ""],
    ["\\pL", ""],
    ["[\\A]", ""],
    ["(", ""],
  ] as const) {
    assert.throws(() => pyRegExp(pattern, flags), InvariantError, pattern);
  }
  // In Python a(?s:.)b matches "a\nb" and (?i:link) matches "LİNK": refusing is the only answer that is not wrong.
});

/** Round-3 review cases: (pattern, flags, text, how, what CPython 3 said). */
const FOLLOW_UP: readonly (readonly [string, string, string, string, boolean])[] = [
  ["\\w", "i", "\u03b9", "full", true],
  ["[\\w]", "i", "\u03b9", "full", true],
  ["\\W", "i", "\u03b9", "full", false],
  ["[^\\w]", "i", "\u03b9", "full", false],
  ["\\bA", "i", "\u03b9A", "search", false],
  ["\\w+", "i", "\u0399\u03b9a", "full", true],
  ["\\123", "", "S", "full", true],
  ["[\\w-]+", "i", "Ab-c", "full", true],
  ["(?#c)(?i)a", "", "A", "full", true],
  ["(?i)(?#c)(?m)^a$", "", "x\nA", "search", true],
  ["(?im)^a", "", "b\nA", "search", true],
];

test("ι stays a word character under IGNORECASE and flag groups may follow a leading comment, as in Python", () => {
  for (const [pattern, flags, text, how, python] of FOLLOW_UP) {
    const regex = how === "search" ? pyRegExp(pattern, flags) : pyFullmatch(pattern, flags);
    assert.equal(regex.test(text), python, `${how} ${pattern} /${flags} ${JSON.stringify(text)}`);
  }
});

test("a full match is the same on every call and Python's own errors are refused, never thrown raw", () => {
  assert.throws(() => pyFullmatch("a", "g"), InvariantError); // g/y would make test() stateful
  assert.throws(() => pyFullmatch("a", "y"), InvariantError);
  const again = pyFullmatch("a");
  const first = again.test("a");
  const second = again.test("a"); // a second call on the same RegExp: no lastIndex carried over
  assert.ok(first && second);
  assert.equal(pyRegExp("a", "gi").flags, "giu"); // searching for every match keeps g
  for (const pattern of ["(?g)a", "[\\777]", "\\U00110000", "[\\p{NoSuch}]", "(?x)a", `${"()".repeat(400)}\\400`]) {
    assert.throws(() => pyRegExp(pattern), InvariantError, pattern);
  }
});

test("the one kept difference: under IGNORECASE U+0345 counts as a word character, and Kelvin still folds beside \\b", () => {
  // Python: re.fullmatch(r"\w", "\u0345", re.I) is None. JavaScript folds U+0345 to ι; leaving it out would need a
  // scoped (?-i:...), which in V8 stops the Kelvin sign matching [A-Za-z] anywhere in the pattern (the case below).
  assert.equal(pyFullmatch("\\w", "i").test("\u0345"), true);
  assert.equal(pyFullmatch("\\w").test("\u0345"), false);
  // Python: re.search(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", "Bearer \u212a" + "x" * 33) matches
  assert.ok(pyRegExp(String.raw`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}`).test(`Bearer \u212a${"x".repeat(33)}`));
});
