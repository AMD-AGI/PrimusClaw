// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One short line of text an agent or a connector supplied, safe to put in a card or a list (teams_agent/remote_view.py `neutral`):
 * control characters gone, credential shapes masked (before the cut, so a cut cannot leave half a credential), `[`/`]`/`<`/`>`
 * swapped for look-alikes so no link or tag can be built from it, then clipped.
 */

import { redactText } from "../security/redact.js";
import { clip } from "./plain.js";
import { squashSpaces } from "./py-text.js";

/** A C0 control character or DEL (Python's `[\u0000-\u001f\u007f]`). */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

export function neutral(text: string, limit = 200): string {
  const line = redactText(squashSpaces(Array.from(text, (ch) => (isControl(ch) ? " " : ch)).join("")))
    .text.replaceAll("[", "(")
    .replaceAll("]", ")")
    .replaceAll("<", "‹")
    .replaceAll(">", "›");
  return clip(line, limit);
}
