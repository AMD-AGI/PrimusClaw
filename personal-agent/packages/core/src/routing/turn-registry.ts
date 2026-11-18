// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turns this worker follows, per chat (the Python `Agent._turns`, `ActiveTurn`, `_queue_behind`, `_drop_turn`,
 * `_item_stopped`). A chat has the turn Claw runs and up to `QUEUED_TURNS_MAX` queued behind it, in the order they were sent; a
 * review for a colleague is kept under a key of its own per pull request, so it neither waits for nor blocks the asker's chat turn.
 */

import type { Clock } from "../ports/clock.js";

/** The messages that may wait behind a chat's running turn (as many as an attached agent's chat queues). */
export const QUEUED_TURNS_MAX = 5;

/** A signal that is set once: what a message queued behind a turn waits for. */
export class Latch {
  private done = false;
  private readonly waiters: (() => void)[] = [];

  get isSet(): boolean {
    return this.done;
  }

  set(): void {
    if (this.done) return;
    this.done = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Settles once it is set. */
  whenSet(): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** True when it was set within `ms` of `clock`, false when the wait ran out. */
  wait(ms: number, clock: Clock): Promise<boolean> {
    if (this.done) return Promise.resolve(true);
    const timer = new AbortController();
    return new Promise<boolean>((resolve) => {
      this.waiters.push(() => {
        timer.abort();
        resolve(true);
      });
      clock.sleep(ms, timer.signal).then(
        () => {
          resolve(this.done);
        },
        () => undefined, // (aborted: the latch was set and has resolved)
      );
    });
  }
}

export class ActiveTurn {
  stopRequested = false;
  /** The person pressed Deny on one of this turn's approval cards. */
  toolDenied = false;
  /** Claw took this turn's stop (its item's, or the interrupt): its failed end is the stop, not an error. */
  stopConfirmed = false;
  /**
   * Set once Claw took the interrupt of this turn (`/stop`): a message queued behind it need not wait for its end, which a turn
   * stopped before Claw ran it may never report.
   */
  readonly stopped = new Latch();
  /** The turn went to Claw (a queued one once the turns in front of it were over or stopped): `/stop` no longer withdraws it. */
  launched = false;
  /** Set once Claw runs the turn's message, or the turn is over: a message sent behind it may go then. */
  readonly running = new Latch();
  /** Set once the turn is over (or never started, or was given up while it waited): the turn behind it may go then. */
  readonly ended = new Latch();
  /** The turn is over (or never started). */
  over = false;

  constructor(
    /** A review for a colleague: its own session, so nothing is queued behind it. */
    readonly review = false,
    /** A review that is a work item of Claw's: a Stop on its card is this turn's stop as well. */
    readonly itemId = "",
  ) {}
}

/** What a turn is kept under: a person and a chat ("" the 1:1 chat), and for a review the item or the pull request. */
export interface TurnKey {
  readonly userId: string;
  readonly scope: string;
  /** For a review: "review:<item id>" or "review:<pull request>"; "" for a chat turn. */
  readonly review: string;
}

function keyOf(key: TurnKey): string {
  return JSON.stringify([key.userId, key.scope, key.review]);
}

export type QueueRefusal = "still_working" | "queue_full";

export class TurnRegistry {
  private readonly turns = new Map<string, { readonly key: TurnKey; readonly turns: ActiveTurn[] }>();

  /** The chat's turns, oldest first: the one Claw runs, then those queued behind it. */
  of(key: TurnKey): readonly ActiveTurn[] {
    return this.turns.get(keyOf(key))?.turns ?? [];
  }

  has(key: TurnKey): boolean {
    return this.turns.has(keyOf(key));
  }

  /** Registers `turn` as the first of a chat that has none; false when the chat has one. */
  claim(key: TurnKey, turn: ActiveTurn): boolean {
    if (this.has(key)) return false;
    this.turns.set(keyOf(key), { key, turns: [turn] });
    return true;
  }

  /**
   * `turn` behind the chat's running one: refused when a review is either of them, or when `QUEUED_TURNS_MAX` already wait (not
   * gone to Claw yet). Otherwise it is registered last, with its place among those that wait (`waiting`: 1 is the next to go;
   * 0 when it is the chat's first turn and runs at once).
   */
  enqueue(key: TurnKey, turn: ActiveTurn): { readonly front: ActiveTurn; readonly waiting: number } | QueueRefusal {
    const entry = this.turns.get(keyOf(key));
    const front = entry?.turns[0];
    if (entry === undefined || front === undefined) {
      this.turns.set(keyOf(key), { key, turns: [turn] });
      return { front: turn, waiting: 0 };
    }
    if (turn.review || front.review) return "still_working";
    const waiting = entry.turns.filter((t) => !t.launched).length;
    if (waiting >= QUEUED_TURNS_MAX) return "queue_full";
    entry.turns.push(turn);
    return { front, waiting: waiting + 1 };
  }

  /** Every turn queued behind the chat's running one that has not gone to Claw yet is given up (`/stop`); how many there were. */
  withdrawQueued(key: TurnKey): number {
    const queued = this.of(key).filter((turn, at) => at > 0 && !turn.launched);
    for (const turn of queued) this.drop(key, turn);
    return queued.length;
  }

  /** The turn is over (or never started): whatever waits behind it may go, and the chat no longer holds it. */
  drop(key: TurnKey, turn: ActiveTurn): void {
    turn.running.set();
    turn.over = true;
    turn.ended.set();
    const entry = this.turns.get(keyOf(key));
    if (entry === undefined) return;
    const at = entry.turns.indexOf(turn);
    if (at >= 0) entry.turns.splice(at, 1);
    if (entry.turns.length === 0) this.turns.delete(keyOf(key));
  }

  /** A work item was stopped from its card: the review turn that follows it ends as stopped, not as a task that failed. */
  itemStopped(itemId: string): void {
    if (!itemId) return;
    for (const entry of this.turns.values()) {
      for (const turn of entry.turns) {
        if (turn.itemId === itemId) {
          turn.stopRequested = true;
          turn.stopConfirmed = true;
        }
      }
    }
  }

  /** The person's turns, one per chat and one per review (what counts against their task limit). */
  countFor(userId: string): number {
    let count = 0;
    for (const entry of this.turns.values()) if (entry.key.userId === userId) count += 1;
    return count;
  }

  /** The review work items the person's turns follow (the board must not count them a second time). */
  reviewItemsOf(userId: string): Set<string> {
    const items = new Set<string>();
    for (const entry of this.turns.values()) {
      if (entry.key.userId === userId && entry.key.review.startsWith("item:")) items.add(entry.key.review.slice(5));
    }
    return items;
  }

  get size(): number {
    return this.turns.size;
  }
}

/** The key of a person's chat turn. */
export function chatTurnKey(userId: string, scope = ""): TurnKey {
  return { userId, scope, review: "" };
}

/** The key of a review turn: its item when Claw made one (one open review per pull request), else the pull request. */
export function reviewTurnKey(userId: string, scope: string, itemId: string, pull: string): TurnKey {
  return { userId, scope, review: itemId ? `item:${itemId}` : `pull:${pull.toLowerCase()}` };
}
