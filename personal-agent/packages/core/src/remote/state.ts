// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What is known of one chat's attachment at a moment: the store's record joined with what this process knows (whether the session
 * only watches a terminal's conversation, whether a turn or the follower is reading it), and what follows from that: its phase,
 * its language, whether it is the agent's window itself, the session card's view of its output.
 */
import { ClawError, ClawUnreachable } from "../claw/errors.js";
import type { Lang } from "../locales/lang.js";
import type { RemotePermission, RemoteState } from "../ports/store/remote.js";
import { isGroupKey, personOf } from "./chat-key.js";
import type { ChatRegistry } from "./chats.js";
import type { RemoteContext } from "./context.js";
import { isTerminalPermission } from "./terminal-asks.js";
import { WindowView } from "./window/view.js";

/** Events read back to learn whether a session only watches a terminal's conversation. */
const WATCH_READ = 50;

/** What a chat's session is doing, as its status card says it. */
export type ChatPhase = "detached" | "watching" | "working" | "idle";

export class ChatState {
  /** What each chat's session card shows of its session's output, in this process. */
  private readonly views = new Map<string, WindowView>();

  constructor(
    private readonly ctx: RemoteContext,
    readonly chats: ChatRegistry,
  ) {}

  attached(chatKey: string): RemoteState | null {
    return this.ctx.remoteState.attachedRemote(chatKey);
  }

  /** The language the chat is answered in ("en" when it cannot be read). */
  lang(chatKey: string): Lang {
    try {
      return this.ctx.langOf(personOf(chatKey)) === "zh" ? "zh" : "en";
    } catch {
      return "en";
    }
  }

  /** TEAMS_DIRECT_CHAT is on for this 1:1 chat's person (a group binding keeps its session card). */
  directOn(chatKey: string): boolean {
    return !isGroupKey(chatKey) && this.ctx.directChat.on(chatKey);
  }

  /** The chat is the agent's window itself, with no card. */
  direct(chatKey: string): boolean {
    return this.ctx.settings.enabled && this.directOn(chatKey);
  }

  /** The chat's session only watches a conversation open in a terminal (read-only). */
  watches(chatKey: string, state: RemoteState | null): boolean {
    return state !== null && this.chats.watches(chatKey, state.sessionId);
  }

  typesIntoTerminal(chatKey: string, state: RemoteState | null): boolean {
    return state !== null && this.chats.typesIntoTerminal(chatKey, state.sessionId);
  }

  /**
   * `watches`, with the marker read back from the session itself the first time this process is asked (a worker that restarted
   * knows its chats' sessions, not which of them only watch): the newest `session_started`/`session_resumed` among its first events
   * says. When that cannot be read the marker as it is answers.
   */
  async knownWatch(chatKey: string, key: string, state: RemoteState): Promise<boolean> {
    const sid = state.sessionId ?? "";
    if (sid && !this.chats.knowsWatch(chatKey, sid)) {
      let rows;
      try {
        rows = await this.ctx.claw.events(key, sid, undefined, WATCH_READ);
      } catch (error) {
        if (error instanceof ClawError || isTransport(error)) return this.watches(chatKey, state);
        throw error;
      }
      const said = rows.filter((r) => r.type === "session_started" || r.type === "session_resumed").at(-1);
      if (said) this.chats.markReadOnly(chatKey, sid, said.data?.["read_only"] === true);
      this.chats.learnedWatch(chatKey, sid);
    }
    return this.watches(chatKey, state);
  }

  /** The watched session has ended (the terminal let the conversation go). False when it is on, or cannot be read now. */
  async watchOver(key: string, state: RemoteState): Promise<boolean> {
    try {
      const session = await this.ctx.claw.session(key, state.sessionId ?? "");
      return session.status === "closed";
    } catch (error) {
      if (error instanceof ClawError || isTransport(error)) return false;
      throw error;
    }
  }

  /** The watching status card offers Take over…: the ref is known, and the connector can take it over (or is not known not to). */
  offersTakeover(chatKey: string): boolean {
    const state = this.attached(chatKey);
    return Boolean(state?.conversationRef) && (this.chats.agentTakeover.get(chatKey) ?? true);
  }

  phase(chatKey: string): ChatPhase {
    const state = this.attached(chatKey);
    if (state === null) return "detached";
    if (this.watches(chatKey, state)) return "watching";
    const follower = this.chats.followers.get(chatKey);
    const busy = this.chats.turns.has(chatKey) || state.turnOpen || (follower?.busy() ?? false);
    return busy ? "working" : "idle";
  }

  /** The chat's window view, reset to its session's. */
  view(chatKey: string, state: RemoteState | null = this.attached(chatKey)): WindowView {
    let view = this.views.get(chatKey);
    if (view === undefined) {
      view = new WindowView();
      this.views.set(chatKey, view);
    }
    if (state?.sessionId) view.reset(state.sessionId);
    return view;
  }

  /** The view when the chat has one, without making one. */
  existingView(chatKey: string): WindowView | undefined {
    return this.views.get(chatKey);
  }

  forgetView(chatKey: string): void {
    this.views.delete(chatKey);
  }

  /**
   * The approvals the chat's session waits for, as the window shows them (none in a group: those go to the binder's 1:1). A
   * question a terminal asks is never among them: the window shows a tool and buttons, not the request, and it has its own card.
   */
  approvalsOf(chatKey: string, state: RemoteState): RemotePermission[] {
    if (isGroupKey(chatKey) || !state.sessionId) return [];
    return this.ctx.permissions
      .pendingRemotePermissions(chatKey, state.sessionId)
      .filter((p) => !isTerminalPermission(p));
  }

  /** The person's time zone (IANA), the default when theirs is not one. */
  zone(chatKey: string): string {
    return validZone(this.ctx.prefs.getPrefs(personOf(chatKey)).timezone);
  }
}

/** The zone the worker falls back to (the store's DEFAULT_TIMEZONE). */
export const DEFAULT_ZONE = "Asia/Shanghai";

/** `zone` when it is a time zone this runtime knows, else the default. */
export function validZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_ZONE;
  }
}

/** Claw was not reached, or did not answer in time (the transport's own failure, never a refusal). */
export function isTransport(error: unknown): boolean {
  return error instanceof ClawUnreachable;
}

/**
 * What the session said of `mode` (`true`: it does not ask, `false`: it asks), or undefined when it said nothing. Its own keys only:
 * a mode called `constructor` or `__proto__` is no flag (Python's `dict.get`).
 */
export function modeFlagOf(flags: Readonly<Record<string, boolean>>, mode: string): boolean | undefined {
  return Object.hasOwn(flags, mode) ? flags[mode] : undefined;
}
