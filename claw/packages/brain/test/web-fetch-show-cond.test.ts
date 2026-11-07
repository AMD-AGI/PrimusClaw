// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A page that shows a cell only for some choices (rocm-docs `data-show-cond`) keeps saying which, once flattened to text
 * (parity R2, 2026-11-07: the ROCm 10.1.0 compatibility matrix lists Rocky Linux 9 and Oracle Linux 8 for MI300X only, and the
 * flattened page read as if they were MI355X distributions).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { htmlToMarkdown, showCondition } = await import("../src/tools/web/fetch.js");

test("SC1 a cell shown only for some GPUs says so in the text web_fetch returns", async () => {
  const html = `<table><tr><th>Oracle Linux</th>
    <td data-show-cond='{"gpu": ["amd-instinct-mi355x", "amd-instinct-mi350x", "amd-instinct-mi300x"]}'>Oracle Linux 10, 9</td>
    <td data-show-cond='{"gpu": ["amd-instinct-mi300x"]}'>Oracle Linux 8</td></tr>
    <tr><th>Rocky Linux</th><td data-show-cond='{"gpu": ["amd-instinct-mi300x"]}'>Rocky Linux 9</td></tr></table>
    <div data-show-cond='{"os": ["sles"]}'><p>SLES 16.0</p></div>`;
  const md = await htmlToMarkdown(html);
  assert.match(md, /\(shown only for gpu: amd-instinct-mi300x\)\s*Oracle Linux 8/);
  assert.match(md, /\(shown only for gpu: amd-instinct-mi300x\)\s*Rocky Linux 9/);
  assert.match(md, /\(shown only for gpu: amd-instinct-mi355x, amd-instinct-mi350x, amd-instinct-mi300x\)\s*Oracle Linux 10, 9/);
  assert.match(md, /\(shown only for os: sles\)\s+SLES 16\.0/);
});

test("SC2 a condition that is not a JSON object of lists adds nothing; a long list is cut and counted", async () => {
  assert.equal(showCondition(null), null);
  assert.equal(showCondition("not json"), null);
  assert.equal(showCondition("[1,2]"), null);
  assert.equal(showCondition('{"gpu": "mi300x"}'), null);
  assert.equal(showCondition('{"gpu": []}'), null);
  const many = showCondition(JSON.stringify({ gfx: Array.from({ length: 20 }, (_, i) => `gfx${i}`) }))!;
  assert.match(many, /gfx11, \+8 more\)$/);
  assert.equal(await htmlToMarkdown(`<td data-show-cond="broken">plain</td>`), "plain");
  assert.equal(await htmlToMarkdown("<p>no conditions</p>"), "no conditions");
});
