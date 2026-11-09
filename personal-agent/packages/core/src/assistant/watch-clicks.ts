// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * "Auto-reply to PR comments" and "Turn off auto-reply" under a task's card (teams_agent/assistant.py `_watch`, `_unwatch`).
 *
 * Turning it on watches the pull request the item's worker reported (Claw's own record, never a link the card's words name) with
 * replies allowed, asked as the person signed in (their exchanged token: Claw takes `reply` from nobody else). Turning it off
 * stops every pull request the item watches, asked with the linked key (taking away needs only ownership). The card is put back
 * as it was, and the outcome is said.
 */
import type { CardClick } from "../approvals/click.js";
import type { WorkItem } from "../claw/model.js";
import { errorName } from "../errors.js";
import { boardText } from "../locales/assistant-board.js";
import { workClickText } from "../locales/work-clicks.js";
import type { ClawWorkItemsPort } from "../ports/claw/index.js";
import type { Logger } from "../ports/logger.js";
import type { AssistantCard, StorePort } from "../ports/store/index.js";
import type { OutMessage, View } from "../ports/surface.js";
import type { TokenExchange } from "../plugins/token-exchange.js";
import { answersUnasked } from "./auto-reply.js";
import { shortPull } from "./events.js";
import { clawFailure, refusal, unreachable } from "./failures.js";
import { finish } from "./finish.js";
import { failureText } from "./work-clicks.js";
import { itemLabel } from "./work-items.js";

export interface WatchClickDeps {
  readonly store: Pick<StorePort, "assistantCards">;
  readonly claw: Pick<ClawWorkItemsPort, "pulls" | "watches" | "watchPull" | "unwatchPull">;
  /** The identity service's token exchange; disabled: answering on GitHub for the person is not offered. */
  readonly exchange: TokenExchange;
  readonly logger: Logger;
}

const t = workClickText.in("en");
const b = boardText.in("en");

function view(v: View): OutMessage {
  return { body: { type: "view", view: v, fallbackText: "" } };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export class WatchClicks {
  constructor(private readonly deps: WatchClickDeps) {}

  private card(click: CardClick): AssistantCard | undefined {
    const id = click.action.data["card"];
    const card = this.deps.store.assistantCards.getAssistantCard(typeof id === "string" ? id : "");
    return card !== null && card.userId === click.sender.id ? card : undefined;
  }

  /** The card again (when it is still open and the item still waits) with what was said under it, else the words alone. */
  private async putBack(click: CardClick, card: AssistantCard, item: WorkItem, said: string, flags: { watching?: boolean; watch?: boolean }) {
    const again = card.state === "open" && item.boardState === "needs_you";
    const model = {
      item,
      text: item.pendingQuestion ?? item.summary,
      cardId: card.cardId,
      note: said,
      watch: flags.watch ?? false,
      watching: flags.watching ?? false,
      lang: null,
    };
    await finish(click, again ? view({ name: "workCard", model }) : said, said);
  }

  async watch(click: CardClick, key: string): Promise<void> {
    const card = this.card(click);
    if (card === undefined) {
      await finish(click, b.cardGone);
      return;
    }
    let found: { item: WorkItem; pulls: string[] };
    try {
      found = await this.deps.claw.pulls(key, card.itemId);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      const refused = refusal(error);
      await finish(click, refused ? failureText(refused.status, refused.code) : b.unreachable);
      return;
    }
    const { item, pulls } = found;
    const [pull] = pulls;
    const outcome = pull === undefined ? { said: t.noPull({ label: itemLabel(item) }), watching: false } : await this.turnOn(click, key, item, pull);
    await this.putBack(click, card, item, outcome.said, { watching: outcome.watching });
  }

  private async turnOn(click: CardClick, key: string, item: WorkItem, pull: string): Promise<{ said: string; watching: boolean }> {
    const token = await this.token(click.sender.id);
    if (token === undefined) return { said: t.watchNeedsSignIn, watching: false };
    // (whether it was on already: Claw's answer to the press does not tell an upgrade of the watch from one that was on)
    const already = await this.wasOn(key, item.itemId, pull);
    const label = itemLabel(item);
    try {
      await this.deps.claw.watchPull(token, item.itemId, pull, true);
    } catch (error) {
      if (!(refusal(error) || unreachable(error))) throw error;
      const refused = refusal(error);
      if (refused === undefined) return { said: b.unreachable, watching: false };
      const refusedText =
        refused.status === 409 ? t.watchRefused409({ label }) : refused.status === 404 ? t.watchRefused404 : refused.status === 403 ? t.watchRefused403 : failureText(refused.status, refused.code);
      return { said: refusedText, watching: false };
    }
    this.deps.store.assistantCards.setAutoReply(click.sender.id, item.itemId, pull);
    const said = already ? t.watchingAlready({ pull, short: shortPull(pull) }) : t.watching({ pull, label, short: shortPull(pull) });
    return { said, watching: true };
  }

  /** The person's exchanged token; undefined when they are not connected through the identity service. */
  private async token(userId: string): Promise<string | undefined> {
    if (!this.deps.exchange.enabled) return undefined;
    const token = await this.deps.exchange.tokenFor(userId);
    if (token.ok) return token.value;
    this.deps.logger.info("no exchanged token to watch a pull request with", { kind: token.error.kind });
    return undefined;
  }

  /** Whether the item already answers new comments on `pull` unasked; false when Claw cannot be read. */
  private async wasOn(key: string, itemId: string, pull: string): Promise<boolean> {
    let watches: readonly Readonly<Record<string, unknown>>[];
    try {
      watches = await this.deps.claw.watches(key, itemId);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      return false;
    }
    const same = pull.replace(/\/+$/, "").toLowerCase();
    return watches.some((w) => answersUnasked(w) && str(w["url"]).replace(/\/+$/, "").toLowerCase() === same);
  }

  async unwatch(click: CardClick, key: string): Promise<void> {
    const card = this.card(click);
    if (card === undefined) {
      await finish(click, b.cardGone);
      return;
    }
    let item: WorkItem;
    let subs: Readonly<Record<string, unknown>>[];
    try {
      item = (await this.deps.claw.pulls(key, card.itemId)).item;
      subs = (await this.deps.claw.watches(key, card.itemId)).filter((s) => s["state"] === "active");
      for (const sub of subs) await this.deps.claw.unwatchPull(key, card.itemId, str(sub["sub_id"]));
    } catch (error) {
      if (!clawFailure(error)) throw error;
      const refused = refusal(error);
      this.deps.logger.info("the automatic replies could not be turned off", { error: errorName(error) });
      await finish(click, refused ? failureText(refused.status, refused.code) : b.unreachable);
      return;
    }
    this.deps.store.assistantCards.clearAutoReply(click.sender.id, card.itemId);
    const label = itemLabel(item);
    const pulls = subs.map((s) => str(s["url"]) || str(s["pr"])).join(", ");
    const said = subs.length ? t.unwatched({ label, pull: pulls }) : t.unwatchedAlready({ label });
    await this.putBack(click, card, item, said, { watch: subs.length > 0 });
  }
}
