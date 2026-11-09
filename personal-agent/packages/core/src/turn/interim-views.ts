// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * INTERIM (W4b): the views the turn asks for and other lines render, declared here until their owners declare them
 * (W5: approval and question cards; W8: the thumbs card). The shapes are the ones agreed with those lines.
 */

import type { Lang } from "../locales/lang.js";
import type { JsonObject } from "../json.js";

/** Brain holds a tool call for the user's decision (a permissionRequest): Approve / Deny. */
export interface ApprovalModel {
  readonly tool: string;
  readonly input: unknown;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly group: boolean;
  readonly ownerName: string;
  /** Brain's permissionRequest: its summary, tool_description and intent say what will change. */
  readonly event: JsonObject;
  readonly lang: Lang;
}

/** One question of a userQuestion, cut to what a card shows. */
export interface CardQuestion {
  readonly id: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly allowMultiple: boolean;
}

/** The agent asks the user before it goes on: its questions, a box for each, one Send button. */
export interface QuestionModel {
  readonly questions: readonly CardQuestion[];
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly group: boolean;
  readonly ownerName: string;
  readonly note: string;
}


declare module "../ports/surface.js" {
  interface ViewMap {
    approval: ApprovalModel;
    question: QuestionModel;
  }
}

const QUESTIONS_MAX = 5;
const OPTIONS_MAX = 10;
const QUESTION_MAX = 500;
const OPTION_MAX = 120;

function clipLine(text: string, limit: number): string {
  const flat = text.split(/\s+/u).filter(Boolean).join(" ");
  const chars = Array.from(flat);
  return chars.length <= limit
    ? flat
    : `${chars
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The questions of a userQuestion event, cut to what a card shows (INTERIM: W5's `cardQuestions`). */
export function cardQuestions(raw: unknown): CardQuestion[] {
  const out: CardQuestion[] = [];
  for (const q of Array.isArray(raw) ? raw : []) {
    if (
      !isObject(q) ||
      typeof q["id"] !== "string" ||
      !q["id"].trim() ||
      typeof q["question"] !== "string" ||
      !q["question"].trim()
    )
      continue;
    const options = (Array.isArray(q["options"]) ? q["options"] : [])
      .filter(
        (o): o is Record<string, unknown> => isObject(o) && typeof o["id"] === "string" && Boolean(o["id"].trim()),
      )
      .map((o) => ({
        id: String(o["id"]),
        label: clipLine(typeof o["label"] === "string" && o["label"] ? o["label"] : String(o["id"]), OPTION_MAX),
      }))
      .slice(0, OPTIONS_MAX);
    out.push({
      id: q["id"],
      question: clipLine(q["question"], QUESTION_MAX),
      options,
      allowMultiple: q["allow_multiple"] === true,
    });
  }
  return out.slice(0, QUESTIONS_MAX);
}
