// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Starting a session and attaching a chat to one. A new session starts in its agent's own mode (a start in a mode that does not ask
 * counts against the person's allowance); an existing session is brought back with nothing replayed, and what it was doing when the
 * chat came (at work, a permission nobody answered) is picked up from the end of its events. The chat's attachment is the store's;
 * what the agent's connector reported about it is this process's (`chats.ts`).
 */
import { ClawError } from "../claw/errors.js";
import { errorName } from "../errors.js";
import { remoteAgentText } from "../locales/remote-agents.js";
import type { RemoteState } from "../ports/store/remote.js";
import { canTakeOver, decode, kindLabel, startsUnattended } from "../remote-view/index.js";
import { neutral } from "../text/neutral.js";
import { personOf } from "./chat-key.js";
import type { RemoteContext } from "./context.js";
import type { FollowControl } from "./follow/control.js";
import type { Lists } from "./lists.js";
import { conversationOf, reconnecting } from "./machines.js";
import { type Agent, type Connector, type Session, agentById, connectorById, sessionFrom } from "./model.js";
import { Reconnecting, saidIn } from "./refusals.js";
import type { ChatState } from "./state.js";
import { type SessionTail, readTail } from "./tail.js";
import { isWindowMode } from "./window/view.js";

/** A new session refused as offline while its machine was reconnecting is asked for once more after this. */
export const RECONNECT_RETRY_SECONDS = 10;

/** What a new session is: where, and the conversation it takes over (or watches), when one. */
export interface NewSession {
  readonly connector: Connector;
  readonly agent: Agent;
  readonly path: string;
  readonly resumeRef?: string | undefined;
  /** The person confirmed that the terminal that has the conversation open is ended first. */
  readonly takeover?: boolean;
  /** The conversation's title, which the status card names. */
  readonly conversation?: string;
  /** The count a start in a mode that does not ask took, given back when no session is made. */
  readonly ticket: object | null;
}

/** What attaching came to: whether it did, the sentence (why not), what to do once it is shown, and what the card says. */
export interface Attached {
  readonly ok: boolean;
  readonly text: string;
  followUp(): Promise<void>;
  readonly phase: "idle" | "working" | "watching" | "offline";
  readonly lead: string;
}

const nothing = (): Promise<void> => Promise.resolve();

export class SessionStarts {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
    private readonly lists: Lists,
    private readonly follow: FollowControl,
  ) {}

  /** Where the chat box goes when a chat attaches: the person's `/agent mode`, else the default; always the chat in a direct chat. */
  newWindow(chatKey: string): string {
    if (this.state.directOn(chatKey)) return "chat";
    let said = "";
    try {
      said = this.ctx.prefs.getPrefs(personOf(chatKey)).remoteWindow;
    } catch (error) {
      this.ctx.logger.info("the person's chat box preference could not be read", {
        error: errorName(error),
      });
    }
    return isWindowMode(said) ? said : this.ctx.settings.windowDefault;
  }

  /**
   * A new session of an agent configured to start in a mode that does not ask is that mode from its first message: it counts
   * against the same per-person limit as a switch to one. The ticket of the count (null: none taken), or the refusal.
   */
  takeUnattendedStart(chatKey: string, agent: Agent): { ticket: object | null; refusal: string } {
    if (!startsUnattended(agent)) return { ticket: null, refusal: "" };
    const ticket = {};
    const refused = this.ctx.guard.take(chatKey, "remote_agent", ticket);
    if (refused)
      return { ticket: null, refusal: remoteAgentText.in("en").startsUnattendedRefused({ refused: refused.text() }) };
    return { ticket, refusal: "" };
  }

  /** The label a session of `agent` is shown with: its icon and name. */
  static labelOf(agent: Agent): string {
    const { icon, label } = kindLabel(agent.kind);
    return `${icon} ${neutral(agent.name, 60) || label}`;
  }

  /**
   * Start a session and attach the chat to it: the session id. The caller tells the person, then starts the watch for the agent's
   * first word. The count `ticket` is given back when no session is made.
   */
  async begin(chatKey: string, key: string, start: NewSession): Promise<string> {
    let session: Session;
    try {
      session = await this.create(key, start);
    } catch (error) {
      this.ctx.guard.giveBack(chatKey, "remote_agent", start.ticket);
      throw error;
    }
    const resumed = start.resumeRef ?? "";
    this.leaveCurrent(chatKey);
    this.state.chats.clearReadOnly(chatKey); // (a new session says itself whether it only watches)
    this.ctx.remoteState.attachRemote(chatKey, {
      sessionId: session.sessionId,
      connectorId: start.connector.connectorId,
      agentId: start.agent.agentId,
      agentLabel: SessionStarts.labelOf(start.agent),
      host: neutral(start.connector.name, 80),
      cwd: neutral(session.cwd || start.path, 300),
      conversation: resumed ? neutral(start.conversation ?? "", 120) : "",
      conversationRef: resumed,
      window: this.newWindow(chatKey),
    });
    this.state.chats.agentTakeover.set(chatKey, canTakeOver(start.agent));
    this.state.chats.agentUnattended.set(chatKey, startsUnattended(start.agent));
    // What the session is called on /agents: the conversation's title, or (a new one) its first message.
    this.ctx.sessionNames.nameRemoteSession(chatKey, session.sessionId, {
      title: resumed ? neutral(start.conversation ?? "", 80) : "",
      conversationRef: resumed,
    });
    return session.sessionId;
  }

  /** The chat leaves what it was reading: a short watch, the follower; and it may be followed again. */
  private leaveCurrent(chatKey: string): void {
    const watcher = this.state.chats.watchers.get(chatKey);
    this.state.chats.watchers.delete(chatKey);
    watcher?.cancel();
    this.follow.drop(chatKey);
    this.state.chats.unlinked.delete(chatKey);
  }

  /**
   * Ask Claw for the session. Refused as offline while the machine is reconnecting (heard from moments ago), it is asked for once
   * more a little later; refused again, the refusal says it is reconnecting, never to restart a connector coming back by itself.
   */
  private async create(key: string, start: NewSession): Promise<Session> {
    const create = async (): Promise<Session> => {
      const raw = await this.ctx.claw.createSession(key, {
        connectorId: start.connector.connectorId,
        agentId: start.agent.agentId,
        cwd: start.path,
        ...(start.resumeRef ? { resumeRef: start.resumeRef } : {}),
        ...(start.takeover ? { takeover: true } : {}),
      });
      return sessionFrom(raw);
    };
    try {
      return await create();
    } catch (error) {
      if (!offlineRefusal(error)) throw error;
      const machines = await this.lists.machines(key);
      const fresh = connectorById(machines.connectors, start.connector.connectorId) ?? start.connector;
      if (!reconnecting(fresh, this.ctx.clock.epochMs() / 1000)) throw error;
    }
    await (this.ctx.paceClock ?? this.ctx.clock).sleep(RECONNECT_RETRY_SECONDS * 1000);
    try {
      return await create();
    } catch (error) {
      if (offlineRefusal(error)) throw new Reconnecting(start.connector);
      throw error;
    }
  }

  /** Where a session's events end now (`tail.ts`). */
  tail(key: string, sessionId: string): Promise<SessionTail> {
    return readTail(
      (after, limit) =>
        this.ctx.claw
          .events(key, sessionId, after ?? undefined, limit)
          .then((rows) => rows.map((r) => ({ id: r.id ?? "", type: r.type ?? "", data: r.data }))),
      (event) => decode(event, this.ctx.errors),
    );
  }

  /**
   * Attach the chat to one of the person's sessions: nothing is replayed, the agent's own session is brought back. The caller
   * shows `text` (why not), then runs `followUp` (a turn that is open is shown, a permission nobody answered gets its card).
   */
  async attach(chatKey: string, key: string, session: Session, hooks: AttachHooks): Promise<Attached> {
    const lang = this.state.lang(chatKey);
    if (session.status !== "active") return refused(saidIn(lang, "sessionEnded"));
    const connector = connectorById((await this.lists.machines(key)).connectors, session.connectorId);
    if (connector === undefined) return refused(saidIn(lang, "machineGone"));
    const agent = agentById(connector, session.agentId);
    this.state.chats.agentUnattended.set(chatKey, agent ? startsUnattended(agent) : false);
    this.leaveCurrent(chatKey);
    const before = this.state.attached(chatKey);
    const sent = before?.sessionId === session.sessionId && before.turnOpen; // a prompt of this chat's whose end was never seen
    const tail = await this.tail(key, session.sessionId);
    const readOnly = tail.readOnly || session.readOnly === true;
    this.remember(chatKey, session, connector, agent, tail, readOnly, before);
    const online = connector.online;
    if (online) await this.resume(key, session.sessionId);
    const working = tail.active && online;
    const followUp = (): Promise<void> => hooks.followUp({ sessionId: session.sessionId, tail, working, sent });
    if (this.state.chats.watches(chatKey, session.sessionId)) {
      return { ok: true, text: "", followUp, phase: online ? "watching" : "offline", lead: "" };
    }
    const lead = working && !sent ? remoteAgentText.in(lang).workingNow : "";
    return { ok: true, text: "", followUp, phase: !online ? "offline" : working ? "working" : "idle", lead };
  }

  /** The attachment in the store, and what this process knows of it. */
  private remember(
    chatKey: string,
    session: Session,
    connector: Connector,
    agent: Agent | undefined,
    tail: SessionTail,
    readOnly: boolean,
    before: RemoteState | null,
  ): void {
    const kept = before?.sessionId === session.sessionId && before.conversation !== "";
    const named = kept
      ? { title: before.conversation, ref: before.conversationRef }
      : agent
        ? conversationOf(agent, session, readOnly)
        : { title: "", ref: "" };
    this.ctx.remoteState.attachRemote(chatKey, {
      sessionId: session.sessionId,
      connectorId: connector.connectorId,
      agentId: session.agentId,
      agentLabel: SessionStarts.labelOf(agent ?? { agentId: "", kind: "", name: "", capabilities: {} }),
      host: neutral(connector.name, 80),
      cwd: neutral(session.cwd, 300),
      cursor: tail.cursor,
      mode: tail.mode ?? "",
      modes: tail.modes,
      unattended: tail.unattended,
      modeFlags: tail.modeFlags,
      conversation: named.title,
      conversationRef: named.ref,
      window: this.newWindow(chatKey),
    });
    this.state.chats.agentTakeover.set(chatKey, agent ? canTakeOver(agent) : false);
    this.state.chats.markReadOnly(chatKey, session.sessionId, readOnly);
    this.state.chats.markTerminal(chatKey, session.sessionId, tail.terminal);
  }

  /** Bring the agent's own session back (it keeps its context; nothing is replayed). */
  private async resume(key: string, sessionId: string): Promise<void> {
    try {
      await this.ctx.claw.command(key, sessionId, { type: "resume" });
    } catch (error) {
      if (!(error instanceof ClawError)) throw error;
      this.ctx.logger.info("resume after attach was not accepted", { status: error.status });
    }
  }
}

/** What the caller does once an attachment is shown: show a turn that is open, the permissions nobody answered, follow it. */
export interface AttachHooks {
  followUp(found: {
    readonly sessionId: string;
    readonly tail: SessionTail;
    readonly working: boolean;
    readonly sent: boolean;
  }): Promise<void>;
}

function refused(text: string): Attached {
  return { ok: false, text, followUp: nothing, phase: "idle", lead: "" };
}

function offlineRefusal(error: unknown): boolean {
  return error instanceof ClawError && error.status === 409 && error.code === "connector_offline";
}
