// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the Router may name one of the user's work items: by its `item_id`, or by the number the user sees
 * (`#3`, or just `3`). Pure, so the evaluation can ask it the same question the tools do.
 *
 * Only these forms are read. A name that merely contains a number ("the CI one, #3", "PR #231") is not a
 * reference: reading it would sooner or later pick the wrong item, and a refusal that says what to pass costs the
 * Router one more call.
 *
 * What a reference means, and whose items it can reach, is `resolveWorkItem` in `work-items.ts`.
 */

export type ItemRef = { by: "id"; itemId: string } | { by: "seq"; seq: number };

/** What a reference can be refused for. `item_not_found` is the lookup's, the other two are the parse's. */
export type ItemRefError = "invalid_item_ref" | "ambiguous_item_ref";

const ITEM_ID = /^kwi_[A-Za-z0-9]+$/;
/** `#3`, `3`, `item 3`, `item #3`. At most nine digits: `seq` is a 32-bit column. */
const ITEM_SEQ = /^(?:item\s*)?#?\s*(\d{1,9})$/i;

/** What every refusal tells the Router to do. */
export const ITEM_REF_HINT = "name an item by its item_id from the list, or by its number such as #3";

function parseOne(token: string): ItemRef | null {
  if (ITEM_ID.test(token)) return { by: "id", itemId: token };
  const seq = ITEM_SEQ.exec(token);
  return seq ? { by: "seq", seq: Number(seq[1]) } : null;
}

export function parseItemRef(raw: unknown):
  | { ok: true; ref: ItemRef }
  | { ok: false; error: ItemRefError; message: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  const one = text ? parseOne(text) : null;
  if (one) return { ok: true, ref: one };
  // Two or more references in one: a call names one item, so say that instead of guessing which was meant.
  const parts = text.split(/\s*(?:,|;|&|\+|\band\b)\s*|\s+/i).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => parseOne(p))) {
    return { ok: false, error: "ambiguous_item_ref", message: `that names ${parts.length} items; a call takes one, so call once per item` };
  }
  return { ok: false, error: "invalid_item_ref", message: `not an item reference: ${ITEM_REF_HINT}` };
}
