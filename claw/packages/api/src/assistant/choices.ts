// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The choice a `say` puts to the user (`CLAW_ASSISTANT_CHOICES`): the options they pick from, one or (`multiple`) several, which a
 * channel shows as a card (radio buttons, or check boxes) whose Send sends the picked options as the user's own next message, exactly
 * as if they had typed them. The model writes it; it is checked here and never refuses the say: a choice that does not fit is left
 * out whole (never a part of it, which would hide an option the text offers), and the message goes without it, its text still naming
 * the options for the user to type.
 *
 *  - from `CHOICES_MIN` to `CHOICES_MAX` options, each one line of at most `CHOICE_MAX_CHARS` code points; one written twice is one;
 *  - nothing internal (`internalTextIn`), no address, no control character, no slash command: what is picked is sent as the user's
 *    own words, so it must be words the user could have typed, and never a command they did not choose.
 */
import { CLAW_ASSISTANT_CHOICES } from "../config.js";
import { internalTextIn } from "./internal-text.js";

/** The fewest options a choice has: one option is no choice. */
export const CHOICES_MIN = 2;
/** The most options one choice has (what a card shows as one list). */
export const CHOICES_MAX = 10;
/** The longest option, in code points: one line beside a radio button. */
export const CHOICE_MAX_CHARS = 80;

/** A checked choice: the options in the model's order, and whether several may be picked. */
export interface SayChoice {
  options: string[];
  multiple: boolean;
}

/** What `say`'s `choices` says to the model. */
export const SAY_CHOICES_PARAM = `Optional, on a say that asks the user to pick: whenever the text asks them to choose among options `
  + `(which one, which of these, A or B), the options here too, each the words the user would send to pick it (${CHOICES_MIN} to `
  + `${CHOICES_MAX}, each at most ${CHOICE_MAX_CHARS} characters, in the reply language), and multiple: true when they may pick several. `
  + "The user sees them as a card to tick and send; what they pick comes back as their next message, as if typed. Name the options in "
  + "the text as well. Not for follow-up prompts (that is suggested), nor for a yes/no a sentence answers. Write it after text.";

export function sayChoicesOn(): boolean {
  return CLAW_ASSISTANT_CHOICES;
}

// What an option can never hold: an address, or a line break or any other control character.
const NOT_IN_OPTION = /https?:\/\/|www\.|[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/i;

/** The choice of `raw` (the model's `choices`), checked; undefined when there is none or it does not fit. */
export function sayChoice(raw: unknown, userWords: string = ""): SayChoice | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { options, multiple } = raw as { options?: unknown; multiple?: unknown };
  if (!Array.isArray(options) || (multiple !== undefined && typeof multiple !== "boolean")) return undefined;
  const out: string[] = [];
  for (const entry of options) {
    if (typeof entry !== "string" || NOT_IN_OPTION.test(entry)) return undefined;
    const option = entry.replace(/\s+/g, " ").trim();
    if (!option || option.startsWith("/") || Array.from(option).length > CHOICE_MAX_CHARS) return undefined;
    if (internalTextIn(option, userWords)) return undefined;
    if (!out.includes(option)) out.push(option);
  }
  if (out.length < CHOICES_MIN || out.length > CHOICES_MAX) return undefined;
  return { options: out, multiple: multiple === true };
}
