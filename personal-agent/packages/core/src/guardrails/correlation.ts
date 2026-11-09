// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { sha256Hex } from "./sha256.js";

/** One part of an operation's correlation id: an id, a number, a flag or nothing. */
export type CorrelationPart = string | number | boolean | null | undefined;

/** A part as Python's `str()` writes it, so that ids derived by the Python worker and by this one are the same. */
function pyStr(part: CorrelationPart): string {
  if (part === null || part === undefined) return "None";
  if (typeof part === "boolean") return part ? "True" : "False";
  return String(part);
}

/**
 * The id that ties the records of one operation together, derived from what every step of it knows (a Claw session
 * and an approval id; a session, a repository and a pull request), so that nothing has to be stored to carry it:
 * 32 hex characters.
 */
export function correlationId(...parts: CorrelationPart[]): string {
  return sha256Hex(parts.map(pyStr).join("\u001f")).slice(0, 32);
}
