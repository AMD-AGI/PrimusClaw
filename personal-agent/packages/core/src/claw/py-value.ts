// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `bool(value)` of a JSON value, as the Python worker tested an answer's field: "", 0, false, null, [] and {} are false. */
export function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}
