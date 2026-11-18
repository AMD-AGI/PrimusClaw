// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Checks a card against the Adaptive Cards 1.5 schema (test-support/data), with the ajv the teams package declares. */
import { readFileSync } from "node:fs";

import { Ajv } from "ajv";

type Json = Record<string, unknown>;

const schema = JSON.parse(
  readFileSync(new URL("../../../../test-support/data/adaptive-card-1.5.schema.json", import.meta.url), "utf8"),
) as Json;
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
