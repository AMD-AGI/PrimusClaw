// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a question card's Send carries back as Claw takes it (teams/tests/test_ask_user_question.py, the answers): the labels of
 * the chosen options, then the words; a choice the card never had is ignored. The card and its presses are in
 * teams/test/assistant-cards-render-approvals.test.ts.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { answersOf, cardQuestions, questionWire } from "../../src/approvals/questions.js";

const QUESTIONS = [
  {
    id: "db",
    question: "Which database?",
    options: [
      { id: "lite", label: "SQLite" },
      { id: "pg", label: "PostgreSQL" },
    ],
  },
  {
    id: "envs",
    question: "Where should it run?",
    allow_multiple: true,
    options: [
      { id: "dev", label: "dev" },
      { id: "prod", label: "prod" },
    ],
  },
];

it("answers are the chosen labels then the words and a choice the card never had is ignored", () => {
  // (what the Send button carries: the questions as the card showed them)
  const data = {
    primusclaw: "answer",
    session_id: "s",
    tool_use_id: "t",
    questions: cardQuestions(QUESTIONS).map(questionWire),
  };
  const cases: [Record<string, string>, Record<string, string>, string[]][] = [
    [{ choice_0: "pg" }, { db: "PostgreSQL" }, ["envs"]],
    [{ text_0: "  MySQL  " }, { db: "MySQL" }, ["envs"]],
    [{ choice_0: "forged", choice_1: "prod,forged" }, { envs: "prod" }, ["db"]],
    [{}, {}, ["db", "envs"]],
  ];
  for (const [filled, answers, skipped] of cases) {
    const got = answersOf({ ...data, ...filled });
    assert.deepEqual([Object.fromEntries(got.answers), got.skipped], [answers, skipped], JSON.stringify(filled));
  }
});
