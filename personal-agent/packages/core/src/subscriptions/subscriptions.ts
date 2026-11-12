// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One Claw notification subscription per linked person, made with that person's own key (teams_agent/subscriptions.py),
 * and per person bound at the identity service with no link, made with their exchanged token when they write.
 *
 * Claw delivers only a subscription's owner's events and shows its signing secret once, so every person's subscription points at
 * its own URL `<base>/<route>`; the random route token finds the person and their secret. With the assistant on, the subscription
 * also asks for the assistant's events and the work items' approvals; one made before gets one PATCH (`types_version`). The record
 * is not taken on trust: at most every ten minutes per person it is looked at in Claw and mended or made again. Nothing here ever
 * logs a key or a secret.
 */
import { errorName } from "../errors.js";
import type { Logger } from "../ports/logger.js";
import type { NotifySubscription } from "../ports/store/index.js";
import type { Random } from "../ports/random.js";
import { ClawAnswerInvalid, ClawError } from "../claw/errors.js";
import { ASSISTANT_TYPES_VERSION, RUN_SOURCES, wantedTypes, type WantedTypes } from "./event-types.js";
import type { ClawSubscription } from "../ports/claw/index.js";
import type { ClawSubscriptions, SubscriptionStore } from "./ports.js";
import { pyRstrip } from "../text/py-text.js";
import { NOTIFICATION_SURFACE_DEFAULT } from "../protocol.js";

/** Notifications off on Claw, or Claw unreachable: a subscription is tried again at most daily. */
export const RETRY_SECONDS = 24 * 3600;
/** How often a subscription is looked at in Claw (and mended) with the assistant on. */
export const UPGRADE_RETRY_SECONDS = 600;
const ROUTE_BYTES = 24;

/** Why a person cannot be reached by the events of their work items ("" is reachable). */
export type Unreachable = "" | "unlinked" | "no_subscription" | "no_user_id" | "no_chat";

export interface SubscriptionsOptions {
  readonly store: SubscriptionStore;
  readonly claw: ClawSubscriptions;
  readonly random: Random;
  readonly logger: Logger;
  /** NOTIFY_WEBHOOK_URL, e.g. http://<worker service>/claw-events. */
  readonly baseUrl: string;
  /** ASSISTANT_ENABLED: subscriptions also get the assistant's event types. */
  readonly assistant?: boolean;
  /** TEAMS_ASSISTANT_UNDERSTANDING_USERS: whose subscription also asks for `assistant.action`. */
  readonly understood?: (aadId: string) => boolean;
  /** ASSISTANT_USERS: whose subscription gets the assistant's types (an empty list: everybody's). */
  readonly assistantFor?: (aadId: string) => boolean;
  /** (key) -> the Claw user id the key is of; undefined when that could not be read. Absent: ids are not filled in. */
  readonly userIdOf?: (key: string) => Promise<string | undefined>;
  /**
   * The chat surface this worker is (`teams`, `slack`, ...), sent as the subscription's `surface`: Claw sends a reply back to the
   * surface the person's message came from, and a proactive message to the one they used last. Absent: Teams.
   */
  readonly surface?: string;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export class Subscriptions {
  private readonly store: SubscriptionStore;
  private readonly claw: ClawSubscriptions;
  private readonly random: Random;
  private readonly log: Logger;
  private readonly base: string;
  private readonly assistant: boolean;
  private readonly understood: (aadId: string) => boolean;
  private readonly assistantFor: (aadId: string) => boolean;
  private readonly userIdOf: ((key: string) => Promise<string | undefined>) | undefined;
  private readonly surface: string;

  constructor(options: SubscriptionsOptions) {
    this.store = options.store;
    this.claw = options.claw;
    this.random = options.random;
    this.log = options.logger;
    this.base = pyRstrip(options.baseUrl, "/");
    this.assistant = options.assistant ?? false;
    this.understood = options.understood ?? (() => false);
    this.assistantFor = options.assistantFor ?? (() => true);
    this.userIdOf = options.userIdOf;
    this.surface = options.surface ?? NOTIFICATION_SURFACE_DEFAULT;
  }

  /** This person's subscription gets the assistant's events (so the assistant can reach them). */
  hasAssistantTypes(aadId: string): boolean {
    const version = this.store.notifySubs.notifyTypesVersion(aadId);
    return version !== null && version >= ASSISTANT_TYPES_VERSION;
  }

  private assistantOnFor(aadId: string): boolean {
    return this.assistant && this.assistantFor(aadId);
  }

  /**
   * `ensure` for every linked person the assistant is on for, after filling in every missing Claw user id. Returns how many people
   * were looked at. Never throws.
   */
  async ensureAll(): Promise<number> {
    await this.fillUserIds();
    if (!this.assistant) return 0;
    const people = this.store.links.linkedUsers().filter((aadId) => this.assistantFor(aadId));
    for (const aadId of people) await this.ensure(aadId);
    return people.length;
  }

  /** Record the Claw user id of every linked person whose link has none. Returns how many were filled in. Never throws. */
  async fillUserIds(): Promise<number> {
    let filled = 0;
    for (const aadId of this.store.links.linkedUsers()) {
      if (await this.fillUserId(aadId)) filled += 1;
    }
    return filled;
  }

  /** `fillUserIds` for one person: true when an id was recorded now. */
  async fillUserId(aadId: string): Promise<boolean> {
    if (this.userIdOf === undefined || !this.store.links.needsClawUserId(aadId)) return false;
    const key = this.store.links.getKey(aadId);
    if (key === null) return false;
    let userId: string | undefined;
    try {
      userId = await this.userIdOf(key);
    } catch (error) {
      this.log.info("the Claw user id of a linked person could not be read", { error: errorName(error) });
      return false;
    }
    if (!userId) return false;
    this.store.links.setClawUserId(aadId, userId);
    return true;
  }

  /**
   * Whether the events of this person's work items reach their chat: "" when they do, else why not. The subscription is made or
   * mended first and the user id filled in, so what is said is the state after trying. Never throws.
   */
  async reachable(aadId: string): Promise<Unreachable> {
    try {
      if (this.store.links.getKey(aadId) === null) return "unlinked";
      await this.ensure(aadId);
      await this.fillUserId(aadId);
      if (
        this.store.notifySubs.getNotifySub(aadId) === null ||
        (this.assistantOnFor(aadId) && !this.hasAssistantTypes(aadId))
      ) {
        return "no_subscription";
      }
      if (this.store.links.needsClawUserId(aadId)) return "no_user_id";
      if (this.store.references.getReference(aadId) === null) return "no_chat";
      return "";
    } catch (error) {
      this.log.warn("whether a person can be reached could not be said", { error: errorName(error) });
      return "no_subscription";
    }
  }

  /**
   * Make sure this person has a subscription (with the assistant's types when it is on). It is made and mended with
   * `credential` when one is given (a person with no link, whose chats run on an exchanged token), else with their linked
   * key. Never throws.
   */
  async ensure(aadId: string, credential?: string): Promise<void> {
    try {
      const key = credential ?? this.store.links.getKey(aadId);
      let found = this.store.notifySubs.getNotifySub(aadId);
      if (found !== null && this.assistantOnFor(aadId)) found = await this.reconcile(aadId, found.subscriptionId, key);
      if (found !== null) return;
      if (key === null || !this.store.notifySubs.claimNotifyAttempt(aadId, RETRY_SECONDS)) return;
      await this.create(aadId, key);
    } catch (error) {
      if (error instanceof ClawError)
        this.log.info("notification subscription not set up for a user; retrying later", { status: error.status });
      else
        this.log.warn("notification subscription not set up for a user; retrying later", { error: errorName(error) });
    }
  }

  private async create(aadId: string, key: string): Promise<void> {
    await this.dropStale(key);
    const route = base64Url(this.random.bytes(ROUTE_BYTES));
    const url = `${this.base}/${route}`;
    let created: ClawSubscription | undefined;
    let version = 0;
    if (this.assistantOnFor(aadId)) {
      for (const rung of wantedTypes(this.understood(aadId))) {
        try {
          created = await this.claw.create(key, url, rung.types, rung.sources, this.surface);
          version = rung.version;
          break;
        } catch (error) {
          if (!refusedWith(error, 400)) throw error;
        }
      }
    }
    // (a Claw that does not know the assistant's events yet: the subscription it has always made; the types come with `ensure`)
    created ??= await this.claw.create(key, url, [], [], this.surface);
    this.store.notifySubs.saveNotifySub(aadId, {
      route,
      subscriptionId: required(created.subscription_id),
      secret: required(created.secret),
      typesVersion: version,
    });
  }

  /**
   * With the assistant on, the recorded subscription must be there in Claw, enabled and asking for the assistant's events: looked
   * at, and mended with one PATCH, at most every UPGRADE_RETRY_SECONDS. One Claw no longer has is forgotten (the caller makes a new
   * one); one Claw refuses even the assistant's types (400, 404) takes the person back to sessions (`types_version` 0).
   */
  private async reconcile(
    aadId: string,
    subscriptionId: string,
    key: string | null,
  ): Promise<NotifySubscription | null> {
    if (key === null || !this.store.notifySubs.claimNotifyAttempt(aadId, UPGRADE_RETRY_SECONDS)) {
      return this.store.notifySubs.getNotifySub(aadId);
    }
    let version: number;
    try {
      const row = (await this.claw.list(key)).find((r) => r.subscription_id === subscriptionId);
      if (row === undefined) {
        this.store.notifySubs.forgetNotifySub(aadId);
        return null;
      }
      version = await this.mend(aadId, key, subscriptionId, row);
    } catch (error) {
      if (refusedWith(error, 400, 404)) this.store.notifySubs.setNotifyTypesVersion(aadId, 0);
      throw error;
    }
    this.store.notifySubs.setNotifyTypesVersion(aadId, version);
    return this.store.notifySubs.getNotifySub(aadId);
  }

  /**
   * The best rung the subscription has already, or the best Claw takes; throws Claw's last refusal when it takes none. A subscription
   * Claw lists with another surface than this worker's is changed to this worker's with it (a Claw from before the label lists none).
   */
  private async mend(aadId: string, key: string, subscriptionId: string, row: ClawSubscription): Promise<number> {
    const disabled = row.enabled === false;
    const otherSurface = typeof row.surface === "string" && row.surface !== this.surface;
    const has = new Set(row.event_types ?? []);
    const hasSources = new Set(row.sources && row.sources.length > 0 ? row.sources : RUN_SOURCES);
    let refused: unknown = new ClawError(400);
    for (const rung of wantedTypes(this.understood(aadId))) {
      if (!disabled && !otherSurface && covers(rung, has, hasSources)) return rung.version;
      try {
        await this.claw.updateTypes(key, subscriptionId, rung.types, {
          enable: disabled,
          ...(rung.sources ? { sources: rung.sources } : {}),
          ...(otherSurface ? { surface: this.surface } : {}),
        });
        return rung.version;
      } catch (error) {
        if (!refusedWith(error, 400)) throw error;
        refused = error;
      }
    }
    throw refused;
  }

  /** Delete this person's earlier subscriptions to this worker: their secret is unknown here, so they would only be refused. */
  private async dropStale(key: string): Promise<void> {
    for (const sub of await this.claw.list(key)) {
      const url = sub.url ?? "";
      if (url !== this.base && !url.startsWith(`${this.base}/`)) continue;
      try {
        await this.claw.delete(key, sub.subscription_id ?? "");
      } catch (error) {
        if (!(error instanceof ClawError)) throw error;
      }
    }
  }

  /** /unlink: delete the subscription in Claw (best effort) and forget it here. */
  async remove(aadId: string, key: string | null): Promise<void> {
    const found = this.store.notifySubs.getNotifySub(aadId);
    if (found !== null && key !== null) {
      try {
        await this.claw.delete(key, found.subscriptionId);
      } catch (error) {
        this.log.info("could not delete a user's notification subscription in Claw", { error: errorName(error) });
      }
    }
    this.store.notifySubs.forgetNotifySub(aadId);
  }
}

function covers(rung: WantedTypes, has: ReadonlySet<string>, hasSources: ReadonlySet<string>): boolean {
  return (
    rung.types.every((t) => has.has(t)) && (rung.sources === undefined || rung.sources.every((s) => hasSources.has(s)))
  );
}

function refusedWith(error: unknown, ...statuses: number[]): boolean {
  return error instanceof ClawError && statuses.includes(error.status);
}

/** A field Claw's answer must carry (the Python worker's `data["subscription_id"]`, a KeyError when absent). */
function required(value: string | undefined): string {
  if (value === undefined) throw new ClawAnswerInvalid("a subscription without its id or secret");
  return value;
}
