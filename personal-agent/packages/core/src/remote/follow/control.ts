// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which chats are followed between turns (`follower.ts`): an attached chat has its reader unless a turn or a short watch is
 * reading its session (the one that ends starts it again). Nothing follows a chat whose person unlinked until it attaches again,
 * and no reader outlives the key it reads with.
 */
import { RemoteTurnState } from "../turn-state.js";
import { personOf, isGroupKey } from "../chat-key.js";
import type { RemoteContext } from "../context.js";
import type { StatusBoard } from "../board.js";
import type { ChatState } from "../state.js";
import { Follower } from "./follower.js";

/** How the follower says a session's end and shows a permission request (the domain's own sentences and cards). */
export interface FollowHooks {
  describeEnd(chatKey: string, connectorId: string, reason: string): Promise<string>;
  showPermission(
    chatKey: string,
    sessionId: string,
    request: Readonly<Record<string, unknown>>,
    to: import("../../ports/surface.js").Conversation,
  ): Promise<void>;
}

export class FollowControl {
  constructor(
    private readonly ctx: RemoteContext,
    private readonly state: ChatState,
    private readonly board: StatusBoard,
    private readonly hooks: FollowHooks,
  ) {}

  /** An attached chat hears its session between turns: what the session says shows there by itself. */
  get follows(): boolean {
    return this.ctx.settings.enabled && this.ctx.settings.follow;
  }

  /**
   * Make sure an attached chat has its reader, unless a turn or a short watch is reading the session. `active`: the agent was seen
   * at work just now, so `/stop` reaches it before its next event. `steps`, `asks`: the steps still running and the permission
   * requests still waiting at that moment.
   */
  ensure(chatKey: string, active = false, steps: readonly string[] = [], asks: readonly string[] = []): void {
    const chats = this.state.chats;
    if (!this.follows || chats.unlinked.has(chatKey)) return;
    const attached = this.state.attached(chatKey);
    if (attached === null) {
      this.drop(chatKey);
      return;
    }
    if (chats.turns.has(chatKey) || chats.watching(chatKey)) return;
    const current = chats.followers.get(chatKey);
    if (current?.alive === true && current.sessionId === attached.sessionId) return;
    this.drop(chatKey);
    // A conversation open in a terminal, watched or typed into: what is typed there is answered there, with no turn of the phone's to
    // end it, so its reply is told after a few quiet seconds, as a watch's is. With the half-minute of a session of the phone's own it
    // came after the person had left (2026-11-11 guide re-check: nothing within 20 s, although the card says replies show up here).
    const watched = this.state.watches(chatKey, attached) || this.state.typesIntoTerminal(chatKey, attached);
    const follower = new Follower(chatKey, attached.sessionId ?? "", {
      clock: this.ctx.clock,
      logger: this.ctx.logger,
      timings: watched ? this.ctx.settings.watchTimings : this.ctx.settings.timings,
      reach: this.ctx.reach,
      remoteState: this.ctx.remoteState,
      references: this.ctx.references,
      permissions: this.ctx.permissions,
      conversationFor: (reference) => this.ctx.conversationFor(reference),
      showPermission: (key, sid, request, to) => this.hooks.showPermission(key, sid, request, to),
      lang: () => this.state.lang(chatKey),
      direct: () => this.state.direct(chatKey),
      describeEnd: (reason) => this.hooks.describeEnd(chatKey, attached.connectorId, reason),
      window: (text, final) => Promise.resolve(this.board.windowSaid(chatKey, text, final)),
      windowSettled: () => this.board.windowSettled(chatKey),
      stream: (key, sid, after, signal) => this.ctx.claw.stream(key, sid, after, signal),
      // (a group binding's chat key reads with its binder's credential)
      credential: () => this.ctx.credentialFor(personOf(chatKey)),
      newTurn: () => new RemoteTurnState(this.ctx.errors),
    });
    chats.followers.set(chatKey, follower);
    follower.start(active, steps, asks);
  }

  /** The chat has left its session (or something else is about to read it): the reader goes, with what it had not said. */
  drop(chatKey: string): void {
    const follower = this.state.chats.followers.get(chatKey);
    this.state.chats.followers.delete(chatKey);
    follower?.drop();
  }

  /** Stop the reader before a message goes to the agent, with what it has read delivered: true when there was one to stop. */
  async stop(chatKey: string): Promise<boolean> {
    const follower = this.state.chats.followers.get(chatKey);
    this.state.chats.followers.delete(chatKey);
    if (follower?.alive !== true) return false;
    await follower.stop(true);
    return true;
  }

  /** The chat leaves its session. */
  detach(chatKey: string): void {
    this.drop(chatKey);
    this.ctx.remoteState.detachRemote(chatKey);
  }

  /** Follow every chat that is attached: a worker that starts delivers what its agents said while it was away, once. */
  resume(): void {
    for (const chatKey of this.ctx.remoteState.remoteAttachedUsers()) {
      if (this.state.directOn(chatKey)) this.chatIsWindow(chatKey);
      this.ensure(chatKey);
    }
  }

  shutdown(): void {
    for (const chatKey of [...this.state.chats.followers.keys()]) this.drop(chatKey);
  }

  /**
   * TEAMS_DIRECT_CHAT is on for this person: an attachment that still has the session card as its window is moved to the chat,
   * here and in the store, so nothing reads it as a card any more (the card itself is left where it is).
   */
  chatIsWindow(chatKey: string): void {
    const attached = this.state.attached(chatKey);
    if (attached?.window === "card") {
      this.ctx.remoteState.setRemoteWindow(chatKey, "chat");
      this.board.cancelWindowEdit(chatKey);
    }
  }

  /** The chats of a person: their 1:1 chat and every group chat they bound to a session. */
  chatsOf(person: string): string[] {
    return [
      person,
      ...this.ctx.remoteState.remoteAttachedUsers().filter((k) => isGroupKey(k) && personOf(k) === person),
    ];
  }
}
