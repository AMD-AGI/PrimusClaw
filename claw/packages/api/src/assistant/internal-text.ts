// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the user must never be shown: the assistant's own wiring. A tool's name, the marker of a worker's report, an item's or a run's
 * id (the user knows an item by its number and title), and an id of the UUID form (a session, a confirmation) unless the user wrote it
 * themselves in the message the turn answers, as they do when they ask about a run by its id.
 *
 * Asked of everything the router's words reach the user by: its `say` (refused, so it rewrites them) and the plain text a turn ended
 * with (`router-turn-end.ts`, which then sends a notice of its own instead).
 */
import { WORK_EVENT_PREFIX } from "./prompts.js";

const INTERNAL_TEXT: ReadonlyArray<{ what: string; re: RegExp }> = [
  { what: "a tool name (mcp__…)", re: /mcp__/i },
  { what: "the [work_event] marker", re: /\[work_event\]/i },
  { what: "an item_id", re: /\bkwi_[0-9a-z]{4,}|\bitem_id\b/i },
  { what: "a run id", re: /\bktsk_[0-9a-z_]{4,}/i },
];
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The first piece of internal text in a message, or null. `userWords` is what the user wrote in this turn's message. Pure, for the tests. */
export function internalTextIn(text: string, userWords: string): string | null {
  for (const { what, re } of INTERNAL_TEXT) if (re.test(text)) return what;
  const own = new Set((userWords.match(UUID_RE) ?? []).map((u) => u.toLowerCase()));
  for (const id of text.match(UUID_RE) ?? []) if (!own.has(id.toLowerCase())) return "an internal id";
  return null;
}

/** What the user wrote, of the messages a turn answers: a worker's report (`[work_event]`) is not the user's words. */
export function userWordsOf(prompts: readonly string[]): string {
  return prompts.filter((p) => !p.startsWith(WORK_EVENT_PREFIX)).join("\n");
}
