// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A remote agent's links are shown as words with their host, never as something a person can click (ported from the Python
 * worker's test_answer_links and test_meta_links): the cases shared with it, the host read from an address, hostile text in linear
 * time, and every line of the live view and the window.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { answerParts } from "../../src/remote/answer.js";
import { neutral } from "../../src/remote/inert.js";
import { inertAnswer } from "../../src/remote/links/answer.js";
import { hostOf } from "../../src/remote/links/hosts.js";
import { trim } from "../../src/remote/links/scans.js";
import { WindowView } from "../../src/remote/window/view.js";

interface AnswerCase {
  readonly about: string;
  readonly input: string;
  readonly lang: "en" | "zh";
  readonly expected: string[];
}
interface MetaCase {
  readonly about: string;
  readonly input: string;
  readonly limit: number;
  readonly expected: string;
}

function cases<T>(name: string): T[] {
  const url = new URL(`../../../../test-support/data/${name}`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { cases: T[] }).cases;
}

export const ANSWER_CASES = cases<AnswerCase>("answer-link-cases.json");
export const META_CASES = cases<MetaCase>("meta-link-cases.json");

test("an answer says what the shared cases say", () => {
  assert.ok(ANSWER_CASES.length >= 46);
  for (const c of ANSWER_CASES) assert.deepEqual(answerParts(c.input, c.lang), c.expected, `${c.lang}: ${c.about}`);
});

test("a line says what the shared cases say", () => {
  assert.ok(META_CASES.length >= 12);
  for (const c of META_CASES) assert.equal(neutral(c.input, c.limit), c.expected, c.about);
});

test("a link is its words and its host", () => {
  const cases: [string, string][] = [
    ["[the docs](https://docs.example.com/a)", "the docs (`docs.example.com`)"],
    ["![diagram](https://img.example/p.png)", "\u{1f5bc} diagram (`img.example`)"],
    ["see https://logs.example/run/42.", "see `logs.example`."],
    ["[x](https://user:pass@git.example:8443/r?token=t0k)", "x (`git.example`)"],
    ["看[文档](https://wiki.example.cn/a)", "看文档（`wiki.example.cn`）"],
    ["[a (b)](https://x.example/p_(1)) end", "a (b) (`x.example`) end"],
    ["[page](example.com/path)", "page (`example.com`)"],
  ];
  for (const [text, words] of cases) {
    assert.equal(inertAnswer(text), words, text);
    assert.equal(inertAnswer(words), words, `again: ${text}`);
  }
});

test("the host never carries the user the password the port or the path", () => {
  assert.equal(hostOf("https://user:pass@Git.Example:8443/r.git?token=t"), "git.example");
  assert.equal(hostOf("example.com/p"), "example.com");
  assert.equal(hostOf("/relative"), "");
  assert.equal(hostOf("javascript:alert(1)"), "");
  assert.equal(hostOf("#top"), "");
});

test("a nul in the text cannot make the answer fail", () => {
  assert.equal(inertAnswer("\x000\x00 and \x001"), "0 and 1");
});

test("a host with a backtick is no host", () => {
  assert.equal(hostOf("https://ho`st.example/"), "");
  assert.equal(inertAnswer("[a](https://ho`st.example/)"), "a");
});

test("hostile text is made words in linear time", () => {
  const hostile = [
    "[".repeat(20000),
    "![".repeat(10000),
    "`".repeat(20000),
    "<a ".repeat(8000),
    "www.".repeat(8000),
    "://".repeat(10000),
    "[a](".repeat(8000),
    "(".repeat(20000),
    "https://evil.example/" + ")".repeat(600000),
    "https://evil.example/" + ").".repeat(300000),
    "` `".repeat(20000),
    // (a search with no end for every `<`, `</a` or `>`, or a length counted afresh for every bracket, was quadratic)
    "<".repeat(400000),
    "<a x>".repeat(80000),
    "<a\u3000".repeat(80000),
    "\u{1d400}[".repeat(100000) + "]".repeat(100000),
    "\u{1d400}<".repeat(200000),
    // (a bare domain at every turn, or labels that never end in one)
    "x.co ".repeat(50000),
    "a.".repeat(200000),
    ("a".repeat(70) + ".").repeat(5000),
    "www.x.co/".repeat(50000),
    "a.co`x`".repeat(30000),
    "x.comailto:".repeat(30000),
  ];
  for (const text of hostile) {
    const started = performance.now();
    inertAnswer(text);
    assert.ok(performance.now() - started < 1000, `${text.slice(0, 12)}…: ${String(performance.now() - started)} ms`);
  }
});

test("an address loses only the parentheses it did not open", () => {
  const cases: [string, string][] = [
    ["https://e.example/a)", "https://e.example/a"],
    ["https://e.example/(a))", "https://e.example/(a)"],
    ["https://e.example/a).)", "https://e.example/a"],
    ["https://e.example/(a)).", "https://e.example/(a)"],
    ["https://e.example/a", "https://e.example/a"],
  ];
  for (const [url, kept] of cases) assert.equal(trim(url), kept, url);
});

test("a mail address and an escaped address are no links either", () => {
  assert.equal(inertAnswer("write to dev@mail.example now"), "write to `dev@mail.example` now");
  assert.equal(inertAnswer("mailto:dev@mail.example"), "`mail.example`");
  assert.equal(inertAnswer("www.example\\.com"), "`www\u{200b}.example.com`");
});

test("closing parentheses after an address are counted once", () => {
  const started = performance.now();
  assert.ok(inertAnswer("(https://x.example/a" + ")".repeat(40000)).startsWith("(`x.example`)"));
  assert.ok(performance.now() - started < 1000);
});

test("what the agent says into the window card is words whichever way it came", () => {
  const view = new WindowView();
  view.reset("rs-1");
  view.setText("look at https://evil.example/x and [docs](https://docs.example/y)");
  assert.equal(view.text, "look at `evil.example` and docs (`docs.example`)");
});

test("a character, a bracket and a space are read as Python reads them", () => {
  // (from Python 3.14's urlsplit and str methods: a bracketed host is an IPv6 or IPvFuture address or nothing, a character beyond
  // the BMP is one character, and Python's whitespace is not JavaScript's)
  const table: readonly (readonly [string, string])[] = [
    ["https:// [x]/a", "`https:​//` [x]/a"],
    ["see https://[v1.host]/x", "see `v1.host`"],
    ["see https://u[1]@host.example/x", "see `https:​//u[1]@host.example/x`"],
    ["see https://[::1]:8080/x", "see `https:​//[::1]:8080/x`"],
    ["a\u{1d400}www.evil.example", "a\u{1d400}`www\u200b.evil.example`"],
    ["a\u{1d400}x@y.example", "`a\u{1d400}x@y.example`"],
    ["<a　href=https://e.example>go</a>", "go (`e.example`)"],
    ["<a﻿href=https://e.example>go</a>", "<a﻿href=`e.example`>go</a>"],
    ["<img\x1csrc=https://e.example/p.png alt=x>", "<imgsrc=`e.example` alt=x>"],
    ["say \u{1d400}https://e.example/x", "say \u{1d400}https:​//e.example/x"],
  ];
  for (const [text, shown] of table) assert.equal(inertAnswer(text), shown, JSON.stringify(text));
});

test("a character that lowers to two does not move where an address is read", () => {
  // (only ASCII letters are lowered to find `www.`, `mailto:` or a tag, so the index found is the index in the text)
  assert.equal(inertAnswer("İİİİİwww."), "İİİİİwww​.");
  assert.equal(inertAnswer("see İİİ www.evil.example"), "see İİİ `www​.evil.example`");
  assert.equal(inertAnswer("İ<A HREF=https://e.example>go</a>"), "İgo (`e.example`)");
});

test("a bare domain is an address, and a file name or code is not", () => {
  const domains: readonly (readonly [string, string])[] = [
    ["example.com", "`example.com`"],
    ["example.com/path", "`example.com/path`"],
    ["Visit example.com.", "Visit `example.com`."],
    ["sub.example.co.uk", "`sub.example.co.uk`"],
    ["example\\.com", "`example.com`"],
    ["api.github.io/x", "`api.github.io/x`"],
    ["foo.app", "`foo.app`"],
    ["evil.dev:8080/x", "`evil.dev:8080/x`"],
    ["EXAMPLE.COM", "`EXAMPLE.COM`"],
    ["a-b.org", "`a-b.org`"],
    ["example.org?q=1", "`example.org?q=1`"],
    ["example.net#top", "`example.net#top`"],
    ["(example.com)", "(`example.com`)"],
    ["example.ai", "`example.ai`"],
    ["evil.md/login", "`evil.md/login`"],
    ["docs.evil.md", "`docs.evil.md`"],
    ["x.co", "`x.co`"],
    ["_x.co_", "_`x.co`_"],
    ["fix it in main.py:42", "fix it in `main.py:42`"],
    ["docs.example.museum/path", "`docs.example.museum/path`"],
    ["a.b.example.zz", "`a.b.example.zz`"],
    ["site.example.qq:8080", "`site.example.qq:8080`"],
    ["foo\\-bar.com/path", "`foo-bar.com/path`"],
    ["docs.foo\\-bar.example.org", "`docs.foo-bar.example.org`"],
    ["user.example.de/x", "`user.example.de/x`"],
    ["\u8bbf\u95eeexample.com\u770b\u770b", "\u8bbf\u95ee`example.com`\u770b\u770b"],
  ];
  for (const [text, shown] of domains) assert.equal(inertAnswer(text), shown, text);
  const words = [
    "README.md",
    "setup.py",
    "run.sh",
    "main.rs",
    "self.id",
    "user.name",
    "arr.at",
    "os.path",
    "np.array",
    "example.de",
    "file.txt",
    "v1.2",
    "a.b",
    "3.14",
    "e.g.",
    "node.js",
    "package.json",
    "index.html",
    "image.png",
    "archive.zip",
    "a/b.com",
    "my_module.py",
    "version 1.2.3",
    "a.b.c",
    "x.y.z9",
    "1.2.3.4",
  ];
  for (const text of words) assert.equal(inertAnswer(text), text, text);
});

test("a short line breaks a bare domain and a mail address, and leaves a file name", () => {
  assert.equal(neutral("Visit example.com/path"), "Visit example\u200b.com/path");
  assert.equal(neutral("docs.evil.md README.md"), "docs.evil\u200b.md README.md");
  assert.equal(neutral("me@evil.example"), "me@\u200bevil.example");
  assert.equal(neutral("john.doe@example.comx@y.example"), "john.doe@\u200bexample.comx@\u200by.example");
  assert.equal(neutral("site.museum\\/path"), "site\u200b.museum\\/path");
  assert.equal(neutral("@user a@b x@1.2 self.id"), "@user a@b x@1.2 self.id");
});

test("a domain the client sees on its own next to a span made here is made words too", () => {
  // (`docs.evil.mdmailto:` is one word to the scans, but once `mailto:` is code `docs.evil.md` stands alone in the client)
  assert.equal(inertAnswer("x.comailto:"), "`x.comailto`:");
  assert.equal(inertAnswer("john.doe.jr@example.com"), "`john.doe.jr@example.com`");
  assert.equal(inertAnswer("see.example.commailto:x"), "`see.example.commailto:x`");
});
