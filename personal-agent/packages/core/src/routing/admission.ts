// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import type { Chat } from "./chat.js";
import type { RouterDeps } from "./deps.js";
import { KeyedLock } from "./lock.js";
import type { TurnRegistry } from "./turn-registry.js";

type AdmissionDeps = Pick<
  RouterDeps,
  "limits" | "claw" | "clock" | "logger" | "metrics" | "securityEvent" | "assistant" | "remote"
>;

/** A message to the assistant that may still start a work item: until when it holds a slot, and the board it saw. */
interface Pending {
  readonly until: number;
  readonly seen: ReadonlySet<string>;
}

/**
 * The task slots one review request was given: `granted` pull requests may start, `running` is what the person had when
 * they asked. A slot is let go when its review turn is kept (it counts as a turn from then on) or when the request is
 * over; `itemIds` are the work items Claw made for them, which the person's board shows too.
 */
export class ReviewSlots {
  left: number;
  readonly itemIds = new Set<string>();

  constructor(
    private readonly onRelease: (slots: ReviewSlots) => void,
    readonly userId: string,
    readonly granted: number,
    readonly running: number,
    readonly limit: number,
  ) {
    this.left = granted;
  }

  /** One admitted review was handed to its turn (kept as a turn, or not started at all): its slot is let go. */
  followed(itemId = ""): void {
    this.left = Math.max(0, this.left - 1);
    this.itemIds.delete(itemId);
    if (this.left === 0) this.release();
  }

  release(): void {
    this.left = 0;
    this.itemIds.clear();
    this.onRelease(this);
  }
}

/**
 * The per-person limit on tasks running at the same time (the Python `Agent._running_tasks`, `_count_tasks`,
 * `_board_count`, `_over_task_limit`, `_admit_reviews`, `_assistant_over_limit`). A task is a chat turn this worker runs,
 * the attached remote agent's turn, a review admitted or followed, and a work item of the person's assistant in progress
 * (read from their board, which Claw keeps). What a check admits is registered before the person's lock is let go, so two
 * messages in two chats cannot both take the last slot.
 */
export class TaskAdmission {
  private readonly pending = new Map<string, Pending[]>();
  private readonly boardSeen = new Map<string, ReadonlySet<string>>();
  private readonly boardTaken = new Map<string, Set<string>>();
  private readonly reserved = new Map<string, number>();
  private readonly reviewSlots = new Map<string, ReviewSlots[]>();
  readonly lock = new KeyedLock();

  constructor(
    private readonly deps: AdmissionDeps,
    private readonly turns: TurnRegistry,
  ) {}

  private now(): number {
    return this.deps.clock.monotonicMs() / 1000;
  }

  /** The person's tasks this worker knows of (the board's are added by `count`). */
  running(userId: string): number {
    let slots = 0;
    for (const held of this.reviewSlots.get(userId) ?? []) slots += held.left;
    return (
      this.turns.countFor(userId) +
      (this.deps.remote.running(userId) ? 1 : 0) +
      (this.reserved.get(userId) ?? 0) +
      slots +
      this.handoffsPending(userId)
    );
  }

  /** The person's messages to the assistant still holding a slot; the expired ones are let go. */
  handoffsPending(userId: string): number {
    const held = this.pending.get(userId);
    if (held === undefined) return 0;
    const now = this.now();
    const kept = held.filter((entry) => now < entry.until);
    if (kept.length === 0) this.pending.delete(userId);
    else this.pending.set(userId, kept);
    return kept.length;
  }

  /** The last message to the assistant was not the assistant's after all (or never reached it): its slot is let go. */
  dropLastHandoff(userId: string): void {
    const held = this.pending.get(userId);
    if (held === undefined) return;
    held.pop();
    if (held.length === 0) this.pending.delete(userId);
  }

  /** The person's tasks running now; the board is read only when that leaves room or a message holds a slot. */
  async count(userId: string, boardKey: string): Promise<number> {
    const running = this.running(userId);
    if (running < this.deps.limits.maxConcurrentTasks || this.pending.has(userId)) {
      const board = await this.boardCount(userId, boardKey);
      return this.running(userId) + board;
    }
    return running;
  }

  /** The review work items the worker counts itself: the board must not count them a second time. */
  private counted(userId: string): Set<string> {
    const ids = this.turns.reviewItemsOf(userId);
    for (const slots of this.reviewSlots.get(userId) ?? []) for (const id of slots.itemIds) ids.add(id);
    return ids;
  }

  private async readBoard(userId: string, key: string): Promise<ReadonlySet<string> | undefined> {
    if (!key || !(this.deps.assistant.on(userId) || this.deps.assistant.understands(userId))) return undefined;
    try {
      const items = await this.deps.claw.workItems.list(key, "in_progress");
      return new Set(items.map((item) => item.itemId));
    } catch (error) {
      this.deps.logger.info("the assistant's board could not be read for the task limit; it counts as empty", {
        error: errorName(error),
      });
      return undefined;
    }
  }

  /**
   * The person's assistant work items in progress (they run in Claw and count too). Each new item on the board lets go
   * the slot of the oldest message to the assistant that has not taken one yet.
   */
  private async boardCount(userId: string, key: string): Promise<number> {
    const ids = await this.readBoard(userId, key);
    if (ids === undefined) return 0;
    this.boardSeen.set(userId, ids);
    const counted = this.counted(userId);
    const taken = new Set([...(this.boardTaken.get(userId) ?? [])].filter((id) => ids.has(id)));
    const held = this.pending.get(userId);
    if (held !== undefined) {
      const kept = held.filter((entry) => {
        const fresh = [...ids].filter((id) => !entry.seen.has(id) && !taken.has(id) && !counted.has(id)).sort();
        if (fresh[0] === undefined) return true;
        taken.add(fresh[0]);
        return false;
      });
      if (kept.length === 0) this.pending.delete(userId);
      else this.pending.set(userId, kept);
    }
    if (taken.size === 0) this.boardTaken.delete(userId);
    else this.boardTaken.set(userId, taken);
    return [...ids].filter((id) => !counted.has(id)).length;
  }

  /**
   * True (the person is told, and the refusal recorded) when a new task would be one more than they may run. `what`
   * names the task in the notice; `boardKey` reads their board. Called under the person's lock.
   */
  async overLimit(chat: Chat, activityId: string, operation: string, what = "", boardKey = ""): Promise<boolean> {
    const running = await this.count(chat.sender.id, boardKey);
    const limit = this.deps.limits.maxConcurrentTasks;
    if (running < limit) return false;
    this.refused(chat.sender.id, activityId, operation, running);
    const zh = chat.zh();
    const named = what ? (zh ? `（${what}）` : ` (${what})`) : "";
    await chat.say(this.deps.limits.concurrencyNotice(chat.lang(), running, named));
    return true;
  }

  private refused(userId: string, activityId: string, operation: string, running: number): void {
    this.deps.securityEvent("rate_limited", {
      aad_object_id: userId,
      activity_id: activityId || null,
      operation,
      reason: "concurrency_limit",
      scope: "user",
      count: running,
      limit: this.deps.limits.maxConcurrentTasks,
    });
    this.deps.metrics.limited("concurrency_limit");
  }

  /**
   * Admits up to `count` pull requests of one review request before Claw is asked to start them; what is admitted holds
   * a slot each until its turn is kept or the request is over. Fewer than `count`: the rest is refused (and recorded).
   */
  async admitReviews(chat: Chat, activityId: string, count: number, boardKey: string): Promise<ReviewSlots> {
    const userId = chat.sender.id;
    const limit = this.deps.limits.maxConcurrentTasks;
    const { slots, running } = await this.lock.run(userId, async () => {
      const now = await this.count(userId, boardKey);
      const granted = Math.max(0, Math.min(count, limit - now));
      const made = new ReviewSlots(
        (s) => {
          this.forget(s);
        },
        userId,
        granted,
        now,
        limit,
      );
      if (granted > 0) this.reviewSlots.set(userId, [...(this.reviewSlots.get(userId) ?? []), made]);
      return { slots: made, running: now };
    });
    if (slots.granted < count) this.refused(userId, activityId, "pr_review", running);
    return slots;
  }

  private forget(slots: ReviewSlots): void {
    const held = this.reviewSlots.get(slots.userId);
    if (held === undefined) return;
    const kept = held.filter((s) => s !== slots);
    if (kept.length === 0) this.reviewSlots.delete(slots.userId);
    else this.reviewSlots.set(slots.userId, kept);
  }

  /**
   * A message for the assistant may start a work item, so it is refused while the person is at the limit. One let
   * through holds a slot until its item is on the board, or for `assistantPendingSeconds`.
   */
  assistantOverLimit(chat: Chat, activityId: string, key: string): Promise<boolean> {
    const userId = chat.sender.id;
    return this.lock.run(userId, async () => {
      if (await this.overLimit(chat, activityId, "assistant_task", "", key)) return true;
      const entry = {
        until: this.now() + this.deps.limits.assistantPendingSeconds,
        seen: this.boardSeen.get(userId) ?? new Set(),
      };
      this.pending.set(userId, [...(this.pending.get(userId) ?? []), entry]);
      return false;
    });
  }

  /** A remote-agent prompt being sent holds a slot until it counts as running (taken under the person's lock). */
  hold(userId: string): void {
    this.reserved.set(userId, (this.reserved.get(userId) ?? 0) + 1);
  }

  letGo(userId: string): void {
    const left = (this.reserved.get(userId) ?? 1) - 1;
    if (left <= 0) this.reserved.delete(userId);
    else this.reserved.set(userId, left);
  }
}
