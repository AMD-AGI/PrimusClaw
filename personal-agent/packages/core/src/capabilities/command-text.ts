// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { cpLength } from "../text/py-text.js";

/**
 * The longest message, as it is read (stripped, its closing punctuation off; in characters, as Python's `len`), that is read
 * for a command said in plain words or a switch to an agent's session. A longer one is no sentence of help's and goes on as
 * the words it is: no pattern runs over it, so no message can make the reading slow (the Python worker's
 * MAX_COMMAND_TEXT_CHARS). A feedback sentence ("反馈：…") is read before this is checked, so a long one is still /feedback.
 */
export const MAX_COMMAND_TEXT_CHARS = 1000;

/** The same for a sentence about the sessions themselves (`sessionControl`; the Python worker's MAX_SESSION_CONTROL_CHARS). */
export const MAX_SESSION_CONTROL_CHARS = 160;

/** `flat` (a message as it is read) is no longer than `most` characters. */
export function within(flat: string, most: number): boolean {
  return cpLength(flat) <= most;
}
