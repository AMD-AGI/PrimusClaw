// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The agents card (`/agents`): per machine its agents, per online agent a "New session" form (a folder from the roots it reported,
 * a subfolder to type, one button) and the conversations it offers, then the user's sessions with Attach / Detach / Close. Every
 * button carries {"primusclaw": "remote", "op": ...}; the worker checks every click against Claw's own lists, never against the card.
 */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import { type RemoteButton, remoteButton } from "./actions.js";
import { agentRoots, kindLabel, startsUnattended } from "./agents.js";
import { type ApprovalInput, approvalInput } from "./machine-views.js";
import { type ConversationItem, conversationItems } from "./conversations-view.js";
import { healthLines } from "./health.js";
import { lit, neutral, plain } from "./inert.js";
import { AGENT_BLOCKS_MAX, ROOT_MAX, SUBFOLDER_MAX } from "./limits.js";
import { byConnector, offlineSince, sessionFacts, shownSessions } from "./listing.js";
import { placeOf } from "./lines.js";
import type { Agent, Connector, Session } from "../remote/model.js";
import type { ConnectorSetupWords } from "./setup.js";

/** Where a new session starts: a choice of the roots the agent reported and a subfolder, or (none reported) the whole folder. */
export type StartFolder =
  | {
      readonly kind: "roots";
      readonly label: string;
      readonly roots: readonly { title: string; value: string }[];
      readonly subfolder: FolderInput;
    }
  | { readonly kind: "folder"; readonly input: FolderInput };

export interface FolderInput {
  readonly label: string;
  readonly placeholder: string;
  readonly maxLength: number;
}

/** One online agent's block. Input ids carry the slot: a card's inputs all come back with every button. */
export interface AgentBlock {
  readonly kind: "agent";
  readonly slot: number;
  /** `icon name`, inert. */
  readonly title: string;
  readonly unattendedNote: string | null;
  /** null for an agent of kind `attach`, which starts no conversation of its own. */
  readonly start: {
    readonly folder: StartFolder;
    readonly approval: ApprovalInput | null;
    readonly button: RemoteButton;
  } | null;
  readonly conversations: readonly ConversationItem[];
  readonly nothingToTakeOver: string | null;
}

export interface SessionRow {
  readonly kind: "session";
  readonly number: number;
  readonly line: string;
  readonly buttons: readonly RemoteButton[];
}

export type AgentsItem =
  | { readonly kind: "lead"; readonly text: string }
  | { readonly kind: "machine"; readonly text: string; readonly separator: boolean }
  | { readonly kind: "versionNote"; readonly text: string }
  | { readonly kind: "problems"; readonly lines: readonly string[] }
  | { readonly kind: "subtle"; readonly text: string }
  | AgentBlock
  | { readonly kind: "heading"; readonly text: string }
  | SessionRow
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "footer"; readonly text: string };

export interface AgentsView {
  readonly lang: Lang;
  /** false: the sessions part alone (`/agent sessions`). */
  readonly machines: boolean;
  readonly title: string;
  readonly items: readonly AgentsItem[];
  readonly actions: readonly RemoteButton[];
  /** The session ids it lists in order: the numbers of `/agent attach N`. */
  readonly listing: readonly string[];
}

export interface AgentsInput {
  readonly connectors: readonly Connector[];
  readonly sessions: readonly Session[];
  /** The session the chat is attached to. */
  readonly attached: string | null;
  readonly now: number;
  /** One line on top: what the tap that brought the card back did, or why it did not. */
  readonly lead?: string;
  readonly machines?: boolean;
  readonly lang?: Lang;
  /** Session id -> (title, the ref of the terminal conversation it joined, "" for none) of the sessions this chat started. */
  readonly names?: ReadonlyMap<string, { readonly title: string; readonly ref: string }>;
  /** Session id -> the machine's conversation id of this chat's own sessions. */
  readonly own?: ReadonlyMap<string, string>;
  readonly setup: ConnectorSetupWords;
}

function startOf(connector: Connector, agent: Agent, slot: number, lang: Lang): AgentBlock["start"] {
  if (agent.kind === "attach") return null;
  const words = remoteText.in(lang);
  const roots = agentRoots(agent);
  const folder: StartFolder =
    roots.length > 0
      ? {
          kind: "roots",
          label: words.folder,
          roots: roots.map((root) => ({ title: neutral(root, 100), value: root })),
          subfolder: { label: words.subfolder, placeholder: words.subfolderExample, maxLength: SUBFOLDER_MAX },
        }
      : { kind: "folder", input: { label: words.folderOnMachine, placeholder: "/home/me/repo", maxLength: ROOT_MAX } };
  const approval = approvalInput(agent, slot, lang);
  const button = remoteButton(words.newSession, "new", "positive", {
    connector_id: connector.connectorId,
    agent_id: agent.agentId,
    slot,
  });
  return { folder, approval, button };
}

interface Joined {
  /** Ref of a terminal conversation this chat is connected to -> (its number on the card, the session id). */
  readonly connected: ReadonlyMap<string, { readonly number: number; readonly sessionId: string }>;
  /** The machine's conversation ids of this chat's own sessions, listed under "Your sessions" instead. */
  readonly mine: ReadonlySet<string>;
}

function agentBlock(
  connector: Connector,
  agent: Agent,
  slot: number,
  input: AgentsInput,
  joined: Joined,
): AgentBlock {
  const lang = input.lang ?? "en";
  const { icon, label } = kindLabel(agent.kind);
  const conversations = conversationItems(connector, agent, input.now, lang, joined);
  return {
    kind: "agent",
    slot,
    title: `${icon} ${lit(agent.name, 60) || label}`,
    unattendedNote: startsUnattended(agent) ? remoteText.in(lang).unattendedNote : null,
    start: startOf(connector, agent, slot, lang),
    conversations,
    nothingToTakeOver:
      agent.kind === "attach" && conversations.length === 0 ? remoteText.in(lang).nothingToTakeOver : null,
  };
}

function offlineAgent(agent: Agent, lang: Lang): AgentsItem {
  const { icon, label } = kindLabel(agent.kind);
  const name = `${icon} ${lit(agent.name, 60) || label}`;
  const words = remoteText.in(lang);
  const text = startsUnattended(agent) ? words.agentOfflineUnattended({ name }) : words.agentOffline({ name });
  return { kind: "subtle", text };
}

/** What a machine's heading says: its name, online or since when it is offline, its connector's version and health. */
function machineHeading(connector: Connector, input: AgentsInput, separator: boolean): AgentsItem[] {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const state = connector.online ? words.online : offlineSince(connector, lang);
  const items: AgentsItem[] = [{ kind: "machine", text: `**${lit(connector.name, 80)}** (${state})`, separator }];
  const note = input.setup.versionNote(connector, lang);
  if (note) items.push({ kind: "versionNote", text: note });
  const problems = healthLines(connector, lang);
  if (problems.length > 0) items.push({ kind: "problems", lines: problems });
  if (connector.agents.length === 0) items.push({ kind: "subtle", text: words.noAgentReported });
  return items;
}

function machineItems(input: AgentsInput, joined: Joined): AgentsItem[] {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const items: AgentsItem[] = [];
  let slot = 0;
  let more = 0;
  for (const connector of input.connectors) {
    items.push(...machineHeading(connector, input, slot > 0 || items.length > 0 || Boolean(input.lead)));
    for (const agent of connector.agents) {
      if (connector.online && connector.connectorId && slot < AGENT_BLOCKS_MAX) {
        items.push(agentBlock(connector, agent, slot, input, joined));
        slot += 1;
      } else if (connector.online) more += 1;
      else items.push(offlineAgent(agent, lang));
    }
  }
  if (more)
    items.push({ kind: "subtle", text: more === 1 ? words.moreAgent({ n: more }) : words.moreAgents({ n: more }) });
  return items;
}

function sessionButtons(sid: string, attached: string | null, ref: string, lang: Lang): RemoteButton[] {
  const words = remoteText.in(lang);
  const first =
    sid === attached
      ? remoteButton(words.detach, "detach", null, { session_id: sid, view: "agents" })
      : remoteButton(words.attach, "attach", "positive", { session_id: sid });
  // Leaving a conversation a terminal has open ends nothing there: it is a Disconnect. A session this chat made is closed.
  const close = ref
    ? remoteButton(words.disconnectTerminal, "close", "default", { session_id: sid })
    : remoteButton(words.close, "close", "destructive", { session_id: sid });
  return [first, close];
}

function sessionRows(input: AgentsInput, shown: readonly Session[]): SessionRow[] {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const index = byConnector(input.connectors);
  return shown.map((session, i) => {
    const sid = session.sessionId;
    const { who, host, facts } = sessionFacts(session, index, input.attached, input.now, lang);
    const { title, ref } = input.names?.get(sid) ?? { title: "", ref: "" };
    const line = words.sessionLine({
      n: i + 1,
      name: lit(title, 40) || words.newConversation,
      who: plain(who),
      place: placeOf(session.cwd, lit),
      host: plain(host),
      facts,
    });
    return { kind: "session", number: i + 1, line, buttons: sessionButtons(sid, input.attached, ref, lang) };
  });
}

function joinedOf(input: AgentsInput, shown: readonly Session[]): Joined {
  const names = input.names ?? new Map<string, { title: string; ref: string }>();
  const shownIds = shown.map((s) => s.sessionId);
  const mine = new Set<string>();
  for (const [sid, acp] of input.own ?? new Map<string, string>()) {
    if (shownIds.includes(sid) && !names.get(sid)?.ref) mine.add(acp);
  }
  const connected = new Map<string, { number: number; sessionId: string }>();
  shownIds.forEach((sid, i) => {
    const ref = names.get(sid)?.ref;
    if (ref) connected.set(ref, { number: i + 1, sessionId: sid });
  });
  return { connected, mine };
}

/** The agents card as a view: what it says and what each button does. */
export function agentsView(input: AgentsInput): AgentsView {
  const lang = input.lang ?? "en";
  const machines = input.machines ?? true;
  const words = remoteText.in(lang);
  const shown = shownSessions(input.sessions);
  const items: AgentsItem[] = input.lead ? [{ kind: "lead", text: input.lead }] : [];
  if (machines) items.push(...machineItems(input, joinedOf(input, shown)));
  if (shown.length > 0 && machines) items.push({ kind: "heading", text: `**${words.yourSessions}**` });
  items.push(...sessionRows(input, shown));
  if (shown.length === 0 && !machines) items.push({ kind: "plain", text: words.noActiveSessions });
  if (machines) items.push({ kind: "footer", text: words.typingWorks });
  const actions = [remoteButton(machines ? words.refresh : words.allAgents, "list")];
  // (another machine is always one tap away: what `/agent pair` gives)
  if (machines) actions.push(remoteButton(words.connectNewMachine, "pair"));
  return {
    lang,
    machines,
    title: machines ? words.yourAgents : words.yourSessions,
    items,
    actions,
    listing: shown.map((s) => s.sessionId),
  };
}
