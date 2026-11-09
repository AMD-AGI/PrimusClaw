// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who a request names: a mention (the person's directory id from the mention, from what the worker has seen of them, or
 * from the group's member list), or a typed name exactly one member of the group has. Anything else is a question back; the
 * asker is never the answer to a question they did not answer. And everyone a message names, to hold one request to one
 * reviewer, whoever read it.
 */

import { errorName } from "../../errors.js";
import type { ConversationRef, RosterMember } from "../../ports/surface.js";
import { pyStrip } from "../../text/py-text.js";
import {
  type Mention,
  displayName,
  markerIndexes,
  memberMatches,
  memberNames,
  mentionId,
  namedIn,
  tokens,
  withoutMarkers,
} from "../../review-text/names.js";
import { prShortPattern, prUrlPattern } from "../../review-text/pull-ref.js";
import { modelFieldPattern } from "../../review-text/asks.js";
import type { ReviewAsk } from "../request-parse.js";
import { bareName } from "../../review-text/text/unicode.js";
import type { ReviewDeps } from "./deps.js";

/** A group's member list is read again after this long (names are matched against it). */
export const ROSTER_CACHE_MS = 300_000;
/** The member list is given up on after this long. */
export const ROSTER_MS = 10_000;

/** The person a request names. */
export interface Actor {
  readonly userId: string;
  readonly name: string;
  readonly channelUserId: string;
}

/** Who was named could not be settled; `text` is what the asker is told. */
export interface ActorUnknown {
  readonly unknown: string;
}

/** Where the request was asked, as the roster reads it. */
export interface Asked {
  readonly conversation: ConversationRef;
  readonly group: boolean;
}

export class ReviewerReader {
  /** group conversation id -> (when read, its members). */
  private readonly rosters = new Map<string, { readonly at: number; readonly members: readonly RosterMember[] }>();

  constructor(private readonly deps: ReviewDeps) {}

  /**
   * The members of the group chat, or undefined when the channel cannot read them. In a 1:1 chat, which has no group,
   * everyone the worker has seen write to it.
   */
  async roster(asked: Asked): Promise<readonly RosterMember[] | undefined> {
    if (!asked.group) {
      return this.deps.store.members.knownMembers().map((m) => ({
        channelUserId: m.id,
        userId: m.objectId,
        name: m.name,
        givenName: "",
        surname: "",
        email: m.email ?? "",
        userPrincipalName: "",
      }));
    }
    const id = asked.conversation.id;
    const now = this.deps.clock.monotonicMs();
    const kept = this.rosters.get(id);
    if (kept !== undefined && now - kept.at < ROSTER_CACHE_MS) return kept.members;
    let members: readonly RosterMember[] | undefined;
    try {
      members = await withTimeout(this.deps, this.deps.surface.members(asked.conversation), ROSTER_MS);
    } catch (err) {
      this.deps.logger.warn("the member list of a group chat could not be read", { error: errorName(err) });
      return undefined;
    }
    if (members === undefined) return undefined;
    this.rosters.set(id, { at: this.deps.clock.monotonicMs(), members });
    try {
      this.deps.store.members.rememberMemberEmails(
        members.map((m) => ({ id: m.channelUserId, email: m.email, userPrincipalName: m.userPrincipalName })),
      );
    } catch (err) {
      // (the addresses only help a later message name someone: the roster is still the answer)
      this.deps.logger.warn("the addresses of a group's members could not be kept", { error: errorName(err) });
    }
    return members;
  }

  /** Who the request names, or the question to ask back. */
  async resolve(asked: Asked, ask: ReviewAsk): Promise<Actor | ActorUnknown> {
    const refs = markerIndexes(ask.who).filter((i) => i < ask.mentions.length);
    // One person is one channel id: a display name with a comma ("Lin, Mei") may come as a mention per word.
    const people = new Set(refs.map((r) => mentionId(ask.mentions[r] as Mention)));
    if (people.size > 1) return { unknown: "一次只能指定一位 reviewer，请分开发送。" };
    const [first] = refs;
    if (first !== undefined) return this.mentioned(asked, ask, refs, ask.mentions[first] as Mention);
    return this.typed(asked, bareName(withoutMarkers(ask.who)));
  }

  private async mentioned(
    asked: Asked,
    ask: ReviewAsk,
    refs: readonly number[],
    mention: Mention,
  ): Promise<Actor | ActorUnknown> {
    const channelUserId = mention.channelUserId;
    const name = pyStrip([...new Set(refs.map((r) => pyStrip(ask.mentions[r]?.name ?? "")))].join(" "));
    let userId = mention.userId || this.deps.store.members.userForChannelId(channelUserId) || "";
    if (!userId && channelUserId) {
      const members = await this.roster(asked);
      userId = members?.find((m) => m.channelUserId === channelUserId)?.userId ?? "";
    }
    if (!userId) {
      return {
        unknown: `我还认不出 ${name || "被 @ 的同事"}（TA 还没有在 1:1 里和我说过话）。请 ${name || "TA"} 先在 1:1 里给我发 \`/github bind\`，之后再 @ 我一次。`,
      };
    }
    return { userId, name: name || this.deps.store.members.memberName(userId) || "", channelUserId };
  }

  private async typed(asked: Asked, typed: string): Promise<Actor | ActorUnknown> {
    const members = await this.roster(asked);
    if (members === undefined) return { unknown: `我读不到这个群的成员名单，认不出「${typed}」。请直接 @ 对方。` };
    const { hits, near } = memberMatches(typed, members);
    if (!hits.length) {
      const where = asked.group ? "这个群里" : "我认识的人里（和我说过话的同事）";
      return {
        unknown: `我在${where}没有找到「${typed}」${near.length ? `（相近的有：${memberNames(near)}）` : ""}，请写出 TA 的全名。`,
      };
    }
    if (hits.length > 1) {
      const where = asked.group ? "这个群里" : "我认识的人里";
      return { unknown: `${where}有不止一位叫「${typed}」的成员：${memberNames(hits)}。请写出全名。` };
    }
    const member = hits[0] as RosterMember;
    const userId = member.userId || this.deps.store.members.userForChannelId(member.channelUserId) || "";
    if (!userId) return { unknown: `我认不出「${typed}」，请写出 TA 在群里的全名。` };
    return { userId, name: member.name || typed, channelUserId: member.channelUserId };
  }

  /**
   * (channel id -> name of everyone the message may name, how many people it names). Everyone it mentions is one, and so
   * is every member whose name it writes as words of its own; members found at the very same words are one name written
   * (one that fits several people: the reviewer's own check asks which), and a member also mentioned is that mention.
   */
  async peopleNamed(
    asked: Asked,
    markedText: string,
    ask: ReviewAsk,
  ): Promise<{ people: Map<string, string>; count: number }> {
    const people = new Map(ask.mentions.map((m) => [mentionId(m), m.name] as const));
    let groups: Set<string>[] = [...people.keys()].map((id) => new Set([id]));
    const stripped = withoutMarkers(markedText)
      .replace(prUrlPattern(), " ")
      .replace(prShortPattern(), " ")
      .replace(modelFieldPattern(), " ");
    const words = tokens(stripped);
    const members = words.length ? ((await this.roster(asked)) ?? []) : [];
    const found = new Map<string, { at: ReadonlySet<string>; ids: Map<string, string> }>();
    for (const member of members) {
      const at = namedIn(words, member);
      if (!member.channelUserId || !at.size) continue;
      const key = [...at].sort().join(",");
      const entry = found.get(key) ?? { at, ids: new Map<string, string>() };
      entry.ids.set(member.channelUserId, member.name);
      found.set(key, entry);
    }
    // A name found inside a longer one ("Lin Mei" inside "Zhang Lin Mei") is part of that one, not a second person.
    const all = [...found.values()];
    const kept = all.filter(
      (e) => !all.some((o) => o !== e && o.at.size > e.at.size && [...e.at].every((p) => o.at.has(p))),
    );
    for (const named of kept) {
      for (const [id, name] of named.ids) if (!people.has(id)) people.set(id, name);
      const ids = new Set(named.ids.keys());
      const joined = groups.filter((g) => [...g].some((i) => ids.has(i)));
      groups = [
        ...groups.filter((g) => ![...g].some((i) => ids.has(i))),
        new Set([...ids, ...joined.flatMap((g) => [...g])]),
      ];
    }
    return { people, count: groups.length };
  }

  /** The names of the people a message names, as the asker is told them. */
  static namesOf(people: ReadonlyMap<string, string>): string {
    return [...people.values()].map((n) => displayName(n) || "?").join("、");
  }
}

/** `promise`, or a rejection once `ms` of the injected clock have passed. */
async function withTimeout<T>(deps: ReviewDeps, promise: Promise<T>, ms: number): Promise<T> {
  const stop = new AbortController();
  const late = deps.clock.sleep(ms, stop.signal).then(() => {
    throw new Error("timeout");
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    stop.abort();
    late.catch(() => undefined);
  }
}
