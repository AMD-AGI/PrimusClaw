// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Where and how to reach a person, and what is known of them (tables `conversation_refs`, `user_prefs`, `held_events`,
 * `teams_users`, `personal_clicks`). */
import type { JsonObject } from "./json.js";

export interface Prefs {
  readonly timezone: string;
  readonly quietEnabled: boolean;
  readonly quietStart: string;
  readonly quietEnd: string;
  /** Epoch seconds notices are paused until; null: not paused. */
  readonly pausedUntil: number | null;
  readonly briefTriggerId: string | null;
  /** 'zh' / 'en' the person is answered in; '' not known yet. */
  readonly lang: string;
  /** They said which (`/lang`): what they write changes nothing. */
  readonly langSet: boolean;
  /** 'card' | 'chat' as the person set it (`/agent mode`); '' not said. */
  readonly remoteWindow: string;
}

export interface ConversationRefRepository {
  /** Keep where to post to this person unprompted (the reference's activityId is dropped). */
  saveReference(userId: string, reference: JsonObject): void;
  getReference(userId: string): JsonObject | null;
  /** When the person last wrote in their 1:1 chat or pressed a button there. */
  lastInboundAt(userId: string): number | null;
}

export interface PrefsRepository {
  getPrefs(userId: string): Prefs;
  getTimezone(userId: string): string;
  setTimezone(userId: string, timezone: string): void;
  /** A (start, end) wall-clock window in the person's time zone, or null for no quiet hours. */
  setQuiet(userId: string, window: readonly [string, string] | null): void;
  setPausedUntil(userId: string, until: number | null): void;
  /** Ignored unless `window` is 'card' or 'chat'. */
  setRemoteWindowPref(userId: string, window: string): void;
  setBriefTrigger(userId: string, triggerId: string | null): void;
  /** `said` false (`/lang auto`): `lang` is only a starting point that `learnLang` changes again. */
  setLang(userId: string, lang: string, said?: boolean): void;
  /** The language a message was written in: kept unless the person said which. */
  learnLang(userId: string, lang: string): void;
}

/** Notices held back by quiet hours or /pause. */
export interface HeldEventRepository {
  /** `event.event_id` identifies it; the newest MAX_HELD_PER_USER per person are kept, for HELD_TTL_SECONDS. */
  holdEvent(userId: string, event: JsonObject): void;
  usersWithHeld(): string[];
  /** Remove and return the person's held events, oldest first, at once. */
  takeHeld(userId: string): JsonObject[];
}

/** A person as the channel's member list reads (`id` the channel id, `objectId` the person id). */
export interface KnownMember {
  readonly id: string;
  readonly objectId: string;
  readonly name: string;
  readonly email?: string;
}

/** A member entry as a group's member list gives it. */
export interface MemberListEntry {
  readonly id?: unknown;
  readonly email?: unknown;
  readonly userPrincipalName?: unknown;
}

/** Which person a channel user id belongs to, as their own messages say. */
export interface MemberDirectoryRepository {
  /** `email` '' keeps the address already known. */
  rememberMember(channelUserId: string, userId: string, name: string, email?: string): void;
  /** Addresses from a member list, kept only for people already known. */
  rememberMemberEmails(members: readonly MemberListEntry[]): void;
  /** Everyone seen, newest first. */
  knownMembers(limit?: number): KnownMember[];
  userForChannelId(channelUserId: string): string | null;
  /** The channel id this person last wrote with. */
  channelIdOf(userId: string): string | null;
  memberName(userId: string): string | null;
  /** A card click of theirs arrived from their 1:1 chat (the app is installed for them). */
  notePersonalClick(userId: string): void;
  clickedPersonally(userId: string): boolean;
}
