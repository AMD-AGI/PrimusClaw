// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { pyJsonDumps } from "../text/py-text.js";

/**
 * Python's `str(value)` of a JSON value, where the worker wrote `str(x)` without `or ""`: None is "None", a boolean
 * "True" / "False"; a list or an object is written as Python's JSON of it (its repr differs only in quotes).
 */
export function pyStrOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  return pyJsonDumps(value);
}

/** `bool(value)` of a JSON value, as the Python worker tested an answer's field: "", 0, false, null, [] and {} are false. */
export function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}
