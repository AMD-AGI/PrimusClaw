// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `/agent ARGS`: the remote-agent subcommands, read here and carried out by the remote-agent feature. */
import { pyLower, pyStrip, splitOnce } from "../text/py-text.js";
import { isKnownCommand } from "./names.js";

export const AGENT_SUBCOMMANDS = ["new", "attach", "detach", "mode", "sessions", "close", "off", "pair"] as const;

export type AgentSubcommand = (typeof AGENT_SUBCOMMANDS)[number];

export interface AgentCommand {
  readonly verb: AgentSubcommand;
  /** What follows the verb; `new` keeps it whole (a folder name may hold spaces). */
  readonly rest: string;
}

function isSubcommand(word: string): word is AgentSubcommand {
  return (AGENT_SUBCOMMANDS as readonly string[]).includes(word);
}

/** The arguments of `/agent ARGS`; null when ARGS is empty or names no subcommand (the caller shows the usage). */
export function parseAgentCommand(arg: string): AgentCommand | null {
  const [head, rest] = splitOnce(pyStrip(arg));
  const verb = head === undefined ? undefined : pyLower(head);
  if (verb === undefined || !isSubcommand(verb)) return null;
  return { verb, rest: rest === undefined ? "" : pyStrip(rest) };
}

/** The words a near miss of `/agents` is measured against. */
const AGENTS_WORDS = ["agents", "agent"] as const;

/** Whether `a` becomes `b` by one letter added, dropped, changed, or two neighbours swapped (`agnets`, `agens`, `agentss`). */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return a === b;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // (one letter changed)
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // (two neighbours swapped)
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i); // (one letter added or dropped)
}

/**
 * Whether `text` is a slip of `/agents` with nothing after it: a full-width slash, a capital, a full stop or a question mark
 * after it, or one letter off (`/agnets`, `/agens`, `/agentss`). Such a message shows the list, as `/agents` does; it never
 * starts or attaches anything, and it never goes on to the assistant as words. A known command (`/agent`, `/agents`) is not a slip.
 */
export function isAgentsSlip(text: string): boolean {
  const said = pyStrip(text);
  if (/\s/u.test(said)) return false;
  const found = /^[/／](\p{L}{4,8})[.?!。？！]*$/u.exec(said);
  const word = found?.[1] === undefined ? "" : pyLower(found[1]);
  if (!word) return false;
  if (said === `/${word}` && isKnownCommand(word)) return false;
  return AGENTS_WORDS.some((w) => oneEditApart(word, w));
}
