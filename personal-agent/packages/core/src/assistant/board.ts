// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/board` (teams_agent/assistant.py `board`, `_board_card`, `_remote_ask_card`): the person's work items in three sections, the
 * reviews they asked of others beside them, and a card for each item that waits for them (at most BOARD_CARDS). The board's own
 * buttons (Accept all, Retry) carry only card ids recorded first, so a press means what the board showed.
 */
import type { ReviewAskedOfOther, WorkItem } from "../claw/model.js";
import { errorName } from "../errors.js";
import { answerLang } from "../language/detect.js";
import { boardText } from "../locales/assistant-board.js";
import type { ClawWorkItemsPort } from "../ports/claw/index.js";
import type { Logger } from "../ports/logger.js";
import type { StorePort } from "../ports/store/index.js";
import type { Conversation, OutMessage, View } from "../ports/surface.js";
import { zoneOf } from "../proactive/quiet.js";
import { refreshAutoReply } from "./auto-reply.js";
import { clawFailure, refusal } from "./failures.js";
import { BOARD_CARDS, BOARD_RETRY_MAX, retryable } from "./work-items.js";

/** Results one Accept all takes (the board button counts the same ones it carries). */
export const ACCEPT_ALL_MAX = 50;
/** After a Claw without retry said so, the board offers no Retry for this long. */
export const NO_RETRY_SECONDS = 6 * 3600;
const REJECTED =
  "PrimusClaw rejected your linked key (it may have expired or been deleted). Send /unlink, then link again.";

export type BoardStore = Pick<StorePort, "now" | "prefs" | "assistantCards" | "remotePermissions">;

/** The approval card of a request an agent on the person's machine waits on, as the board shows it (W6b's card). */
export type BoardRemoteAsk = (request: {
  readonly ask: Readonly<Record<string, unknown>>;
  readonly options: readonly unknown[];
  readonly sessionId: string;
  readonly machine: string;
  readonly agent: string;
  readonly about: string;
  readonly expiresAt: number;
  readonly zone: string;
  readonly lang: string;
}) => OutMessage;

export interface BoardDeps {
  readonly store: BoardStore;
  readonly claw: Pick<ClawWorkItemsPort, "list" | "askedOfOthers" | "watches">;
  readonly logger: Logger;
  /** The chat talks to the assistant (`AssistantChat.on`). */
  readonly on: (userId: string) => boolean;
  readonly remoteAsk: BoardRemoteAsk;
  /** The locale of the client the message being handled came from ("" none): the language before the person said one. */
  readonly clientLocale?: () => string;
}

function view(v: View): OutMessage {
  return { body: { type: "view", view: v, fallbackText: "" } };
}

function text(said: string): OutMessage {
  return { body: { type: "text", text: said } };
}

export class Board {
  /** Claw answered Retry with a route it does not have (a Claw before retry): no Retry on the board until then. */
  noRetryUntil = 0;

  constructor(private readonly deps: BoardDeps) {}

  private locale(): string {
    return this.deps.clientLocale?.() ?? "";
  }

  /** `/board`: the person's work items, and a card for each one that waits for them. */
  async show(userId: string, key: string, conversation: Conversation): Promise<void> {
    const t = boardText.in("en");
    if (!this.deps.on(userId)) {
      await conversation.send(text(t.notAvailable));
      return;
    }
    let items: WorkItem[];
    try {
      items = await this.deps.claw.list(key);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      const status = refusal(error)?.status;
      await conversation.send(
        text(status === 404 ? t.notAvailable : status === 401 || status === 403 ? REJECTED : t.failed),
      );
      return;
    }
    const asked = await this.askedOfOthers(key);
    if (!items.length && !asked.length) {
      await conversation.send(text(t.empty));
      return;
    }
    await conversation.send(view({ name: "board", model: this.model(userId, items, asked) }));
    await this.waitingCards(userId, key, items, conversation);
  }

  /** The reviews the person asked of others; best effort: the board is shown whatever this answers. */
  private async askedOfOthers(key: string): Promise<ReviewAskedOfOther[]> {
    try {
      return await this.deps.claw.askedOfOthers(key);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      this.deps.logger.info("the reviews asked of others were not read for the board", { error: errorName(error) });
      return [];
    }
  }

  private async waitingCards(
    userId: string,
    key: string,
    items: readonly WorkItem[],
    conversation: Conversation,
  ): Promise<void> {
    const { store } = this.deps;
    const waiting = items.filter((i) => i.boardState === "needs_you");
    for (const item of waiting.slice(0, BOARD_CARDS)) {
      const ask = this.remoteAskCard(userId, item);
      if (ask !== undefined) {
        await conversation.send(ask); // (an agent on their machine waits: its own approval card)
        continue;
      }
      await refreshAutoReply(
        { cards: store.assistantCards, claw: this.deps.claw, logger: this.deps.logger },
        { userId, itemId: item.itemId, key },
      );
      const cardId = store.assistantCards.addAssistantCard(userId, item.itemId, item.resultVersion, item.canAccept);
      const said = item.pendingQuestion ?? item.summary;
      const lang = answerLang(store.prefs.getPrefs(userId).lang, this.locale(), said, item.title);
      const watching = store.assistantCards.autoReply(userId, item.itemId) !== null;
      await conversation.send(
        view({ name: "workCard", model: { item, text: said, cardId, note: "", watch: false, watching, lang } }),
      );
    }
    if (waiting.length > BOARD_CARDS) {
      await conversation.send(text(boardText.in("en").moreWaiting({ n: waiting.length - BOARD_CARDS })));
    }
  }

  /**
   * For a development environment item that waits on the person: the approval card of the first of its requests this chat was
   * shown and that is still open, so the board's "needs you" is answered where it is listed. Undefined: the item's own card.
   */
  private remoteAskCard(userId: string, item: WorkItem): OutMessage | undefined {
    if (item.kind !== "remote") return undefined;
    const { store } = this.deps;
    const sessionId = typeof item.params["session_id"] === "string" ? item.params["session_id"] : "";
    const asked = item.params["waiting"];
    const now = store.now();
    for (const actionId of Array.isArray(asked) && sessionId ? asked : []) {
      const perm = store.remotePermissions.getRemotePermission(sessionId, String(actionId));
      if (perm === null || perm.userId !== userId || perm.state !== "pending" || perm.expiresAt <= now) continue;
      const prefs = store.prefs.getPrefs(userId);
      return this.deps.remoteAsk({
        // (a question a terminal asks is drawn again whole, with its content: never its buttons alone)
        ask: perm.ask ?? { action_id: perm.actionId, tool: perm.tool },
        options: perm.options,
        sessionId,
        machine: typeof item.params["machine"] === "string" ? item.params["machine"] : "",
        agent: typeof item.params["agent_id"] === "string" ? item.params["agent_id"] : "",
        about: `#${String(item.seq)} ${item.title}`,
        expiresAt: perm.expiresAt,
        zone: zoneOf(prefs),
        lang: answerLang(prefs.lang, this.locale(), item.title),
      });
    }
    return undefined;
  }

  /** The board with its own buttons, each button's card recorded first; in the person's language. */
  model(userId: string, items: readonly WorkItem[], asked: readonly ReviewAskedOfOther[]) {
    const { store } = this.deps;
    const lang = answerLang(store.prefs.getPrefs(userId).lang, this.locale(), ...items.slice(0, 5).map((i) => i.title));
    const acceptable = items.filter((i) => i.boardState === "needs_you" && i.canAccept).slice(0, ACCEPT_ALL_MAX);
    const accept =
      acceptable.length > 1
        ? acceptable.map((i) => store.assistantCards.addAssistantCard(userId, i.itemId, i.resultVersion, true))
        : [];
    const now = store.now();
    const offerRetry = now >= this.noRetryUntil;
    const retry = items
      .filter((i) => retryable(i, now) && offerRetry)
      .slice(0, BOARD_RETRY_MAX)
      .map((item) => ({
        cardId: store.assistantCards.addAssistantCard(userId, item.itemId, item.resultVersion, false),
        item,
      }));
    return { items, asked, now, accept, retry, lang };
  }

  /** The board as it is now, to replace the board a press was made on; undefined when it cannot be read. */
  async now(userId: string, key: string): Promise<OutMessage | undefined> {
    let items: WorkItem[];
    let asked: ReviewAskedOfOther[];
    try {
      items = await this.deps.claw.list(key);
      asked = await this.deps.claw.askedOfOthers(key);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      return undefined;
    }
    return items.length || asked.length ? view({ name: "board", model: this.model(userId, items, asked) }) : undefined;
  }
}
