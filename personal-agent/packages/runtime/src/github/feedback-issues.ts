// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Feedback's issues in one GitHub repository (the Python worker's `feedback.GitHubIssues`): the FeedbackSink core
 * delivers reports to. Every call goes through the shared GitHub client (`api.ts`: its headers, one retry with a fresh
 * token on a 401); a failure is a status and a short code, never a body or a secret.
 */
import {
  err,
  ok,
  type FeedbackSink,
  type IssueRef,
  type Logger,
  type Result,
  type SinkError,
} from "@primusclaw/personal-agent";

import { GithubApi, GithubApiError, segment } from "./api.js";
import { GithubAuthError } from "./app-token.js";

export const FEEDBACK_LABEL = "clawy-feedback";
const LABEL_COLOR = "d93f0b";
const LABEL_DESCRIPTION = "Reported by a user from Teams through Clawy";

/** `%Y-%m-%dT%H:%M:%SZ`, as GitHub's `since` takes it. */
function isoSeconds(epochMs: number): string {
  return `${new Date(Math.floor(epochMs / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

function failed(status: number, code = ""): Result<never, SinkError> {
  return err({ kind: "sink_failed", status, code: code || `github_${String(status)}` });
}

/** What a call that threw says: GitHub not reached, or no usable credential. Anything else is a bug and is thrown. */
function failure(error: unknown): Result<never, SinkError> {
  if (error instanceof GithubApiError) return failed(error.status, error.code);
  if (error instanceof GithubAuthError) return failed(0, error.code);
  throw error;
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function issueOf(value: unknown): IssueRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { number, html_url: url } = value as Record<string, unknown>;
  return typeof number === "number" && Number.isInteger(number) && typeof url === "string"
    ? { number, url }
    : undefined;
}

function bodyOf(value: unknown): string {
  const body = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["body"] : undefined;
  return typeof body === "string" ? body : "";
}

export class GithubIssueSink implements FeedbackSink {
  private labelReady = false;
  private readonly repoPath: string;

  constructor(
    private readonly api: GithubApi,
    /** `owner/name`. */
    repo: string,
    private readonly log: Logger,
  ) {
    const [owner = "", name = ""] = repo.split("/");
    this.repoPath = `/repos/${segment(owner)}/${segment(name)}`;
  }

  async createIssue(title: string, body: string, labels: readonly string[]): Promise<Result<IssueRef, SinkError>> {
    try {
      await this.ensureLabel();
      const response = await this.api.request({
        method: "POST",
        path: `${this.repoPath}/issues`,
        body: { title, body, labels },
      });
      if (response.status !== 201) return failed(response.status);
      const issue = issueOf(await jsonOf(response));
      return issue ? ok(issue) : failed(response.status, "bad_response");
    } catch (error) {
      return failure(error);
    }
  }

  async findIssue(marker: string, sinceEpochMs: number): Promise<Result<IssueRef | undefined, SinkError>> {
    const query = `labels=${FEEDBACK_LABEL}&state=all&sort=created&direction=desc&per_page=100&since=${isoSeconds(sinceEpochMs)}`;
    try {
      const response = await this.api.request({ method: "GET", path: `${this.repoPath}/issues?${query}` });
      if (response.status !== 200) return failed(response.status);
      const list = await jsonOf(response);
      if (!Array.isArray(list)) return failed(response.status, "bad_response");
      const found: unknown = list.find((issue: unknown) => bodyOf(issue).includes(marker));
      if (found === undefined) return ok(undefined);
      const issue = issueOf(found);
      return issue ? ok(issue) : failed(response.status, "bad_response");
    } catch (error) {
      return failure(error);
    }
  }

  async hasComment(issue: number, marker: string, sinceEpochMs: number): Promise<Result<boolean, SinkError>> {
    const path = `${this.repoPath}/issues/${String(issue)}/comments?per_page=100&since=${isoSeconds(sinceEpochMs)}`;
    try {
      const response = await this.api.request({ method: "GET", path });
      if (response.status !== 200) return failed(response.status);
      const list = await jsonOf(response);
      if (!Array.isArray(list)) return failed(response.status, "bad_response");
      return ok(list.some((comment) => bodyOf(comment).includes(marker)));
    } catch (error) {
      return failure(error);
    }
  }

  async comment(issue: number, body: string): Promise<Result<void, SinkError>> {
    try {
      const response = await this.api.request({
        method: "POST",
        path: `${this.repoPath}/issues/${String(issue)}/comments`,
        body: { body },
      });
      return response.status === 201 ? ok(undefined) : failed(response.status);
    } catch (error) {
      return failure(error);
    }
  }

  /** The feedback label, made once if the repository lacks it. Best effort: a report is worth more than its label. */
  private async ensureLabel(): Promise<void> {
    if (this.labelReady) return;
    try {
      const found = await this.api.request({ method: "GET", path: `${this.repoPath}/labels/${FEEDBACK_LABEL}` });
      if (found.status === 200) {
        this.labelReady = true;
        return;
      }
      if (found.status !== 404) {
        this.log.warn("feedback: could not look up the label", { status: found.status });
        return;
      }
      const made = await this.api.request({
        method: "POST",
        path: `${this.repoPath}/labels`,
        body: { name: FEEDBACK_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION },
      });
      if (made.status === 201 || made.status === 422)
        this.labelReady = true; // 422: somebody else made it first
      else this.log.warn("feedback: could not create the label", { status: made.status });
    } catch (error) {
      // (no usable credential is the report's failure too: it goes up, as the issue could not be filed either)
      if (!(error instanceof GithubApiError)) throw error;
      this.log.warn("feedback: could not create the label", { code: error.code });
    }
  }
}
