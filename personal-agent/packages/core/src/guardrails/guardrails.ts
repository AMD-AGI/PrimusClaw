// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Limit } from "../config/settings.js";
import { guardrailsText } from "../locales/guardrails.js";
import type { Lang } from "../locales/lang.js";
import type { SecurityEventName } from "../observability/security-events.js";
import type { Clock } from "../ports/clock.js";
import { DEFAULT_LIMITS, SENSITIVE_OPERATIONS, type SensitiveOperation } from "./operations.js";

/** Ids of what an audit record is about (a session, a repository, a pull request); never text a person wrote. */
export type AuditFields = Readonly<Record<string, unknown>>;

/** Logs one security event (the observability module's `securityEvent`, bound to the worker's logger and metrics). */
export type AuditSink = (event: SecurityEventName, fields: AuditFields) => void;

/** People who did nothing for a whole window are forgotten once more than this many (person, operation) are kept. */
const FORGET_PAST = 10_000;

/** An operation a limit refused, and when it can be done again. */
export class Refused {
  constructor(
    readonly operation: SensitiveOperation,
    readonly limit: Limit,
    readonly retryAfterSeconds: number,
  ) {}

  /** The sentence the person is told: what was refused, the limit, and when it can be done again. */
  text(lang: Lang = "en"): string {
    const t = guardrailsText.in(lang);
    return t.refused({
      count: this.limit.count,
      what: t[this.operation],
      window: windowWords(this.limit.windowSeconds, lang),
      minutes: Math.max(1, Math.ceil(this.retryAfterSeconds / 60)),
    });
  }
}

function windowWords(seconds: number, lang: Lang): string {
  const t = guardrailsText.in(lang);
  if (seconds % 3600 === 0) return t.hours({ n: seconds / 3600 });
  if (seconds % 60 === 0) return t.minutes({ n: seconds / 60 });
  return t.seconds({ n: seconds });
}

interface Taken {
  readonly at: number;
  readonly ticket: object | undefined;
}

/**
 * The per-person limits of the operations that act with someone's authority: a sliding window of how many times one
 * person did each. Past it the operation is refused, with a `rate_limited` security event. Only the operation that adds
 * authority is limited (approving, confirming, starting a review, switching to a mode that does not ask). The counts
 * live in memory (one replica; a restart only ever lets a person do more, never less). One per worker.
 */
export class Guardrails {
  readonly limits: ReadonlyMap<SensitiveOperation, Limit>;
  /** `person\u001foperation` -> when it was done and the ticket it was taken with, oldest first */
  private readonly done = new Map<string, Taken[]>();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditSink,
    limits: ReadonlyMap<string, Limit> = new Map(),
  ) {
    const merged = new Map<SensitiveOperation, Limit>(
      Object.entries(DEFAULT_LIMITS) as Array<[SensitiveOperation, Limit]>,
    );
    const unknown = [...limits.keys()].filter((op) => !Object.hasOwn(SENSITIVE_OPERATIONS, op)).sort();
    if (unknown.length) throw new RangeError(`no such sensitive operation: ${unknown.join(", ")}`);
    for (const [op, limit] of limits) merged.set(op as SensitiveOperation, limit);
    this.limits = merged;
  }

  private now(): number {
    return this.clock.epochMs() / 1000;
  }

  private limitOf(operation: SensitiveOperation): Limit {
    return this.limits.get(operation) ?? DEFAULT_LIMITS[operation];
  }

  /**
   * Counts one `operation` by `person` and returns null, or, at the limit, counts nothing, logs a `rate_limited`
   * security event (with `fields`: ids of what was refused) and returns the refusal. `ticket` names this count, for
   * `giveBack` to undo exactly it.
   */
  take(person: string, operation: SensitiveOperation, ticket?: object, fields: AuditFields = {}): Refused | null {
    const limit = this.limitOf(operation);
    if (limit.count <= 0) return null;
    const now = this.now();
    const key = `${person}\u001f${operation}`;
    const done = this.done.get(key) ?? [];
    this.done.set(key, done);
    while (done.length > 0 && (done[0]?.at ?? now) <= now - limit.windowSeconds) done.shift();
    const oldest = done[0];
    if (oldest !== undefined && done.length >= limit.count) {
      const retry = Math.max(1, Math.ceil(oldest.at + limit.windowSeconds - now));
      this.audit("rate_limited", {
        operation,
        reason: "user_limit",
        scope: "user",
        aad_object_id: person,
        count: done.length,
        limit: limit.count,
        window_seconds: limit.windowSeconds,
        retry_after_seconds: retry,
        ...fields,
      });
      return new Refused(operation, limit, retry);
    }
    done.push({ at: now, ticket });
    if (this.done.size > FORGET_PAST) this.forget(now);
    return null;
  }

  /**
   * Undoes the `take` made with `ticket`: the operation was not done after all, so it must not use up the person's
   * allowance. Exactly that count goes, never another one, and only once. A take without a ticket is never given back.
   */
  giveBack(person: string, operation: SensitiveOperation, ticket: object | undefined): void {
    if (ticket === undefined) return;
    const done = this.done.get(`${person}\u001f${operation}`) ?? [];
    const index = done.findIndex((taken) => taken.ticket === ticket);
    if (index !== -1) done.splice(index, 1);
  }

  private forget(now: number): void {
    for (const [key, done] of [...this.done]) {
      const operation = key.slice(key.lastIndexOf("\u001f") + 1) as SensitiveOperation;
      const newest = done.at(-1);
      if (newest === undefined || newest.at <= now - this.limitOf(operation).windowSeconds) this.done.delete(key);
    }
  }

  /** How many (person, operation) the guardrails remember. */
  get remembered(): number {
    return this.done.size;
  }
}
