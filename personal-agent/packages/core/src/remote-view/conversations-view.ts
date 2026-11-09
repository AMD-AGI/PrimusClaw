// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The conversations an agent offers on the agents card, in three groups: those a terminal has open now (shared, never taken from
 * it: Connect or Watch only, or, when this chat is connected to it, that and Disconnect); below them, labelled, those no process
 * runs (Take over) and those the connector cannot tell. One this connector already holds for a session of this chat is not listed.
 */
import type { Lang } from "../locales/lang.js";
import { remoteText } from "../locales/remote.js";
import { type RemoteButton, remoteButton } from "./actions.js";
import { canTypeIntoTerminals, typesInto, watchesLive } from "./agents.js";
import { type Conversation, WATCH_STATE, resumableOf } from "./conversations.js";
import { lit } from "./inert.js";
import { IDLE_SHOWN, RESUMABLE_SHOWN } from "./limits.js";
import type { RemoteAgent, RemoteConnector } from "./pending-model.js";
import { agoEpoch } from "./time.js";

export type ConversationItem =
  /** Its title (inert, or "Untitled") and, under it, its folder and how long ago. */
  | { readonly kind: "conversation"; readonly title: string; readonly where: string }
  /** A small subtle line right under the conversation. */
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "buttons"; readonly buttons: readonly RemoteButton[] }
  /** The label of a group, with a separator above it when something is listed before it. */
  | { readonly kind: "group"; readonly text: string; readonly separator: boolean }
  | { readonly kind: "more"; readonly text: string };

const UNKNOWN_SHOWN = 2;

/** The line under a conversation open in a terminal: what connecting to it does, and when the phone can only watch, why and
 * what to change. */
export function shareNote(agent: RemoteAgent, entry: Conversation, lang: Lang): string {
  const words = remoteText.in(lang);
  if (typesInto(agent, entry)) return words.shareNoteTyped;
  return canTypeIntoTerminals(agent) ? words.shareNoteNoTmux : words.shareNoteOld;
}

/** The one button a conversation open in a terminal offers: connect, when what is sent is typed into that terminal; else watch. */
export function shareButton(
  agent: RemoteAgent,
  entry: Conversation,
  lang: Lang,
): { title: string; style: "positive" | null } {
  const words = remoteText.in(lang);
  return typesInto(agent, entry)
    ? { title: words.shareConnect, style: "positive" }
    : { title: words.shareWatch, style: null };
}

interface Place {
  readonly connectorId: string;
  readonly agentId: string;
  readonly now: number;
  readonly lang: Lang;
}

function heading(entry: Conversation, place: Place): ConversationItem {
  const when = agoEpoch(place.now, entry.updatedAt, place.lang);
  return {
    kind: "conversation",
    title: lit(entry.title, 80) || remoteText.in(place.lang).untitled,
    where: lit(entry.cwd, 80) + (when ? ` · ${when}` : ""),
  };
}

function resume(title: string, style: "positive" | null, entry: Conversation, place: Place): RemoteButton {
  return remoteButton(title, "new", style, {
    connector_id: place.connectorId,
    agent_id: place.agentId,
    resume: entry.ref,
  });
}

function liveItems(
  agent: RemoteAgent,
  entry: Conversation,
  place: Place,
  connected: ReadonlyMap<string, { readonly number: number; readonly sessionId: string }>,
): ConversationItem[] {
  const words = remoteText.in(place.lang);
  const here = connected.get(entry.ref);
  if (here) {
    return [
      { kind: "note", text: words.connectedHere({ n: here.number }) },
      {
        kind: "buttons",
        buttons: [remoteButton(words.disconnectTerminal, "close", null, { session_id: here.sessionId })],
      },
    ];
  }
  if (!watchesLive(agent)) return [{ kind: "note", text: words.exitItFirst }];
  // shared with the phone: what is sent is typed into the terminal, or the phone watches; the terminal keeps it either way
  const { title, style } = shareButton(agent, entry, place.lang);
  return [
    { kind: "note", text: (typesInto(agent, entry) ? "⌨ " : "👁 ") + shareNote(agent, entry, place.lang) },
    { kind: "buttons", buttons: [resume(title, style, entry, place)] },
  ];
}

/** The conversations of one online agent on the agents card. */
export function conversationItems(
  connector: RemoteConnector,
  agent: RemoteAgent,
  now: number,
  lang: Lang,
  joined: {
    readonly connected: ReadonlyMap<string, { readonly number: number; readonly sessionId: string }>;
    readonly mine: ReadonlySet<string>;
  },
): ConversationItem[] {
  const words = remoteText.in(lang);
  const place = { connectorId: connector.connectorId, agentId: agent.agentId, now, lang };
  const entries = resumableOf(agent).filter((e) => e.state !== "attached" && !joined.mine.has(e.ref));
  const live = entries.filter((e) => e.state === WATCH_STATE);
  const idle = entries.filter((e) => e.state === "idle");
  const unknown = entries.filter((e) => e.state === "unknown");
  const items: ConversationItem[] = [];
  for (const entry of live.slice(0, RESUMABLE_SHOWN))
    items.push(heading(entry, place), ...liveItems(agent, entry, place, joined.connected));
  const room = Math.max(0, RESUMABLE_SHOWN - Math.min(live.length, RESUMABLE_SHOWN));
  const shownIdle = idle.slice(0, Math.min(room, IDLE_SHOWN));
  if (shownIdle.length > 0) {
    items.push({ kind: "group", text: words.idleGroup, separator: live.length > 0 });
    for (const entry of shownIdle) {
      items.push(heading(entry, place), {
        kind: "buttons",
        buttons: [resume(words.takeOver, "positive", entry, place)],
      });
    }
  }
  if (unknown.length > 0) {
    items.push({ kind: "group", text: words.unknownGroup, separator: live.length > 0 || shownIdle.length > 0 });
    for (const entry of unknown.slice(0, UNKNOWN_SHOWN))
      items.push(heading(entry, place), { kind: "note", text: words.cannotTell });
  }
  const hidden =
    entries.length -
    Math.min(live.length, RESUMABLE_SHOWN) -
    shownIdle.length -
    Math.min(unknown.length, UNKNOWN_SHOWN);
  if (hidden > 0) items.push({ kind: "more", text: words.olderConversations({ n: hidden }) });
  return items;
}
