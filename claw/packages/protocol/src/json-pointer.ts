// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * JSON Pointer (RFC 6901) lookups, the single reader of every `*_from_input`
 * field of an AppManifest.
 *
 * Claw reads values out of a run's input by pointer and does not know what any
 * field means, so admission (which checks the workspaces a pointer names) and
 * the app runner (which builds the sandbox environment from the same pointers)
 * must read the input the same way. They share this file for that reason.
 *
 * Rules that are easy to get wrong:
 *  - `~1` decodes to `/` and `~0` to `~`, in that order, so `~01` is `~1`.
 *  - An array index is `0` or a number without a leading zero. `-` (the
 *    element after the last) never names an existing value, and neither does a
 *    token such as `01`, `+1` or `1e0`.
 *  - Only own properties are read, so `/__proto__` and `/constructor` do not
 *    reach the prototype chain of an input that came off the wire.
 *  - A value of `null` counts as absent: "the first pointer that exists" must
 *    skip a field the caller left empty rather than stop on it.
 */

export type PointerResult =
  | { found: true; value: unknown }
  | { found: false };

const NOT_FOUND: PointerResult = { found: false };
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/** True when `pointer` is a syntactically valid RFC 6901 pointer. */
export function isJsonPointer(pointer: unknown): pointer is string {
  if (typeof pointer !== "string") return false;
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  // `~` must be followed by 0 or 1.
  return !/~(?![01])/.test(pointer);
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The value `pointer` names inside `doc`, or `{found:false}`. Never throws. */
export function resolveJsonPointer(doc: unknown, pointer: string): PointerResult {
  if (!isJsonPointer(pointer)) return NOT_FOUND;
  let cursor: unknown = doc;
  if (pointer !== "") {
    for (const raw of pointer.slice(1).split("/")) {
      const token = unescapeToken(raw);
      if (Array.isArray(cursor)) {
        if (!ARRAY_INDEX.test(token)) return NOT_FOUND;
        const index = Number(token);
        if (index >= cursor.length) return NOT_FOUND;
        cursor = cursor[index];
      } else if (typeof cursor === "object" && cursor !== null) {
        if (!Object.prototype.hasOwnProperty.call(cursor, token)) return NOT_FOUND;
        cursor = (cursor as Record<string, unknown>)[token];
      } else {
        return NOT_FOUND;
      }
    }
  }
  if (cursor === undefined || cursor === null) return NOT_FOUND;
  return { found: true, value: cursor };
}

/**
 * The value of a `JsonPointer | JsonPointer[]` field: for a list, the first
 * pointer that resolves to a present value.
 */
export function resolveFirstJsonPointer(
  doc: unknown,
  pointers: string | readonly string[] | undefined,
): PointerResult {
  if (pointers === undefined) return NOT_FOUND;
  const list = typeof pointers === "string" ? [pointers] : pointers;
  for (const pointer of list) {
    const hit = resolveJsonPointer(doc, pointer);
    if (hit.found) return hit;
  }
  return NOT_FOUND;
}
