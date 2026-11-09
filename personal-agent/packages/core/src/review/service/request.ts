// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a request in a chat: pull requests written by number alone are expanded to owner/repo#N (in the repository the
 * message names, or asked about: never guessed), then the model's reading is held to the message (`checkIntent`), or the
 * rules read it (`parseReviewAsk`). Nothing here acts: it says what was asked, or the one question to ask back.
 */

import { markedText } from "../../inbound-text/marked-text.js";
import { quoteBlock } from "../../inbound-text/quote-block.js";
import { reviewRequestText as t } from "../../locales/review-request.js";
import type { InboundMessage, UserRef } from "../../ports/surface.js";
import { type BareGroup, bareGroups, strayNumbers, writtenRepos, looksLikeRepo } from "../bare-numbers.js";
import { checkIntent } from "../intent-check.js";
import { type Mention, namedWithin } from "../names.js";
import { MARK_CLOSE, MARK_OPEN, pullsIn, keyOf, type PullKey } from "../pull-ref.js";
import { asksReviewOnly, parseReviewAsk, type ReviewAsk, saysReviewAndMerge } from "../request-parse.js";
import { bareName, unique } from "../text/unicode.js";
import type { ReviewDeps } from "./deps.js";

/** A message as the request is read from it. */
export interface Asking {
  readonly message: InboundMessage;
  readonly sender: UserRef;
  readonly group: boolean;
}

/** The message with each bare number written as owner/repo#N, the repository read, and what was and was not taken. */
export interface Expanded {
  readonly message: InboundMessage;
  readonly repo: string;
  readonly taken: readonly PullKey[];
  readonly stray: readonly number[];
}

/** What reading a request came to: not one (chat), a question asked back, or the request. */
export type Reading =
  | { readonly kind: "chat" }
  | { readonly kind: "question"; readonly text: string }
  | { readonly kind: "ask"; readonly ask: ReviewAsk };

const numbersOf = (group: BareGroup): string => group.numbers.map((n) => `#${String(n)}`).join("、");

export class RequestReader {
  /** A repository name GitHub answered for (lower case) -> its "owner/name". */
  private readonly reposSeen = new Map<string, string>();

  constructor(private readonly deps: ReviewDeps) {}

  private marked(asking: Asking): { text: string; mentions: readonly Mention[] } {
    const { message } = asking;
    const marked = markedText(message.text, message.mentions, {
      links: message.links,
      group: asking.group,
      redact: this.deps.mask,
    });
    return { text: marked.text, mentions: marked.mentions };
  }

  /**
   * A request that names pull requests by number alone: the message with each number as owner/repo#N, and the repository
   * it was read as: the one written just before the numbers; the one other repository the message names; the asker's most
   * recent /repo of an allowed owner. Otherwise one question back: the repository is never guessed.
   */
  async barePulls(asking: Asking): Promise<Expanded | string> {
    const raw = asking.message.text;
    const plain = this.marked(asking).text;
    const none: Expanded = { message: asking.message, repo: "", taken: [], stray: [] };
    if (!saysReviewAndMerge(plain) && !asksReviewOnly(plain)) return none;
    const groups = bareGroups(raw);
    if (!groups.length) return { ...none, stray: strayNumbers(raw, groups) };
    const chosen = await this.chooseRepos(groups, writtenRepos(plain), this.recentRepo(asking.sender.id));
    if (typeof chosen === "string") return chosen;
    const stray = strayNumbers(
      raw,
      chosen.map(([group]) => group),
    );
    if (!chosen.length) return { ...none, stray };
    let text = raw;
    const spans = chosen.flatMap(([group, repo]) => group.spans.map(([a, b]) => [a, b, repo] as const));
    for (const [a, b, repo] of spans.sort((x, y) => y[0] - x[0] || y[1] - x[1])) {
      // ("#245": the "#" goes with it)
      const start = text.slice(a - 1, a) === "#" ? a - 1 : text.slice(a - 2, a) === "# " ? a - 2 : a;
      text = `${text.slice(0, start)} ${repo}#${text.slice(a, b)} ${text.slice(b)}`;
    }
    const repos = unique(chosen.map(([, repo]) => repo));
    const taken = chosen.flatMap(([group, repo]) => {
      const [owner = "", name = ""] = repo.toLowerCase().split(/\/(.*)/su);
      return group.numbers.map((n) => keyOf(owner, name, n));
    });
    this.deps.logger.info("bare pull request numbers read", {
      repos: repos.join(", "),
      count: taken.length,
      stray: stray.length,
    });
    return { message: { ...asking.message, text }, repo: repos.join("、"), taken, stray };
  }

  private recentRepo(userId: string): string {
    if (!userId) return "";
    const allowed = new Set(this.deps.owners.map((o) => o.toLowerCase()));
    const recent = this.deps.store.repoHistory
      .recentRepos(userId)
      .find((r) => allowed.has((r.repo.split("/")[0] ?? "").toLowerCase()));
    return recent?.repo ?? "";
  }

  private async chooseRepos(
    groups: readonly BareGroup[],
    written: readonly string[],
    recent: string,
  ): Promise<[BareGroup, string][] | string> {
    const chosen: [BareGroup, string][] = [];
    const example = this.deps.owners[0] ?? "";
    for (const group of groups) {
      let repo = "";
      if (group.repo.includes("/")) {
        repo = group.repo.replace(/\.git$/u, "");
      } else if (group.repo) {
        const named = await this.repoNamed(group.repo);
        // (a word and a number that is no repository's pull request: not a pull request)
        if (!named && !group.explicit) continue;
        if (named === undefined) {
          return `我暂时没能向 GitHub 确认「${group.repo}」是哪个仓库，所以没有开始 review。是哪个仓库的 ${numbersOf(group)}？请写成 owner/repo#编号，例如 ${example}/<仓库>#${String(group.numbers[0])}。`;
        }
        if (!named)
          return `我在 ${this.deps.owners.join("、")} 里没有找到仓库「${group.repo}」，是哪个仓库的 ${numbersOf(group)}？请写成 owner/repo#编号。`;
        repo = named;
      }
      repo ||= written.length === 1 ? (written[0] ?? "") : written.length ? "" : recent;
      if (!repo) {
        return written.length
          ? `这条消息里有不止一个仓库（${written.join("、")}），是哪个仓库的 ${numbersOf(group)}？请写成 owner/repo#编号。`
          : `是哪个仓库的 ${numbersOf(group)}？请写成 owner/repo#编号，例如 ${example}/<仓库>#${String(group.numbers[0])}。`;
      }
      chosen.push([group, repo]);
    }
    return chosen;
  }

  /**
   * The one "owner/name" among the allowed owners that GitHub has a public repository `name` for; '' when none or more
   * than one has; undefined when GitHub could not be asked. With one allowed owner, a GitHub that cannot be asked leaves only
   * one repository a name that looks like one can be: that owner's (Claw's own read of the pull request refuses a wrong one).
   */
  private async repoNamed(name: string): Promise<string | undefined> {
    const seen = this.reposSeen.get(name.toLowerCase());
    if (seen) return seen;
    const hits: string[] = [];
    for (const owner of this.deps.owners) {
      const found = await this.deps.pulls.repo(owner, name);
      if (found === undefined && this.deps.owners.length === 1 && looksLikeRepo(name)) {
        this.deps.logger.info("a repository could not be checked on GitHub; read as the one allowed owner's");
        return `${owner}/${name}`;
      }
      if (found === undefined) return undefined;
      if (found) hits.push(found);
    }
    // (GitHub said so once: later requests need not ask again)
    if (hits.length === 1 && hits[0] !== undefined) this.reposSeen.set(name.toLowerCase(), hits[0]);
    return hits.length === 1 ? hits[0] : "";
  }

  /**
   * What the message asks: the model's reading held to the message, when the message names a pull request and the asker
   * has a key to read it with; else, or when the model gives no reading in time, the rules'.
   */
  async read(asking: Asking): Promise<Reading> {
    const { text, mentions } = this.marked(asking);
    const quote = quoteBlock(asking.message.quotes, { group: true, redact: this.deps.mask });
    const full = quote ? `${text}\n${quote}` : text;
    const found = pullsIn(full);
    const key = found.length && this.deps.intent !== undefined ? this.deps.store.links.getKey(asking.sender.id) : null;
    const rules = (): Reading => {
      const ask = parseReviewAsk(text, mentions);
      return ask === undefined ? { kind: "chat" } : { kind: "ask", ask };
    };
    if (!key || this.deps.intent === undefined) return rules();
    const listed = mentions.map((m, i) => ({
      marker: `${MARK_OPEN}${String(i)}${MARK_CLOSE}`,
      id: m.channelUserId || m.userId || m.name,
      name: m.name,
    }));
    const raw = await this.deps.intent.read(key, full, listed);
    if (raw === undefined) return rules();
    const verdict = checkIntent(raw, text, mentions, found, !asking.group);
    if (verdict.kind === "unreadable") {
      this.deps.logger.info("the model's reading of a request was unreadable; the rules read it", { why: verdict.why });
      return rules();
    }
    if (verdict.kind !== "ask") return verdict;
    const ruled = parseReviewAsk(text, mentions);
    if (ruled === undefined) return verdict;
    return this.heldToRules(verdict.ask, ruled, mentions);
  }

  /**
   * Every "请 X ..." line must name the reviewer too; and whether it merges is what the words say, never only the model's
   * reading. A reading that names nobody, or someone else, where the rules read a name is a question, never a guess.
   */
  private heldToRules(reading: ReviewAsk, ruled: ReviewAsk, mentions: readonly Mention[]): Reading {
    const ask = { ...reading, again: ruled.again, merge: ruled.merge };
    const rulesName = bareName(ruled.who);
    const readName = bareName(ask.who);
    const nobody = !readName && (rulesName || ruled.again.some((w) => bareName(w)));
    const someoneElse = rulesName && readName && !namedWithin(ask.who, rulesName, mentions);
    if (nobody || someoneElse) return { kind: "question", text: t.unsureWho };
    return { kind: "ask", ask };
  }
}
