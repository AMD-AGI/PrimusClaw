// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The questions a review item asks its owner, read back into Chinese for a reviewer who writes it (`assistant/review-questions.ts`, N20).
 *
 *   Q1  every template's English reads back to its own Chinese, with its argument kept
 *   Q2  any other text (a worker's own question, a near miss) is not read back
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { REVIEW_QUESTIONS, reviewQuestionZh } from "../src/assistant/review-questions.js";

test("Q1 every template's English reads back to its Chinese, the argument kept", () => {
  const arg = "AMD-AGI/demo.x#7";
  for (const [name, t] of Object.entries(REVIEW_QUESTIONS)) {
    const zh = reviewQuestionZh(t.en(arg));
    assert.equal(zh, t.zh(arg), name);
    assert.match(zh!, /[一-鿿]/, name);
  }
  assert.equal(reviewQuestionZh("Look at AMD-AGI/PrimusClaw#646"), "请看一下 AMD-AGI/PrimusClaw#646");
  assert.equal(reviewQuestionZh("Confirm or deny the merge of AMD-AGI/demo#7"), "确认或拒绝合入 AMD-AGI/demo#7");
});

test("Q2 other text is not read back", () => {
  for (const text of ["GitHub says the branch has conflicts", "Look at", "Please look at AMD-AGI/demo#7", ""]) {
    assert.equal(reviewQuestionZh(text), null, text);
  }
});
