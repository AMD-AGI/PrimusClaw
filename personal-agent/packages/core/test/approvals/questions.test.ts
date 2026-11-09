// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { OPTION_MAX, QUESTIONS_MAX, answersOf, cardQuestions, questionWire } from "../../src/approvals/questions.js";

const QUESTIONS = [
  {
    id: "q1",
    question: "Which branch?",
    options: [{ id: "a", label: "main" }, { id: "b", label: "dev" }, { id: "c" }],
    allow_multiple: true,
  },
  { id: "q2", question: "Anything else?" },
];

it("card questions keep what a card shows and drop what it cannot", () => {
  const raw = [
    ...QUESTIONS,
    { id: "", question: "x" },
    { id: "q3", question: "  " },
    "nonsense",
    null,
    { id: 7, question: "n" },
  ];
  const out = cardQuestions(raw);
  assert.deepEqual(
    out.map((q) => q.id),
    ["q1", "q2", "7"],
  );
  assert.deepEqual(out[0]?.options, [
    { id: "a", label: "main" },
    { id: "b", label: "dev" },
    { id: "c", label: "c" },
  ]);
  assert.equal(out.at(0)?.allowMultiple, true);
  assert.equal(out[1]?.allowMultiple, false);
  assert.deepEqual(cardQuestions("not a list"), []);
});

it("card questions are clipped and counted", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    id: `q${String(i)}`,
    question: `Q${String(i)}`,
    options: [{ id: "o", label: "x".repeat(500) }],
  }));
  const out = cardQuestions(many);
  assert.equal(out.length, QUESTIONS_MAX);
  assert.equal(Array.from(out[0]?.options[0]?.label ?? "").length, OPTION_MAX);
});

it("answers are the chosen labels then the typed words and blanks are skipped", () => {
  const { answers, skipped } = answersOf({
    questions: QUESTIONS.map((q) => q),
    choice_0: "a,b,zz",
    text_0: "  and quickly ",
    text_1: "",
  });
  assert.deepEqual([...answers], [["q1", "main, dev. and quickly"]]);
  assert.deepEqual(skipped, ["q2"]);
});

it("the wire form round trips", () => {
  const out = cardQuestions(QUESTIONS);
  assert.deepEqual(cardQuestions(out.map(questionWire)), out);
});
