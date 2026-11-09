// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Narrowing for the untyped JSON of a stream event's `data`, which is read field by field and never trusted. */
export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it is an object, else an empty one (Python: `data.get(x) or {}`). */
export function objectOr(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

/** Python's `str(value or "")` for a field that should be text: a non-empty string as it is, '' for anything falsy. */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null || value === false || value === 0 || value === "") return "";
  if (typeof value === "number" || typeof value === "boolean") return pyRepr(value);
  return JSON.stringify(value) ?? "";
}

function pyRepr(value: number | boolean): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return Number.isInteger(value) ? String(value) : String(value);
}

/** Python truthiness of a JSON value. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}
