// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a chat message as one of the commands (`/help`, `/timezone Asia/Shanghai`, a word of Teams' commands menu). Pure: no
 * state, no I/O. What each command does is in `routing/`.
 */
import { decimalInt, isUpper, pyLower, pySplit, pyStrip, splitOnce, squashSpaces } from "../text/py-text.js";
import { CODE_ALPHABET, CODE_LENGTH } from "../ports/store/policy.js";
import { pyFullmatch } from "../text/py-regex.js";
import { isCommand, type Command } from "./names.js";

/** The command name if `text` is exactly a known command, else null. */
export function parseCommand(text: string): Command | null {
  const word = pyLower(pyStrip(text));
  if (!word.startsWith("/")) return null;
  const name = word.slice(1);
  return isCommand(name) ? name : null;
}

/** The argument text of `/name ARGS` ("" when there is none), or null when `text` is not that command. */
export function commandArgs(text: string, name: string): string | null {
  const [head, rest] = splitOnce(pyStrip(text));
  if (head === undefined || pyLower(head) !== `/${name}`) return null;
  return rest === undefined ? "" : pyStrip(rest);
}

/**
 * What Teams' commands menu inserts. Choosing an entry puts the entry's TITLE in the compose box with no slash (`help`,
 * `agent detach`), and a person who types a menu word without a slash means the same: a message that is exactly one of these words
 * is the command, in every state of the chat. `sessions` and `detach` are the remote agent's (`/agent sessions`, `/agent detach`),
 * not Claw's own `/sessions`, which a person still types with its slash. Nothing but an exact match counts: `help me` is a sentence.
 */
export const MENU_COMMANDS: Readonly<Record<string, string>> = {
  help: "/help",
  new: "/new",
  link: "/link",
  stop: "/stop",
  agents: "/agents",
  "agent sessions": "/agent sessions",
  "agent detach": "/agent detach",
  whoami: "/whoami",
  feedback: "/feedback",
  unlink: "/unlink",
  sessions: "/agent sessions",
  detach: "/agent detach",
};

/** The entries of the group chat's own menu. */
export const GROUP_MENU_COMMANDS = ["help", "new", "stop", "whoami", "feedback"] as const;

const LINK_WITH_CODE = pyFullmatch(String.raw`link\s+([${CODE_ALPHABET}]{${String(CODE_LENGTH)}})`, "i");

/**
 * Is `word`, which has the length and the letters of a link code, a code and not a word? Every letter of `database` is in the
 * alphabet, so the shape alone takes `link database` for a link attempt. The console shows a code in capitals and the generator
 * does not promise a digit, so it is a code when it is in capitals or has a digit. `/link CODE` takes any case.
 */
function looksLikeACode(word: string): boolean {
  return isUpper(word) || /\p{Nd}/u.test(word);
}

/**
 * `text` as the command it is when it is exactly a word of the commands menu (case and spacing do not matter), `link CODE` with a
 * code of the console's shape as `/link CODE`, and `text` itself otherwise. `group`: a group chat reads only its own menu's words.
 */
export function menuCommand(text: string, group = false): string {
  const said = squashSpaces(text);
  const lower = pyLower(said);
  const command = Object.hasOwn(MENU_COMMANDS, lower) ? MENU_COMMANDS[lower] : undefined;
  if (command !== undefined && (!group || (GROUP_MENU_COMMANDS as readonly string[]).includes(lower))) return command;
  const found = group ? null : LINK_WITH_CODE.exec(said);
  const code = found?.[1];
  if (code !== undefined && looksLikeACode(code)) return `/link ${code}`;
  return text;
}

/** The code of a `/link CODE` message, else null. */
export function parseLinkCode(text: string): string | null {
  const [head = "", code, ...more] = pySplit(pyStrip(text));
  return pyLower(head) === "/link" && code !== undefined && more.length === 0 ? code : null;
}

/** Whether `text` is a /timezone message, and its argument: null for none, "" for more than one word. */
export function parseTimezone(text: string): { isTimezone: boolean; arg: string | null } {
  const [head = "", arg, ...more] = pySplit(pyStrip(text));
  if (pyLower(head) !== "/timezone") return { isTimezone: false, arg: null };
  if (arg === undefined) return { isTimezone: true, arg: null };
  return { isTimezone: true, arg: more.length === 0 ? arg : "" };
}

/** The groups of a whole match, "" for one that took part in none (a Python `m[i]` that the pattern always fills). */
function groupsOf(pattern: RegExp, text: string): string[] | null {
  const found = pattern.exec(pyStrip(text));
  return found === null ? null : found.slice(1).map((group) => group || "");
}

const QUIET = pyFullmatch(String.raw`(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})`);
const DURATION = pyFullmatch(String.raw`(\d{1,4})\s*([mhd])`, "i");
const CLOCK = pyFullmatch(String.raw`(\d{1,2}):(\d{2})`);
export const MAX_PAUSE_SECONDS = 30 * 24 * 3600;
const UNIT_SECONDS: Readonly<Record<string, number>> = { m: 60, h: 3600, d: 86400 };

/** '8:30' to '08:30'; null unless it is a real 24-hour time. */
export function parseClock(text: string): string | null {
  const [hours = "", minutes = ""] = groupsOf(CLOCK, text) ?? [];
  const hour = decimalInt(hours);
  if (!hours || hour > 23 || decimalInt(minutes) > 59) return null;
  // (the minutes as written, as the Python worker gives them: "８:３０" is "08:３０")
  return `${String(hour).padStart(2, "0")}:${minutes}`;
}

/** '22:00-08:00' to ['22:00', '08:00']; null when malformed or empty (start equals end). */
export function parseQuietWindow(text: string): readonly [string, string] | null {
  const found = groupsOf(QUIET, text);
  if (found === null) return null;
  const [h1, m1, h2, m2] = found;
  const start = parseClock(`${String(h1)}:${String(m1)}`);
  const end = parseClock(`${String(h2)}:${String(m2)}`);
  return start !== null && end !== null && start !== end ? [start, end] : null;
}

/** '2h', '30m', '1d' to seconds, at most 30 days; null when malformed. */
export function parseDurationSeconds(text: string): number | null {
  const [count = "", unit = ""] = groupsOf(DURATION, text) ?? [];
  const seconds = decimalInt(count) * (UNIT_SECONDS[pyLower(unit)] ?? 0);
  return seconds > 0 && seconds <= MAX_PAUSE_SECONDS ? seconds : null;
}
