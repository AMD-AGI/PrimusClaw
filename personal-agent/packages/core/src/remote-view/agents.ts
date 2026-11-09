// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an agent's connector says it is and can do (`capabilities`, the connector's own keys: docs/remote-agents.md). Absent is
 * unknown, never a default: a flag that is not a boolean `true` is not claimed.
 */
import { neutral } from "./inert.js";
import { ROOT_MAX, ROOTS_MAX } from "./limits.js";
import { hasControl, strip } from "./py-text.js";
import type { Agent, Connector } from "../remote/model.js";
import { list } from "./reported.js";

/** `kind` is an opaque label the connector reports; a client picks an icon from it. Unknown kinds get a neutral one. */
const KINDS: readonly (readonly [prefix: string, label: string, icon: string])[] = [
  ["claude", "Claude Code", "\u{1f7e0}"],
  ["codex", "Codex", "⬛"],
  ["cursor", "Cursor", "\u{1f537}"],
];

export interface KindLabel {
  readonly icon: string;
  readonly label: string;
}

/** The icon and label of a connector's agent `kind`. */
export function kindLabel(kind: unknown): KindLabel {
  const word = strip(typeof kind === "string" ? kind : "").toLowerCase();
  for (const [prefix, label, icon] of KINDS) {
    if (word.startsWith(prefix)) return { icon, label };
  }
  return { icon: "\u{1f916}", label: "Agent" };
}

/** What a user types to name an agent: `machine/id`, shown inside a code span, each part inert and no backtick in it. */
export function agentRef(connector: Pick<Connector, "name">, agent: Pick<Agent, "agentId">): string {
  return `${neutral(connector.name, 80)}/${neutral(agent.agentId, 64)}`.replaceAll("`", "'");
}

/** The folders an agent says it may work in (`capabilities.roots`): strings only, one line each, each once, at most ROOTS_MAX. */
export function agentRoots(agent: Agent): string[] {
  const roots: string[] = [];
  for (const root of list(agent.capabilities["roots"])) {
    if (
      typeof root === "string" &&
      strip(root) !== "" &&
      Array.from(root).length <= ROOT_MAX &&
      !hasControl(root) &&
      !roots.includes(root)
    ) {
      roots.push(root);
    }
  }
  return roots.slice(0, ROOTS_MAX);
}

function says(agent: Agent | null | undefined, key: string): boolean {
  return agent?.capabilities[key] === true;
}

/** The connector can take back a message that waits for its terminal without stopping anything (`withdraw`). */
export function withdraws(agent: Agent | null | undefined): boolean {
  return says(agent, "withdraw");
}

/** The connector can open a conversation that is open in a terminal read-only (`watch_live`). */
export function watchesLive(agent: Agent): boolean {
  return says(agent, "watch_live");
}

/** The connector types messages into the terminal that has this conversation open (a tmux pane of its user's). */
export function typesInto(agent: Agent, entry: { readonly input?: string }): boolean {
  return watchesLive(agent) && says(agent, "terminal_input") && entry.input === "terminal";
}

/** The connector can type into a terminal at all (`terminal_input`), whether or not this conversation's is one it can reach. */
export function canTypeIntoTerminals(agent: Agent): boolean {
  return says(agent, "terminal_input");
}

/** A new session of this agent starts in a mode that does not ask before a write or a command (`capabilities.unattended`). */
export function startsUnattended(agent: Agent): boolean {
  return says(agent, "unattended");
}

/** A client may switch this agent to a mode that does not ask (`capabilities.unattended_allowed`). */
export function unattendedAllowed(agent: Agent): boolean {
  return says(agent, "unattended_allowed");
}

export type Approval = "ask" | "unattended";

/** What a new session of `agent` may be asked to run as, when its connector lets a client switch to a mode that does not ask;
 * the default is how its owner configured it to start. null when there is nothing to choose. */
export function approvalChoice(agent: Agent): { readonly default: Approval } | null {
  if (!unattendedAllowed(agent)) return null;
  return { default: startsUnattended(agent) ? "unattended" : "ask" };
}

/** The connector can take over a conversation a terminal has open, once the person confirms (`capabilities.takeover`). */
export function canTakeOver(agent: Agent): boolean {
  return says(agent, "takeover");
}

/** The name of the agent: its own (made inert), or its kind's label. */
export function agentName(agent: Agent, limit: number): string {
  return neutral(agent.name, limit) || kindLabel(agent.kind).label;
}
