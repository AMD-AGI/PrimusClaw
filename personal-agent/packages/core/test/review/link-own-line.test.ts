// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A link in a message Clawy sends ends its line: nothing comes after it on that line (`test_link_on_its_own_line`). Teams turns a
 * bare URL into a link by itself, and the link takes in what it can read as part of one ("打开 <url>，输入代码" linked the full-width
 * comma and the words after it, and the page that opened was a 404). So every URL is the last thing on its line: the rendered
 * messages are checked, and every string the packages build is scanned, so the next message that glues text to a link is caught
 * before it is sent.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { linkText } from "../../src/locales/link.js";
import { CONSENT_EN, CONSENT_ZH } from "../../src/locales/review-github.js";
import { stringsWithTextAfterALink, textAfterLinks } from "../../../../test-support/link-check.js";

const URL_TEXT = "https://github.com/login/device";

// --- the checker itself ---------------------------------------------------------------------------------------------------

for (const text of [
  `打开 ${URL_TEXT}，输入代码`, // the full-width comma and the words after it are taken into the link
  `打开 ${URL_TEXT}。`,
  `Open ${URL_TEXT}, then enter the code`,
  `Open ${URL_TEXT}.`,
  `Open ${URL_TEXT} and enter the code`,
  `(${URL_TEXT})`,
  `${URL_TEXT}）`,
  `${URL_TEXT} ，继续`,
  `${URL_TEXT}\n${URL_TEXT}，second line is the bad one`,
  "https://github.com/login/device?a=1，x",
]) {
  test(`the checker flags text after a link: ${JSON.stringify(text)}`, () => {
    assert.notDeepEqual(textAfterLinks(text), []);
  });
}

for (const text of [
  URL_TEXT,
  `打开下面的链接：\n${URL_TEXT}\n输入代码`,
  `${URL_TEXT}\n\n${URL_TEXT}\n`,
  `Open this page:\n${URL_TEXT}   \nthen`,
  `[the session](${URL_TEXT})，and more`, // a Markdown link has its own delimiter
  `<a href="${URL_TEXT}">x</a>`,
  `${URL_TEXT}/pull/9\nnext`, // a longer URL is still one URL
  `${URL_TEXT}.json\nnext`, // a dot inside a URL is not a full stop
]) {
  test(`the checker passes a link that ends its line: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(textAfterLinks(text), []);
  });
}

test("the scan reads the strings a module builds", () => {
  const bad = [
    'const ZH = "1. 打开 {uri}，输入代码";', // a `{name}` template
    "function f(url: string, publicUrl: string) {",
    "  const a = `Open ${url}, then`;", // a template literal
    '  const b = `${publicUrl}/teams-link ` + "and send it";', // concatenation of a template
    '  const c = "Open " + url + "，then";', // concatenation
    '  const d = "see " + `${url}` + " now";',
    "}",
  ].join("\n");
  assert.equal(stringsWithTextAfterALink(bad).length, 5);
  const fine = [
    "/** Docstring: GET {serviceUrl}/v3/x, then. */",
    'import x from "https://example.test/x";',
    "function f(url: string, publicUrl: string, link: string, quote: (s: string) => string, p: string) {",
    "  const a = `${url}/${quote(p)}`;",
    "  const b = `Open:\\n${url}\\n\\nthen`;",
    "  const c = `[Open the session](${link})`;",
    '  const d = "https://api.botframework.com";',
    '  const e = "Open:\\n" + url;',
    "  return `${publicUrl}${p}`;",
    "}",
  ].join("\n");
  assert.deepEqual(stringsWithTextAfterALink(fine), []);
});

// --- every message the packages build -------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

test("no string in the review service puts text after a link", () => {
  const found = [
    ...sources(path.join(ROOT, "core/src/review")),
    ...sources(path.join(ROOT, "core/src/locales")).filter((f) => path.basename(f).startsWith("review-")),
    ...sources(path.join(ROOT, "runtime/src/github")),
    ...sources(path.join(ROOT, "teams/src/views/review")),
  ].flatMap((file) => stringsWithTextAfterALink(fs.readFileSync(file, "utf8"), path.relative(ROOT, file)));
  assert.deepEqual(found, [], `a link must end its line (put it on a line of its own):\n${found.join("\n")}`);
});

// --- the messages themselves, as they are sent ----------------------------------------------------------------------------

test("the bind consent puts the link on a line of its own in both languages", () => {
  const fill = (text: string) =>
    text.replaceAll("{uri}", URL_TEXT).replaceAll("{code}", "ABCD-1234").replaceAll("{minutes}", "15");
  const text = `${fill(CONSENT_ZH)}\n\n---\n\n${fill(CONSENT_EN)}`;
  assert.deepEqual(textAfterLinks(text), []);
  assert.equal(text.split("\n").filter((l) => l === URL_TEXT).length, 2); // once in each language, alone on its line
  assert.ok(text.includes("`ABCD-1234`"));
});

test("the message to an unlinked user puts the link on a line of its own", () => {
  const page = "https://claw.example.test/primus-claw/teams-link";
  for (const lang of ["zh", "en"] as const) {
    const text = linkText
      .in(lang)
      .linkSteps({ lead: "", bot: "Clawy", page, notice: "AI notice", channel: "Microsoft Teams" });
    assert.ok(
      text.split("\n").some((line) => line === page),
      lang,
    ); // (alone on its line)
    assert.deepEqual(textAfterLinks(text), [], lang);
  }
});
