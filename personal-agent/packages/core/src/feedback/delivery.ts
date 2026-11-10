// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import type { FeedbackSink, IssueRef, SinkError } from "../plugins/feedback-sink.js";
import type { Clock } from "../ports/clock.js";
import { epochSeconds } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { FeedbackReport, FeedbackRepository } from "../ports/store/feedback.js";
import type { Result } from "../result.js";
import {
  FEEDBACK_LABEL,
  commentBody,
  issueBody,
  issueTitle,
  retryMarker,
  type IssueWording,
  type ReportText,
} from "./issue-text.js";

/**
 * Delivering a recorded report: a fresh issue, or a comment on the issue of the same person's report in the same
 * session a few minutes before. One delivery at a time (the chat and the retry loop never file one report twice), and a
 * retry first asks whether the earlier attempt got through although its answer was lost (the hidden marker). What
 * could not be delivered is kept, with a retry time that doubles up to six hours.
 */

/** A retry looks for its earlier attempt from this long before the report was made. */
const RECONCILE_SKEW_SECONDS = 300;
const RETRY_BASE_SECONDS = 60;
const RETRY_MAX_SECONDS = 6 * 3600;

export type ReportDeliveryKind = "filed" | "commented" | "unconfigured" | "error";

export interface ReportDelivery {
  readonly kind: ReportDeliveryKind;
  readonly issue?: IssueRef;
}

export interface ReportDeliveryDeps {
  readonly reports: FeedbackRepository;
  /** Undefined: no sink is configured, reports are only recorded. */
  readonly sink: FeedbackSink | undefined;
  readonly clock: Clock;
  readonly log: Logger;
  readonly wording: IssueWording;
  readonly publicBaseUrl: string;
}

/** A failure that ends this attempt (its code is recorded); `unconfigured` is the sink saying it has nowhere to file. */
class Stop extends Error {
  override readonly name = "Stop";

  constructor(readonly error: SinkError) {
    super(error.kind === "sink_failed" ? error.code : error.kind);
  }
}

function unwrap<T>(result: Result<T, SinkError>): T {
  if (!result.ok) throw new Stop(result.error);
  return result.value;
}

function textOf(row: FeedbackReport): ReportText {
  return {
    id: row.id,
    createdAt: row.createdAt,
    text: row.text,
    scene: row.scene,
    reporterName: row.reporterName,
    reporterEmail: row.reporterEmail,
    sessionId: row.sessionId,
  };
}

export class FeedbackDelivery {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ReportDeliveryDeps) {}

  get configured(): boolean {
    return this.deps.sink !== undefined;
  }

  /** Delivers report `reportId` unless it was already; never throws for a delivery that failed (it is recorded). */
  deliver(reportId: number): Promise<ReportDelivery> {
    const run = this.queue.then(() => this.deliverNow(reportId));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Files the reports whose retry time has come; how many went out. */
  async replayPending(limit = 5): Promise<number> {
    if (this.deps.sink === undefined) return 0;
    let sent = 0;
    for (const row of this.deps.reports.dueFeedback(limit)) {
      const done = await this.deliver(row.id);
      if (done.kind === "filed" || done.kind === "commented") sent += 1;
    }
    if (sent) this.deps.log.info("feedback: stored reports delivered", { count: sent });
    return sent;
  }

  private async deliverNow(reportId: number): Promise<ReportDelivery> {
    const row = this.deps.reports.getFeedbackReport(reportId);
    if (row === null) return { kind: "error" };
    if (row.state === "filed" && row.issueNumber !== null) {
      return { kind: row.asComment ? "commented" : "filed", issue: { number: row.issueNumber, url: row.issueUrl } };
    }
    const sink = this.deps.sink;
    if (sink === undefined) return { kind: "unconfigured" };
    try {
      const { issue, asComment } = await this.send(sink, row);
      this.deps.reports.markFeedbackFiled(row.id, issue, asComment);
      return { kind: asComment ? "commented" : "filed", issue };
    } catch (err) {
      if (err instanceof Stop && err.error.kind === "sink_not_configured") return { kind: "unconfigured" };
      return this.failed(
        row,
        err instanceof Stop && err.error.kind === "sink_failed" ? err.error.code : errorName(err),
      );
    }
  }

  private async send(sink: FeedbackSink, row: FeedbackReport): Promise<{ issue: IssueRef; asComment: boolean }> {
    const sinceMs = (row.createdAt - RECONCILE_SKEW_SECONDS) * 1000;
    const marker = retryMarker(row);
    const target = this.deps.reports.feedbackTarget(row);
    if (target !== null) {
      const commented = await this.commentOn(sink, row, target, marker, sinceMs);
      if (commented) return { issue: target, asComment: true };
    }
    const found = row.attempts ? unwrap(await sink.findIssue(marker, sinceMs)) : undefined;
    const issue =
      found ??
      unwrap(
        await sink.createIssue(
          issueTitle(this.deps.wording, row.text, row.reporterName),
          issueBody(this.deps.wording, this.deps.publicBaseUrl, textOf(row)),
          [FEEDBACK_LABEL],
        ),
      );
    return { issue, asComment: false };
  }

  /** False when the issue is gone (404, 410): a fresh one is filed instead. */
  private async commentOn(
    sink: FeedbackSink,
    row: FeedbackReport,
    target: IssueRef,
    marker: string,
    sinceMs: number,
  ): Promise<boolean> {
    try {
      const already = row.attempts ? unwrap(await sink.hasComment(target.number, marker, sinceMs)) : false;
      if (!already) unwrap(await sink.comment(target.number, commentBody(textOf(row))));
      return true;
    } catch (err) {
      if (err instanceof Stop && err.error.kind === "sink_failed" && [404, 410].includes(err.error.status))
        return false;
      throw err;
    }
  }

  private failed(row: FeedbackReport, code: string): ReportDelivery {
    const delay = Math.min(RETRY_BASE_SECONDS * 2 ** row.attempts, RETRY_MAX_SECONDS);
    this.deps.reports.markFeedbackFailed(row.id, code, epochSeconds(this.deps.clock) + delay);
    this.deps.log.warn("feedback: report not delivered; retrying later", { report: row.id, code, delay });
    return { kind: "error" };
  }
}
