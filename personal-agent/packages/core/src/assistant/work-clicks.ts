// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Presses on Accept and Stop under a work item's card, and on the board's Accept all and Retry (teams_agent/assistant.py
 * `on_click`, `_retry`, `_accept_all`). Cards are not trusted: a button carries the id of the card this worker recorded, and
 * what it means is read from the record; it must be the presser's and not yet used, and of two presses exactly one goes on.
 * Claw is asked as the presser. Accept is pinned to the version the person saw: a newer one gets a card of its own.
 */
import type { CardClick } from "../approvals/click.js";
import type { Decision, WorkItem } from "../claw/model.js";
import { boardText } from "../locales/assistant-board.js";
import { workClickText } from "../locales/assistant-work-clicks.js";
import type { ClawWorkItemsPort } from "../ports/claw/index.js";
import type { AssistantCard, StorePort } from "../ports/store/index.js";
import type { OutMessage, View } from "../ports/surface.js";
import type { Board } from "./board.js";
import { answerInvalid, refusal, unreachable } from "./failures.js";
import { finish } from "./finish.js";
import { ACCEPT_ALL_MAX, NO_RETRY_SECONDS } from "./board.js";
import { itemLabel, retryable } from "./work-items.js";

export type WorkClickStore = Pick<StorePort, "now" | "assistantCards">;

export interface WorkClickDeps {
  readonly store: WorkClickStore;
  readonly claw: Pick<ClawWorkItemsPort, "get" | "accept" | "stop" | "retry">;
  readonly board: Board;
  /** An item was stopped here: whatever follows its work here ends as stopped. */
  readonly onStopped: (itemId: string) => void;
}

const t = workClickText.in("en");
const b = boardText.in("en");

function view(v: View): OutMessage {
  return { body: { type: "view", view: v, fallbackText: "" } };
}

/** What a refusal from Claw means for a person who pressed a button. */
export function failureText(status: number, code: string): string {
  if (status === 404) return t.notFound;
  if (status === 401 || status === 403) return t.rejected;
  if (status === 503 && code === "interrupt_not_recorded") return t.notStopped;
  return t.couldNot({ status });
}

/** Where an item stands, for a press that arrived too late (or too early) to do what its card offered. */
export function statusText(item: WorkItem): string {
  const label = itemLabel(item);
  if (item.boardState === "done") return t.alreadyClosed({ label, outcome: item.outcome ?? "closed" });
  if (item.canAccept) return t.waitingVersion({ label, version: item.resultVersion });
  if (item.boardState === "needs_you") return t.waitingForYou({ label, question: item.pendingQuestion ?? "" });
  return t.workedOn({ label });
}

export class WorkClicks {
  constructor(private readonly deps: WorkClickDeps) {}

  /** The card is the presser's and open, and this press now holds it ("busy"): of two presses exactly one goes on. */
  private take(card: AssistantCard | null, click: CardClick): card is AssistantCard {
    return (
      card !== null &&
      card.userId === click.sender.id &&
      this.deps.store.assistantCards.moveAssistantCard(card.cardId, "busy", { onlyFrom: "open" })
    );
  }

  private card(click: CardClick): AssistantCard | null {
    const id = click.action.data["card"];
    return this.deps.store.assistantCards.getAssistantCard(typeof id === "string" ? id : "");
  }

  /** Accept or Stop under a work item's card. */
  async acceptOrStop(click: CardClick, key: string, op: "accept" | "stop"): Promise<void> {
    const { store } = this.deps;
    const card = this.card(click);
    if (card === null || card.userId !== click.sender.id || (op === "accept" && !card.canAccept)) {
      await finish(click, b.cardGone);
      return;
    }
    if (card.state === "ended") {
      await finish(click, t.reviewEnded({ how: card.ended ? `（${card.ended}）` : "" }));
      return;
    }
    if (!store.assistantCards.moveAssistantCard(card.cardId, "busy", { onlyFrom: "open" })) {
      await finish(click, b.cardUsed);
      return;
    }
    let decision: Decision;
    try {
      decision =
        op === "accept"
          ? await this.deps.claw.accept(key, card.itemId, card.version)
          : await this.deps.claw.stop(key, card.itemId);
    } catch (error) {
      await this.notDecided(click, card, error);
      return;
    }
    store.assistantCards.moveAssistantCard(card.cardId, "done");
    if (decision.ok && op === "stop") this.deps.onStopped(decision.item.itemId);
    await this.decided(click, op, decision);
  }

  /** Nothing was done: a 404 ends the card; anything else offers it again, as a new message that can be pressed. */
  private async notDecided(click: CardClick, card: AssistantCard, error: unknown): Promise<void> {
    if (!(refusal(error) || unreachable(error))) throw error;
    const refused = refusal(error);
    if (refused?.status === 404) {
      this.deps.store.assistantCards.moveAssistantCard(card.cardId, "done");
      await finish(click, failureText(404, refused.code));
      return;
    }
    const said = refused ? failureText(refused.status, refused.code) : t_unreachable();
    this.deps.store.assistantCards.moveAssistantCard(card.cardId, "open");
    const model = { text: said + b.pressAgain, cardId: card.cardId, version: card.version, canAccept: card.canAccept };
    await finish(click, said + b.tryAgain, view({ name: "workNote", model }));
  }

  private async decided(click: CardClick, op: "accept" | "stop", decision: Decision): Promise<void> {
    const { item, ok, error } = decision;
    const label = itemLabel(item);
    if (await this.reviewOutcome(click, op, decision)) return;
    if (ok) {
      const verb = op === "accept" ? "Accepted" : "Stopped";
      const version = op === "accept" ? item.resultVersion : null;
      await finish(click, view({ name: "workDone", model: { verb, item } }), t.done({ verb, label, version }));
    } else if (error === "version_mismatch") {
      await this.newerVersion(click, item);
    } else {
      await finish(click, statusText(item));
    }
  }

  /** The outcomes of a review's stop, and a merge that cannot be stopped; false when the decision is none of them. */
  private async reviewOutcome(
    click: CardClick,
    op: "accept" | "stop",
    { item, ok, error }: Decision,
  ): Promise<boolean> {
    const label = itemLabel(item);
    const review = op === "stop" && item.kind === "review";
    if (ok && review) {
      await finish(
        click,
        view({ name: "workDone", model: { verb: t.stoppedTitle, item } }),
        t.stoppedReview({ label }),
      );
    } else if (!ok && error === "item_closed" && review) {
      await finish(click, t.reviewEnded({ how: "" }));
    } else if (!ok && (error === "already_merged" || error === "merge_in_progress")) {
      await finish(click, error === "already_merged" ? t.alreadyMerged({ label }) : t.mergeInProgress({ label }));
    } else {
      return false;
    }
    return true;
  }

  /** The result changed after the card was made: nothing was accepted, and a card for the current result is sent. */
  private async newerVersion(click: CardClick, item: WorkItem): Promise<void> {
    const cardId = this.deps.store.assistantCards.addAssistantCard(
      click.sender.id,
      item.itemId,
      item.resultVersion,
      true,
    );
    const note = t.updated({ version: item.resultVersion });
    const card = view({
      name: "workCard",
      model: {
        item,
        text: item.summary,
        cardId,
        note: t.lookAgain({ note }),
        watch: false,
        watching: false,
        lang: null,
      },
    });
    await finish(click, t.updatedCard({ note, version: item.resultVersion }), card);
  }

  /**
   * Retry on the board: the task (failed, or stopped) runs again in its own session; Claw decides whether it may. A stopped task
   * is read first: past RETRY_STOPPED_SECONDS its Retry has expired, as the board would no longer offer it, and Claw is not asked.
   */
  async retry(click: CardClick, key: string): Promise<void> {
    const { store } = this.deps;
    const card = this.card(click);
    if (card === null || card.userId !== click.sender.id) {
      await finish(click, b.cardGone);
      return;
    }
    if (!this.take(card, click)) {
      await finish(click, b.cardUsed);
      return;
    }
    let decision: Decision;
    try {
      const item = await this.deps.claw.get(key, card.itemId);
      if (item.boardState === "done" && item.outcome === "stopped" && !retryable(item, store.now())) {
        await this.retryExpired(click, key, card, item);
        return;
      }
      decision = await this.deps.claw.retry(key, card.itemId);
    } catch (error) {
      await this.retryFailed(click, key, card, error);
      return;
    }
    store.assistantCards.moveAssistantCard(card.cardId, "done");
    const label = itemLabel(decision.item);
    const said = decision.ok
      ? t.retried({ label })
      : decision.error === "too_many_active_items"
        ? t.tooMany({ label })
        : t.notRetryable({ label });
    await finish(click, (await this.deps.board.now(click.sender.id, key)) ?? said, said);
  }

  /** A Retry pressed after the stop it was drawn for has aged past RETRY_STOPPED_SECONDS: the card is done, Claw is not asked. */
  private async retryExpired(click: CardClick, key: string, card: AssistantCard, item: WorkItem): Promise<void> {
    this.deps.store.assistantCards.moveAssistantCard(card.cardId, "done");
    const said = t.stoppedLongAgo({ label: itemLabel(item) });
    await finish(click, (await this.deps.board.now(click.sender.id, key)) ?? said, said);
  }

  private async retryFailed(click: CardClick, key: string, card: AssistantCard, error: unknown): Promise<void> {
    if (!(refusal(error) || unreachable(error) || answerInvalid(error))) throw error;
    const { store } = this.deps;
    const refused = refusal(error);
    if (refused === undefined) {
      store.assistantCards.moveAssistantCard(card.cardId, "open");
      await finish(click, t_unreachable() + b.retryAgain);
      return;
    }
    store.assistantCards.moveAssistantCard(card.cardId, refused.status === 404 ? "done" : "open");
    let said: string;
    if (refused.status === 404 && refused.code !== "not_found") {
      this.deps.board.noRetryUntil = store.now() + NO_RETRY_SECONDS; // (the route is not there, not the item)
      said = t.noRetry;
    } else {
      said = failureText(refused.status, refused.code);
    }
    await finish(click, (await this.deps.board.now(card.userId, key)) ?? said, said);
  }

  /**
   * Accept all on the board: each result it listed, at the version it showed (one card each); a result that changed since, or a
   * card already used, is left for its own card. One line says what was accepted.
   */
  async acceptAll(click: CardClick, key: string): Promise<void> {
    const ids = click.action.data["cards"];
    const cards = (Array.isArray(ids) ? ids : [])
      .slice(0, ACCEPT_ALL_MAX)
      .map((id) => this.deps.store.assistantCards.getAssistantCard(String(id)));
    const mine = cards.filter((c): c is AssistantCard => c !== null && c.userId === click.sender.id && c.canAccept);
    if (!mine.length) {
      await finish(click, b.cardGone);
      return;
    }
    const accepted: string[] = [];
    const left: string[] = [];
    for (const card of mine) {
      if (!this.take(card, click)) continue; // (accepted, or being accepted, by its own card)
      await this.acceptOne(key, card, accepted, left);
    }
    if (!accepted.length && !left.length) {
      await finish(click, b.cardUsed);
      return;
    }
    let said = accepted.length ? t.acceptedAll({ n: accepted.length, labels: accepted.join("；") }) : t.acceptedNone;
    if (left.length) said += t.leftOver({ n: left.length });
    await finish(click, (await this.deps.board.now(click.sender.id, key)) ?? said, said);
  }

  private async acceptOne(key: string, card: AssistantCard, accepted: string[], left: string[]): Promise<void> {
    let decision: Decision;
    try {
      decision = await this.deps.claw.accept(key, card.itemId, card.version);
    } catch (error) {
      if (!(refusal(error) || unreachable(error))) throw error;
      this.deps.store.assistantCards.moveAssistantCard(card.cardId, refusal(error)?.status === 404 ? "done" : "open");
      left.push(card.itemId);
      return;
    }
    this.deps.store.assistantCards.moveAssistantCard(card.cardId, "done");
    (decision.ok ? accepted : left).push(itemLabel(decision.item));
  }
}

function t_unreachable(): string {
  return b.unreachable;
}
