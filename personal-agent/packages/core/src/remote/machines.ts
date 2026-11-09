// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which of the user's machines and agents a typed name means, and how an offline machine is told. People name a machine
 * (`dev-pod`), an agent by its id or by what it is (`codex`, `claude`), or both (`dev-pod/codex`); a name that more than one
 * online machine answers to must be qualified. A machine that is offline but was heard from moments ago is reconnecting by
 * itself (a PrimusClaw release ends every connection for a few seconds): it is tried, and never told to be restarted.
 */
import type { Lang } from "../locales/lang.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { length } from "../remote-view/py-text.js";
import { neutral, resumableOf } from "../remote-view/index.js";
import type { Agent, Connector, Session } from "./model.js";

/** What a user types to name an agent: `machine/id`, inert, with no backtick to end the code span it is shown in. */
export function agentRefOf(connector: Connector, agent: Agent): string {
  return `${neutral(connector.name, 80)}/${neutral(agent.agentId, 64)}`.replaceAll("`", "'");
}

/** A machine last seen this recently is reconnecting, not gone. */
export const RECONNECT_WINDOW_SECONDS = 120;

/** An agent on a machine: what a name resolves to. */
export interface AgentOnMachine {
  readonly kind: "agent";
  readonly connector: Connector;
  readonly agent: Agent;
}

/** A name that is a machine's, not an agent's, and the machine has more than one agent to choose from. */
export interface MachineChoice {
  readonly kind: "machine";
  readonly connector: Connector;
  readonly agents: readonly Agent[];
}

/** Why nothing was found, as the sentence to say. */
export interface Unresolved {
  readonly kind: "refusal";
  readonly text: string;
}

export type Resolved = AgentOnMachine | MachineChoice | Unresolved;

const onMachine = (connector: Connector, agent: Agent): AgentOnMachine => ({ kind: "agent", connector, agent });
const refusal = (text: string): Unresolved => ({ kind: "refusal", text });

/** How long ago Claw last heard from the machine (`last_seen_at`, else its heartbeat), in seconds; null when it does not say. */
function secondsSinceSeen(connector: Connector, now: number): number | null {
  const when = connector.lastSeenAt || connector.heartbeatAt;
  if (!when) return null;
  const at = Date.parse(when);
  return Number.isNaN(at) ? null : Math.max(0, now - at / 1000);
}

/**
 * The machine is offline but was heard from moments ago: its connector is most likely reconnecting by itself, and restarting it
 * is not what to do. `now`: wall-clock seconds.
 */
export function reconnecting(connector: Connector, now: number): boolean {
  const ago = secondsSinceSeen(connector, now);
  return ago !== null && ago <= RECONNECT_WINDOW_SECONDS;
}

/** Why nothing can be started on an offline machine, and what to do: wait a moment when it is reconnecting, else start it. */
export function offlineText(connector: Connector, now: number, lang: Lang = "en"): string {
  const name = neutral(connector.name, 80);
  const text = remoteAgentText.in(lang);
  return reconnecting(connector, now) ? text.reconnecting({ name }) : text.offlineNamed({ name });
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * What `ref` means when it is the name of one of the user's machines: its only agent, a choice between several, or the sentence
 * that says why not. Null when no machine has that name.
 */
function resolveMachine(connectors: readonly Connector[], ref: string, now: number, lang: Lang): Resolved | null {
  const named = connectors.filter((c) => sameName(c.name, ref));
  const first = named[0];
  if (first === undefined) return null;
  const up = named.filter((c) => c.online);
  const online = up.length > 0 ? up : named.filter((c) => reconnecting(c, now)).slice(0, 1); // (one coming back is tried)
  const text = remoteAgentText.in(lang);
  const only = online[0];
  if (only === undefined) return refusal(offlineText(first, now, lang));
  if (online.length > 1) return refusal(text.machinesNamedAlike({ ref: neutral(ref, 80) }));
  const agents = only.agents.filter((a) => a.agentId);
  const one = agents[0];
  if (one === undefined) return refusal(text.noAgentReported({ name: neutral(only.name, 80) }));
  return agents.length === 1 ? onMachine(only, one) : { kind: "machine", connector: only, agents };
}

/** `word` is what people call this agent: its own name, or the word its kind starts with (`claude` for `claude-code`). */
function namesAgent(agent: Agent, word: string): boolean {
  const w = word.trim().toLowerCase();
  if (!w) return false;
  return agent.name.toLowerCase() === w || (length(w) >= 4 && agent.kind.toLowerCase().startsWith(w));
}

/** The sentence `resolveAgent` gives when nothing the user has is called `ref`. */
export function noAgentCalled(ref: string, lang: Lang = "en"): string {
  return remoteAgentText.in(lang).noAgentCalled({ ref: neutral(ref, 80) });
}

function pairsWhere(
  connectors: readonly Connector[],
  machine: string,
  matches: (agent: Agent) => boolean,
): AgentOnMachine[] {
  return connectors.flatMap((c) =>
    machine && !sameName(c.name, machine) ? [] : c.agents.filter(matches).map((a) => onMachine(c, a)),
  );
}

/**
 * The agent a user named, or why none: `AGENT` is an agent id (or what people call it), `MACHINE/AGENT` names the machine as
 * well, and a name that more than one online machine has must be qualified. A bare name that is no agent's but a machine's is
 * read as the machine. `now`: wall-clock seconds.
 */
export function resolveAgent(connectors: readonly Connector[], ref: string, now: number, lang: Lang = "en"): Resolved {
  const slash = ref.lastIndexOf("/");
  const machine = slash < 0 ? "" : ref.slice(0, slash);
  const agentId = ref.slice(slash + 1);
  let found = pairsWhere(connectors, machine, (a) => sameName(a.agentId, agentId));
  if (found.length === 0) found = pairsWhere(connectors, machine, (a) => namesAgent(a, agentId));
  const first = found[0];
  if (first === undefined)
    return (machine ? null : resolveMachine(connectors, ref, now, lang)) ?? refusal(noAgentCalled(ref, lang));
  let online = found.filter((p) => p.connector.online);
  if (online.length === 0) {
    // none online, one reconnecting: it is tried, and asked again once it is back
    const coming = found.filter((p) => reconnecting(p.connector, now));
    online = coming.length === 1 ? coming : [];
  }
  const only = online[0];
  if (online.length === 1 && only !== undefined) return only;
  if (online.length > 1) {
    const names = online.map((p) => `\`${agentRefOf(p.connector, p.agent)}\``).join(", ");
    return refusal(remoteAgentText.in(lang).agentOnMachines({ names }));
  }
  return refusal(offlineText(first.connector, now, lang));
}

/**
 * The title and ref of the existing conversation a session of `agent` continues (or watches), as its connector lists it now: the
 * one entry it says this connector holds (`attached`; for a watch, the one a terminal has open, `live`) in the session's folder.
 * Both '' when that is not exactly one: a title is shown only when it is certain.
 */
export function conversationOf(agent: Agent, session: Session, readOnly: boolean): { title: string; ref: string } {
  if (agent.kind !== "attach") return { title: "", ref: "" };
  const want = readOnly ? "live" : "attached";
  const hits = resumableOf(agent).filter((e) => e.state === want && e.cwd === session.cwd);
  const hit = hits[0];
  return hits.length === 1 && hit !== undefined ? { title: hit.title, ref: hit.ref } : { title: "", ref: "" };
}
