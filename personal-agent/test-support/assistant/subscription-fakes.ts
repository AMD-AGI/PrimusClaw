// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** In-memory stand-ins for the store slices and Claw's subscription endpoints the subscription keeper uses. */
import type { NotifySubscription } from "../../packages/core/src/ports/store/index.js";
import type { ClawSubscription } from "../../packages/core/src/ports/claw/index.js";
import type { ClawSubscriptions, SubscriptionStore } from "../../packages/core/src/subscriptions/ports.js";

export { ClawError as ClawStatusError } from "../../packages/core/src/claw/errors.js";
import { ClawError as ClawStatusError } from "../../packages/core/src/claw/errors.js";

interface Row {
  subscription_id: string;
  owner: string;
  url: string;
  secret: string;
  event_types: string[];
  sources: string[];
  enabled: boolean;
}

/** Claw's notification subscriptions, owned by key; unknown types or sources are refused with 400 (as Claw does). */
export class FakeClawSubscriptions implements ClawSubscriptions {
  knownTypes = new Set([
    "run.completed",
    "run.failed",
    "approval.requested",
    "assistant.say",
    "work_item.needs_you",
    "assistant.action",
  ]);
  knownSources = new Set(["trigger", "long_run", "assistant_item"]);
  readonly rows = new Map<string, Row>();
  readonly calls: string[] = [];
  down = false;
  private n = 0;

  private check(): void {
    if (this.down) throw new TypeError("fetch failed");
  }

  private known(values: readonly string[] | undefined, known: ReadonlySet<string>): boolean {
    return values === undefined || (values.length > 0 && values.every((v) => known.has(v)));
  }

  create(key: string, url: string, types?: readonly string[], sources?: readonly string[]): Promise<ClawSubscription> {
    this.calls.push(`create ${key}`);
    this.check();
    if (!this.known(types, this.knownTypes) || !this.known(sources, this.knownSources))
      return Promise.reject(new ClawStatusError(400));
    this.n += 1;
    const row: Row = {
      subscription_id: `sub-${String(this.n)}`,
      owner: key,
      url,
      secret: `secret-${String(this.n)}`,
      event_types: types ? [...types] : ["run.completed", "run.failed"],
      sources: sources ? [...sources] : ["trigger", "long_run"],
      enabled: true,
    };
    this.rows.set(row.subscription_id, row);
    return Promise.resolve({ subscription_id: row.subscription_id, secret: row.secret });
  }

  list(key: string): Promise<ClawSubscription[]> {
    this.calls.push(`list ${key}`);
    this.check();
    return Promise.resolve([...this.rows.values()].filter((r) => r.owner === key).map((r) => ({ ...r })));
  }

  updateTypes(
    key: string,
    subscriptionId: string,
    types: readonly string[],
    options: { enable?: boolean; sources?: readonly string[] } = {},
  ): Promise<ClawSubscription> {
    this.calls.push(`patch ${key}`);
    this.check();
    const row = this.rows.get(subscriptionId);
    if (row === undefined || row.owner !== key)
      return Promise.reject(new ClawStatusError(404, '{"error":"not_found"}'));
    if (!this.known(types, this.knownTypes) || !this.known(options.sources, this.knownSources)) {
      return Promise.reject(new ClawStatusError(400, '{"error":"invalid_filter"}'));
    }
    row.event_types = [...types];
    if (options.sources) row.sources = [...options.sources];
    if (options.enable) row.enabled = true;
    return Promise.resolve({});
  }

  delete(key: string, subscriptionId: string): Promise<void> {
    this.calls.push(`delete ${key}`);
    this.check();
    const row = this.rows.get(subscriptionId);
    if (row === undefined || row.owner !== key)
      return Promise.reject(new ClawStatusError(404, '{"error":"not_found"}'));
    this.rows.delete(subscriptionId);
    return Promise.resolve();
  }

  of(key: string): Row[] {
    return [...this.rows.values()].filter((r) => r.owner === key);
  }
}

interface Sub extends NotifySubscription {
  secret: string;
  typesVersion: number;
}

/** The store slices: links (key, Claw user id), conversation references and notification subscriptions. */
export class FakeSubscriptionStore implements SubscriptionStore {
  now = 1_700_000_000;
  readonly keys = new Map<string, string>();
  readonly userIds = new Map<string, string>();
  readonly refs = new Set<string>();
  readonly subs = new Map<string, Sub>();
  readonly attempts = new Map<string, number>();

  readonly links: SubscriptionStore["links"];
  readonly references: SubscriptionStore["references"];
  readonly notifySubs: SubscriptionStore["notifySubs"];

  constructor() {
    this.links = {
      getKey: (u) => this.keys.get(u) ?? null,
      setClawUserId: (u, id) => void this.userIds.set(u, id),
      needsClawUserId: (u) => this.keys.has(u) && !this.userIds.has(u),
      linkedUsers: () => [...this.keys.keys()],
    };
    this.references = {
      getReference: (u) => (this.refs.has(u) ? { conversation: { id: `c-${u}` } } : null),
    };
    this.notifySubs = {
      saveNotifySub: (u, s) =>
        void this.subs.set(u, {
          route: s.route,
          subscriptionId: s.subscriptionId,
          secret: s.secret,
          typesVersion: s.typesVersion ?? 0,
        }),
      notifyTypesVersion: (u) => this.subs.get(u)?.typesVersion ?? null,
      setNotifyTypesVersion: (u, v) => {
        const sub = this.subs.get(u);
        if (sub) sub.typesVersion = v;
      },
      getNotifySub: (u) => {
        const sub = this.subs.get(u);
        return sub ? { route: sub.route, subscriptionId: sub.subscriptionId } : null;
      },
      forgetNotifySub: (u) => {
        this.subs.delete(u);
        this.attempts.delete(u); // (as the store does: a forgotten subscription is made again at once)
      },
      claimNotifyAttempt: (u, minInterval) => {
        const last = this.attempts.get(u);
        if (last !== undefined && this.now - last < minInterval) return false;
        this.attempts.set(u, this.now);
        return true;
      },
    };
  }

  link(aadId: string, key: string, userId?: string): void {
    this.keys.set(aadId, key);
    if (userId) this.userIds.set(aadId, userId);
    this.refs.add(aadId);
  }
}
