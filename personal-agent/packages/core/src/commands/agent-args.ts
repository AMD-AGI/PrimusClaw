// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `/agent ARGS`: the remote-agent subcommands, read here and carried out by the remote-agent feature. */
import { pyLower, pyStrip, splitOnce } from "../text/py-text.js";

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
