// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { cpLength, isPySpace, pySplit } from "../text/py-text.js";

/** `/observe on | off | status`, said to the bot in a group; with 开/关/状态 as well. */
export type ObserveVerb = "on" | "off" | "status" | "usage";

// A Map, not an object literal: a word from the chat must not find `constructor` or `__proto__` on Object.prototype.
const VERBS: ReadonlyMap<string, ObserveVerb> = new Map([
  ["on", "on"],
  ["开", "on"],
  ["打开", "on"],
  ["开启", "on"],
  ["off", "off"],
  ["关", "off"],
  ["关闭", "off"],
  ["status", "status"],
  ["状态", "status"],
  ["", "status"],
]);

/** The command's verb, `usage` for a malformed one, undefined when the text is not this command. */
export function parseObserve(text: string): ObserveVerb | undefined {
  const words = pySplit(text);
  const head = words[0]?.toLowerCase();
  if (head !== "/observe" && head !== "observe") return undefined;
  if (head === "observe" && words.length === 1) return undefined; // the bare word is a word, not the command
  if (words.length > 2) return "usage";
  return VERBS.get(words[1]?.toLowerCase() ?? "") ?? "usage";
}

const SCOPE_PREFIX = "group:teams:";
/** Claw's `group:<channel>:<id>` takes an id of at most 160 characters, with no white space. */
const SCOPE_ID_MAX = 160;

/** The scope a group chat is to Claw, or undefined when its id cannot be one. */
export function scopeOf(conversationId: string): string | undefined {
  if (!conversationId || cpLength(conversationId) > SCOPE_ID_MAX || Array.from(conversationId).some(isPySpace)) {
    return undefined;
  }
  return SCOPE_PREFIX + conversationId;
}
