// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Part } from "../capabilities/registry.js";
import type { ConversationRef, InboundAction, InboundEvent, OutMessage } from "../ports/surface.js";
import type { ClickRoute, SettleOptions } from "../ports/routing.js";
import { TaskAdmission } from "./admission.js";
import { Chat, settleClick } from "./chat.js";
import { Credentials } from "./credentials.js";
import type { RouterDeps } from "./deps.js";
import { KeyOwners } from "./identity.js";
import { TurnRegistry } from "./turn-registry.js";
import { CommandViews } from "./views.js";

/** What every part of the router shares: its dependencies and the services built from them, once. */
export class RouterContext {
  readonly turns = new TurnRegistry();
  readonly views: CommandViews;
  readonly credentials: Credentials;
  readonly admission: TaskAdmission;
  readonly owners: KeyOwners;

  constructor(readonly deps: RouterDeps) {
    this.views = new CommandViews(deps.config.botName, deps.config.publicBaseUrl, deps.note);
    this.credentials = new Credentials(deps, this.views);
    this.admission = new TaskAdmission(deps, this.turns);
    this.owners = new KeyOwners(deps.identity);
  }

  /** The parts of the worker that are on: what help offers and what the assistant may be asked for. */
  parts(): ReadonlySet<Part> {
    const { config, github, remote } = this.deps;
    const on: [Part, boolean][] = [
      ["github", github !== undefined],
      ["remote", remote.enabled],
      ["brief", config.briefEnabled],
      ["schedule", config.schedulesEnabled],
      ["watch_job", config.jobWatchEnabled],
    ];
    return new Set(on.filter(([, enabled]) => enabled).map(([part]) => part));
  }

  /** The chat an event is answered in: its conversation, as the person who sent it. */
  chatOf(event: InboundEvent, scope: string): Chat {
    const conversation = this.deps.surface.conversation(event.conversation);
    return new Chat(this.deps.store, event.sender, conversation, scope, event.locale);
  }

  /** A chat in another conversation of the same person (their 1:1 chat, a group a request waited in). */
  chatIn(chat: Chat, ref: ConversationRef, scope = ""): Chat {
    return new Chat(this.deps.store, chat.sender, this.deps.surface.conversation(ref), scope, chat.locale);
  }

  /** A click as a feature handler is given it. */
  clickRoute(action: InboundAction, chat: Chat): ClickRoute {
    return {
      sender: chat.sender,
      conversation: chat.conversation,
      scope: chat.scope,
      lang: () => chat.lang(),
      action,
      settle: (card: OutMessage | string, options?: SettleOptions) => this.settle(action, chat, card, options),
    };
  }

  /** THE way the router ends a click (see `settleClick`). */
  settle(action: InboundAction, chat: Chat, card: OutMessage | string, options?: SettleOptions): Promise<boolean> {
    return settleClick(
      { action, conversation: chat.conversation, note: this.deps.note },
      this.deps.logger,
      card,
      options,
    );
  }

  /** What the turns of stopped work items must know (a review following it ends as stopped, not failed). */
  private readonly stopListeners: ((itemId: string) => void)[] = [];

  /** A work item was stopped from its card or a group's "停 825": the review turn following it ends as stopped. */
  itemStopped(itemId: string): void {
    this.turns.itemStopped(itemId);
    for (const listener of this.stopListeners) listener(itemId);
  }

  /** The review service hears of a stopped item too (`GithubReview.item_stopped`). */
  onItemStopped(listener: (itemId: string) => void): void {
    this.stopListeners.push(listener);
  }

  /** Whether the person's 1:1 chat (or a group of theirs, `scope`) has a turn this worker follows. */
  hasTurn(userId: string, scope = ""): boolean {
    return this.turns.has({ userId, scope, review: "" });
  }
}
