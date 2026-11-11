// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The chat's command words. Anything else, unknown `/words` included, goes on as the person's text.
 *
 * What help says is rendered from the capability registry (`capabilities/registry.ts`), not from this list.
 */

export const COMMANDS = ["help", "new", "stop", "unlink", "whoami", "resume", "memory", "sessions"] as const;

/** The only commands a group chat accepts. */
export const GROUP_COMMANDS = ["help", "new", "stop", "whoami", "feedback"] as const;

export const PERSONAL_ONLY_COMMANDS = [
  "link",
  "unlink",
  "resume",
  "timezone",
  "quiet",
  "pause",
  "brief",
  "repo",
  "sessions",
  "agents",
  "agent",
  "lang",
  "approvals",
] as const;

/**
 * `/feedback [TEXT]` takes an argument, so it is read with `commandArgs`, never `parseCommand`; it is listed here (not in
 * COMMANDS) only so that a group chat accepts it and an unknown `/word` is still plain text.
 */
export const ARGUMENT_COMMANDS = ["feedback"] as const;

export type Command = (typeof COMMANDS)[number];

function within(list: readonly string[], name: string): boolean {
  return list.includes(name);
}

/** A command the worker handles itself (anything else is text for Claw). */
export function isKnownCommand(name: string): boolean {
  return within(COMMANDS, name) || within(PERSONAL_ONLY_COMMANDS, name) || within(ARGUMENT_COMMANDS, name);
}

export function isGroupCommand(name: string): boolean {
  return within(GROUP_COMMANDS, name);
}

export function isCommand(name: string): name is Command {
  return within(COMMANDS, name);
}
