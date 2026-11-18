// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The TypeScript converter against the Python one: each fixture input gives the same HTML, or fails the same way. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { RichTextError, toTeamsHtml } from "../../src/richtext/index.js";

const Golden = z.object({
  cases: z.array(
    z.object({
      name: z.string(),
      markdown: z.string(),
      lead: z.boolean(),
      html: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

const golden = Golden.parse(
  JSON.parse(readFileSync(new URL("../../../../test-support/data/richtext_golden.json", import.meta.url), "utf8")),
);

test("the golden fixture covers at least forty inputs", () => {
  assert.ok(golden.cases.length >= 40, String(golden.cases.length));
});

for (const c of golden.cases) {
  test(`same html as the python converter: ${c.name}`, () => {
    if (c.html === undefined) {
      assert.equal(c.error, "ValueError");
      assert.throws(() => toTeamsHtml(c.markdown, { lead: c.lead }), RichTextError);
    } else {
      assert.equal(toTeamsHtml(c.markdown, { lead: c.lead }), c.html);
    }
  });
}
