// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import { err, ok, type Result } from "./result.js";

/**
 * Every input that comes from outside the process (a Claw response, a channel's activity, a queue message, an HTTP
 * request, the environment) is read through a zod schema, here, before any field of it is used. What failed is kept as
 * the paths of the offending fields only: the values may be anything, including a secret.
 */
export interface InvalidInput {
  readonly kind: "invalid_input";
  /** What was being read ("claw.work_item", "teams.activity"), for the log line. */
  readonly what: string;
  /** The dotted paths of the fields that did not match (never their values). */
  readonly paths: readonly string[];
}

export function parseInput<S extends z.ZodType>(
  what: string,
  schema: S,
  input: unknown,
): Result<z.output<S>, InvalidInput> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const paths = parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)");
  return err({ kind: "invalid_input", what, paths: [...new Set(paths)] });
}
