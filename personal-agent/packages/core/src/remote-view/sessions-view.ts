// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sessions card: every session the user has, per machine (an offline one says since when) and per agent: its active sessions
 * with "Switch to it" (the one the chat is on says so) and Close, then the conversations it offers; one a terminal has open says
 * how it is shared. Whatever needs the user comes first and says so: a session with an approval card open (`waiting`) and a
 * conversation whose terminal waits for its person; a line under the title counts them.
 */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import { type RemoteButton, remoteButton } from "./actions.js";
import { kindLabel, watchesLive } from "./agents.js";
import { type Conversation, WATCH_STATE, needsYou, resumableOf } from "./conversations.js";
import { shareButton, shareNote } from "./conversations-view.js";
import { lit } from "./inert.js";
import { CONVERSATIONS_PER_AGENT, SESSIONS_PER_AGENT } from "./limits.js";
import { activeSessions, conversationLine, newestFirst, offlineSince } from "./listing.js";
import { MARKS } from "./marks.js";
import type { RemoteAgent, RemoteConnector, RemoteSession } from "./pending-model.js";
import type { ConnectSteps, ConnectorSetupWords } from "./setup.js";
import { windowText } from "./status-view.js";
import { ago } from "./time.js";

export type AgentRow =
  /** A session of the user's, numbered (`row-session-N`), and its buttons. */
  | {
      readonly kind: "session";
      readonly number: number;
      readonly line: string;
      readonly buttons: readonly RemoteButton[];
    }
  | { readonly kind: "more"; readonly text: string }
  /** A conversation the agent offers (`row-conv-N`, N counted over the whole card). */
  | { readonly kind: "conversation"; readonly rowId: number; readonly line: string }
  | { readonly kind: "buttons"; readonly buttons: readonly RemoteButton[] }
  | { readonly kind: "note"; readonly text: string };

export type SessionsItem =
  | { readonly kind: "lead"; readonly text: string }
  | { readonly kind: "badge"; readonly text: string }
  | { readonly kind: "machine"; readonly text: string; readonly online: boolean }
  | { readonly kind: "versionNote"; readonly text: string }
  | { readonly kind: "subtle"; readonly text: string }
  /** One agent (`row-agent-N`): its title and rows. */
  | { readonly kind: "agent"; readonly rowId: number; readonly title: string; readonly rows: readonly AgentRow[] }
  | { readonly kind: "connect"; readonly steps: ConnectSteps }
  | { readonly kind: "window"; readonly text: string };

export interface SessionsView {
  readonly lang: Lang;
  readonly title: string;
  readonly items: readonly SessionsItem[];
  readonly actions: readonly RemoteButton[];
  /** The active session ids in the order shown: the numbers of `/agent attach N`. */
  readonly listing: readonly string[];
}

export interface SessionsInput {
  readonly connectors: readonly RemoteConnector[];
  readonly sessions: readonly RemoteSession[];
  readonly attached: string | null;
  readonly now: number;
  readonly lang?: Lang;
  readonly lead?: string;
  readonly setup: ConnectorSetupWords;
  /** Session ids with an approval card open. */
  readonly waiting?: ReadonlySet<string>;
  /** The console's list of sessions, "" for none. */
  readonly page?: string;
}

/** Element ids are positions (names joined by "-" can collide): one counter per kind over the whole card. */
interface Counters {
  listing: string[];
  conversations: number;
  agents: number;
}

function needCount(input: SessionsInput, active: readonly RemoteSession[]): number {
  const waiting = input.waiting ?? new Set<string>();
  const open = new Set(active.map((s) => s.sessionId));
  const sessions = [...open].filter((sid) => waiting.has(sid)).length;
  const terminals = input.connectors
    .filter((c) => c.online)
    .flatMap((c) => c.agents)
    .flatMap((a) => resumableOf(a))
    .filter((e) => e.state !== "attached" && needsYou(e)).length;
  return sessions + terminals;
}

function hasEntries(agent: RemoteAgent, connectorId: string, active: readonly RemoteSession[]): boolean {
  const ofAgent = active.some((s) => s.connectorId === connectorId && s.agentId === agent.agentId);
  return ofAgent || resumableOf(agent).some((e) => e.state !== "attached");
}

/** An agent with nothing to list is left out when another agent of the machine has something: one "no session" line at most. */
function listedAgents(
  agents: readonly RemoteAgent[],
  connectorId: string,
  active: readonly RemoteSession[],
): RemoteAgent[] {
  const listed = agents.filter((a) => hasEntries(a, connectorId, active));
  const quiet = agents.filter((a) => !listed.includes(a));
  if (listed.length > 0 && quiet.length > 0) return listed;
  return quiet.length > 0 ? quiet.slice(0, 1) : [...agents];
}

function sessionRows(mine: readonly RemoteSession[], input: SessionsInput, counters: Counters): AgentRow[] {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const waiting = input.waiting ?? new Set<string>();
  const rows: AgentRow[] = [];
  for (const session of mine.slice(0, SESSIONS_PER_AGENT)) {
    const sid = session.sessionId;
    counters.listing.push(sid);
    const when = ago(input.now, session.updatedAt, lang);
    let line = `${String(counters.listing.length)}. ${lit(session.cwd, 80)}` + (when ? ` · ${when}` : "");
    if (waiting.has(sid)) line = words.waitingApprovalMark({ mark: MARKS.needsYou }) + line;
    const close = remoteButton(words.close, "close", "destructive", { session_id: sid, view: "sessions" });
    const current = sid === input.attached; // (no switching to it: it is the one; closing it is still one tap)
    rows.push({
      kind: "session",
      number: counters.listing.length,
      line: current ? line + words.current : line,
      buttons: current
        ? [close]
        : [remoteButton(words.switchToIt, "attach", "positive", { session_id: sid, view: "sessions" }), close],
    });
  }
  if (mine.length > SESSIONS_PER_AGENT)
    rows.push({ kind: "more", text: words.olderSessions({ n: mine.length - SESSIONS_PER_AGENT }) });
  return rows;
}

function conversationRows(
  connector: RemoteConnector,
  agent: RemoteAgent,
  entry: Conversation,
  input: SessionsInput,
  rowId: number,
): AgentRow[] {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const online = connector.online;
  const fields = { connector_id: connector.connectorId, agent_id: agent.agentId, resume: entry.ref, view: "sessions" };
  const rows: AgentRow[] = [{ kind: "conversation", rowId, line: conversationLine(entry, input.now, lang) }];
  if (entry.state === "idle" && online) {
    rows.push({ kind: "buttons", buttons: [remoteButton(words.takeOverSwitch, "new", null, fields)] });
  } else if (entry.state === WATCH_STATE && !(online && watchesLive(agent))) {
    rows.push({ kind: "note", text: words.terminalOnly });
  } else if (entry.state === WATCH_STATE) {
    // shared with the phone: typed into, or watched; never taken from the terminal
    const { title, style } = shareButton(agent, entry, lang);
    rows.push(
      { kind: "note", text: shareNote(agent, entry, lang) },
      { kind: "buttons", buttons: [remoteButton(title, "new", style, fields)] },
    );
  }
  return rows;
}

function agentItem(
  connector: RemoteConnector,
  agent: RemoteAgent,
  active: readonly RemoteSession[],
  input: SessionsInput,
  counters: Counters,
): SessionsItem {
  const lang = input.lang ?? "en";
  const waiting = input.waiting ?? new Set<string>();
  const { icon, label } = kindLabel(agent.kind);
  const mine = active
    .filter((s) => s.connectorId === connector.connectorId && s.agentId === agent.agentId)
    .sort((a, b) => Number(!waiting.has(a.sessionId)) - Number(!waiting.has(b.sessionId)));
  const rows = sessionRows(mine, input, counters);
  // (stable: waiting first, else newest; one a session of the user's has open is listed above, as that session)
  const offered = [...resumableOf(agent)]
    .sort((a, b) => Number(!needsYou(a)) - Number(!needsYou(b)))
    .filter((e) => e.state !== "attached")
    .slice(0, CONVERSATIONS_PER_AGENT);
  for (const entry of offered) {
    counters.conversations += 1;
    rows.push(...conversationRows(connector, agent, entry, input, counters.conversations));
  }
  if (mine.length === 0 && offered.length === 0) rows.push({ kind: "note", text: remoteText.in(lang).noSession });
  counters.agents += 1;
  return { kind: "agent", rowId: counters.agents, title: `${icon} ${lit(agent.name, 60) || label}`, rows };
}

function machineItems(
  connector: RemoteConnector,
  active: readonly RemoteSession[],
  input: SessionsInput,
  counters: Counters,
): SessionsItem[] {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const online = connector.online;
  const state = online ? words.online : offlineSince(connector, lang);
  const items: SessionsItem[] = [{ kind: "machine", text: `**${lit(connector.name, 80)}** (${state})`, online }];
  const note = input.setup.versionNote(connector, lang);
  if (note) items.push({ kind: "versionNote", text: note });
  const agents = connector.agents;
  if (agents.length === 0) items.push({ kind: "subtle", text: words.noAgentReportedShort });
  for (const agent of listedAgents(agents, connector.connectorId, active)) {
    items.push(agentItem(connector, agent, active, input, counters));
  }
  return items;
}

/** The sessions card as a view. */
export function sessionsView(input: SessionsInput): SessionsView {
  const lang = input.lang ?? "en";
  const words = remoteText.in(lang);
  const items: SessionsItem[] = input.lead ? [{ kind: "lead", text: input.lead }] : [];
  const active = newestFirst(activeSessions(input.sessions));
  const need = needCount(input, active);
  if (need) items.push({ kind: "badge", text: words.nWaiting({ mark: MARKS.needsYou, n: need }) });
  const counters: Counters = { listing: [], conversations: 0, agents: 0 };
  for (const connector of input.connectors) items.push(...machineItems(connector, active, input, counters));
  const window = windowText(input.page ?? "", lang, true);
  if (input.connectors.length === 0) items.push({ kind: "connect", steps: input.setup.connectSteps(lang) });
  else if (window) items.push({ kind: "window", text: window });
  const actions = [remoteButton(words.refresh, "switch", null, { session_id: input.attached ?? "" })];
  if (input.attached) actions.unshift(remoteButton(words.backButton, "row", null, { session_id: input.attached }));
  return { lang, title: words.yourSessions, items, actions, listing: counters.listing };
}
