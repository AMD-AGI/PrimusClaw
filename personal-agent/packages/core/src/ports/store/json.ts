// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "../../json.js";

export type { JsonObject };

/** A JSON object as opposed to an array or a scalar (what a `*_json` column of an object holds when it is well formed). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
