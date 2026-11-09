// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The fixed numbers and colours of the Teams rich-text converter: heading sizes, status colours and the size limits. */

export const LEAD_PX = 16; // the first bold line (the verdict)
export const LABEL_PX = 15; // a bold section label; Teams' own text is 14px
/** >= 3.3:1 on white, #f5f5f5, #292929 and #1f1f1f, so readable in light and dark themes. */
export const STATUS_COLORS: Readonly<Record<string, string>> = {
  "✅": "#2b9249",
  "⚠": "#a67c00",
  "❌": "#d9484c",
  "⏳": "#2f80ed",
};
export const MAX_INPUT_CHARS = 20_000; // code points
export const MAX_OUTPUT_BYTES = 22_000; // UTF-8; Teams refuses a message of about 28 KB
export const MAX_NEST = 6; // emphasis inside emphasis; deeper is shown as plain text
export const MAX_LABEL_CHARS = 40; // a status colour covers a short label, never a paragraph
export const MAX_URL_CHARS = 2000;
export const LINK_SCAN = 500; // a link label or destination longer than this is not a link

/** What the converter throws when it cannot convert an answer safely; the caller then sends the markdown itself. */
export class RichTextError extends Error {
  override readonly name = "RichTextError";
}
