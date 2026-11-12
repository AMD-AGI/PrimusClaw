// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turn engine as the router starts it (`TurnRunner`, W4's port): a router's `TurnRun` and `TurnHooks` become one
 * turn's context, and the turn runs to its answer. Review turns carry their own options (`ReviewTurnOptions`), which the
 * review service fills in.
 */

import type { Integrations } from "../plugins/integrations.js";
import type { ModelRefusalPolicy } from "../plugins/model-refusal-policy.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { TurnCards } from "../ports/turn-cards.js";
import type { ConversationKind, Envelope, UserRef } from "../ports/surface.js";
import type { PublicErrors } from "../public-error/public-errors.js";
import type { TurnHooks as RouterHooks, TurnOutcome, TurnRun, TurnRunner } from "../routing/turn-runner.js";
import type { PullRef } from "../claw/model.js";
import { newRecord, type TurnContext, type TurnHooks, type TurnRequest, type TurnStyle } from "./engine/context.js";
import { runTurn } from "./engine/run-turn.js";
import { lastAnswer } from "./last-answer.js";
import type { GithubOutcome } from "./github-outcome.js";
import type { TurnClaw } from "./ports.js";

/**
 * Every approval or question card a turn shows is recorded before it is sent (1:1 too): its owner is known when it is
 * clicked, and Claw's notification for the same approval then sends no second card. W5 implements it over the store.
 */
export interface TurnApprovals {
  /**
   * False when a card for this approval is already in a chat: the turn then shows none. `userId`: the person the turn is for,
   * whose approval it is (Python `store.save_approval(sender.aad_id, ...)`).
   */
  record(
    userId: string,
    sessionId: string,
    toolUseId: string,
    tool: string,
    expiresIn: number | undefined,
    envelope: Envelope,
    questions?: unknown,
  ): boolean;
  sent(sessionId: string, toolUseId: string, cardId?: string): void;
  unsent(sessionId: string, toolUseId: string): void;
}

/** What a review turn adds to a chat turn (the review service fills it in). */
export interface ReviewTurnOptions {
  /** The id of the user whose GitHub account the session's tools use. */
  readonly actingAs: string;
  readonly reviewTarget: PullRef;
  /** The requester's own linked key, beside the exchanged token. Never logged. */
  readonly modelKey: string;
  readonly reviewModel: string;
  readonly reviewOnly: boolean;
  /** A review Claw made itself: its session is followed, nothing is sent. */
  readonly attach: boolean;
  readonly attachMessageId: string;
  /** Its acknowledgement, at the top of the progress message. */
  readonly lead: string;
  /** Asked in a group: the asker, whom the answer @mentions. */
  readonly mention: UserRef | undefined;
  /** The review's one message: its result line and summary. */
  readonly shapeAnswer: (
    answer: string,
    link: string,
    model: string,
    results: GithubOutcome[],
    comments: number,
    prSummary: string,
  ) => string;
  /** Each finished GitHub write, as it arrives: the line shown at the top of the progress message. */
  readonly onGithubResult: (outcome: GithubOutcome, model: string) => string | undefined;
  /** Claw refused the session as `acting_as_must_be_self`: asks for the review as the reviewer's item instead. */
  readonly asItem?: () => Promise<boolean>;
}

/** What a review turn tells the review service once it is over (agent.py's reading of the turn's context after it). */
export interface ReviewTurnOutcome {
  /** The review was asked for again as the reviewer's item, and the asker told (`asItem`). */
  readonly moved: boolean;
  /** Claw refused the asker's credentials (401): its status and error word; null when it did not. */
  readonly refusal: { readonly status: number; readonly code: string } | null;
  /** The model the turn ran on. */
  readonly ranModel: string;
  /** What the turn wrote to GitHub (a review posted, a merge, a place in the queue); not every call it made. */
  readonly wrote: readonly GithubOutcome[];
  /** The sentence of what the pull request does that a review or merge call gave. */
  readonly prSummary: string;
}

declare module "../routing/turn-runner.js" {
  interface ReviewRunFields {
    readonly turn: ReviewTurnOptions;
  }
  interface TurnOutcome {
    /** A review turn only. */
    readonly review?: ReviewTurnOutcome;
  }
}

function reviewOutcome(record: TurnContext["record"]): ReviewTurnOutcome {
  const refusal = record.refusal ? { status: record.refusal.status, code: record.refusal.code } : null;
  return {
    moved: record.moved,
    refusal,
    ranModel: record.ranModel,
    wrote: [...record.wrote],
    prSummary: record.prSummary,
  };
}

export interface TurnEngineDeps {
  readonly claw: TurnClaw;
  readonly clock: Clock;
  readonly log: Logger;
  readonly refusals: ModelRefusalPolicy;
  readonly errors: PublicErrors;
  readonly publicBaseUrl: string;
  /** The reply style's switches, and in which kinds of chat a turn is shown by a live stream. */
  readonly style: TurnStyle & { readonly streamsIn: (kind: ConversationKind) => boolean };
  readonly approvals: TurnApprovals;
  /** The approval, question and thumbs cards (the approvals' and the feedback feature's). */
  readonly cards: TurnCards;
  /** Fetches the files a person sent (undefined: this worker takes none). */
  readonly fetchFiles?: TurnHooks["fetchFiles"];
  readonly onFilesDropped?: TurnHooks["onFilesDropped"];
  /** A deployment's MCP servers, named in progress lines. */
  readonly integrations?: Integrations;
}

function reviewRequest(review: ReviewTurnOptions): Partial<TurnRequest> {
  return {
    actingAs: review.actingAs,
    reviewTarget: review.reviewTarget,
    ...(review.modelKey ? { modelKey: review.modelKey } : {}),
    ...(review.reviewModel ? { reviewModel: review.reviewModel } : {}),
    reviewOnly: review.reviewOnly,
    attach: review.attach,
    attachMessageId: review.attachMessageId,
    lead: review.lead,
    ...(review.mention ? { mention: review.mention } : {}),
  };
}

function reviewHooks(review: ReviewTurnOptions): Partial<TurnHooks> {
  return {
    shapeAnswer: review.shapeAnswer,
    onGithubResult: review.onGithubResult,
    ...(review.asItem ? { asItem: review.asItem } : {}),
  };
}

export class TurnEngine implements TurnRunner {
  constructor(private readonly deps: TurnEngineDeps) {}

  private request(run: TurnRun): TurnRequest {
    const kind = run.conversation.ref.kind;
    const review = run.review?.turn;
    return {
      key: run.credential,
      text: run.text,
      idempotencyKey: run.messageId,
      publicBaseUrl: this.deps.publicBaseUrl,
      ...(this.deps.style.streamsIn(kind) && run.messageId ? { streamReplyTo: run.messageId } : {}),
      group: run.group,
      ownerName: run.ownerName,
      notifies: run.notifies,
      model: run.model,
      fallbackModel: run.fallbackModel,
      ownThumbs: run.ownThumbs,
      ...(run.repo ? { repo: [run.repo.url, run.repo.branch] as const } : {}),
      showChanges: run.showChanges,
      quote: run.quote,
      sent: run.sent,
      lang: run.lang,
      files: run.files,
      ...(review ? reviewRequest(review) : {}),
    };
  }

  private hooks(run: TurnRun, hooks: RouterHooks): TurnHooks {
    const { approvals } = this.deps;
    const review = run.review?.turn;
    return {
      ...(run.provider ? { keyProvider: run.provider } : {}),
      onApproval: (sid, toolUseId, tool, expiresIn, envelope, questions) =>
        approvals.record(run.userId, sid, toolUseId, tool, expiresIn, envelope, questions),
      onApprovalSent: (sid, toolUseId, cardId) => {
        approvals.sent(sid, toolUseId, cardId);
      },
      onApprovalUnsent: (sid, toolUseId) => {
        approvals.unsent(sid, toolUseId);
      },
      onTurn: (sid, what, messageId) => {
        hooks.onTurn(sid, what, messageId);
      },
      onRunning: () => {
        hooks.onRunning();
      },
      ...(this.deps.fetchFiles ? { fetchFiles: this.deps.fetchFiles } : {}),
      ...(this.deps.onFilesDropped ? { onFilesDropped: this.deps.onFilesDropped } : {}),
      ...(review ? reviewHooks(review) : {}),
    };
  }

  lastAnswer(credential: string, sessionId: string): Promise<string | undefined> {
    const { claw, clock, log, errors } = this.deps;
    return lastAnswer({ claw, clock, log, errors }, credential, sessionId);
  }

  async run(run: TurnRun, hooks: RouterHooks): Promise<TurnOutcome> {
    const { claw, clock, log, refusals, errors, style, cards, integrations } = this.deps;
    const ctx: TurnContext = {
      request: this.request(run),
      hooks: this.hooks(run, hooks),
      deps: {
        claw,
        surface: run.conversation,
        clock,
        log,
        refusals,
        errors,
        style,
        cards,
        ...(integrations ? { integrations } : {}),
      },
      record: newRecord(run.sessionId ?? undefined, run.sessionModel),
    };
    const report = hooks.reportView();
    await runTurn(report ? { ...ctx, hooks: { ...ctx.hooks, reportMessage: () => report } } : ctx, {
      onSession: (sessionId) => {
        hooks.onSession(sessionId, ctx.record.sessionModel);
      },
      stopRequested: () => hooks.stopRequested(),
      toolDenied: () => hooks.toolDenied(),
      stopConfirmed: () => hooks.stopConfirmed(),
    });
    const finalAnswer = ctx.record.finalAnswer;
    return run.review ? { finalAnswer, review: reviewOutcome(ctx.record) } : { finalAnswer };
  }
}
