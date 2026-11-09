// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A Stop button of our own for a turn that started from a phone (stop_button.py, internal #458). Teams' own Stop under a
 * streaming reply is greyed out on a phone, so a turn a phone starts in a 1:1 chat gets a small card with one Stop button,
 * sent STOP_CARD_DELAY_SECONDS after the turn starts (a quick answer never shows one). It covers the three kinds of turn a
 * phone starts: a turn on the chat's own session, a message to the person's assistant, a message to an attached agent.
 *
 * A press stops that turn, and only that turn: the card carries a token for the turn it was sent for, and the press is
 * carried out only while that very turn still runs (`Offer.alive`). The card is never edited: when the turn ends it is
 * deleted, and a pressed one is deleted and the outcome said as a new message.
 */

import { errorName } from "../errors.js";
import { toLang, type Lang } from "../locales/lang.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { Random } from "../ports/random.js";
import type { Conversation, OutMessage } from "../ports/surface.js";
import { nowSeconds, sleepSeconds } from "./ports.js";
import { detach } from "./task.js";

/** A turn still running after this gets the card; a quick answer never shows one. */
export const STOP_CARD_DELAY_SECONDS = 4.0;
/** A token is forgotten after this (no turn followed here runs that long). */
export const OFFER_KEEP_SECONDS = 2 * 60 * 60;
/** Tokens kept at most (the oldest go first). */
export const OFFERS_MAX = 2000;
export const STOP_KINDS = ["session", "assistant", "remote"] as const;
export type StopKind = (typeof STOP_KINDS)[number];

/** The Stop card of a turn: the token it carries, in the person's language. */
export interface StopModel {
  readonly token: string;
  readonly lang: Lang;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    turnStop: StopModel;
  }
}

/** One card's Stop: whose it is, which kind of turn, and how to tell that the very turn it was sent for still runs. */
export interface Offer {
  readonly token: string;
  readonly userId: string;
  readonly kind: StopKind;
  /** Given the credential of the press: whether the turn still runs (it may ask Claw, and rejects when it cannot tell). */
  readonly alive: (credential: string) => Promise<boolean>;
  readonly at: number;
  cardId: string | undefined;
  used: boolean;
}

export interface StopButtonsDeps {
  readonly clock: Clock;
  readonly random: Random;
  readonly log: Logger;
  readonly delaySeconds?: number;
}

/** Python's `secrets.token_urlsafe(12)`: 12 random bytes as unpadded base64url (16 characters). */
function tokenOf(random: Random): string {
  const bytes = random.bytes(12);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The card as a message; a client that cannot draw it shows its words. */
export function stopMessage(token: string, lang: string): OutMessage {
  const model: StopModel = { token, lang: toLang(lang === "zh" ? "zh" : "en") };
  return { body: { type: "view", view: { name: "turnStop", model }, fallbackText: "Stop" } };
}

export class StopButtons {
  private readonly offers = new Map<string, Offer>();
  private readonly showing = new Set<Promise<unknown>>();

  constructor(private readonly deps: StopButtonsDeps) {}

  /**
   * Sends the card for a turn that has just started, once it has run the delay (`ended` not settled by then), and deletes
   * it when `ended` settles. Returns at once.
   */
  offer(
    userId: string,
    kind: StopKind,
    conversation: Pick<Conversation, "post" | "delete">,
    lang: string,
    alive: (credential: string) => Promise<boolean>,
    ended: Promise<unknown>,
  ): Offer {
    this.prune();
    const offer: Offer = {
      token: tokenOf(this.deps.random),
      userId,
      kind,
      alive,
      at: nowSeconds(this.deps.clock),
      cardId: undefined,
      used: false,
    };
    const task = detach((signal) => this.show(offer, conversation, lang, ended, signal));
    const done = task.settled();
    this.showing.add(done);
    void done.then(() => this.showing.delete(done));
    return offer;
  }

  private async show(
    offer: Offer,
    conversation: Pick<Conversation, "post" | "delete">,
    lang: string,
    ended: Promise<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const over = ended.then(
      () => "ended" as const,
      () => "ended" as const,
    );
    const wait = new AbortController();
    const delay = sleepSeconds(this.deps.clock, this.deps.delaySeconds ?? STOP_CARD_DELAY_SECONDS, wait.signal).then(
      () => "delay" as const,
      () => "ended" as const,
    );
    const first = await Promise.race([over, delay]);
    wait.abort();
    if (first === "ended" || signal.aborted) return;
    this.offers.set(offer.token, offer); // (before the card goes out: a press may come before `post` returns)
    try {
      offer.cardId = await conversation.post(stopMessage(offer.token, lang));
    } catch (err) {
      this.deps.log.warn("the Stop card of a turn from a phone could not be sent", { error: errorName(err) });
      return;
    }
    this.deps.log.info("stop card sent for a turn from a phone", { kind: offer.kind });
    await this.untilEndedOrForgotten(over);
    if (offer.cardId && !offer.used) await this.remove(conversation, offer.cardId); // (a press takes a pressed card away)
  }

  /** Until the turn ends, or the token is forgotten anyway. */
  private async untilEndedOrForgotten(over: Promise<unknown>): Promise<void> {
    const keep = new AbortController();
    const forgotten = sleepSeconds(this.deps.clock, OFFER_KEEP_SECONDS, keep.signal).catch(() => undefined);
    await Promise.race([over, forgotten]);
    keep.abort();
  }

  private async remove(conversation: Pick<Conversation, "delete">, cardId: string): Promise<void> {
    try {
      const removed = await conversation.delete(cardId);
      if (!removed.ok)
        this.deps.log.info("the Stop card of an ended turn could not be deleted", { reason: removed.error.kind });
    } catch (err) {
      // (its press still stops nothing once the turn is over)
      this.deps.log.info("the Stop card of an ended turn could not be deleted", { error: errorName(err) });
    }
  }

  /** The offer of a card this person pressed; undefined for a token that is unknown, forgotten, or someone else's. */
  get(token: string, userId: string): Offer | undefined {
    const offer = this.offers.get(token);
    if (!offer || offer.userId !== userId || nowSeconds(this.deps.clock) - offer.at > OFFER_KEEP_SECONDS)
      return undefined;
    return offer;
  }

  private prune(): void {
    const now = nowSeconds(this.deps.clock);
    for (const [token, offer] of this.offers) if (now - offer.at > OFFER_KEEP_SECONDS) this.offers.delete(token);
    while (this.offers.size >= OFFERS_MAX) {
      const oldest = this.offers.keys().next().value;
      if (oldest === undefined) break;
      this.offers.delete(oldest);
    }
  }

  /** Wait for every card being shown (tests). */
  async drain(): Promise<void> {
    while (this.showing.size) await Promise.all([...this.showing]);
  }
}
