// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawAnswerInvalid, type JsonObject } from "@primusclaw/personal-agent";
import { z } from "zod";

/** Claw's answer `{data: <object>}`; anything else is an answer this client does not understand. */
const dataObject = z.looseObject({ data: z.record(z.string(), z.unknown()) });
/** Claw's answer `{data: [...]}`. */
const dataList = z.looseObject({ data: z.array(z.unknown()) });
/** Claw's answer `{data: <anything>}`. */
const dataAny = z.looseObject({ data: z.unknown() });

/** The answer's `data` object. */
export function dataOf(answer: unknown, what: string): JsonObject {
  const parsed = dataObject.safeParse(answer);
  if (!parsed.success) throw new ClawAnswerInvalid(`${what}: no data object`);
  return parsed.data.data as JsonObject;
}

/** The answer's `data` list, the objects in it only. */
export function rowsOf(answer: unknown, what: string): JsonObject[] {
  const parsed = dataList.safeParse(answer);
  if (!parsed.success) throw new ClawAnswerInvalid(`${what} is not a list`);
  return parsed.data.data.filter(isRow) as JsonObject[];
}

/** The answer's `data`, whatever it is (an answer without the field is not one). */
export function anyDataOf(answer: unknown, what: string): unknown {
  const parsed = dataAny.safeParse(answer);
  if (!parsed.success || !("data" in parsed.data)) throw new ClawAnswerInvalid(`${what}: no data`);
  return parsed.data.data;
}

/** The answer itself, as an object. */
export function objectOf(answer: unknown, what: string): Record<string, unknown> {
  if (!isRow(answer)) throw new ClawAnswerInvalid(`${what}: not an object`);
  return answer;
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `message_id` of a message Claw took, or null when it queued it behind a running turn (`{"queued": true}`). */
export function messageIdOf(answer: unknown): string | null {
  const out = objectOf(answer, "a message");
  const id = out["message_id"];
  if ((id === undefined || id === null || id === "") && out["queued"] === true) return null;
  if (typeof id !== "string" || id === "") throw new ClawAnswerInvalid("a message without its id");
  return id;
}
