// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Checks a card against the Adaptive Cards 1.5 schema (test-support/data), and reads a card message's parts. */
import { readFileSync } from "node:fs";

import { Ajv } from "ajv";

type Json = Record<string, unknown>;

const schema = JSON.parse(readFileSync(new URL("data/adaptive-card-1.5.schema.json", import.meta.url), "utf8")) as Json;
const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "id"));
const id = schema["id"];
// (draft-06: Ajv validates it with the draft-07 vocabulary, which is a superset for every keyword this schema uses)
const validate = new Ajv({ strict: false, allErrors: false }).compile({
  ...rest,
  $id: typeof id === "string" ? id : "",
});

/** Throws with the schema's complaint when `card` is not a valid Adaptive Card 1.5. */
export function assertValidCard(card: Json): void {
  if (!validate(card)) throw new Error(`not an Adaptive Card 1.5: ${JSON.stringify(validate.errors)}`);
}

/** The card of a card message (its one attachment's content). */
export function cardOf(activity: Json): Json {
  const attachments = activity["attachments"] as Json[];
  return attachments[0]?.["content"] as Json;
}

/** Every element of a card body, depth first, without the header's coloured bar (decoration, not words). */
export function* elements(items: unknown): Generator<Json> {
  for (const item of (items ?? []) as Json[]) {
    if (item["text"] === "┃") continue;
    yield item;
    yield* elements(item["items"] ?? item["columns"]);
  }
}

/** Every text of a card body, in order. */
export function textsOf(card: Json): string[] {
  return [...elements(card["body"])].map((b) => (typeof b["text"] === "string" ? b["text"] : ""));
}

/** Every button of a card: in the body's action sets, then the card's own. */
export function buttonsOf(card: Json): Json[] {
  const inBody = [...elements(card["body"])]
    .filter((b) => b["type"] === "ActionSet")
    .flatMap((b) => b["actions"] as Json[]);
  return [...inBody, ...((card["actions"] ?? []) as Json[])];
}
