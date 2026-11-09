// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PR_SUMMARY_MAX_CJK,
  PR_SUMMARY_MAX_OTHER,
  clipPrSummary,
  cpLength,
  parseRequesterView,
} from "../../src/index.js";

const ZH = "给代审结论卡加一句话，概述这个 PR 做了什么";
const EN = "Adds a one-sentence summary of what the pull request does to the review conclusion card.";
const LINK = "https://github.com/AMD-AGI/Hyperloom/pull/12";

describe("a pull request's one-sentence summary", () => {
  for (const value of [null, 3, "", "  \n\t ", ["a"], { x: 1 }]) {
    it(`nothing that is not a sentence is shown: ${JSON.stringify(value)}`, () => {
      assert.equal(clipPrSummary(value), "");
    });
  }

  it("a sentence that fits is shown as written on one line", () => {
    assert.equal(clipPrSummary(`  ${ZH}\n。 `), ZH + " 。");
    assert.equal(clipPrSummary(EN), EN);
  });

  it("a long sentence is cut by its language", () => {
    const zh = clipPrSummary("把代审结论卡上的说明改成一句话".repeat(10));
    assert.equal(cpLength(zh), PR_SUMMARY_MAX_CJK);
    assert.ok(zh.endsWith("…"));
    const en = clipPrSummary("Adds a summary line ".repeat(20));
    assert.ok(cpLength(en) <= PR_SUMMARY_MAX_OTHER && en.endsWith("…") && !en.endsWith(" …"));
    assert.equal(clipPrSummary("中".repeat(PR_SUMMARY_MAX_CJK)), "中".repeat(PR_SUMMARY_MAX_CJK));
    assert.equal(clipPrSummary("a".repeat(PR_SUMMARY_MAX_OTHER)), "a".repeat(PR_SUMMARY_MAX_OTHER));
    assert.equal(cpLength(clipPrSummary("\u{20000}".repeat(100))), PR_SUMMARY_MAX_CJK);
  });

  it("a credential in it is masked", () => {
    const secret = "ghp_" + "A1b2C3d4E5".repeat(4);
    assert.ok(!clipPrSummary(`Rotates ${secret} in CI`).includes(secret));
  });

  it("link and tag markup becomes full-width brackets", () => {
    assert.equal(clipPrSummary("[click](https://x.test) <b>bold</b>"), "［click］(https://x.test) ‹b›bold‹/b›");
  });

  it("the asker's view reads it and a view without it reads as before", () => {
    const view = parseRequesterView(
      { status: "done", pr_url: LINK, verdict: "approve", merged: true, pr_summary: ZH + "\n" + "很长".repeat(100) },
      "item-1",
    );
    assert.ok(view?.prSummary.startsWith(ZH));
    assert.equal(cpLength(view?.prSummary ?? ""), PR_SUMMARY_MAX_CJK);
    assert.equal(
      parseRequesterView({ status: "done", pr_url: LINK, verdict: "approve", merged: true }, "i")?.prSummary,
      "",
    );
    assert.equal(parseRequesterView({ status: "done", pr_url: LINK, pr_summary: null }, "i")?.prSummary, "");
  });
});
