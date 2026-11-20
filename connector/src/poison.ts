// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Finding the event that fails every post it is in.
 *
 * Events are posted oldest first, in batches, until Claw acknowledges them. A post that fails is retried as it was, which is
 * right for an outage and wrong for an event Claw cannot store: Claw answered 500 to the same batch for ever, and every event
 * after it, of every session on the machine, waited behind it (the person saw their prompt arrive and never an answer).
 *
 * So a post that fails in a way that may be about what it carries (Claw answered, with 500 or a 4xx that is not about the
 * credential, the route or the rate) {@link ISOLATE_AFTER_FAILURES} times in a row, or once with such a 4xx, is split: its first
 * half is posted alone, then, whichever half fails, that half is split again, down to one event. That event is posted again with
 * its text made storable ({@link storableDeep}). Only when that post fails {@link SET_ASIDE_AFTER_REFUSALS} times, each time with
 * Claw saying it is the event's fault ({@link failureKind} `content`: a 4xx, or a 500 the database gave for a value it cannot
 * hold) and otherwise answering (an empty post just after it is taken), is the event set aside unsent, and everything after it
 * goes on. A 500 that says nothing of the sort (a deadlock, a pool that ran dry, a bug that is not the event's) may split a batch,
 * which costs nothing but smaller posts, and never sets an event aside: a Claw that fails now and then would otherwise narrow the
 * search onto an event that was fine and drop it, a turn's end as likely as any.
 *
 * Only a prefix of the queue is ever posted, so no session's event goes before an earlier one of the same session: Claw
 * acknowledges a session up to the highest number it stored, which would otherwise drop the earlier ones unsent.
 */
import { HttpError } from "./claw-client.js";
import type { OutEvent } from "./outbox.js";
import { storableDeep } from "./redact.js";

/** Failures in a row of the same first event, by a 500, before its batch is split. */
export const ISOLATE_AFTER_FAILURES = 3;
/** Refusals of the one event made storable, each followed by an empty post Claw took, before it is set aside. */
export const SET_ASIDE_AFTER_REFUSALS = 2;

/**
 * What a failed post says about what it carried.
 * - `content`: Claw named the request itself: a 4xx other than one about the credential (401, 403), a route this Claw lacks (404),
 *   a timeout (408), a conflict (409) or the rate (429); or a 500 whose SQLSTATE is class 22 (data exception, e.g. 22P05 for a NUL
 *   in jsonb) or 54 (a value too large or too deep), which the same value meets again on every post.
 * - `unknown`: any other 500. It may be the content (an API that fails in a way it does not name) or Claw (a deadlock, a lost
 *   connection): enough to split a batch, never to set an event aside.
 * - `outage`: no answer, a gateway's 502/503/504 and every other answer, which pass by themselves and are waited out.
 */
export type FailureKind = "content" | "unknown" | "outage";

export function failureKind(e: unknown): FailureKind {
  if (!(e instanceof HttpError)) return "outage";
  if (e.status === 500) return e.sqlState !== undefined && /^(22|54)/.test(e.sqlState) ? "content" : "unknown";
  return e.status >= 400 && e.status < 500 && ![401, 403, 404, 408, 409, 429].includes(e.status) ? "content" : "outage";
}

/** Whether a failed post may have failed for what it carried ({@link failureKind} other than `outage`). */
export function mayBeContent(e: unknown): boolean {
  return failureKind(e) !== "outage";
}

/** The next post: these events, and whether their text was made storable (then they are the one event under suspicion). */
export interface PoisonPlan { events: OutEvent[]; storable: boolean }

/** What the caller does after a failed post. */
export type PoisonVerdict =
  /** Wait as usual and post again (the plan may have changed). */
  | "retry"
  /** The one event under suspicion failed even made storable: post nothing, and tell {@link PoisonFinder.probed} whether Claw took it. */
  | "probe"
  /** Claw refused that event alone, as the event's fault, and took the empty posts around it: set it aside ({@link PoisonFinder.setAside}). */
  | "set_aside";

export class PoisonFinder {
  /** Events one of which fails every post it is in: the last post that failed for what it carried, less what was taken since. */
  private suspect: OutEvent[] | null = null;
  /** The first event of the posts that failed in a row, and how many did. */
  private head: OutEvent | null = null;
  private fails = 0;
  /** Times the one event under suspicion was refused made storable with an empty post taken just after. */
  private refusals = 0;

  /** Whether a batch is being split. */
  get isolating(): boolean { return this.suspect !== null; }

  /** What to post: `pending` (the oldest events, at most a batch), or while a batch is split, the part of it to try next. */
  plan(pending: OutEvent[], queued: (e: OutEvent) => boolean): PoisonPlan {
    if (this.suspect) {
      // Shed or acknowledged meanwhile: no longer posted, and no longer suspect.
      this.suspect = this.suspect.filter(queued);
      if (this.suspect.length === 0) this.suspect = null;
    }
    if (!this.suspect) return { events: pending, storable: false };
    if (this.suspect.length > 1) return { events: this.suspect.slice(0, Math.floor(this.suspect.length / 2)), storable: false };
    const [ev] = this.suspect as [OutEvent];
    return { events: [{ ...ev, data: storableDeep(ev.data) }], storable: true };
  }

  /** Claw took the post: what it held is not the culprit. */
  taken(plan: PoisonPlan): void {
    this.head = null;
    this.fails = 0;
    this.refusals = 0;
    if (!this.suspect) return;
    if (plan.storable) { this.suspect = null; return; }
    const sent = new Set(plan.events);
    this.suspect = this.suspect.filter((e) => !sent.has(e));
    if (this.suspect.length === 0) this.suspect = null;
  }

  /** The post failed with `e`. */
  failed(plan: PoisonPlan, e: unknown): PoisonVerdict {
    const kind = failureKind(e);
    if (kind === "outage" || plan.events.length === 0) return "retry";
    if (this.suspect) {
      // Only Claw's word that the event is at fault counts towards setting it aside, and only in a row.
      if (plan.storable) {
        if (kind === "content") return "probe";
        this.refusals = 0;
        return "retry";
      }
      this.suspect = plan.events;
      this.refusals = 0;
      return "retry";
    }
    const first = plan.events[0]!;
    if (this.head !== first) { this.head = first; this.fails = 0; }
    this.fails++;
    // A 4xx is Claw's word about the request itself: no point in repeating it before splitting.
    if (this.fails >= ISOLATE_AFTER_FAILURES || (e as HttpError).status !== 500) {
      this.suspect = plan.events;
      this.head = null;
      this.fails = 0;
    }
    return "retry";
  }

  /** Whether Claw took the empty post made after the one event under suspicion was refused ({@link PoisonVerdict} `probe`). */
  probed(taken: boolean): PoisonVerdict {
    if (!taken) { this.refusals = 0; return "retry"; }
    return ++this.refusals >= SET_ASIDE_AFTER_REFUSALS ? "set_aside" : "retry";
  }

  /** The event under suspicion was set aside: posting goes on as usual. */
  setAside(): void {
    this.suspect = null;
    this.refusals = 0;
  }
}
