// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A page larger than one answer is read in parts (`selectPart`): the feature-gate page of Kubernetes converts to several hundred
 * thousand characters, and its first 50,000 end long before `SchedulerQueueingHints` (2026-11-06 parity run, R1; the ROCm compatibility
 * matrix in R2 likewise).
 *
 *   LP1 a page longer than an answer, read with no part: its first part, and a note that says how long it is and the offset to read on
 *   LP2 find: the page around each place the text appears, wherever it is on the page, with where each piece is
 *   LP3 offset: from that character on; the last part says it is the end
 *   LP4 find that matches nothing says so, with the page's length; a page that fits whole has no note
 *   LP5 the second read of a page comes from the cache, and find works on it
 *   LP6 web_fetch's schema offers find and offset
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";

import { WebFetchService, selectPart, FIND_CONTEXT_CHARS } from "../src/tools/web/fetch.js";
import { WEB_FETCH_MAX_OUTPUT_CHARS } from "../src/config.js";

const pages = new Map<string, () => string>();
let served = 0;
const previous = axios.defaults.adapter;
axios.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
  const page = pages.get(String(config.url));
  if (!page) throw new Error(`no page ${config.url}`);
  served += 1;
  return { data: Buffer.from(page()), status: 200, statusText: "OK", headers: { "content-type": "text/plain; charset=utf-8" }, config, request: {} };
}) as AxiosAdapter;
after(() => { axios.defaults.adapter = previous; });

/** A reference page: one line per gate, alphabetical, the one asked about far past the first answer's length. */
function gatesPage(): string {
  const lines: string[] = [];
  for (let i = 0; i < 4000; i += 1) lines.push(`| Gate${String(i).padStart(4, "0")} | false | Alpha | 1.${i % 40} | - |`);
  lines.splice(3500, 0, "| SchedulerQueueingHints | true | GA | 1.34 | - |");
  return lines.join("\n");
}

async function fetchPage(url: string, extra: Record<string, unknown> = {}): Promise<string> {
  return new WebFetchService({} as never).execute({ url, ...extra }, { isError: false });
}

test("LP1 a long page read with no part: its first part, and how to read on", async () => {
  pages.set("https://docs.example/lp1", gatesPage);
  const total = gatesPage().length;
  assert.ok(total > WEB_FETCH_MAX_OUTPUT_CHARS * 2, "the page is longer than an answer");
  const out = await fetchPage("https://docs.example/lp1");
  assert.match(out, new RegExp(`Part: Showing characters 0-${WEB_FETCH_MAX_OUTPUT_CHARS} of ${total}\\. Call web_fetch again with offset=${WEB_FETCH_MAX_OUTPUT_CHARS}`));
  assert.ok(!out.includes("SchedulerQueueingHints"), "the gate is past the first part");
});

test("LP2 find: the page around each place the text appears, wherever it is", async () => {
  pages.set("https://docs.example/lp2", gatesPage);
  const out = await fetchPage("https://docs.example/lp2", { find: "schedulerqueueinghints" });
  assert.match(out, /\| SchedulerQueueingHints \| true \| GA \| 1\.34 \|/);
  assert.match(out, /Part: Showing the page around 1 match of "schedulerqueueinghints"/);
  assert.match(out, /\[characters \d+-\d+ of \d+\]/);
  assert.ok(out.length < FIND_CONTEXT_CHARS * 2 + 1000, "only the part around it");
});

test("LP3 offset: from that character on, and the last part says it is the end", async () => {
  pages.set("https://docs.example/lp3", gatesPage);
  const total = gatesPage().length;
  const out = await fetchPage("https://docs.example/lp3", { offset: total - 100 });
  assert.match(out, new RegExp(`Showing characters ${total - 100}-${total} of ${total}\\. That is the end of the page\\.`));
  assert.ok(out.trimEnd().endsWith(gatesPage().slice(-20)));
});

test("LP4 find with no match says so; a page that fits whole has no note", () => {
  const none = selectPart("abc def", { offset: 0, find: "xyz" });
  assert.equal(none.text, "");
  assert.match(none.note, /"xyz" does not appear on this page \(7 characters\)/);
  assert.deepEqual(selectPart("short page", { offset: 0, find: "" }), { text: "short page", note: "" });
  const two = selectPart(`${"a".repeat(5000)}NEEDLE${"b".repeat(5000)}NEEDLE${"c".repeat(100)}`, { offset: 0, find: "needle" });
  assert.match(two.note, /2 matches/);
  assert.equal((two.text.match(/NEEDLE/g) ?? []).length, 2);
});

test("LP5 a second read of the page comes from the cache, and find works on it", async () => {
  pages.set("https://docs.example/lp5", gatesPage);
  await fetchPage("https://docs.example/lp5");
  const before = served;
  const out = await fetchPage("https://docs.example/lp5", { find: "SchedulerQueueingHints" });
  assert.equal(served, before, "not fetched again");
  assert.match(out, /\| SchedulerQueueingHints \| true \| GA/);
});

test("LP6 web_fetch offers find and offset", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/tools/router.ts", import.meta.url), "utf8"));
  const schema = src.slice(src.indexOf('name: "web_fetch"'), src.indexOf("── exit_plan_mode"));
  assert.match(schema, /find: \{ type: "string"/);
  assert.match(schema, /offset: \{ type: "number"/);
});
