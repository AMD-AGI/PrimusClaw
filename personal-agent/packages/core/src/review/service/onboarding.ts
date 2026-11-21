// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review asked of someone who cannot be acted as yet takes three steps of theirs, each in its own place: their Primus
 * account connected at the identity service, `/github bind`, and `/github auto-merge on` (and their own key, `/link`, when
 * that is missing too). Finishing one looks like being done, so what was asked is kept (`review_onboarding`) and followed:
 * each step they finish is answered with the next one in their own chat, once, and when all are done the asker hears it
 * where they asked, with a button that starts the same request again. Nothing starts without that press, and the press
 * runs every check again (the reviewer's standing authorization included).
 *
 * The identity service tells this worker nothing when a person confirms there, so their state is read again: on the
 * steps done here (`/github bind`, `/github auto-merge`), on any message of theirs, and every ONBOARDING_SWEEP_MS.
 */

import { errorName } from "../../errors.js";
import type { JsonObject } from "../../json.js";
import { onboardingText as t, stepsShown, type OnboardingStep } from "../../locales/review-onboarding.js";
import { noteMessage } from "../../note/note.js";
import { usable } from "../../ports/github.js";
import type { ClickRoute } from "../../ports/routing.js";
import type { ReviewOnboarding } from "../../ports/store/github.js";
import type { Conversation, ConversationRef, InboundMessage, UserRef } from "../../ports/surface.js";
import type { Random } from "../../ports/random.js";
import type { PullRef } from "../../claw/model.js";
import { pullRef, shortName } from "../../review-text/pull-ref.js";
import { reviewAsk, type ReviewAsk } from "../request-parse.js";
import { epochSeconds } from "../../ports/clock.js";
import { personalChat, say, stored } from "./chat.js";
import type { ReviewDeps } from "./deps.js";
import type { Notices } from "./notices.js";
import type { Actor } from "./reviewer.js";
import type { RequestContext } from "./context.js";

/** How often the reviewers something waits for are read again (a confirmation at the identity service sends nothing). */
export const ONBOARDING_SWEEP_MS = 60_000;
/** The click kind of the buttons this sends. */
export const ONBOARDING_CLICK = "review_onboarding";
/** A handoff Claw keeps for 24 hours; a retry after this many seconds starts as an ordinary request of the same reviewer. */
const HANDOFF_REUSE_SECONDS = 23 * 3600;

/** Where a reviewer is: the step to do now, every one done, or undefined when it could not be read just now. */
export type ReviewerProgress = OnboardingStep | "ready";

const RANK: Readonly<Record<ReviewerProgress, number>> = { identity: 1, bind: 2, auto_merge: 3, link: 4, ready: 5 };

/** What is kept of a request to say it again and start it again. */
interface Kept {
  readonly actor: Actor;
  readonly requester: Actor;
  readonly pulls: readonly PullRef[];
  readonly merge: boolean;
  /** The models the request named ("用 X 帮我 review"); none: the default. Checked again when it starts again. */
  readonly models: readonly string[];
  readonly note: string;
  readonly handoffId: string;
  readonly askedAt: number;
  readonly asked: JsonObject;
  readonly group: boolean;
  readonly where: string;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function actorOf(value: unknown): Actor {
  const o = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return { userId: str(o.userId), name: str(o.name), channelUserId: str(o.channelUserId) };
}

function keptOf(row: ReviewOnboarding): Kept | undefined {
  const r = row.request;
  const pulls = Array.isArray(r.pulls)
    ? r.pulls.flatMap((p) => {
        const o = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
        const number = Number(o.number);
        return str(o.owner) && str(o.repo) && Number.isInteger(number) && number > 0
          ? [pullRef(str(o.owner), str(o.repo), number)]
          : [];
      })
    : [];
  const asked = r.asked;
  if (!pulls.length || typeof asked !== "object" || asked === null || Array.isArray(asked)) return undefined;
  return {
    actor: actorOf(r.actor),
    requester: actorOf(r.requester),
    pulls,
    merge: r.merge === true,
    models: Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === "string" && m !== "") : [],
    note: str(r.note),
    handoffId: str(r.handoffId),
    askedAt: typeof r.askedAt === "number" ? r.askedAt : 0,
    asked: asked as JsonObject,
    group: r.group === true,
    where: str(r.where),
  };
}

const names = (rows: readonly Kept[]): string =>
  [...new Set(rows.map((k) => k.requester.name).filter(Boolean))].join("、");

export class ReviewerOnboarding {
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly deps: ReviewDeps,
    private readonly notices: Notices,
    private readonly random: Random,
    /** Starts a request again, as the asker's press of the retry button (the review service's checks). */
    private readonly retry: (ctx: RequestContext, ask: ReviewAsk, actor: Actor) => Promise<void>,
    /** `/github <args>` as the person typed it in their 1:1 chat (the steps' buttons). */
    private readonly github: (sender: UserRef, args: string, conversation: Conversation) => Promise<void>,
  ) {}

  /** Settles when the reads started by messages have ended. For tests. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  /** The step this person is to do now for a review asked of them, or undefined when it cannot be read just now. */
  async progress(userId: string): Promise<ReviewerProgress | undefined> {
    let status: Awaited<ReturnType<ReviewDeps["credentials"]["status"]>>;
    try {
      status = await this.deps.credentials.status(userId);
    } catch (err) {
      this.deps.logger.info("a reviewer's steps could not be read", { error: errorName(err) });
      return undefined;
    }
    if (!status.ok) return status.error.kind === "not_bound" ? "identity" : undefined;
    if (!usable(status.value)) return "bind";
    if (!status.value.delegation) return "auto_merge";
    return this.linked(userId) ? "ready" : "link";
  }

  private linked(userId: string): boolean {
    return (this.deps.store.links.getKey(userId) ?? "").startsWith("ak-");
  }

  /**
   * A review for someone else did not start because `step` is theirs to do: kept, the steps sent to them (once a day, the
   * identity card too while the identity service does not know them), and one line where it was asked naming the step.
   */
  async refused(
    ctx: RequestContext,
    ask: ReviewAsk,
    actor: Actor,
    pulls: readonly PullRef[],
    step: OnboardingStep,
  ): Promise<void> {
    const steps = stepsShown(!this.linked(actor.userId));
    const asked = {
      asker: ctx.sender.name,
      group: ctx.group,
      pulls: pulls.map(shortName).join(", "),
      merge: ask.merge,
    };
    const person: UserRef = { id: actor.userId, channelUserId: actor.channelUserId, name: actor.name, email: "" };
    const store = this.deps.store.reviewDelegation;
    // (the furthest step an earlier ask of theirs, still open, has already told them; one they have since undone is
    // not told, so it is said again)
    const regressed = this.behind(actor.userId, RANK[step]);
    const prior = Math.max(0, ...store.openReviewOnboardings(actor.userId).map((o) => o.toldRank));
    const send = async (chat: Conversation) => {
      await say(this.deps, chat, t.first(asked, steps, step));
      await this.cardAfterText(chat, person, step);
    };
    let sent = prior >= RANK[step];
    if (!sent) {
      const outcome = await this.notices.onceADayOutcome(actor, ctx.conversation.ref, "bind", send);
      // (a notice that went earlier today did not say this step, or no open ask would be short of it: said now, once)
      sent =
        outcome === "sent" ||
        (outcome === "earlier" && (await this.notices.toPerson(actor, ctx.conversation.ref, send)));
    }
    const request: JsonObject = {
      actor: { ...actor },
      requester: { userId: ctx.sender.id, name: ctx.sender.name, channelUserId: ctx.sender.channelUserId },
      pulls: pulls.map((p) => ({ owner: p.owner, repo: p.repo, number: p.number })),
      merge: ask.merge,
      // (the model the asker named runs the retry too, through the same model checks a new request gets)
      models: [...ask.models],
      note: ctx.text,
      handoffId: ask.handoffId,
      askedAt: epochSeconds(this.deps.clock),
      asked: ctx.conversation.ref.wire as JsonObject,
      group: ctx.group,
      where: ctx.group ? ctx.message.conversationName : "",
    };
    store.saveReviewOnboarding({
      onboardingId: this.random.hexId(),
      actorId: actor.userId,
      requesterId: ctx.sender.id,
      pulls: pulls.map(shortName).join(" "),
      request,
      // (not reached: their next message, or the sweep, sends the steps)
      toldRank: sent ? RANK[step] : prior,
    });
    // (said again for a step they undid: the earlier asks were told it too)
    if (regressed && sent) store.claimOnboardingStep(actor.userId, RANK[step]);
    await say(this.deps, ctx.conversation, t.missing(actor.name || "对方", steps, step, sent, ctx.group));
  }

  /**
   * What goes with a step, after its text went: a card that could not be sent is not worth saying the step again for
   * (the text names what to type), so it is only logged and the step counts as said.
   */
  private async cardAfterText(chat: Conversation, person: UserRef, step: OnboardingStep): Promise<void> {
    try {
      await this.stepCard(chat, person, step);
    } catch (err) {
      this.deps.logger.warn("the card under a reviewer's step could not be sent", { error: errorName(err) });
    }
  }

  /** What goes with a step: the identity card, or a button that does the step. */
  private async stepCard(chat: Conversation, person: UserRef, step: OnboardingStep): Promise<void> {
    if (step === "identity") {
      await this.deps.host.connectIdentity(person, chat, "");
      return;
    }
    const button = (title: string, op: string, style?: "positive") => ({
      title,
      verb: `primusclaw.${ONBOARDING_CLICK}`,
      data: { primusclaw: ONBOARDING_CLICK, op },
      ...(style ? { style } : {}),
    });
    if (step === "bind")
      await chat.send(noteMessage({ text: t.bindPrompt, buttons: [button(t.bindButton, "bind", "positive")] }));
    else if (step === "auto_merge")
      await chat.send(
        noteMessage({
          text: t.autoMergePrompt,
          buttons: [button(t.autoMergeButton, "auto_merge_on", "positive"), button(t.declineButton, "decline")],
        }),
      );
  }

  /**
   * A reviewer who undid a step they had done (`/github unbind`, or an identity service that no longer knows them) is
   * behind what they were told: each open ask told further than `rank` is put just below it, so the step they are at
   * now is said again (once, by whoever raises it first). True when any was.
   */
  private behind(userId: string, rank: number): boolean {
    const store = this.deps.store.reviewDelegation;
    let any = false;
    for (const row of store.openReviewOnboardings(userId))
      if (row.toldRank > rank) {
        store.releaseOnboardingStep(row.onboardingId, row.toldRank, rank - 1);
        any = true;
      }
    return any;
  }

  /** A message of this person's: when something waits for them, their state is read again (in the background). */
  activity(userId: string): void {
    if (!this.deps.store.reviewDelegation.openReviewOnboardings(userId).length) return;
    const task = this.advance(userId).catch((err: unknown) => {
      this.deps.logger.warn("a reviewer's next step could not be sent", { error: errorName(err) });
    });
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }

  /** Every reviewer something waits for, read again; every asker still owed a reviewer's no, told. */
  async sweep(): Promise<void> {
    try {
      await this.tellDeclined(this.deps.store.reviewDelegation.declinedReviewOnboardings());
    } catch (err) {
      this.deps.logger.warn("an asker could not be told that the reviewer said no", { error: errorName(err) });
    }
    for (const userId of this.deps.store.reviewDelegation.onboardingReviewers()) {
      try {
        await this.advance(userId);
      } catch (err) {
        this.deps.logger.warn("a reviewer's next step could not be sent", { error: errorName(err) });
      }
    }
  }

  /**
   * This person's state, read again: a step further than they were told is answered with the next one (once, whoever
   * reads it first), and so is a step they undid; all done, each asker is told where they asked. A step that could not
   * be said is claimed back, so the next read (their next message, or the sweep) says it.
   */
  async advance(userId: string): Promise<void> {
    const store = this.deps.store.reviewDelegation;
    if (!store.openReviewOnboardings(userId).length) return;
    const now = await this.progress(userId);
    if (now === undefined) return;
    const rank = RANK[now];
    this.behind(userId, rank);
    const open = store.openReviewOnboardings(userId);
    if (!open.length) return;
    // (whoever raises the told step first says it: a sweep and a message that read the same news say it once)
    if (!store.claimOnboardingStep(userId, rank)) return;
    const unclaim = (rows: readonly ReviewOnboarding[]) => {
      for (const row of rows)
        if (row.toldRank < rank) store.releaseOnboardingStep(row.onboardingId, rank, row.toldRank);
    };
    if (now === "ready") {
      // (read again: one asked since is owed the news too; one not read before is claimed back to nothing told)
      const before = new Map(open.map((o) => [o.onboardingId, o.toldRank]));
      await this.ready(store.openReviewOnboardings(userId), rank, (id) => before.get(id) ?? 0);
      return;
    }
    let said = false;
    try {
      said = await this.tell(userId, open, now);
    } finally {
      if (!said) unclaim(open);
    }
  }

  /** The step `now` said in the reviewer's own chat; false when that chat could not be reached. */
  private async tell(userId: string, open: readonly ReviewOnboarding[], now: OnboardingStep): Promise<boolean> {
    const kept = open.flatMap((row) => keptOf(row) ?? []);
    const first = kept[0];
    if (first === undefined) return false;
    const chat = await personalChat(this.deps, first.actor, this.via(first));
    if (chat === undefined) {
      this.deps.logger.info("a reviewer's next step waits for their chat to be reachable");
      return false;
    }
    const person: UserRef = { id: userId, channelUserId: first.actor.channelUserId, name: first.actor.name, email: "" };
    const steps = stepsShown(!this.linked(userId));
    // (never reached before: what was asked, with every step; else the next one)
    const text = open.every((o) => o.toldRank === 0)
      ? t.first(
          { asker: names(kept), group: first.group, pulls: first.pulls.map(shortName).join(", "), merge: first.merge },
          steps,
          now,
        )
      : t.next(names(kept), steps, now);
    await say(this.deps, chat, text);
    // (said once the text is out: a card that fails after it does not send the step again)
    await this.cardAfterText(chat, person, now);
    return true;
  }

  private via(kept: Kept): ConversationRef | undefined {
    return this.deps.restoreRef(kept.asked);
  }

  /**
   * Every step is done: each asker, where they asked, hears it with the button that asks again, and only then is the
   * request marked told; one that could not be told is claimed back (from `rank`) and told on the next read. The
   * reviewer hears it too.
   */
  private async ready(
    open: readonly ReviewOnboarding[],
    rank: number,
    toldBefore: (onboardingId: string) => number,
  ): Promise<void> {
    const store = this.deps.store.reviewDelegation;
    const told: Kept[] = [];
    for (const row of open) {
      const kept = keptOf(row);
      const where = kept === undefined ? undefined : stored(this.deps, kept.asked);
      // (nowhere to tell, now or later: done)
      if (kept === undefined || where === undefined) {
        store.finishReviewOnboarding(row.onboardingId);
        continue;
      }
      const pulls = kept.pulls.map(shortName).join(", ");
      const text = t.ready(kept.actor.name || "对方", pulls, kept.merge);
      const retry = {
        title: t.retryButton,
        verb: `primusclaw.${ONBOARDING_CLICK}`,
        data: { primusclaw: ONBOARDING_CLICK, op: "retry", id: row.onboardingId },
        style: "positive" as const,
      };
      try {
        await where.send(
          noteMessage({ text: this.deps.mask(text), title: t.readyTitle, tone: "good", buttons: [retry] }),
        );
      } catch (err) {
        this.deps.logger.warn("the asker could not be told that the reviewer is ready", { error: errorName(err) });
        store.releaseOnboardingStep(row.onboardingId, rank, toldBefore(row.onboardingId));
        continue;
      }
      if (store.finishReviewOnboarding(row.onboardingId)) told.push(kept);
    }
    const first = told[0];
    if (first === undefined) return;
    try {
      const chat = await personalChat(this.deps, first.actor, this.via(first));
      if (chat !== undefined) await say(this.deps, chat, t.allDone(names(told)));
    } catch (err) {
      this.deps.logger.warn("the reviewer could not be told that every step is done", { error: errorName(err) });
    }
  }

  /**
   * The reviewer turned their standing authorization off, or said not now: each asker waiting on them is told, once. Each
   * is marked declined first (nothing waits for the reviewer any more), and stays owed to its asker until the telling
   * went, so a send that fails is tried again by the sweep.
   */
  async declined(userId: string): Promise<void> {
    const store = this.deps.store.reviewDelegation;
    for (const row of store.openReviewOnboardings(userId)) store.declineReviewOnboarding(row.onboardingId);
    await this.tellDeclined(store.declinedReviewOnboardings(userId));
  }

  /** Each asker owed a reviewer's no is told it where they asked (once, whoever takes it first); then it is dropped. */
  private async tellDeclined(rows: readonly ReviewOnboarding[]): Promise<void> {
    const store = this.deps.store.reviewDelegation;
    for (const row of rows) {
      if (!store.claimDeclinedOnboarding(row.onboardingId)) continue;
      const kept = keptOf(row);
      const where = kept === undefined ? undefined : stored(this.deps, kept.asked);
      // (nowhere to tell, now or later: done)
      if (kept === undefined || where === undefined) {
        store.dropReviewOnboarding(row.onboardingId);
        continue;
      }
      try {
        await say(this.deps, where, t.refused(kept.actor.name || "对方", kept.pulls.map(shortName).join(", ")));
      } catch (err) {
        this.deps.logger.warn("the asker could not be told that the reviewer said no", { error: errorName(err) });
        store.releaseDeclinedOnboarding(row.onboardingId);
        continue;
      }
      store.dropReviewOnboarding(row.onboardingId);
    }
  }

  /** A press of one of the buttons this sent. */
  async click(click: ClickRoute): Promise<void> {
    const data = click.action.data;
    const op = data.op;
    if (op === "retry") {
      await this.retryClick(click, str(data.id));
      return;
    }
    if (op !== "bind" && op !== "auto_merge_on" && op !== "decline") {
      await click.settle(t.inactive);
      return;
    }
    // (each acts on the presser's own account only, as the same words typed in their 1:1 chat do)
    if (click.conversation.ref.kind !== "personal") {
      await click.settle(t.oneToOne);
      return;
    }
    if (op === "decline") {
      await click.settle(t.declined);
      await this.declined(click.sender.id);
      return;
    }
    await click.settle(op === "bind" ? t.binding : t.allowed);
    await this.github(click.sender, op === "bind" ? "bind" : "auto-merge on", click.conversation);
  }

  /** The asker's press of "ask again": the same request, started again through every check, once. */
  private async retryClick(click: ClickRoute, id: string): Promise<void> {
    const store = this.deps.store.reviewDelegation;
    const row = id ? store.getReviewOnboarding(id) : null;
    const kept = row === null || !row.done || row.declined ? undefined : keptOf(row);
    if (row === null || kept === undefined) {
      await click.settle(t.retryGone);
      return;
    }
    if (click.sender.id !== row.requesterId) {
      const retry = {
        title: t.retryButton,
        verb: `primusclaw.${ONBOARDING_CLICK}`,
        data: { primusclaw: ONBOARDING_CLICK, op: "retry", id },
      };
      await click.settle(noteMessage({ text: t.onlyAsker, title: t.readyTitle, buttons: [retry] }), {
        fallback: t.onlyAsker,
      });
      return;
    }
    store.dropReviewOnboarding(row.onboardingId);
    const pulls = kept.pulls.map(shortName).join(", ");
    await click.settle(t.retried(pulls));
    // (Claw keeps a handoff a day: an older one is asked as an ordinary request, its merge flag as the asker gave it)
    const fresh = epochSeconds(this.deps.clock) - kept.askedAt < HANDOFF_REUSE_SECONDS;
    const ask = reviewAsk({
      who: kept.actor.name,
      pulls: kept.pulls,
      merge: kept.merge,
      models: kept.models,
      named: [kept.actor.channelUserId],
      handoffId: fresh ? kept.handoffId : "",
    });
    const message: InboundMessage = {
      type: "message",
      id: `${click.action.id || row.onboardingId}-retry`,
      sender: click.sender,
      conversation: click.conversation.ref,
      locale: click.action.locale,
      clientPlatform: click.action.clientPlatform,
      text: kept.note,
      mentioned: true,
      targeted: false,
      namesBotFirst: false,
      conversationName: kept.where,
      mentions: [],
      links: [],
      quotes: [],
      files: [],
      unreadableFiles: [],
      provenance: "typed",
    };
    const ctx: RequestContext = {
      message,
      sender: click.sender,
      conversation: click.conversation,
      scope: click.scope,
      text: kept.note,
      group: click.conversation.ref.kind !== "personal",
    };
    await this.retry(ctx, ask, kept.actor);
  }
}
