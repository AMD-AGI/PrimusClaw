// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One short line of text an agent or a connector supplied, safe to put in a card or a list (teams_agent/remote_view.py `neutral`):
 * control characters gone, credential shapes masked (before the cut, so a cut cannot leave half a credential), `[`/`]`/`<`/`>`
 * swapped for look-alikes so no link or tag can be built from it, then clipped.
 */

import { redactText } from "../security/redact.js";
import { cpHead, cpLen, flat } from "./plain.js";

// eslint-disable-next-line no-control-regex -- the control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function neutral(text: string, limit = 200): string {
  const line = redactText(flat(text.replace(CONTROL, " ")))
    .text.replaceAll("[", "(")
    .replaceAll("]", ")")
    .replaceAll("<", "‹")
    .replaceAll(">", "›");
  return cpLen(line) <= limit ? line : `${cpHead(line, limit - 1).trimEnd()}…`;
}
