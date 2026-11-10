// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The Python cards tests' `valid`: a card's content validates against the Adaptive Card 1.5 schema. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Ajv } from "ajv";

import type { JsonObject } from "../src/cards/json.js";

const schema = JSON.parse(
  readFileSync(new URL("../../../test-support/data/adaptive-card-1.5.schema.json", import.meta.url), "utf8"),
) as JsonObject;
const rules = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "id"));
const validate = new Ajv({ strict: false, allErrors: true }).compile({
  ...rules,
  $id: typeof schema["id"] === "string" ? schema["id"] : "",
});

export function valid(card: JsonObject): void {
  assert.ok(validate(card), JSON.stringify(validate.errors));
}
