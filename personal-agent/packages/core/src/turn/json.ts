// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Reading the untyped JSON of a stream event's `data` field by field, with the Python worker's truthiness. */

import type { JsonObject, JsonValue } from "../json.js";

export type { JsonObject, JsonValue };

const EMPTY: JsonObject = Object.freeze({});

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it is an object, else an empty one (Python: `data.get(x) or {}`). */
export function objectOr(value: unknown): JsonObject {
  return isObject(value) ? value : EMPTY;
}

/** Python truthiness of a JSON value. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python's `str(value or "")` for a field that should be text: '' for anything falsy, a number as Python prints it. */
export function textOf(value: unknown): string {
  if (!truthy(value)) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return "True";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}
