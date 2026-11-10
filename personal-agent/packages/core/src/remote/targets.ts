// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a typed or tapped name of a session or conversation means: a session by its number in the last listing or a prefix of its
 * id; an agent as people name it, which means its newest active session, else a conversation it offers to take over, else a new
 * session in its first folder; a conversation by its ref. And what a tap on a card names (a folder, a conversation to take over),
 * read against what the agent reports NOW, never against the card.
 */
import type { Lang } from "../locales/lang.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import { remoteText } from "../locales/remote.js";
import { agentRoots, canTakeOver, watchesLive } from "./agents.js";
import {
  type Conversation,
  TAKEOVER_STATES,
  WATCH_STATE,
  cleanSubfolder,
  joinPath,
  resumableOf,
} from "./conversations.js";
import { AGENT_BLOCKS_MAX } from "./limits.js";
import { neutral } from "../text/neutral.js";
import type { ChatRegistry } from "./chats.js";
import { textOf } from "./fields.js";
import { agentRefOf, noAgentCalled, resolveAgent } from "./machines.js";
import type { Agent, Connector, Session } from "./model.js";
import { saidIn } from "./refusals.js";
import { own } from "../own.js";

/** Characters of a session id that name it (fewer is a number from the last listing). */
export const MIN_ID_PREFIX = 6;

/** A session to start: on which agent, taking over (or watching) which conversation, in which folder. */
export interface ToStart {
  readonly kind: "start";
  readonly connector: Connector;
  readonly agent: Agent;
  readonly entry: Conversation | null;
  readonly path: string;
}

export type Target =
  | { readonly kind: "session"; readonly session: Session }
  | ToStart
  | { readonly kind: "refusal"; readonly text: string };

const refusal = (text: string): Target => ({ kind: "refusal", text });

/** The sessions `ref` names as a session: its number in the last listing, or a prefix of its id of at least 6 characters. */
export function sessionsByRef(listing: readonly string[], sessions: readonly Session[], ref: string): Session[] {
  if (/^\d+$/u.test(ref) && ref.length < MIN_ID_PREFIX) {
    // (an id's first characters may all be digits: those are an id)
    const n = Number(ref);
    const wanted = n > 0 && n <= listing.length ? listing[n - 1] : undefined;
    return sessions.filter((s) => s.sessionId === wanted);
  }
  if (ref.length >= MIN_ID_PREFIX)
    return sessions.filter((s) => s.sessionId.toLowerCase().startsWith(ref.toLowerCase()));
  return [];
}

/** What a tap names, read against what this process and the agent's report say now. */
export class Targets {
  constructor(private readonly chats: ChatRegistry) {}

  /**
   * What `/agent attach REF` goes to: a session, or (for an agent) its newest active session, else the newest conversation it
   * offers to take over that no terminal has open, else a new session in its first folder, else the one a terminal has open,
   * watched. `now`: wall-clock seconds.
   */
  target(
    chatKey: string,
    listing: readonly string[],
    connectors: readonly Connector[],
    sessions: readonly Session[],
    ref: string,
    now: number,
    lang: Lang,
  ): Target {
    const found = sessionsByRef(listing, sessions, ref);
    const one = found[0];
    if (found.length === 1 && one) return { kind: "session", session: one };
    if (found.length === 0 && ref.length >= MIN_ID_PREFIX) {
      const taken = this.conversationByRef(chatKey, connectors, ref, now);
      if (taken !== null) return taken;
    }
    if (/^\d+$/u.test(ref)) return refusal(saidIn(lang, "whichSession")); // (a number: no agent is called that)
    const chosen = resolveAgent(connectors, ref, now, lang);
    if (chosen.kind === "machine") {
      const names = chosen.agents.map((a) => `\`${agentRefOf(chosen.connector, a)}\``).join(", ");
      return refusal(remoteAgentText.in(lang).agentsOnHost({ host: neutral(chosen.connector.name, 80), names }));
    }
    if (chosen.kind === "refusal") {
      // (neither a session nor an agent of theirs)
      if (found.length > 0 || chosen.text === noAgentCalled(ref, lang))
        return refusal(saidIn(lang, "whichSessionOrAgent"));
      return chosen;
    }
    return this.forAgent(chosen.connector, chosen.agent, sessions, lang);
  }

  private forAgent(connector: Connector, agent: Agent, sessions: readonly Session[], lang: Lang): Target {
    const mine = sessions
      .filter((s) => s.status === "active" && s.connectorId === connector.connectorId && s.agentId === agent.agentId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const newest = mine[0];
    if (newest) return { kind: "session", session: newest };
    const entries = resumableOf(agent);
    const idle = entries.find((e) => e.state === "idle");
    if (idle) return { kind: "start", connector, agent, entry: idle, path: idle.cwd };
    const root = agentRoots(agent)[0];
    if (root !== undefined && agent.kind !== "attach")
      return { kind: "start", connector, agent, entry: null, path: root };
    const live = watchesLive(agent) ? entries.find((e) => e.state === WATCH_STATE) : undefined;
    if (live) return { kind: "start", connector, agent, entry: live, path: live.cwd }; // all it has is open in a terminal: watched
    return refusal(remoteText.in(lang).noSessionYet({ ref: neutral(agentRefOf(connector, agent), 120) }));
  }

  /**
   * A conversation an agent on the person's machines offers to take over, named by its ref (or its first characters): what the
   * assistant puts to the person as that conversation's attach command. Null when no conversation of theirs has that ref.
   */
  private conversationByRef(
    chatKey: string,
    connectors: readonly Connector[],
    ref: string,
    now: number,
  ): Target | null {
    const want = ref.toLowerCase();
    const hits = connectors.flatMap((c) =>
      c.agents.flatMap((a) =>
        resumableOf(a)
          .filter((e) => e.ref.toLowerCase().startsWith(want))
          .map((e) => ({ c, a, e })),
      ),
    );
    const hit = hits[0];
    if (hit === undefined) return null;
    const en = remoteAgentText.in("en");
    if (hits.length > 1) return refusal(en.whichConversation);
    if (!hit.c.online) return refusal(en.offlineNamed({ name: neutral(hit.c.name, 80) }));
    const taken = this.takeoverOf(chatKey, hit.c, hit.a, { resume: hit.e.ref }, now, "en");
    if (taken.entry === null) return refusal(taken.problem.replace("tap Take over again", "send this again"));
    return { kind: "start", connector: hit.c, agent: hit.a, entry: taken.entry, path: taken.entry.cwd };
  }

  /**
   * The conversation a "Take over" (or "Watch") tap names, or why not: it must be on the agent's list NOW. One open in a terminal
   * is watched, read-only, unless the tap is the Take over of the confirmation card this process showed this chat for it (its
   * ticket, once, in time): then the connector ends the terminal first.
   */
  takeoverOf(
    chatKey: string,
    connector: Connector,
    agent: Agent,
    data: Readonly<Record<string, unknown>>,
    now: number,
    lang: Lang,
  ): { entry: Conversation | null; problem: string } {
    const entry = resumableOf(agent).find((e) => e.ref === textOf(data["resume"]));
    const no = (sentence: Parameters<typeof saidIn>[1]): { entry: null; problem: string } => ({
      entry: null,
      problem: saidIn(lang, sentence),
    });
    if (entry === undefined) return no("conversationGone");
    if (entry.state === WATCH_STATE && data["takeover"]) {
      const held = this.chats.ticketOf(chatKey);
      const fresh =
        held !== undefined &&
        held.connectorId === connector.connectorId &&
        held.agentId === agent.agentId &&
        held.ref === entry.ref &&
        held.ticket === textOf(data["takeover"]) &&
        held.until >= now;
      if (!fresh) return no("confirmExpired");
      if (!canTakeOver(agent)) return no("stillInTerminal");
      this.chats.spendTicket(chatKey);
      return { entry, problem: "" }; // (confirmed: the connector ends the terminal, or says why it cannot)
    }
    if (entry.state === WATCH_STATE && !watchesLive(agent)) return no("stillInTerminal"); // (it would refuse it)
    if (!TAKEOVER_STATES.includes(entry.state) && entry.state !== WATCH_STATE) return no("cannotTellTerminal");
    return { entry, problem: "" };
  }

  /**
   * The folder a "New session" tap asks for, or why there is none: a choice among the roots the agent reports NOW and a subfolder
   * below it, or the whole folder when it reports none; or, from the card that asks which of a machine's agents, the folder this
   * process kept when it was typed (the card carries only a token).
   */
  folderOf(
    chatKey: string,
    agent: Agent,
    data: Readonly<Record<string, unknown>>,
    now: number,
    lang: Lang,
  ): { path: string; problem: string } {
    const no = (sentence: Parameters<typeof saidIn>[1]): { path: string; problem: string } => ({
      path: "",
      problem: saidIn(lang, sentence),
    });
    if ("typed" in data) {
      const path = this.chats.typedPath(chatKey, textOf(data["typed"]), now);
      return path ? { path, problem: "" } : no("cardExpired");
    }
    const slot = slotOf(data);
    if (slot < 0) return no("tapInvalidAgents");
    const roots = agentRoots(agent);
    if (roots.length === 0) {
      const path = textOf(own(data, `dir${String(slot)}`)).trim();
      return path ? { path, problem: "" } : no("typeFolder");
    }
    const root = own(data, `root${String(slot)}`);
    if (typeof root !== "string" || !roots.includes(root)) return no("folderGone");
    const sub = cleanSubfolder(own(data, `dir${String(slot)}`));
    if (sub === null) return no("badSubfolder");
    return { path: joinPath(root, sub), problem: "" };
  }
}

/** The block of the card a tap came from (-1: the tap names none that the card has). */
export function slotOf(data: Readonly<Record<string, unknown>>): number {
  const raw = data["slot"];
  const slot =
    typeof raw === "number" ? raw : typeof raw === "string" && /^\s*[-+]?\d+\s*$/u.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(slot) && slot >= 0 && slot < AGENT_BLOCKS_MAX ? slot : -1;
}
