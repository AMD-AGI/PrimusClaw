// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the Router may name an item (`src/assistant/item-ref.ts`): by its id, or by the number the user sees.
 *
 *   I1  an id, `#3`, `3` and `item 3` are references, and say which
 *   I2  two references in one are refused as ambiguous, and say so
 *   I3  anything else is refused as not a reference, including words that merely contain a number
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ITEM_REF_HINT, parseItemRef } from "../src/assistant/item-ref.js";

const ID = "kwi_01K9X4Q7M2W8N5R3T6V1A2B3C4";

test("I1 an item id, #3, 3 and item 3 are references", () => {
  assert.deepEqual(parseItemRef(ID), { ok: true, ref: { by: "id", itemId: ID } });
  assert.deepEqual(parseItemRef(`  ${ID}\n`), { ok: true, ref: { by: "id", itemId: ID } });
  for (const text of ["#3", "3", " #3 ", "item 3", "Item #3", "item3", "# 3"]) {
    assert.deepEqual(parseItemRef(text), { ok: true, ref: { by: "seq", seq: 3 } }, text);
  }
  assert.deepEqual(parseItemRef("#007"), { ok: true, ref: { by: "seq", seq: 7 } });
  assert.deepEqual(parseItemRef("999999999"), { ok: true, ref: { by: "seq", seq: 999999999 } });
});

test("I2 two references in one are ambiguous, and the refusal says a call takes one", () => {
  for (const text of ["#1, #2", "1 and 2", "#1 #2", `${ID} ${ID}`, "3;4", "#3 & #4", `${ID} and #2`, "#1 + #2"]) {
    const r = parseItemRef(text);
    assert.ok(!r.ok && r.error === "ambiguous_item_ref", `${text}: ${JSON.stringify(r)}`);
    assert.match((r as { message: string }).message, /call once per item/, text);
  }
});

test("I3 what is not a reference is refused as such, and the refusal says what to pass", () => {
  const notReferences: unknown[] = [
    "", "   ", undefined, null, 3, {}, ["#3"],
    "the CI one", "PR #231", "Q3 report", "Fix flaky test", "#", "#x", "3.5", "-3", "#3a", "kwi_", "kwi_a-b", "1234567890",
    "item", "three", "#3 is the one",
  ];
  for (const raw of notReferences) {
    const r = parseItemRef(raw);
    assert.ok(!r.ok && r.error === "invalid_item_ref", `${JSON.stringify(raw)}: ${JSON.stringify(r)}`);
    assert.ok((r as { message: string }).message.includes(ITEM_REF_HINT), JSON.stringify(raw));
  }
});
