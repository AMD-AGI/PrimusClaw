// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Reads a card message's parts (the schema check is in packages/teams/test/remote/card-schema.ts, where ajv 8 resolves). */
type Json = Record<string, unknown>;

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
