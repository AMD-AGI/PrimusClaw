// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** JSON values as they go on the wire: what a card, an activity or an envelope is made of. */
export type Json = string | number | boolean | null | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json | undefined;
}

/** One element of an Adaptive Card (a TextBlock, a Container, an Action...): a JSON object with a `type`. */
export interface CardElement extends JsonObject {
  type: string;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every JSON object in `node`, depth first, `node` itself first. */
export function* walk(node: unknown): Generator<JsonObject> {
  if (Array.isArray(node)) {
    for (const value of node) yield* walk(value);
  } else if (isObject(node)) {
    yield node;
    for (const value of Object.values(node)) yield* walk(value);
  }
}
