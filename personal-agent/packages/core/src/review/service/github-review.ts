// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review delegation as the chat sees it: a colleague reviews (and, when it is safe, merges) a public pull request as the
 * person who was named for it. This facade joins its parts (the binding, the request reader, the checks and the start, the
 * turn follow-up, held writes, the asker's follow, item cards, the connect card) and gives the router what it calls: the
 * interceptors, the `/github` command, the card buttons, the turn hooks and the help values.
 */

import type { Lang } from "../../locales/lang.js";
import { reviewRequestText as rt } from "../../locales/review-request.js";
import type { JsonObject } from "../../json.js";
import type { Random } from "../../ports/random.js";
import type { ClickRoute, MessageRoute, RouteHandlers } from "../../ports/routing.js";
import type { Conversation, InboundMessage, UserRef } from "../../ports/surface.js";
import type { ReviewTurnOptions, ReviewTurnOutcome } from "../../turn/runner.js";
import { GithubConnect } from "../connect/github-connect.js";
import type { ReviewHandoff } from "../handoff.js";
import { pullKey } from "../../review-text/pull-ref.js";
import { otherReviewers, reviewAsk } from "../request-parse.js";
import { isReviewMode, type ReviewTurn } from "../review-turn.js";
import { bareName, unique } from "../../review-text/text/unicode.js";
import { GithubAccount } from "./account.js";
import { say } from "./chat.js";
import { HeldWrites } from "./confirm.js";
import type { ReviewDeps } from "./deps.js";
import { AskerFollow } from "./follow.js";
import { NOT_YET, modeOf } from "./identity.js";
import { CARD_SWEEP_MS, ItemCards } from "./item-cards.js";
import { ReviewItems } from "./items.js";
import { ReviewLaunch } from "./launch.js";
import { Notices, type PostWorkCard } from "./notices.js";
import { RequestReader } from "./request.js";
import { ReviewerReader } from "./reviewer.js";
import { ReviewChecks, type RequestContext } from "./start.js";
import { ReviewTurns } from "./turns.js";
import { markedText } from "../../inbound-text/marked-text.js";

const MODE_STRONG = /全自动|档位|哪一?档|代审设置|review[\s_-]*mode|fully[\s_-]*auto/iu;
const MODE_WORDS =
  /全自动|自动合|直接合|不用问|问我|fully[\s_-]*auto|auto[\s_-]*merge|高风险|high[\s_-]*risk|人工(?:再)?确认|ask me|review[\s_-]*(?:mode|setting)|档位|哪一?档|代审|审.{0,6}设置/iu;
const CONFIRM_MODE_WORDS = {
  high_risk_confirm: ["高风险时再问你", "ask you on high risk"],
  fully_auto: ["全自动合入", "fully automatic"],
} as const;
/** Help waits this long, at most, for the identity service. */
const HELP_LOOKUP_MS = 3000;

export class GithubReview {
  readonly account: GithubAccount;
  readonly connect: GithubConnect;
  private readonly reviewers: ReviewerReader;
  private readonly requests: RequestReader;
  private readonly notices: Notices;
  private readonly cards: ItemCards;
  private readonly follows: AskerFollow;
  private readonly items: ReviewItems;
  private readonly turns: ReviewTurns;
  private readonly held: HeldWrites;
  private readonly checks: ReviewChecks;
  private readonly launch: ReviewLaunch;

  constructor(
    private readonly deps: ReviewDeps,
    random: Random,
    postWorkCard: PostWorkCard,
  ) {
    this.account = new GithubAccount(deps);
    this.connect = new GithubConnect(deps, this.account, random);
    this.reviewers = new ReviewerReader(deps);
    this.requests = new RequestReader(deps);
    this.notices = new Notices(deps, postWorkCard);
    this.cards = new ItemCards(deps, (itemId) => this.follows.following(itemId));
    this.follows = new AskerFollow(deps, this.cards, this.notices);
    this.items = new ReviewItems(deps);
    this.turns = new ReviewTurns(deps, this.notices, this.cards, this.follows);
    this.held = new HeldWrites(deps, this.notices, this.account);
    this.turns.offerHeld = (review, item, asked) => this.held.offer(review, item, asked);
    this.launch = new ReviewLaunch(deps, this.items, this.notices, this.cards, this.follows, this.turns);
    this.checks = new ReviewChecks(deps, this.reviewers, this.items, this.notices, (s, held, handed) =>
      this.launch.launch(s, held, handed),
    );
    this.turns.retryAsItem = (review, s) => this.launch.asItem(review, s);
  }

  /** Settles when the background work started so far (device flows, follows, hints) has ended. For tests. */
  async idle(): Promise<void> {
    await Promise.all([this.account.idle(), this.follows.idle(), this.connect.idle()]);
  }

  /** Which channel id is whose, from a message of theirs: a mention in a group can then be read without the member list. */
  remember(message: InboundMessage): void {
    const sender = message.sender;
    if (sender.channelUserId)
      this.deps.store.members.rememberMember(sender.channelUserId, sender.id, sender.name, sender.email);
  }

  private context(route: MessageRoute): RequestContext {
    return {
      message: route.message,
      sender: route.sender,
      conversation: route.conversation,
      scope: route.scope,
      text: route.message.text,
      group: route.message.conversation.kind !== "personal",
    };
  }

  /**
   * A message that may be "请 XX 帮我 review 合入 <PR> [<PR> ...]". True when it was one (answered here, or started), false
   * for any other message. Whoever is named is the only account that is ever used: no one stands in for them.
   */
  async request(route: MessageRoute): Promise<boolean> {
    const ctx = this.context(route);
    const asking = { message: ctx.message, sender: ctx.sender, group: ctx.group };
    const expanded = await this.requests.barePulls(asking);
    if (typeof expanded === "string") {
      await say(this.deps, ctx.conversation, expanded);
      return true;
    }
    const message = expanded.message;
    const reading = await this.requests.read({ ...asking, message });
    if (reading.kind === "chat") return false;
    if (reading.kind === "question") {
      await say(this.deps, ctx.conversation, reading.text);
      return true;
    }
    // A number read as a pull request that the reading then left out is named back too.
    const kept = new Set(reading.ask.pulls.map(pullKey));
    const left = expanded.taken.filter((k) => !kept.has(k)).map((k) => Number(k.split("\u0000")[2]));
    let ask = { ...reading.ask, repo: expanded.repo, unread: unique([...expanded.stray, ...left]) };
    if (!bareName(ask.who) && ctx.group) {
      await say(this.deps, ctx.conversation, rt.askWho);
      return true;
    }
    const others = otherReviewers(ask);
    if (others.length) {
      await say(this.deps, ctx.conversation, rt.laterLineNamesOthers({ names: others.join("、") }));
      return true;
    }
    // One request is one reviewer, whoever read it: everyone the message mentions or names is one person, or nothing starts.
    const marked = markedText(message.text, message.mentions, {
      links: message.links,
      group: ctx.group,
      redact: this.deps.mask,
    });
    const { people, count } = await this.reviewers.peopleNamed(
      { conversation: ctx.conversation.ref, group: ctx.group },
      marked.text,
      ask,
    );
    if (count > 1) {
      await say(this.deps, ctx.conversation, rt.mentionsSeveral({ names: ReviewerReader.namesOf(people) }));
      return true;
    }
    ask = { ...ask, named: [...people.keys()] };
    await this.checks.request({ ...ctx, message }, ask);
    return true;
  }

  /**
   * A review the person's assistant handed back: started exactly as the same request typed here is, as the reviewer, with
   * the reviewer's own exchanged token and linked key, and answered in `conversation`.
   */
  async handoff(
    message: InboundMessage,
    sender: UserRef,
    conversation: Conversation,
    handoff: ReviewHandoff,
  ): Promise<void> {
    const members = this.deps.store.members;
    const userId = this.deps.store.links.userForClawUser(handoff.reviewerUserId) ?? "";
    const name = handoff.reviewerName || (userId ? members.memberName(userId) : "") || "对方";
    if (!userId) {
      await say(
        this.deps,
        conversation,
        `${name} 还没有在 Clawy 里连接自己的 Primus key（1:1 里发 \`/link\`），我没法以 TA 的身份 review，所以没有开始 review。`,
      );
      return;
    }
    const channelUserId = members.channelIdOf(userId) ?? "";
    const ask = reviewAsk({
      who: name,
      pulls: handoff.pulls,
      merge: handoff.merge,
      named: [channelUserId],
      handoffId: handoff.handoffId,
    });
    const ctx: RequestContext = {
      message,
      sender,
      conversation,
      scope: "",
      text: handoff.note,
      group: message.conversation.kind !== "personal",
    };
    await this.checks.request(ctx, ask, { userId, name, channelUserId });
  }

  /** A 1:1 message that asks, in the person's own words, to change or see the confirmation setting. True when it was one. */
  async modeMessage(sender: UserRef, text: string, conversation: Conversation): Promise<boolean> {
    if (!MODE_WORDS.test(text) || Array.from(text).length > 300) return false;
    const key = this.deps.intent === undefined ? null : this.deps.store.links.getKey(sender.id);
    const raw = key && this.deps.intent !== undefined ? await this.deps.intent.readMode(key, text) : undefined;
    if (raw === undefined && !MODE_STRONG.test(text)) return false;
    const suggested = raw === undefined ? "" : modeWanted(raw);
    if (suggested === null) return false;
    await this.account.showMode(sender, suggested, conversation);
    return true;
  }

  /** What the turn engine is given for a review. */
  turnOptions(review: ReviewTurn, modelKey: string): ReviewTurnOptions {
    return this.turns.options(review, modelKey);
  }

  /** A review's turn has ended (the router calls this with what the engine collected). */
  afterTurn(review: ReviewTurn, finalAnswer: string, outcome: ReviewTurnOutcome, asked: Conversation): Promise<void> {
    return this.turns.afterTurn(review, finalAnswer, outcome, asked);
  }

  /** The asker stopped an item from its card, where that is said. */
  itemStopped(itemId: string): void {
    this.follows.itemStopped(itemId);
  }

  /** Called once the worker runs: the follows of the last worker are taken up again. */
  resume(): number {
    return this.follows.resume();
  }

  /** Open review cards are checked for an item that is over, now and then every CARD_SWEEP_MS, until `signal` aborts. */
  async sweepCards(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.cards.closeEnded();
      } catch (err) {
        this.deps.logger.warn("the sweep of open review cards failed", {
          error: err instanceof Error ? err.name : "Error",
        });
      }
      try {
        await this.deps.clock.sleep(CARD_SWEEP_MS, signal);
      } catch {
        return;
      }
    }
  }

  /** The open confirmations of the person (the assistant's context). */
  pendingConfirmations(userId: string): readonly JsonObject[] {
    return this.deps.store.githubConfirmations.pendingGithubConfirmations(userId).map((r) => ({
      pull_request: `${r.repo}#${String(r.pr)}`,
      waits: r.kind === "review" ? `${r.event} review to post` : "merge",
    }));
  }

  /** Help's values of the person's GitHub ("github", "delegation", "confirm_mode"); those it cannot read are left out. */
  async helpValues(userId: string, lang: Lang): Promise<Readonly<Record<string, string>>> {
    const zh = lang === "zh";
    const [on, off] = zh ? ["开", "关"] : ["on", "off"];
    const status = await this.within(this.deps.credentials.status(userId));
    if (status === undefined || !status.ok) return {};
    const state = status.value;
    const values: Record<string, string> = { github: githubWord(state, zh), delegation: state.delegation ? on : off };
    if (!state.bound) return values;
    // (Claw holds it; before Claw has the setting, the default is what applies)
    const mode = await this.within(modeOf(this.deps, userId));
    if (isReviewMode(mode)) values.confirm_mode = CONFIRM_MODE_WORDS[mode][zh ? 0 : 1];
    if (mode === NOT_YET) {
      const fallback = CONFIRM_MODE_WORDS.high_risk_confirm[zh ? 0 : 1];
      values.confirm_mode = zh ? `默认：${fallback}` : `default: ${fallback}`;
    }
    return values;
  }

  private async within<T>(promise: Promise<T>): Promise<T | undefined> {
    const stop = new AbortController();
    const late = this.deps.clock.sleep(HELP_LOOKUP_MS, stop.signal).then(() => undefined);
    try {
      return await Promise.race([promise, late]);
    } catch {
      return undefined;
    } finally {
      stop.abort();
      late.catch(() => undefined);
    }
  }

  /** What the review delegation brings the router. */
  routeHandlers(): RouteHandlers {
    const interceptor = (name: string) => ({ name, intercept: (route: MessageRoute) => this.request(route) });
    return {
      personalInterceptors: [
        {
          name: "github-typed-answer",
          intercept: (r: MessageRoute) => this.held.typed(r.sender, r.message.text, r.conversation),
        },
        {
          name: "github-mode",
          intercept: (r: MessageRoute) => this.modeMessage(r.sender, r.message.text, r.conversation),
        },
        interceptor("github-review-request"),
      ],
      groupInterceptors: [interceptor("github-review-request")],
      commands: [
        {
          name: "github",
          beforeCredential: true,
          run: async (route, args) => {
            this.connect.forget(route.sender.id);
            if (route.message?.conversation.kind !== "personal") return false;
            await this.account.command(route.sender, args, route.conversation);
            return true;
          },
        },
      ],
      clicks: [
        {
          verbs: ["primusclaw.github_mode", "primusclaw.github_confirm", "primusclaw.github_connect"],
          beforeCredential: async (click: ClickRoute) => {
            await this.click(click);
            return true;
          },
        },
      ],
    };
  }

  private async click(click: ClickRoute): Promise<void> {
    const data = click.action.data;
    const settle = (card: Parameters<ClickRoute["settle"]>[0], fallback?: string): Promise<boolean> =>
      click.settle(card, fallback === undefined ? {} : { fallback });
    if (data.primusclaw === "github_mode") await this.account.modeClick(click.sender, data, settle, click.conversation);
    else if (data.primusclaw === "github_confirm")
      await this.held.click(click.sender, data, settle, click.conversation);
    else await this.connect.dismiss(click.sender, data, click.lang(), settle);
  }
}

/** How help says the binding: its login, expired, or not connected. */
function githubWord(
  state: { readonly bound: boolean; readonly expired: boolean; readonly login: string },
  zh: boolean,
): string {
  if (!state.bound) return zh ? "未连接" : "not connected";
  if (state.expired) return zh ? "已过期" : "expired";
  return `\`${state.login}\``;
}

/** The setting a model reading asks for: a mode, "show" to see it, or null when the reading is not about it. */
function modeWanted(raw: Readonly<Record<string, unknown>>): "high_risk_confirm" | "fully_auto" | "show" | null {
  if (raw.intent === "show_review_mode") return "show";
  if (raw.intent !== "set_review_mode" || !isReviewMode(raw.mode)) return null;
  return raw.mode;
}
