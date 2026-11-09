// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { pyJsonDumps } from "../text/py-text.js";

/**
 * Python's reading of a JSON value the worker did not check the type of: `str(value)` and `bool(value)`. Only the
 * scalars Claw sends matter in practice; a list or an object is written as Python's JSON of it, not its repr.
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return pyJsonDumps(value);
}

/** `bool(value)` of a JSON value: "", 0, false, null, [] and {} are false. */
export function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `str(value or "")`: a false value is "", anything else its text. */
export function pyStrOr(value: unknown): string {
  return pyTruthy(value) ? pyStr(value) : "";
}
