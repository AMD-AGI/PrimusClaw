// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model gateway's refusal of the user's own key, as a failed turn's text begins: an SDK's or the gateway's error class in front at
 * most, then the status and the sentence. Pure, so the re-run on the fallback model (`model-fallback.ts`) and the notice for a router
 * turn that could not be run again (`router-turn-end.ts`) read a turn's text the same way.
 *
 * Two kinds:
 *  - `missing`: the key has no subscription key behind it: the proxy's 403 for a user with no binding at all, and the upstream's 401 for
 *    a request that carried no subscription key;
 *  - `invalid`: a subscription key was bound and sent, and the upstream refused it (401 "invalid subscription key": revoked, expired or
 *    mistyped). Re-binding a valid key is the only cure, and the user is told so.
 *
 * Bounded and without nested quantifiers, so a hostile text costs linear time. Anchored at the text's start: an answer that quotes the
 * refusal is an answer.
 */
const PREFIX = String.raw`^\s*(?:(?:API |[A-Za-z_.]{1,40})Error:\s*){0,3}`;
const MISSING_KEY = new RegExp(
  PREFIX + String.raw`(?:403\b[^\n]{0,40}No APIM Key binding found|401\b[^\n]{0,160}?missing subscription key)`,
  "i",
);
const INVALID_KEY = new RegExp(PREFIX + String.raw`401\b[^\n]{0,160}?invalid subscription key`, "i");

export type KeyRefusal = "missing" | "invalid";

/** Which refusal of the user's key a failed turn's text is, or null for any other text. */
export function keyRefusalOf(text: unknown): KeyRefusal | null {
  if (typeof text !== "string") return null;
  if (MISSING_KEY.test(text)) return "missing";
  if (INVALID_KEY.test(text)) return "invalid";
  return null;
}
