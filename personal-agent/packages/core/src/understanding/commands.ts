// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { pySplit } from "../text/py-text.js";

/** Commands the worker reads in a 1:1 chat that are not in the command module's lists. */
export const WORDS_OF_A_CHAT = ["github", "board"] as const;

/** What `exactCommand` needs of the chat's commands (the command module's `menuCommand` and `isKnownCommand`). */
export interface CommandBook {
  /** `text` as the command it is when it is exactly a word of the commands menu, else `text` itself. */
  menuCommand(text: string): string;
  /** A command the worker handles itself. */
  isKnownCommand(name: string): boolean;
}

/**
 * `text` is a command the worker handles itself, typed as one (`/brief on 10:00`), or a word of the commands menu:
 * what goes the fast way, with no model. A slash and words that are no command (`/brief10:0`) are a message.
 */
export function exactCommand(text: string, commands: CommandBook): boolean {
  const [first] = pySplit(commands.menuCommand(text));
  if (first === undefined || !first.startsWith("/")) return false;
  const name = first.slice(1).toLowerCase();
  return commands.isKnownCommand(name) || (WORDS_OF_A_CHAT as readonly string[]).includes(name);
}
