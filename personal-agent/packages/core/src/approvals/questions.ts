// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The questions an agent asks before it goes on (`ask_user_question`, Brain's userQuestion event) and the answers a question
 * card sends back (teams_agent/render.py: card_questions, answers_of).
 */
import { z } from "zod";

import { clip } from "../text/plain.js";
import { cpHead, pyStrip } from "../text/py-text.js";

/** The tool whose call waits for the answer to a question card. */
export const QUESTION_TOOL = "ask_user_question";
export const QUESTIONS_MAX = 5;
export const OPTIONS_MAX = 10;
export const QUESTION_MAX = 500;
export const OPTION_MAX = 120;
/** What one free-text answer takes. */
export const ANSWER_MAX = 1000;

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
}

export interface CardQuestion {
  readonly id: string;
  readonly question: string;
  readonly options: readonly QuestionOption[];
  readonly allowMultiple: boolean;
}

/** Python's `str(x or "")` for the scalar values a question's fields hold. */
function scalarText(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value === true) return "True";
  return "";
}

const rawOption = z.object({ id: z.unknown(), label: z.unknown() }).partial();
const rawQuestion = z
  .object({ id: z.unknown(), question: z.unknown(), options: z.unknown(), allow_multiple: z.unknown() })
  .partial();

function optionsOf(raw: unknown): QuestionOption[] {
  const out: QuestionOption[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const option = rawOption.safeParse(item);
    if (!option.success || typeof item !== "object" || Array.isArray(item)) continue;
    const id = scalarText(option.data.id);
    if (!pyStrip(id)) continue;
    out.push({ id, label: clip(scalarText(option.data.label) || id, OPTION_MAX) });
  }
  return out.slice(0, OPTIONS_MAX);
}

/**
 * The questions of a userQuestion event (or of a question card's own data), cut to what a card shows. A question without an id or
 * text is left out; so is anything that is not an object.
 */
export function cardQuestions(raw: unknown): CardQuestion[] {
  const out: CardQuestion[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const question = rawQuestion.safeParse(item);
    if (!question.success || typeof item !== "object" || Array.isArray(item)) continue;
    const id = scalarText(question.data.id);
    const text = scalarText(question.data.question);
    if (!pyStrip(id) || !pyStrip(text)) continue;
    out.push({
      id,
      question: clip(text, QUESTION_MAX),
      options: optionsOf(question.data.options),
      allowMultiple: question.data.allow_multiple === true,
    });
  }
  return out.slice(0, QUESTIONS_MAX);
}

/** A question as a card's button carries it on the wire (the Python worker's dict, so a card it drew can be answered here). */
export function questionWire(question: CardQuestion): Record<string, unknown> {
  return {
    id: question.id,
    question: question.question,
    options: question.options.map((o) => ({ id: o.id, label: o.label })),
    allow_multiple: question.allowMultiple,
  };
}

export interface Answers {
  /** {question id: answer}, in the order of the questions. */
  readonly answers: ReadonlyMap<string, string>;
  /** The ids of the questions left blank. */
  readonly skipped: readonly string[];
}

/**
 * What the person answered on a question card, as Claw takes it: an answer is the labels of the chosen options, then what was
 * typed; a choice the card never offered is ignored.
 */
export function answersOf(data: Readonly<Record<string, unknown>>): Answers {
  const answers = new Map<string, string>();
  const skipped: string[] = [];
  cardQuestions(data["questions"]).forEach((q, i) => {
    const labels = new Map(q.options.map((o) => [o.id, o.label]));
    const chosen = scalarText(data[`choice_${String(i)}`])
      .split(",")
      .flatMap((c) => {
        const label = labels.get(c);
        return label === undefined ? [] : [label];
      });
    const typed = cpHead(pyStrip(scalarText(data[`text_${String(i)}`])), ANSWER_MAX);
    const answer = [chosen.join(", "), typed].filter(Boolean).join(". ");
    if (answer) answers.set(q.id, answer);
    else skipped.push(q.id);
  });
  return { answers, skipped };
}
