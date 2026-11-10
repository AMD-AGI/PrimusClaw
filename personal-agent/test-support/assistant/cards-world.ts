// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Python tests' `assistant_world` for the assistant's cards and its board, without the router (W4): a real store, the
 * work-items Claw of `board-claw.ts`, the say planner and the proactive delivery that send a result's card, `/board`, and the
 * presses on the cards, wired as the worker wires them. What the router does around a press is done here as it does it: the
 * presser's linked key is read, and `settle` replaces the pressed card (an "update" of `card-1`) and says the outcome as a new
 * message. A test that reads the cards themselves gives `render` (the Teams renderers); core's tests read the views.
 */
import type { JsonObject, OutMessage, View } from "@primusclaw/personal-agent";
import { own } from "@primusclaw/personal-agent";

import { FakeClock } from "../clock.js";
import { advanceSeconds, openTestStore } from "../store.js";
import type { Recorded } from "../surface.js";
import { world as proactiveWorld } from "./proactive-world.js";
import { FakeBoardClaw } from "./board-claw.js";
import { Board, type BoardRemoteAsk } from "../../packages/core/src/assistant/board.js";
import { SayPlanner } from "../../packages/core/src/assistant/say.js";
import { WatchClicks } from "../../packages/core/src/assistant/watch-clicks.js";
import { WorkClicks } from "../../packages/core/src/assistant/work-clicks.js";
import { WorkCardClicks } from "../../packages/core/src/assistant/work-handler.js";
import { silentLogger } from "../../packages/core/src/ports/logger.js";
import type { ClickRoute, SettleOptions } from "../../packages/core/src/ports/routing.js";
import type { AssistantCardRepository } from "../../packages/core/src/ports/store/index.js";
import type { Conversation } from "../../packages/core/src/ports/surface.js";
import { noTokenExchange, type TokenExchange } from "../../packages/core/src/plugins/token-exchange.js";

export const ALICE = "aad-a";
export const BOB = "aad-b";
export const KEY_OF: Readonly<Record<string, string>> = { [ALICE]: "ak-alice", [BOB]: "ak-bob" };
/** 2026-10-30 04:53 UTC: midday in Shanghai, no quiet hours. */
export const NOON = 1_761_800_000;

/** One message that reached a chat, or an edit of one (`update` of the pressed card). */
export interface Out {
  readonly op: "send" | "update";
  readonly message: OutMessage;
  /** The message an update replaced. */
  readonly id: string;
  readonly conversation: string;
}

export interface CardsWorldOptions {
  /** The chat talks to the assistant (default yes). */
  readonly assistant?: boolean;
  readonly exchange?: TokenExchange;
  /** Alice is linked before the test starts (default yes). */
  readonly link?: boolean;
  /** The Teams card a message shows (an update with words: the note card that replaces the pressed one); undefined: none. */
  readonly render?: (message: OutMessage, op: Out["op"]) => JsonObject | undefined;
}

/** The record of the assistant's cards, counting what was added (the Python tests' `SELECT COUNT(*) FROM assistant_cards`). */
function counting(repo: AssistantCardRepository): AssistantCardRepository & { added: number } {
  const counted = {
    added: 0,
    addAssistantCard: (userId: string, itemId: string, version: number, canAccept: boolean) => {
      counted.added += 1;
      return repo.addAssistantCard(userId, itemId, version, canAccept);
    },
    getAssistantCard: repo.getAssistantCard.bind(repo),
    endAssistantCard: repo.endAssistantCard.bind(repo),
    placeAssistantCard: repo.placeAssistantCard.bind(repo),
    placedAssistantCards: repo.placedAssistantCards.bind(repo),
    moveAssistantCard: repo.moveAssistantCard.bind(repo),
    setAutoReply: repo.setAutoReply.bind(repo),
    autoReply: repo.autoReply.bind(repo),
    clearAutoReply: repo.clearAutoReply.bind(repo),
  };
  return counted;
}

function words(message: OutMessage): string {
  const body = message.body;
  if (body.type === "text") return body.text;
  if (body.type === "rich") return body.markdown;
  // (without the Teams renderers: the view's name, and the words of its model when it holds some)
  const model = body.view.model as unknown as Readonly<Record<string, unknown>>;
  return typeof model["text"] === "string" && model["text"]
    ? `view:${body.view.name} ${model["text"]}`
    : `view:${body.view.name}`;
}

export class CardsWorld {
  readonly clock = new FakeClock(NOON * 1000);
  readonly store = openTestStore({ clock: this.clock }).store;
  readonly server = new FakeBoardClaw();
  readonly cardsRepo = counting(this.store.assistantCards);
  /** The client locale of the message being handled ("" none). */
  locale = "";
  /** The requests the board put to the person as a remote agent's approval card. */
  readonly asks: Parameters<BoardRemoteAsk>[0][] = [];
  readonly stopped: string[] = [];
  assistant: boolean;
  readonly say: SayPlanner;
  readonly board: Board;
  readonly handler: WorkCardClicks;
  readonly proactive;
  readonly surface;
  private clicks = 0;

  constructor(private readonly options: CardsWorldOptions = {}) {
    this.assistant = options.assistant ?? true;
    const { store, server, cardsRepo } = this;
    const exchange = options.exchange ?? noTokenExchange;
    const locale = () => this.locale;
    this.say = new SayPlanner({
      store: { prefs: store.prefs, assistantCards: cardsRepo, assistantButtons: store.assistantButtons },
      exactCommand: () => false,
      style: () => ({ citations: true, suggestedReplies: true }),
      clientLocale: locale,
    });
    const now = () => store.now();
    this.board = new Board({
      store: { now, prefs: store.prefs, assistantCards: cardsRepo, remotePermissions: store.remotePermissions },
      claw: server,
      logger: silentLogger,
      on: () => this.assistant,
      remoteAsk: (request) => {
        this.asks.push(request);
        return { body: { type: "text", text: `ask ${request.sessionId} ${String(request.ask["action_id"])}` } };
      },
      clientLocale: locale,
    });
    const work = new WorkClicks({
      store: { now, assistantCards: cardsRepo },
      claw: server,
      board: this.board,
      onStopped: (id) => this.stopped.push(id),
    });
    const watch = new WatchClicks({
      store: { assistantCards: cardsRepo },
      claw: server,
      exchange,
      logger: silentLogger,
    });
    this.handler = new WorkCardClicks(work, watch, exchange, (u) => store.links.getKey(u) !== null, silentLogger);
    const p = proactiveWorld({ on: { store, clock: this.clock }, claw: server, say: this.say });
    this.proactive = p.proactive;
    this.surface = p.surface;
  }

  static start(options: CardsWorldOptions = {}): CardsWorld {
    const w = new CardsWorld(options);
    if (options.link ?? true) w.link(ALICE);
    return w;
  }

  /** The person is linked with their key, their Claw user id recorded, and a place to post to saved. */
  link(userId: string): void {
    const key = own(KEY_OF, userId) ?? `ak-${userId}`;
    this.store.links.redeemPending(userId, userId, this.store.links.stashPending(key));
    this.store.links.setClawUserId(userId, `u-${key.slice(3)}`);
    this.store.references.saveReference(userId, {
      serviceUrl: "https://smba.test/",
      conversation: { id: `c-${userId}` },
      bot: { id: "28:bot" },
    });
  }

  conversation(userId = ALICE): Conversation {
    const id = `c-${userId}`;
    return this.surface.conversation({ id, kind: "personal", tenantId: "", wire: { conversation: { id } } });
  }

  /** Deliver an event the way the /claw-events endpoint does: what the proactive policy decided. */
  push(event: JsonObject, userId = ALICE): Promise<string> {
    return this.proactive.handle(userId, this.store.references.getReference(userId) ?? {}, event);
  }

  /** `/board` from the person (the router hands it over with their linked key). */
  showBoard(userId = ALICE): Promise<void> {
    return this.board.show(userId, this.store.links.getKey(userId) ?? "", this.conversation(userId));
  }

  /** A press on a card (Teams' `card-1` unless said) carrying `data`, as the router hands it over. */
  async click(data: JsonObject, o: { user?: string; cardId?: string } = {}): Promise<void> {
    const user = o.user ?? ALICE;
    const conversation = this.conversation(user);
    const cardId = o.cardId ?? "card-1";
    this.clicks += 1;
    const record = (entry: Recorded) => {
      this.surface.record(entry);
    };
    const route = {
      sender: { id: user, name: "", email: "", channelUserId: `29:${user}` },
      conversation,
      scope: "",
      action: { type: "action", id: `click-${String(this.clicks)}`, verb: "", data, cardMessageId: cardId },
      lang: () => "en" as const,
      settle: (card: OutMessage | string, options: SettleOptions = {}) => {
        const message: OutMessage = typeof card === "string" ? { body: { type: "text", text: card } } : card;
        record({ op: "update", conversation: conversation.ref.id, id: cardId, message });
        const line = options.fallback ?? (typeof card === "string" ? card : undefined);
        if (options.announce !== false && line !== undefined) {
          record({ op: "send", conversation: conversation.ref.id, message: { body: { type: "text", text: line } } });
        }
        return Promise.resolve(true);
      },
    } as unknown as ClickRoute;
    const key = this.store.links.getKey(user);
    if (key === null) await this.handler.beforeCredential(route);
    else await this.handler.withCredential(route, key);
  }

  /** The messages and edits that reached the chats, in order. */
  sent(): Out[] {
    return this.surface.outbox.flatMap((r: Recorded): Out[] => {
      if (r.op === "send" || r.op === "post")
        return [{ op: "send", message: r.message, id: "", conversation: r.conversation }];
      if (r.op === "update") return [{ op: "update", message: r.message, id: r.id, conversation: r.conversation }];
      return [];
    });
  }

  /** What was sent from `mark` on. */
  since(mark: number): Out[] {
    return this.sent().slice(mark);
  }

  mark(): number {
    return this.sent().length;
  }

  /** Every view sent or edited in, in order. */
  views(): View[] {
    return this.sent().flatMap((o) => (o.message.body.type === "view" ? [o.message.body.view] : []));
  }

  /** The texts of the messages sent (not their cards). */
  texts(): string[] {
    return this.sent().flatMap((o) => (o.op === "send" && o.message.body.type !== "view" ? [words(o.message)] : []));
  }

  /** What the person was left reading, one entry per message sent or edited: its text, or its card's words (`render`). */
  said(): string[] {
    return this.sent().map((o) => {
      const card = this.options.render?.(o.message, o.op);
      return card === undefined ? words(o.message) : cardWords(card);
    });
  }

  /** Every Teams card sent or edited in, as its content, in order (needs `render`). */
  cards(): JsonObject[] {
    return this.sent().flatMap((o) => {
      const card = this.options.render?.(o.message, o.op);
      return card === undefined ? [] : [card];
    });
  }

  lastCard(): JsonObject {
    const card = this.cards().at(-1);
    if (card === undefined) throw new RangeError("no card was sent");
    return card;
  }

  /** The Execute buttons of `card` (default: the last one). */
  buttons(card?: JsonObject): JsonObject[] {
    const actions = (card ?? this.lastCard())["actions"];
    return (Array.isArray(actions) ? (actions as JsonObject[]) : []).filter((a) => a["type"] === "Action.Execute");
  }

  /** Move the clock on (`clock.now += seconds`). */
  advance(seconds: number): void {
    advanceSeconds(this.clock, seconds);
  }

  /** The words of a Claw call that reached the item routes (method and path), in order. */
  calledPaths(): string[] {
    return this.server.calls.map(([method, path]) => `${method} ${path}`);
  }
}

const BAR = "┃";

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The words of a card's blocks, in order (the Python FakeOutbox._words): facts as "title: value", not the header's bar. */
export function blockWords(blocks: unknown): string[] {
  const out: string[] = [];
  for (const block of Array.isArray(blocks) ? (blocks as JsonObject[]) : []) {
    const text = block["text"];
    if (text !== BAR && typeof text === "string") out.push(text);
    for (const fact of Array.isArray(block["facts"]) ? (block["facts"] as JsonObject[]) : []) {
      out.push(`${textOf(fact["title"])}: ${textOf(fact["value"])}`);
    }
    out.push(...blockWords(block["items"]));
    for (const column of Array.isArray(block["columns"]) ? (block["columns"] as JsonObject[]) : []) {
      out.push(...blockWords(column["items"]));
    }
  }
  return out;
}

/** A card's words joined (activity text first when the message has some). */
export function cardWords(card: JsonObject): string {
  return blockWords(card["body"])
    .filter((w) => w)
    .join(" ");
}
