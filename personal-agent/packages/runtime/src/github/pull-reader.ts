// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who wrote a pull request (and its title, and the branch it goes into), read from GitHub's public API with no credential.
 * It exists to refuse early (a committer cannot approve their own pull request); it is not what stops it, Claw is. So any
 * answer that is not a reading (GitHub down, a rate limit, a pull request that is not there) is "not known".
 */

import {
  type Logger,
  type PullRef,
  type PullReader,
  cpHead,
  errorName,
  own,
  squashSpaces,
} from "@primusclaw/personal-agent";

import { GithubApi, segment } from "./api.js";

/** The one public read of who wrote a pull request: an early answer, never worth a long wait. */
export const PULL_READ_MS = 5_000;

const MARKUP = /[`<>*_[\]()#|\\]/gu;
const oneLine = (value: string, limit: number): string => cpHead(squashSpaces(value.replace(MARKUP, " ")), limit);

const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null && !Array.isArray(body)
    ? own(body as Record<string, unknown>, key)
    : undefined;

export class PublicPullReader implements PullReader {
  constructor(
    private readonly api: GithubApi,
    private readonly logger: Logger,
  ) {}

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const response = await this.api.request({ method: "GET", path, timeoutMs: PULL_READ_MS });
    return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
  }

  async repo(owner: string, name: string): Promise<string | undefined> {
    let answer: { status: number; body: unknown };
    try {
      answer = await this.get(`/repos/${segment(owner)}/${segment(name)}`);
    } catch (error) {
      this.logger.info("a repository could not be read", { error: errorName(error) });
      return undefined;
    }
    if (answer.status === 404) return "";
    const full = field(answer.body, "full_name");
    return typeof full === "string" && full.includes("/") && !field(answer.body, "private") ? full : undefined;
  }

  private pullPath(pull: PullRef): string {
    return `/repos/${segment(pull.owner)}/${segment(pull.repo)}/pulls/${String(pull.number)}`;
  }

  async base(pull: PullRef): Promise<string> {
    try {
      const answer = await this.get(this.pullPath(pull));
      const ref = field(field(answer.body, "base"), "ref");
      return typeof ref === "string" ? oneLine(ref, 100) : "";
    } catch (error) {
      this.logger.info("the base branch of a pull request could not be read", { error: errorName(error) });
      return "";
    }
  }

  async read(pull: PullRef): Promise<{ readonly author: string | undefined; readonly title: string }> {
    try {
      const answer = await this.get(this.pullPath(pull));
      const login = field(field(answer.body, "user"), "login");
      const title = field(answer.body, "title");
      return {
        author: typeof login === "string" && login ? login : undefined,
        title: typeof title === "string" ? oneLine(title, 120) : "",
      };
    } catch (error) {
      this.logger.info("who wrote a pull request could not be read", { error: errorName(error) });
      return { author: undefined, title: "" };
    }
  }
}
