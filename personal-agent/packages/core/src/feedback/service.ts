// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FeedbackSink } from "../plugins/feedback-sink.js";
import type { ClawSessionsPort } from "../ports/claw/sessions.js";
import { epochSeconds, type Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { FeedbackRepository } from "../ports/store/feedback.js";
import type { LinkRepository } from "../ports/store/link.js";
import { FEEDBACK_OFFER_TTL_SECONDS } from "../ports/store/policy.js";
import { withDeadline } from "./deadline.js";
import { FeedbackDelivery, type ReportDeliveryKind } from "./delivery.js";
import { lastExchange, type TurnText } from "./exchange.js";
import { readHistory, whyNotRead, type HistoryReader } from "./history.js";
import { tagOf } from "./identifiers.js";
import {
  cleanText,
  conversationComment,
  reporterEmail,
  reporterName,
  type IssueWording,
  type Mask,
} from "./issue-text.js";
import { lastTurnId, lastTurns, sceneMarkdown, type Scene } from "./scene.js";
import type { FeedbackOfferView, FeedbackReportView } from "./views.js";

/**
 * `/feedback`: the scene of a problem is recorded and an issue is filed for the team. The report is written to the
 * store BEFORE anything is sent, so one that cannot be delivered (no sink yet, GitHub down) is kept and filed later.
 * After a delivered report in a 1:1 chat the reporter is offered to add their last question and answer, which are read
 * then, with their own key, and masked; nothing of the conversation is recorded unless they press Yes.
 */

/** The scene is best effort: it may not hold the report up longer than this. */
const COLLECT_MS = 25_000;

/** What the deployment says about itself in a report (image tags read at start; "" when not said). */
export interface WorkerInfo {
  readonly pluginId: string;
  readonly version: string;
  readonly workerImage: string;
  readonly apiImage: string;
  readonly brainImage: string;
}

export interface Reporter {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  /** "" for the 1:1 chat, the conversation id of a group. */
  readonly scope: string;
  /** The conversation, for its log lines. */
  readonly conversationId: string;
}

/** The worker's own recent log lines of one chat (ids and levels only), newest last. */
export interface LogTail {
  tail(userId: string, conversationId: string): readonly string[];
}

export interface FeedbackServiceDeps {
  readonly reports: FeedbackRepository;
  readonly links: Pick<LinkRepository, "clawUserIdOf">;
  readonly sessions: Pick<ClawSessionsPort, "events" | "stream" | "turn">;
  readonly sink: FeedbackSink | undefined;
  readonly clock: Clock;
  readonly log: Logger;
  readonly mask: Mask;
  readonly turnText: TurnText;
  readonly wording: IssueWording;
  readonly publicBaseUrl: string;
  readonly worker: WorkerInfo;
  readonly logs?: LogTail;
}

export interface ReportResult {
  readonly kind: ReportDeliveryKind;
  readonly number?: number;
  readonly url?: string;
  readonly sessionId: string;
  /** The newest turn of the session: what "my last question and answer" means. */
  readonly lastTurnId: string;
}

export type OfferOutcome = "invalid" | "declined" | "added" | "empty" | "retry";

export class FeedbackService {
  readonly delivery: FeedbackDelivery;
  private readonly history: HistoryReader;

  constructor(private readonly deps: FeedbackServiceDeps) {
    this.delivery = new FeedbackDelivery(deps);
    this.history = { sessions: deps.sessions, clock: deps.clock, log: deps.log };
  }

  get configured(): boolean {
    return this.delivery.configured;
  }

  /** Record the report, then try to deliver it: the record comes first, so nothing is lost on a failure. */
  async report(
    who: Reporter,
    text: string,
    key: string | undefined,
    sessionId: string | undefined,
  ): Promise<ReportResult> {
    const scene = await this.collect(who, key, sessionId);
    const reportId = this.deps.reports.addFeedbackReport({
      userId: who.userId,
      scope: who.scope,
      sessionId: sessionId ?? "",
      text: cleanText(this.deps.mask, text),
      scene: sceneMarkdown(scene),
      reporterName: reporterName(who.name),
      reporterEmail: reporterEmail(who.email),
    });
    const delivery = await this.delivery.deliver(reportId);
    return {
      kind: delivery.kind,
      ...(delivery.issue ? { number: delivery.issue.number, url: delivery.issue.url } : {}),
      sessionId: sessionId ?? "",
      lastTurnId: lastTurnId(scene),
    };
  }

  /** The scene of this chat. Whatever cannot be read is said so in it, and the report goes ahead without it. */
  async collect(who: Reporter, key: string | undefined, sessionId: string | undefined): Promise<Scene> {
    const now = epochSeconds(this.deps.clock);
    const { worker } = this.deps;
    const base: Scene = {
      name: who.name,
      platformUserId: this.deps.links.clawUserIdOf(who.userId) ?? "",
      chat: who.scope ? "group" : "1:1",
      at: now,
      sessionId: sessionId ?? "",
      pluginId: worker.pluginId,
      workerVersion: worker.version || "unknown",
      workerImage: tagOf(worker.workerImage),
      apiImage: tagOf(worker.apiImage),
      brainImage: tagOf(worker.brainImage),
      busy: undefined,
      turns: [],
      turnsNote: "",
      logs: this.deps.logs?.tail(who.userId, who.conversationId) ?? [],
    };
    if (!sessionId) return { ...base, turnsNote: "this chat has no PrimusClaw session yet" };
    if (!key) {
      return { ...base, turnsNote: "the chat is not linked to a PrimusClaw account, so its session was not read" };
    }
    try {
      return await withDeadline(this.deps.clock, COLLECT_MS, () => this.readTurns(base, key, sessionId, now));
    } catch (err) {
      const why = whyNotRead(err);
      this.deps.log.warn("feedback: could not read the session", { why });
      return { ...base, turnsNote: `the session could not be read (${why})` };
    }
  }

  private async readTurns(base: Scene, key: string, sessionId: string, now: number): Promise<Scene> {
    const turns = lastTurns(await readHistory(this.history, key, sessionId), now);
    let busy: boolean | undefined;
    try {
      busy = (await this.deps.sessions.turn(key, sessionId)).running;
    } catch (err) {
      this.deps.log.info("feedback: whether the session runs was not read", { why: whyNotRead(err) });
    }
    return { ...base, turns, busy, turnsNote: turns.length ? "" : "the session has no turns yet" };
  }

  /** The Yes/No offer for a report that reached the sink, when there is a turn to include; else undefined. */
  makeOffer(userId: string, result: ReportResult): FeedbackOfferView | undefined {
    if (result.kind !== "filed" && result.kind !== "commented") return undefined;
    if (!result.number || !result.sessionId || !result.lastTurnId) return undefined;
    const offerId = this.deps.reports.addFeedbackOffer(userId, result.number, result.sessionId, result.lastTurnId);
    return { offerId, issueNumber: result.number };
  }

  /** The Report a problem button under a message of `userId`'s that went wrong (in a group only they can use it). */
  reportView(userId: string, scope: string): FeedbackReportView {
    return { promptId: this.deps.reports.addFeedbackPrompt(userId, scope), group: Boolean(scope) };
  }

  /** A press on Yes or No under the offer; the offer is read from the store, never from the card. */
  async answerOffer(userId: string, key: string, offerId: string, include: boolean): Promise<[OfferOutcome, number]> {
    const offer = this.deps.reports.getFeedbackOffer(offerId);
    const now = epochSeconds(this.deps.clock);
    if (offer === null || offer.userId !== userId || now - offer.createdAt > FEEDBACK_OFFER_TTL_SECONDS) {
      return ["invalid", 0];
    }
    const move = (state: string, onlyFrom?: string): boolean =>
      this.deps.reports.moveFeedbackOffer(offerId, state, onlyFrom === undefined ? {} : { onlyFrom });
    if (!include) return move("declined") ? ["declined", offer.issueNumber] : ["invalid", 0];
    if (!move("sending")) return ["invalid", 0];
    const outcome = await this.addExchange(key, offer.sessionId, offer.turnId, offer.issueNumber);
    move(outcome === "retry" ? "open" : "done", "sending");
    return [outcome, offer.issueNumber];
  }

  private async addExchange(key: string, sessionId: string, turnId: string, issue: number): Promise<OfferOutcome> {
    const sink = this.deps.sink;
    if (sink === undefined) return "retry";
    let rows;
    try {
      rows = await withDeadline(this.deps.clock, COLLECT_MS, () => readHistory(this.history, key, sessionId));
    } catch (err) {
      this.deps.log.warn("feedback: could not read the session for the offer", { why: whyNotRead(err) });
      return "retry";
    }
    const exchange = lastExchange(rows, turnId, this.deps.turnText);
    if (exchange === undefined) return "empty";
    const added = await sink.comment(issue, conversationComment(this.deps.mask, exchange.question, exchange.answer));
    if (added.ok) return "added";
    this.deps.log.warn("feedback: could not add the conversation", {
      code: added.error.kind === "sink_failed" ? added.error.code : added.error.kind,
    });
    return "retry";
  }
}
