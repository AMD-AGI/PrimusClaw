// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { err, type Result } from "../result.js";

/**
 * Where `/feedback` reports go (the Python worker's `feedback.GitHubIssues`: issues in one repository). The report is
 * recorded before it is delivered, and a hidden marker in the issue or comment lets a retry find what an earlier
 * attempt delivered without an answer, so nothing is filed twice.
 */
export interface IssueRef {
  readonly number: number;
  readonly url: string;
}

/** The sink could not do it: the HTTP status it got (0 when nothing answered) and a short code; never a body. */
export interface SinkFailed {
  readonly kind: "sink_failed";
  readonly status: number;
  readonly code: string;
}

/** No sink is configured: reports are recorded and not delivered. */
export interface SinkNotConfigured {
  readonly kind: "sink_not_configured";
}

export type SinkError = SinkFailed | SinkNotConfigured;

export interface FeedbackSink {
  createIssue(title: string, body: string, labels: readonly string[]): Promise<Result<IssueRef, SinkError>>;
  /** The report issue whose body carries `marker`, created since `sinceEpochMs`; undefined when there is none. */
  findIssue(marker: string, sinceEpochMs: number): Promise<Result<IssueRef | undefined, SinkError>>;
  /** Whether a comment on issue `issue` since `sinceEpochMs` carries `marker`. */
  hasComment(issue: number, marker: string, sinceEpochMs: number): Promise<Result<boolean, SinkError>>;
  comment(issue: number, body: string): Promise<Result<void, SinkError>>;
}

const notConfigured = (): Promise<Result<never, SinkNotConfigured>> =>
  Promise.resolve(err({ kind: "sink_not_configured" }));

/** No sink: every call says so, and the report stays recorded. */
export const noFeedbackSink: FeedbackSink = {
  createIssue: notConfigured,
  findIssue: notConfigured,
  hasComment: notConfigured,
  comment: notConfigured,
};
