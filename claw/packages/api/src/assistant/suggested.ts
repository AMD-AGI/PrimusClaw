// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The replies a `say` suggests (`CLAW_ASSISTANT_SUGGESTED_REPLIES`): what the user is likely to send next, which a channel shows as
 * buttons that send it as their message (Teams' suggested replies). The model writes them; they are checked here and never refuse
 * the say: one that does not fit is left out, and the message goes without it.
 *
 *  - at most `SUGGESTED_MAX` of them, each one line of at most `SUGGESTED_MAX_CHARS` code points, none twice;
 *  - nothing internal (`internalTextIn`: a tool name, an id, a marker), no address, no markup, no slash command: a button sends its
 *    words as the user's own message, so it must be words the user could have typed, and never a command they did not choose.
 */
import { CLAW_ASSISTANT_SUGGESTED_REPLIES } from "../config.js";
import { internalTextIn } from "./internal-text.js";

/** The most replies one message suggests (Teams shows three). */
export const SUGGESTED_MAX = 3;
/** The longest suggested reply, in code points: a few words that fit a button. */
export const SUGGESTED_MAX_CHARS = 30;

/** What `say`'s `suggested` says to the model. */
export const SAY_SUGGESTED_PARAM = `Optional, on a say that answers: up to ${SUGGESTED_MAX} short replies the user is likely to send next, `
  + `each a few words (at most ${SUGGESTED_MAX_CHARS} characters) in the reply language, written as the user would write them `
  + "(列出失败的那几个, 详细说说 #12, Show the logs). They are shown as buttons that send them. Leave it out on a quick line that you are "
  + "looking, on a question whose answer only the user knows, and when nothing obvious follows. Write it after text.";

export function suggestedRepliesOn(): boolean {
  return CLAW_ASSISTANT_SUGGESTED_REPLIES;
}

// What a reply a button sends can never hold: an address, markup or a line break; and what it may not start with: a command.
const NOT_IN_REPLY = /https?:\/\/|www\.|[<>`*_\[\]{}|\\]|[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/i;

/** The replies of `raw` (the model's `suggested`) that can be suggested, in its order; [] when none can. */
export function suggestedReplies(raw: unknown, userWords: string = ""): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= SUGGESTED_MAX) break;
    if (typeof entry !== "string" || NOT_IN_REPLY.test(entry)) continue;
    const reply = entry.replace(/\s+/g, " ").trim();
    if (!reply || reply.startsWith("/") || Array.from(reply).length > SUGGESTED_MAX_CHARS || out.includes(reply)) continue;
    if (internalTextIn(reply, userWords)) continue;
    out.push(reply);
  }
  return out;
}
