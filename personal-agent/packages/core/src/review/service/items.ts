// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Asking Claw for the review items of a request (`POST /v1/assistant/reviews`): each runs in a session Claw makes and is on
 * the asker's (or, asked of someone else, the reviewer's) board, where it can be stopped. Claw starts all of them or none;
 * when it refuses because of one pull request, that one is named with why and the others are asked for again. A Claw
 * without review items (404) leaves the sessions to be made here, as before.
 */

import { ClawError, ReviewsRefused, errorKind } from "../../claw/errors.js";
import type { ReviewStart, PullRef } from "../../claw/model.js";
import { oneLine, displayName } from "../../review-text/names.js";
import { pullKey, shortName } from "../../review-text/pull-ref.js";
import {
  ALREADY,
  ONE_PULL,
  PR_CHECK_REASONS,
  REVIEWER_REASONS,
  REVIEWS_STARTED_AT_ONCE,
  batchRefusal,
} from "../refusals.js";
import { reviewPrompt } from "../prompts.js";
import type { ReviewTurn } from "../review-turn.js";
import type { ReviewDeps } from "./deps.js";
import { clawFailure } from "./identity.js";
import type { Actor } from "./reviewer.js";

/** How long Claw's answer to whether it chooses a review's model is reused. */
export const CLAW_MODELS_MS = 300_000;

/** What asking for the items came to. */
export type ItemsAsked =
  | { readonly kind: "started"; readonly reviews: ReviewTurn[] }
  /** A Claw without review items: the sessions are made here. */
  | { readonly kind: "no_items" }
  /** Claw started none, or could not be asked: what the asker is told. */
  | { readonly kind: "refused"; readonly text: string };

export interface ItemsRequest {
  readonly token: string;
  readonly modelKey: string;
  readonly actor: Actor;
  readonly actingAs: string;
  readonly merge: boolean;
  readonly model: string;
  /** Asked of someone else: their exchanged token and own key ('' a review of one's own). */
  readonly actingToken: string;
  readonly actingKey: string;
  /** The asker's own words, quoted to the reviewer as untrusted. */
  readonly note: string;
  readonly handoffId: string;
}

const tooManyForThisClaw = `PrimusClaw 这一版一次只接受 ${String(REVIEWS_STARTED_AT_ONCE)} 个，这个没有开始，请稍后单独再发`;

export class ReviewItems {
  private clawModels: { readonly at: number; readonly chooses: boolean } | undefined;
  /** The pull requests a review was asked for and has not ended (a Claw without review items: this worker's memory). */
  private readonly reviewing = new Set<string>();

  constructor(private readonly deps: ReviewDeps) {}

  /** Whether Claw chooses a review's model itself, asked at most every CLAW_MODELS_MS; the last answer stands when it cannot say. */
  async clawChoosesModels(token: string): Promise<boolean> {
    const now = this.deps.clock.monotonicMs();
    if (this.clawModels !== undefined && now - this.clawModels.at < CLAW_MODELS_MS) return this.clawModels.chooses;
    let chooses: boolean;
    try {
      chooses = (await this.deps.claw.settings.assistantSettings(token)) !== null;
    } catch (err) {
      if (!clawFailure(err)) throw err;
      this.deps.logger.info("could not ask Claw whether it chooses review models", { error: errorKind(err) });
      return this.clawModels?.chooses ?? false;
    }
    this.clawModels = { at: now, chooses };
    return chooses;
  }

  /** Asks Claw for one item per review; see `ItemsAsked`. Refused pull requests go in `refused`. */
  async start(
    request: ItemsRequest,
    reviews: readonly ReviewTurn[],
    refused: [PullRef, string][],
  ): Promise<ItemsAsked> {
    let left = [...reviews];
    const who = displayName(request.actor.name) || "对方";
    // A Claw that chooses a review's model is sent only the model the request named; one that does not, the default too.
    const sentModel = (await this.clawChoosesModels(request.token))
      ? request.model
      : request.model || this.deps.defaultModel;
    while (left.length) {
      let started: ReviewStart[];
      try {
        started = await this.ask(request, left, sentModel);
      } catch (err) {
        const next = this.afterRefusal(err, left, refused, who);
        if (next === "no_items" || (typeof next === "object" && "text" in next))
          return next === "no_items" ? { kind: "no_items" } : { kind: "refused", text: next.text };
        left = next;
        continue;
      }
      return { kind: "started", reviews: this.taken(request, left, started, refused) };
    }
    return { kind: "started", reviews: [] };
  }

  private ask(request: ItemsRequest, left: readonly ReviewTurn[], model: string): Promise<ReviewStart[]> {
    return this.deps.claw.assistant.startReviews(request.token, {
      modelKey: request.modelKey,
      prs: left.map((r) => ({ pull: r.pull, message: reviewPrompt(r) })),
      actingAs: request.actingAs,
      actingAsName: request.actor.name,
      reviewOnly: !request.merge,
      model,
      ...(request.actingToken
        ? { actingToken: request.actingToken, actingKey: request.actingKey, requesterNote: request.note }
        : {}),
      ...(request.actingToken && request.handoffId ? { handoffId: request.handoffId } : {}),
    });
  }

  /** What a refusal leaves: the reviews to ask for again, no items here, or the one line for the asker. */
  private afterRefusal(
    err: unknown,
    left: readonly ReviewTurn[],
    refused: [PullRef, string][],
    who: string,
  ): ReviewTurn[] | "no_items" | { readonly text: string } {
    if (err instanceof ReviewsRefused) {
      this.deps.logger.info("Claw refused a request for reviews", { status: err.status, error: err.error });
      if (
        err.status === 400 &&
        err.error === "invalid_request" &&
        err.data.field === "prs" &&
        left.length > REVIEWS_STARTED_AT_ONCE
      ) {
        // (a Claw from before it queued the rest takes ten at most: those start, the rest are named as not started)
        for (const r of left.slice(REVIEWS_STARTED_AT_ONCE)) refused.push([r.pull, tooManyForThisClaw]);
        return left.slice(0, REVIEWS_STARTED_AT_ONCE);
      }
      const one = reviewOf(err.data.pr, left);
      const reason = typeof err.data.reason === "string" ? err.data.reason : "";
      if (ONE_PULL.includes(err.error) && one !== undefined && !Object.hasOwn(REVIEWER_REASONS, reason)) {
        refused.push([one.pull, err.error === "pr_check_failed" ? this.checkReason(reason, err.error, one) : ALREADY]);
        return left.filter((r) => r !== one);
      }
      return { text: batchRefusal(err, who, left.length, this.deps.errors) };
    }
    if (err instanceof ClawError) {
      if (err.status === 404) {
        this.deps.logger.info("Claw has no review items; the review sessions are made here");
        return "no_items";
      }
      this.deps.logger.warn("a request for reviews failed", { status: err.status });
      return { text: `PrimusClaw 没有接受这次 review 请求（错误 ${String(err.status)}），一个也没有开始。` };
    }
    if (!clawFailure(err)) throw err;
    this.deps.logger.warn("a request for reviews got no usable answer from Claw", { error: errorKind(err) });
    return {
      text: "我暂时没能从 PrimusClaw 得到回答，不确定 review 是否已经开始。请稍后再发一次（同一个 PR 不会重复开始）。",
    };
  }

  private checkReason(reason: string, error: string, one: ReviewTurn): string {
    const known = Object.hasOwn(PR_CHECK_REASONS, reason) ? PR_CHECK_REASONS[reason] : undefined;
    if (known !== undefined) return known;
    // (Claw's own words may name hosts or paths)
    const shown = oneLine(
      this.deps.errors.publicReason(reason || error, "review_pr_check", { pr: shortName(one.pull) }),
      60,
    );
    return `PrimusClaw 没有接受（${shown}）`;
  }

  private taken(
    request: ItemsRequest,
    left: readonly ReviewTurn[],
    started: readonly ReviewStart[],
    refused: [PullRef, string][],
  ): ReviewTurn[] {
    const byPull = new Map(started.map((one) => [pullKey(one.target), one]));
    const taken: ReviewTurn[] = [];
    for (const review of left) {
      const one = byPull.get(pullKey(review.pull));
      if (one === undefined) {
        refused.push([review.pull, "PrimusClaw 没有开始它"]);
        continue;
      }
      review.item = one;
      review.sessionId = one.sessionId;
      // (what Claw says it runs on is what every card and receipt shows)
      if (one.model !== null) {
        review.model = one.model;
        review.modelReported = true;
      }
      review.forReviewer = Boolean(request.actingToken);
      taken.push(review);
    }
    return taken;
  }

  /**
   * A Claw without review items: the pull requests this worker is reviewing already are refused, and the others are taken
   * (in `held`) until their review ends. This worker's memory is all there is then.
   */
  hold(reviews: readonly ReviewTurn[], refused: [PullRef, string][], held: PullRef[]): ReviewTurn[] {
    const fresh: ReviewTurn[] = [];
    for (const review of reviews) {
      const key = pullKey(review.pull);
      if (this.reviewing.has(key)) {
        refused.push([review.pull, ALREADY]);
        continue;
      }
      this.reviewing.add(key);
      held.push(review.pull);
      fresh.push(review);
    }
    return fresh;
  }

  /** A review taken in this worker's memory has ended (or never started): its pull request is free again. */
  release(pull: PullRef): void {
    this.reviewing.delete(pullKey(pull));
  }
}

/** The review of the pull request Claw named in a refusal (`data.pr`), if it is one of them. */
function reviewOf(raw: unknown, reviews: readonly ReviewTurn[]): ReviewTurn | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const pr = raw as Readonly<Record<string, unknown>>;
  const owner = typeof pr.owner === "string" ? pr.owner.toLowerCase() : "";
  const repo = typeof pr.repo === "string" ? pr.repo.toLowerCase() : "";
  if (typeof pr.number !== "number") return undefined;
  const number = pr.number;
  return reviews.find((r) => pullKey(r.pull) === pullKey({ owner, repo, number }));
}
