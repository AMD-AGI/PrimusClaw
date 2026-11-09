// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonValue } from "../../plugins/route-extension.js";


/** A JSON object (a conversation reference, a card envelope, a held event, a review). */
export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
