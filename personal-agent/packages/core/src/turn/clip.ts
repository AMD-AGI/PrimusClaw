// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Clipping and escaping shared by the answer views. */

import { clipWithEllipsis, collapseSpaces } from "../text/python-str.js";
import { textOf } from "./json.js";

export const TITLE_MAX = 120;
export const SUMMARY_MAX = 280;

/** One line: whitespace collapsed, cut to `limit` characters with an ellipsis. */
export function clip(text: unknown, limit: number): string {
  return clipWithEllipsis(collapseSpaces(textOf(text)), limit);
}

const MARKDOWN = /([\\`*_[\]<])/g;

/** `text` for a card text block, which reads markdown: its markup characters escaped, so `__init__.py` is not bold. */
export function plain(text: string): string {
  return text.replace(MARKDOWN, "\\$1");
}
