// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every prerequisite of a review, checked before anything exists in Claw (a session spends a model key, and a review that
 * cannot be finished must not cost one): the asker's identity, the reviewer's GitHub binding and standing authorization, the
 * reviewer's own token and key for a review asked of them, the model the request names, and that the reviewer did not write
 * the pull request. Whichever is missing: one line where it was asked, and the steps in the person's own chat.
 */

import { errorKind } from "../../claw/errors.js";
import { reviewStartText as t } from "../../locales/review-start.js";
import { describeRefusal, usable, type GithubState } from "../../ports/github.js";
import type { Conversation, ConversationRef, InboundMessage, UserRef } from "../../ports/surface.js";
import { oneLine } from "../names.js";
import { type PullRef, shortName, slug } from "../pull-ref.js";
import { MAX_MODELS_LISTED, MAX_PULLS_PER_REQUEST, REVIEWS_STARTED_AT_ONCE, refusedText } from "../refusals.js";
import type { ReviewAsk } from "../request-parse.js";
import { type ReviewTurn, reviewTurn } from "../review-turn.js";
import { bareName, pickLang } from "../text/unicode.js";
import type { ReviewDeps, ReviewSlots } from "./deps.js";
import { clawFailure, tokenFor } from "./identity.js";
import type { ReviewItems } from "./items.js";
import type { Notices } from "./notices.js";
import type { Actor, ReviewerReader } from "./reviewer.js";
import { say } from "./chat.js";

/** Where and by whom a request was made. */
export interface RequestContext {
  readonly message: InboundMessage;
  readonly sender: UserRef;
  readonly conversation: Conversation;
  readonly scope: string;
  /** What the person wrote (the asker's note to the reviewer). */
  readonly text: string;
  readonly group: boolean;
}

/** What `take` settled, for the start: who asks and for whom, with what. */
export interface Settled {
  readonly ctx: RequestContext;
  readonly ask: ReviewAsk;
  readonly token: string;
  readonly modelKey: string;
  readonly requester: Actor;
  readonly actor: Actor;
  readonly state: GithubState;
  readonly model: string;
  readonly actingToken: string;
  readonly actingKey: string;
  readonly reviews: ReviewTurn[];
  readonly refused: [PullRef, string][];
  readonly several: boolean;
  /** Gives back the per-person count of each review given to it that did not start. */
  readonly giveBack: (notStarted: readonly ReviewTurn[]) => void;
  readonly slots: ReviewSlots | undefined;
}

export type Launch = (settled: Settled, held: PullRef[], handed: PullRef[]) => Promise<void>;

const asked = (ctx: RequestContext): ConversationRef => ctx.conversation.ref;

export class ReviewChecks {
  constructor(
    private readonly deps: ReviewDeps,
    private readonly reviewers: ReviewerReader,
    private readonly items: ReviewItems,
    private readonly notices: Notices,
    private readonly launch: Launch,
  ) {}

  private say(ctx: RequestContext, text: string): Promise<void> {
    return say(this.deps, ctx.conversation, text);
  }

  /** The pull requests' checks, then `take`. `named`: the reviewer, already known (a handoff); undefined: read from the message. */
  async request(ctx: RequestContext, ask: ReviewAsk, named?: Actor): Promise<void> {
    if (!ask.pulls.length) {
      await this.say(ctx, t.attachPulls(ask.unread.join("、")));
      return;
    }
    if (ask.pulls.length > MAX_PULLS_PER_REQUEST) {
      await this.say(ctx, t.tooMany(MAX_PULLS_PER_REQUEST, REVIEWS_STARTED_AT_ONCE, ask.pulls.length));
      return;
    }
    if (ask.models.length > 1) {
      await this.say(ctx, t.oneModel(ask.models.join("、")));
      return;
    }
    const allowed = new Set(this.deps.owners.map((o) => o.toLowerCase()));
    const refused: [PullRef, string][] = [];
    const pulls = ask.pulls.filter((pull) => {
      if (allowed.has(pull.owner.toLowerCase())) return true;
      refused.push([pull, t.ownersOnly(this.deps.owners.join("、"))]);
      return false;
    });
    const several = ask.pulls.length > 1;
    if (!pulls.length) {
      await this.say(ctx, several ? t.noneStarted(refusedText(refused)) : t.ownersOnlyOne(this.deps.owners.join("、")));
      return;
    }
    // Whether one is being reviewed already is Claw's to say; only a Claw without review items leaves it to this worker.
    const held: PullRef[] = [];
    const handed: PullRef[] = [];
    try {
      await this.take(ctx, ask, pulls, refused, several, named, held, handed);
    } finally {
      for (const pull of held) if (!handed.includes(pull)) this.items.release(pull);
    }
  }

  /** The asker's identity token, or undefined when they were told what to do. */
  private async askerToken(ctx: RequestContext): Promise<string | undefined> {
    const token = await tokenFor(this.deps, ctx.sender.id);
    if ("token" in token) return token.token;
    if (token.failed === "unavailable") {
      this.deps.logger.warn("the token to start a review could not be exchanged", { error: token.reason });
      await this.say(ctx, t.platformDown);
      return undefined;
    }
    // (not connected, or connected with an API key only: the usual onboarding)
    if (this.deps.store.links.getKey(ctx.sender.id) !== null)
      await this.say(ctx, t.identityOnly(ctx.sender.name || "你"));
    if (ctx.group) await this.deps.host.onboard(ctx.message, ctx.sender, ctx.conversation, ctx.scope);
    else await this.deps.host.connectIdentity(ctx.sender, ctx.conversation, t.connectLead);
    return undefined;
  }

  /** Who reviews: the asker (a 1:1 chat that names nobody), the reviewer a handoff named, or the one the message names. */
  private async whoReviews(
    ctx: RequestContext,
    ask: ReviewAsk,
    requester: Actor,
    named: Actor | undefined,
  ): Promise<Actor | undefined> {
    if (named !== undefined) return named.userId === requester.userId ? requester : named;
    const nobody = !bareName(ask.who);
    const own = !ctx.group && nobody && ask.named.every((id) => id === requester.channelUserId);
    if (own) return requester;
    if (nobody && !ctx.group) {
      // (nobody named, yet someone is: ask)
      await this.say(ctx, t.unsureWho);
      return undefined;
    }
    const actor = await this.reviewers.resolve({ conversation: asked(ctx), group: ctx.group }, ask);
    if ("unknown" in actor) {
      await this.say(ctx, actor.unknown);
      return undefined;
    }
    // (a reading, or a quote, named someone the asker's own words do not)
    if (!ask.named.includes(actor.channelUserId)) {
      await this.say(ctx, t.unsureWhoFull);
      return undefined;
    }
    return actor;
  }

  /** The reviewer's GitHub binding, usable and authorized, or undefined when the asker was told why not. */
  private async reviewerState(
    ctx: RequestContext,
    ask: ReviewAsk,
    actor: Actor,
    pulls: readonly PullRef[],
  ): Promise<GithubState | undefined> {
    const status = await this.deps.credentials.status(actor.userId);
    if (!status.ok) {
      if (status.error.kind === "not_bound") {
        await this.notices.noGithub(asked(ctx), ctx.group, ctx.sender, actor, pulls, ctx.conversation, false);
        return undefined;
      }
      this.deps.logger.warn("github status call failed", { error: describeRefusal(status.error) });
      await this.say(ctx, t.githubUnknown(actor.name || "对方"));
      return undefined;
    }
    if (!usable(status.value)) {
      await this.notices.noGithub(asked(ctx), ctx.group, ctx.sender, actor, pulls, ctx.conversation, true);
      return undefined;
    }
    // (the authorization is the switch; Claw refuses every tool without it)
    if (!status.value.delegation && actor.userId !== ctx.sender.id) {
      await this.say(ctx, t.notAuthorized(actor.name || "对方", ask.merge));
      return undefined;
    }
    return status.value;
  }

  /** A review asked of someone else runs on their own token and key: both, or undefined when the asker was told. */
  private async actingCredentials(
    ctx: RequestContext,
    actor: Actor,
  ): Promise<{ token: string; key: string } | undefined> {
    if (actor.userId === ctx.sender.id) return { token: "", key: "" };
    const who = actor.name || "对方";
    const key = this.deps.store.links.getKey(actor.userId) ?? "";
    if (!key.startsWith("ak-")) {
      await this.say(ctx, t.reviewerNotLinked(who));
      return undefined;
    }
    const token = await tokenFor(this.deps, actor.userId);
    if ("token" in token) return { token: token.token, key };
    if (token.failed === "not_bound") await this.say(ctx, t.reviewerNotConnected(who));
    else {
      this.deps.logger.warn("the reviewer's token could not be exchanged", { error: token.reason });
      await this.say(ctx, t.reviewerPlatformDown(who));
    }
    return undefined;
  }

  /** The model the request named, as the key that pays may use it; '' the default; undefined when the asker was told why not. */
  private async modelFor(
    ctx: RequestContext,
    ask: ReviewAsk,
    token: string,
    payingKey: string,
    acting: boolean,
    who: string,
  ): Promise<string | undefined> {
    const [named] = ask.models;
    if (named === undefined) return "";
    // A Claw that chooses a review's model runs one asked of someone else on that person's own settings, and says so.
    if (acting && (await this.items.clawChoosesModels(token)))
      return oneLine(named.replace(/[^A-Za-z0-9._:/-]/gu, ""), 128);
    const whose = acting ? `${who} 的` : "你的";
    let available: string[];
    try {
      available = await this.deps.claw.settings.models(payingKey);
    } catch (err) {
      if (!clawFailure(err)) throw err;
      this.deps.logger.warn("the models of the asker's key could not be listed", { error: errorKind(err) });
      await this.say(ctx, t.modelsUnknown(whose, named));
      return undefined;
    }
    const model = available.find((m) => m === named) ?? available.find((m) => m.toLowerCase() === named.toLowerCase());
    if (model !== undefined) return model;
    const listed =
      available.slice(0, MAX_MODELS_LISTED).join("、") +
      (available.length > MAX_MODELS_LISTED ? ` 等 ${String(available.length)} 个` : "");
    await this.say(ctx, t.modelUnusable(whose, oneLine(named, 100), listed, available.length > 0));
    return undefined;
  }

  private async take(
    ctx: RequestContext,
    ask: ReviewAsk,
    pulls: readonly PullRef[],
    refused: [PullRef, string][],
    several: boolean,
    named: Actor | undefined,
    held: PullRef[],
    handed: PullRef[],
  ): Promise<void> {
    const token = await this.askerToken(ctx);
    if (token === undefined) return;
    const requester: Actor = { userId: ctx.sender.id, name: ctx.sender.name, channelUserId: ctx.sender.channelUserId };
    // (the asker's own key: only a review of their own runs on it)
    const modelKey = this.deps.store.links.getKey(ctx.sender.id) ?? "";
    const actor = await this.whoReviews(ctx, ask, requester, named);
    if (actor === undefined) return;
    if (!modelKey && actor.userId === ctx.sender.id) {
      await this.notices.requesterMustLink(asked(ctx), ctx.group, requester, ctx.conversation, pulls);
      return;
    }
    const state = await this.reviewerState(ctx, ask, actor, pulls);
    if (state === undefined) return;
    const acting = await this.actingCredentials(ctx, actor);
    if (acting === undefined) return;
    const who = actor.name || "对方";
    const model = await this.modelFor(ctx, ask, token, acting.key || modelKey, Boolean(acting.key), who);
    if (model === undefined) return;
    const built = await this.build(ctx, ask, pulls, refused, several, actor, requester, state, model, who);
    if (built === undefined) return;
    const slots = await this.admit(ctx, built.reviews, refused, built.giveBack, modelKey);
    try {
      await this.launch(
        {
          ctx,
          ask,
          token,
          modelKey,
          requester,
          actor,
          state,
          model,
          actingToken: acting.token,
          actingKey: acting.key,
          reviews: slots.reviews,
          refused,
          several,
          giveBack: built.giveBack,
          slots: slots.slots,
        },
        held,
        handed,
      );
    } finally {
      slots.slots?.release();
    }
  }

  /** One review per pull request, each counted for the asker; a pull request its reviewer wrote is refused. */
  private async build(
    ctx: RequestContext,
    ask: ReviewAsk,
    pulls: readonly PullRef[],
    refused: [PullRef, string][],
    several: boolean,
    actor: Actor,
    requester: Actor,
    state: GithubState,
    model: string,
    who: string,
  ): Promise<{ reviews: ReviewTurn[]; giveBack: (notStarted: readonly ReviewTurn[]) => void } | undefined> {
    const read = await Promise.all(pulls.map((pull) => this.deps.pulls.read(pull)));
    const where = ctx.group ? oneLine(ctx.message.conversationName, 60) || "群聊" : "私聊";
    const reviews: ReviewTurn[] = [];
    const tickets = new Map<ReviewTurn, object>();
    for (const [index, pull] of pulls.entries()) {
      const { author, title } = read[index] ?? { author: undefined, title: "" };
      // (undefined: not read; Claw's own rule is the backstop)
      if (author !== undefined && author.toLowerCase() === state.login.toLowerCase()) {
        if (!several) {
          await this.say(ctx, t.ownPull(shortName(pull), who));
          return undefined;
        }
        refused.push([pull, t.ownPullShort(who)]);
        continue;
      }
      // Each review started is one use of a colleague's GitHub account, counted for the person who asked
      const ticket = {};
      const limited = this.deps.guard.take(ctx.sender.id, "pr_review", ticket, {
        repo: slug(pull),
        pr_number: pull.number,
      });
      if (limited !== undefined) {
        if (!several) {
          await this.say(ctx, t.limited(shortName(pull), limited.text(true), limited.text()));
          return undefined;
        }
        refused.push([pull, t.limitedShort]);
        continue;
      }
      const review = reviewTurn({
        requesterId: ctx.sender.id,
        requesterName: ctx.sender.name,
        requesterChannelId: requester.channelUserId,
        actorId: actor.userId,
        actorUserId: state.userId,
        actorName: actor.name,
        actorChannelId: actor.channelUserId,
        pull,
        asked: ctx.conversation.ref,
        model,
        title,
        where,
        fromGroup: ctx.group,
        lang: pickLang(ctx.text),
        reviewOnly: !ask.merge,
        actorLogin: state.login,
      });
      reviews.push(review);
      tickets.set(review, ticket);
    }
    // (one that does not start gives exactly its own count back)
    const giveBack = (notStarted: readonly ReviewTurn[]): void => {
      for (const review of notStarted) {
        const ticket = tickets.get(review);
        if (ticket !== undefined) this.deps.guard.giveBack(ctx.sender.id, "pr_review", ticket);
      }
    };
    return { reviews, giveBack };
  }

  /** The task limit, checked before Claw is asked: only the reviews that start now hold a slot. */
  private async admit(
    ctx: RequestContext,
    reviews: ReviewTurn[],
    refused: [PullRef, string][],
    giveBack: (notStarted: readonly ReviewTurn[]) => void,
    modelKey: string,
  ): Promise<{ reviews: ReviewTurn[]; slots: ReviewSlots | undefined }> {
    if (!reviews.length || this.deps.host.admitReviews === undefined) return { reviews, slots: undefined };
    const needed = Math.min(reviews.length, REVIEWS_STARTED_AT_ONCE);
    const slots = await this.deps.host.admitReviews(ctx.message, ctx.sender, needed, modelKey);
    if (slots.granted >= needed) return { reviews, slots };
    const over = t.overTasks(slots.running, slots.limit);
    const dropped = reviews.slice(slots.granted);
    for (const review of dropped) refused.push([review.pull, over]);
    giveBack(dropped); // (not started: over the task limit)
    return { reviews: reviews.slice(0, slots.granted), slots };
  }
}
