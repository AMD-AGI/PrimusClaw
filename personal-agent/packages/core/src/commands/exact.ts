// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { pySplit, pyLower } from "../text/py-text.js";
import { isKnownCommand, WORDS_OF_A_CHAT } from "./names.js";
import { menuCommand } from "./parse.js";

/**
 * `text` is a command the worker handles itself, typed as one (`/brief on 10:00`), or a word of the commands menu: what
 * goes the fast way, with no model (the Python `understanding.exact_command`). A slash and words that are no command
 * (`/brief10:0`) are a message like any other.
 */
export function exactCommand(text: string): boolean {
  const [first] = pySplit(menuCommand(text));
  if (first === undefined || !first.startsWith("/")) return false;
  const name = pyLower(first.slice(1));
  return isKnownCommand(name) || (WORDS_OF_A_CHAT as readonly string[]).includes(name);
}
