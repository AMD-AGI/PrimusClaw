// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every remote-agent card and line speaks the chat's language (test_remote_cards_zh): rendered in Chinese, none of the English UI
 * words is left. The English UI words come from the catalogs: every word of an English sentence that its Chinese sentence does not
 * keep. The Chinese render must have none of them outside what the fixtures supplied, inline code, links and slash commands, and the
 * English render of the same card must have some, so the check is seen to refuse.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Lang, own, remoteDomain, remoteView } from "@primusclaw/personal-agent";

import { fixtureStrings, renders } from "./zh-fixtures.js";

const WORD = /[A-Za-z][A-Za-z']*/g;
const STRIPPED = [
  /`[^`]*`/g,
  /\]\([^)]*\)/g,
  /https?:\/\/\S+/g,
  /(?<![\p{L}\p{N}_])\/[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]*)+/gu,
  /[\p{L}\p{N}_-]+\.[A-Za-z][\p{L}\p{N}_]*/gu,
  /(?<![\p{L}\p{N}_/])\/[a-z][\p{L}\p{N}_-]*/gu,
  /\{[a-zA-Z_]+\}/g,
];

/** Text without what stays English in both languages by design. */
function strip(text: string): string {
  return STRIPPED.reduce((t, pattern) => t.replace(pattern, " "), text);
}

function wordsOf(text: string): Set<string> {
  return new Set((strip(text).match(WORD) ?? []).map((w) => w.toLowerCase()));
}

/** A catalog message with its fields as `{name}`. */
function template(message: unknown): string {
  if (typeof message === "string") return message;
  const fields = new Proxy({}, { get: (_, key) => `{${String(key)}}` });
  return (message as (p: unknown) => string)(fields);
}

type Catalog = { in(lang: Lang): Readonly<Record<string, unknown>> };
const CATALOGS: Catalog[] = [
  remoteView.remoteText,
  remoteView.remoteHealthText,
  remoteView.remoteQueuedText,
  remoteView.remoteOffText,
];

/** (Chinese, English) of every fixed sentence of the remote-agent cards and lines. */
function pairs(): [string, string][] {
  return CATALOGS.flatMap((catalog) => {
    const zh = catalog.in("zh");
    const en = catalog.in("en");
    return Object.keys(en).map((key): [string, string] => [template(own(zh, key)), template(own(en, key))]);
  });
}

function uiWords(): Set<string> {
  const kept = new Set(pairs().flatMap(([zh]) => [...wordsOf(zh)]));
  return new Set(
    pairs()
      .flatMap(([, en]) => [...wordsOf(en)])
      .filter((w) => !kept.has(w)),
  );
}
const UI_WORDS = uiWords();
const FIXTURES = [...fixtureStrings()]
  .filter((s) => s.length > 1 && !UI_WORDS.has(s.toLowerCase()))
  .sort((a, b) => b.length - a.length);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What a person reads of a card (every text but a monospace one, button titles, labels, placeholders) or of a line, without the
 * text the fixtures supplied. */
function shownText(rendered: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (node["fontType"] === "Monospace") return;
      for (const key of ["text", "title", "label", "placeholder"]) {
        const value = own(node, key);
        if (typeof value === "string") parts.push(value);
      }
      Object.values(node).forEach((v) => {
        if (v && typeof v === "object") walk(v);
      });
    }
  };
  if (typeof rendered === "string") parts.push(rendered);
  else walk(rendered);
  let text = parts.join("\n");
  for (const supplied of FIXTURES) {
    for (const form of new Set([supplied, remoteDomain.plain(supplied)])) {
      text = text.replace(new RegExp(`(?<![A-Za-z])${escape(form)}(?![A-Za-z])`, "g"), " ");
    }
  }
  return text;
}

function englishLeft(rendered: unknown): Set<string> {
  return new Set((strip(shownText(rendered)).match(WORD) ?? []).filter((w) => UI_WORDS.has(w.toLowerCase())));
}

test("the word list comes from the tables and is not trivial", () => {
  for (const w of ["session", "attach", "close", "refresh", "typing", "folder", "offline", "online", "back"])
    assert.ok(UI_WORDS.has(w), w);
  for (const w of ["agent", "path", "claude", "resume"]) assert.ok(!UI_WORDS.has(w), w); // (kept on purpose: the Chinese says them too)
  for (const [zh, en] of pairs()) assert.ok(zh && en && zh !== en, `${zh} / ${en}`);
});

test("every table sentence has the same fields in both languages", () => {
  const fields = (text: string) => new Set(text.match(/\{[a-zA-Z]+\}/g) ?? []);
  for (const [zh, en] of pairs()) assert.deepEqual(fields(zh), fields(en), en);
});

const ZH = renders("zh");
const EN = renders("en");

test("a card in a chinese chat has no english ui word left", () => {
  for (const name of Object.keys(EN)) {
    assert.deepEqual(englishLeft(own(ZH, name)), new Set(), `${name}: ${shownText(own(ZH, name))}`);
    assert.ok(englishLeft(own(EN, name)).size > 0, `${name}: the same card in English is refused`);
  }
});

test("the fixtures say every sentence of the table", () => {
  const all = Object.values(ZH)
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
    .join("\n");
  const zh = remoteView.remoteText.in("zh");
  for (const key of Object.keys(zh)) {
    const fragments = template(own(zh, key))
      .split(/\{[a-zA-Z]+\}/)
      .map((f) => f.trim());
    const longest = fragments.sort((a, b) => b.length - a.length)[0] ?? "";
    assert.ok(all.includes(JSON.stringify(longest).slice(1, -1)) || all.includes(longest), `${key}: ${longest}`);
  }
});

test("english is unchanged in shape", () => {
  const text = JSON.stringify(EN["agents card"]);
  for (const words of [
    "Your agents",
    "Typing works too: /help lists the commands.",
    '"New session"',
    '"Attach"',
    '"Close"',
    '"Refresh"',
    "Your sessions",
    "(online)",
  ]) {
    assert.ok(text.includes(words), words);
  }
});

test("an always option named in chinese keeps its english title", () => {
  const option = { optionId: "o", kind: "allow_always", name: "始终允许" };
  assert.equal(remoteDomain.buttonTitle(option, "en"), "Always: 始终允许");
  assert.equal(remoteDomain.buttonTitle(option, "zh"), "始终允许");
  assert.equal(remoteDomain.buttonTitle({ ...option, name: "Always allow" }, "zh"), "Always allow");
  assert.equal(remoteDomain.buttonTitle({ ...option, name: "好" }, "zh"), "始终：好");
});
