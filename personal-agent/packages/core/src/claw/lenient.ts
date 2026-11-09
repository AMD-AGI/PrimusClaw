// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Field readers for Claw's answers, which this agent reads the way the Python worker did: a field that is absent, or of
 * another type than expected, is read as absent (`undefined`) and the reading fills in its own default. The answer as a
 * whole is still checked (an object where an object is expected), by the caller's schema.
 */
import { z } from "zod";

/** A value `schema` accepts, else `undefined`: a field Claw sent wrong is read as one it did not send. */
export function lenient<T extends z.ZodType>(schema: T) {
  return z.optional(
    z.unknown().transform((value): z.output<T> | undefined => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }),
  );
}

/** Any string. */
export const anyText = lenient(z.string());
/** A string that is not empty (Python's `isinstance(v, str) and v`). */
export const someText = lenient(z.string().min(1));
/** A whole number (Python's `isinstance(v, int) and not isinstance(v, bool)`). */
export const wholeNumber = lenient(z.number().int());
export const flag = lenient(z.boolean());
/** A JSON object (not an array). */
export const objectOf = lenient(z.record(z.string(), z.unknown()));
/** Whatever was there, unread. */
export const anything = z.unknown().optional();

/** Rows of a list: the ones `schema` accepts (rows that are not objects are left out). */
export function rowsOf<T extends z.ZodType>(schema: T): z.ZodType<Array<z.output<T>>> {
  return z.array(z.unknown()).transform((rows) =>
    rows.flatMap((row) => {
      const parsed = schema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}

/** Whether `value` is a JSON object (a dict to Python): not null, not an array. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
