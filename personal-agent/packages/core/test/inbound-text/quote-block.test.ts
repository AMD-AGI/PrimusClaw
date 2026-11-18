// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import type { LogFields, Logger } from "../../src/ports/logger.js";
import type { InboundQuote } from "../../src/ports/surface.js";
import { NAME_CHARS, QUOTE_CHARS, QUOTE_COUNT, quoteBlock, withQuote } from "../../src/inbound-text/quote-block.js";

const WHEN_MS = "1793695000000";
const WHEN = "2026-11-03 08:36 UTC";
const SECRET = "ghp_" + "A1b2C3d4E5".repeat(4);
const mask = (text: string): string => text.replace(/ghp_[A-Za-z0-9]+/g, "[hidden]");

function quote(fields: Partial<InboundQuote> = {}): InboundQuote {
  return {
    messageId: "m-100",
    author: "Bob",
    text: "The deploy failed on node 3",
    fromBot: false,
    sentAt: WHEN_MS,
    deleted: false,
    source: "entity",
    ...fields,
  };
}

function recorder(): { logger: Logger; lines: [string, string, LogFields | undefined][] } {
  const lines: [string, string, LogFields | undefined][] = [];
  const logger: Logger = {
    debug: (m, f) => lines.push(["debug", m, f]),
    info: (m, f) => lines.push(["info", m, f]),
    warn: (m, f) => lines.push(["warn", m, f]),
    error: (m, f) => lines.push(["error", m, f]),
    child: () => logger,
  };
  return { logger, lines };
}

test("one quote: a head line, then every line of it after a marker", () => {
  assert.equal(quoteBlock([quote()]), `Quoted message from Bob (${WHEN}):\n> The deploy failed on node 3`);
  assert.equal(quoteBlock([]), "");
});

test("the bot's own reply is said to be its earlier reply", () => {
  assert.equal(
    quoteBlock([quote({ fromBot: true, text: "Build 42 is green." })]),
    `Quoted your earlier reply (${WHEN}):\n> Build 42 is green.`,
  );
});

test("no name and no time give a bare head", () => {
  assert.equal(quoteBlock([quote({ author: "", sentAt: "" })]), "Quoted message:\n> The deploy failed on node 3");
});

test("line breaks of every kind are lines, blank ones keep their marker without a trailing space", () => {
  assert.equal(
    quoteBlock([quote({ text: "  one  \r\ntwo\u2028\n\nfour\x85five  " })]),
    `Quoted message from Bob (${WHEN}):\n> one\n> two\n>\n>\n> four\n> five`,
  );
});

test("a mention's markup inside a quote is text", () => {
  assert.equal(
    quoteBlock([quote({ text: "<AT>PrimusClaw Assistant</at> hi" })]),
    `Quoted message from Bob (${WHEN}):\n> PrimusClaw Assistant hi`,
  );
});

test("a deleted quote and an empty one say so", () => {
  assert.match(quoteBlock([quote({ text: "", deleted: true })]), /\n> \[the quoted message was deleted\]$/);
  assert.match(quoteBlock([quote({ text: " \n " })]), /\n> \[the text of the quoted message is not available\]$/);
});

test("a group masks the name and the text, a one to one chat does not", () => {
  const q = quote({ author: `Eve ${SECRET}`, text: `token is ${SECRET} ok` });
  const group = quoteBlock([q], { group: true, redact: mask });
  assert.ok(!group.includes(SECRET) && group.includes("Quoted message from Eve [hidden] ("));
  assert.ok(quoteBlock([q], { redact: mask }).includes(SECRET));
  assert.ok(quoteBlock([q], { group: true }).includes(SECRET), "no redact given: nothing is masked");
});

test("the cut counts code points and follows the mask", () => {
  const block = quoteBlock([quote({ text: "\u{1F600}".repeat(QUOTE_CHARS + 5) })]);
  const body = block.split("\n> ")[1] ?? "";
  assert.equal(Array.from(body).length, QUOTE_CHARS + "… [cut]".length);
  const straddling = "y".repeat(QUOTE_CHARS - 10) + " " + SECRET;
  const masked = quoteBlock([quote({ text: straddling })], { group: true, redact: mask });
  assert.ok(!masked.includes("ghp_") && masked.includes("[hidden]"));
});

test("a long name is cut", () => {
  const block = quoteBlock([quote({ author: "N".repeat(500) })]);
  assert.ok(block.startsWith(`Quoted message from ${"N".repeat(NAME_CHARS)} (`));
});

test("all the quotes share one budget and the rest are counted", () => {
  const five = [0, 1, 2, 3, 4].map((i) => quote({ author: `P${String(i)}`, text: "z".repeat(1500) }));
  const block = quoteBlock(five);
  assert.equal(block.split("Quoted message from").length - 1, 3);
  assert.ok(block.endsWith("(2 more quoted messages not shown)"));
  const one = quoteBlock([quote({ text: "w".repeat(QUOTE_CHARS) }), quote({ author: "Cy", text: "v" })]);
  assert.ok(one.endsWith("(1 more quoted message not shown)") && !one.includes("> v"));
  const many = Array.from({ length: 8 }, (_, i) => quote({ author: `Q${String(i)}`, text: "n" }));
  const shown = quoteBlock(many);
  assert.equal(shown.split("Quoted message from").length - 1, QUOTE_COUNT);
  assert.ok(shown.endsWith("(3 more quoted messages not shown)"));
});

test("a quote is logged by where it came from and never by what it says", () => {
  const { logger, lines } = recorder();
  quoteBlock([quote({ text: "the secret plan" }), quote({ source: "html", text: "other words" })], { logger });
  assert.deepEqual(lines, [["info", "the message quotes earlier messages", { count: 2, sources: "entity+html" }]]);
});

test("with quote puts the quote before the words", () => {
  assert.equal(withQuote("hi", "Q"), "Q\n\nhi");
  assert.equal(withQuote("hi", ""), "hi");
  assert.equal(withQuote("", "Q"), "Q");
  assert.equal(withQuote("", ""), "");
});
