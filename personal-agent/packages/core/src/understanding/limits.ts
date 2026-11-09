// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { cpHead } from "../text/py-text.js";
import { textOf } from "../review-text/names.js";

/** Each list of the channel context holds at most this many entries. */
export const CONTEXT_ITEMS_MAX = 50;
/** ... and each string at most this many characters. */
export const CONTEXT_TEXT_MAX = 200;

/** `str(value or "")[:CONTEXT_TEXT_MAX]`. */
export function clip(value: unknown): string {
  return cpHead(textOf(value), CONTEXT_TEXT_MAX);
}
