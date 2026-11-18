// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A value that survives `JSON.stringify` / `JSON.parse` unchanged. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}
