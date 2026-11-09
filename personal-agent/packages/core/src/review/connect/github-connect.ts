// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A question about the person's own GitHub, asked before Claw has any GitHub token of theirs: the connect card beside the
 * answer, and the question asked again as soon as they connect. Nothing is ever held: the message goes on at once whatever
 * is offered beside it. A card is offered at most once in SHOWN_SECONDS; "Not now" closes it for a day. A binding made with
 * `public_repo` only is told, beside the answer, that it cannot read a repository GitHub does not show publicly.
 */

import { errorKind } from "../../claw/errors.js";
import { errorName } from "../../errors.js";
import type { Random } from "../../ports/random.js";
import { needsWiderScope, usable } from "../../ports/github.js";
import type { Conversation, UserRef } from "../../ports/surface.js";
import { codeMinutes } from "../consent.js";
import { githubConnectMessage } from "../views.js";
import { say } from "../service/chat.js";
import type { ReviewDeps } from "../service/deps.js";
import type { GithubAccount } from "../service/account.js";
import { MAX_REPOS_LOOKED_AT, asksAboutOwnGithub, repositoriesNamed } from "./questions.js";

/** Claw said it reads this person's GitHub: no need to ask again for this long. */
export const CONNECTED_MS = 600_000;
/** "Not now": no card for this long. */
export const DECLINED_MS = 24 * 3600_000;
/** A card was offered: no other for this long, whatever became of it. */
export const SHOWN_MS = 6 * 3600_000;

interface Offered {
  readonly cardId: string;
  readonly again: () => Promise<void>;
}

export interface ConnectRequest {
  readonly sender: UserRef;
  readonly credential: string;
  readonly text: string;
  readonly lang: "zh" | "en";
  readonly conversation: Conversation;
  readonly again: () => Promise<void>;
}

export class GithubConnect {
  private readonly connected = new Map<string, number>();
  private readonly quiet = new Map<string, number>();
  private readonly offered = new Map<string, Offered>();
  private readonly narrowHint = new Map<string, number>();
  private readonly wide = new Map<string, number>();
  private readonly hinting = new Set<string>();
  private readonly hints = new Set<Promise<void>>();

  constructor(
    private readonly deps: ReviewDeps,
    private readonly account: GithubAccount,
    private readonly random: Random,
  ) {}

  private now(): number {
    return this.deps.clock.monotonicMs();
  }

  /** Settles when the scope hints started so far have ended. */
  async idle(): Promise<void> {
    await Promise.all([...this.hints]);
  }

  /** The person changed their GitHub connection: what was remembered of it is asked again next time. */
  forget(userId: string): void {
    this.connected.delete(userId);
    this.quiet.delete(userId);
    this.narrowHint.delete(userId);
    this.wide.delete(userId);
  }

  /** Offers the connect card for a question about the person's own GitHub when Claw cannot read it yet; true when sent. */
  async offer(request: ConnectRequest): Promise<boolean> {
    const userId = request.sender.id;
    const now = this.now();
    const repos = repositoriesNamed(request.text);
    if (
      !this.hinting.has(userId) &&
      (this.narrowHint.get(userId) ?? 0) <= now &&
      (this.wide.get(userId) ?? 0) <= now &&
      repos.length
    ) {
      // (in the background: the message goes on at once; one look at a time per person)
      this.hinting.add(userId);
      const task: Promise<void> = this.maybeHint(request, repos).finally(() => {
        this.hints.delete(task);
        this.hinting.delete(userId);
      });
      this.hints.add(task);
    }
    if (
      !asksAboutOwnGithub(request.text) ||
      (this.connected.get(userId) ?? 0) > now ||
      (this.quiet.get(userId) ?? 0) > now
    )
      return false;
    let connection;
    try {
      connection = await this.deps.claw.settings.githubConnection(request.credential);
    } catch (err) {
      this.deps.logger.info("Claw's GitHub connection could not be read; no card", { error: errorKind(err) });
      return false;
    }
    // (an older Claw, or one that reads only a GH_TOKEN: connecting here would give it nothing)
    if (connection === null || !connection.bindingReads) return false;
    if (connection.readsWith) {
      this.connected.set(userId, now + CONNECTED_MS);
      return false;
    }
    return this.sendCard(request, now);
  }

  private async sendCard(request: ConnectRequest, now: number): Promise<boolean> {
    const userId = request.sender.id;
    const offered: Offered = { cardId: this.random.hexId(), again: request.again };
    let code;
    try {
      code = await this.account.bindForQuestion(request.sender, request.conversation, (ok) =>
        this.bound(userId, offered, ok, request.conversation, request.lang),
      );
    } catch (err) {
      this.deps.logger.info("no GitHub code for a question; no card", { error: errorName(err) });
      return false;
    }
    if (code === undefined || "kind" in code) return false;
    this.offered.set(userId, offered);
    this.quiet.set(userId, now + SHOWN_MS);
    try {
      await request.conversation.send(
        githubConnectMessage({
          code: code.userCode,
          uri: code.verificationUri,
          minutes: codeMinutes(code),
          question: request.text,
          lang: request.lang,
          cardId: offered.cardId,
        }),
      );
    } catch (err) {
      this.deps.logger.warn("the GitHub connect card could not be sent", { error: errorName(err) });
      this.offered.delete(userId);
      return false;
    }
    return true;
  }

  private until(map: ReadonlyMap<string, number>, userId: string): number {
    return map.get(userId) ?? 0;
  }

  /** The scope line is looked for in the background: the message goes on at once; one look at a time per person. */
  private startHint(request: ConnectRequest, now: number): void {
    const userId = request.sender.id;
    const repos = repositoriesNamed(request.text);
    if (
      this.hinting.has(userId) ||
      this.until(this.narrowHint, userId) > now ||
      this.until(this.wide, userId) > now ||
      !repos.length
    ) {
      return;
    }
    this.hinting.add(userId);
    const task: Promise<void> = this.maybeHint(request, repos).finally(() => {
      this.hints.delete(task);
      this.hinting.delete(userId);
    });
    this.hints.add(task);
  }

  /** The device flow of a card ended: once connected, the question is asked again. */
  private async bound(
    userId: string,
    offered: Offered,
    connected: boolean,
    conversation: Conversation,
    lang: "zh" | "en",
  ): Promise<void> {
    if (this.offered.get(userId) !== offered) return; // ("Not now": nothing is asked again)
    this.offered.delete(userId);
    if (!connected) return;
    this.connected.set(userId, this.now() + CONNECTED_MS);
    try {
      await say(
        this.deps,
        conversation,
        lang === "zh"
          ? "现在用你的 GitHub 再回答一次你刚才的问题。"
          : "Answering your question again, now with your GitHub.",
      );
    } catch (err) {
      this.deps.logger.warn("a line before a question asked again could not be sent", { error: errorName(err) });
    }
    await offered.again();
  }

  /** "Not now": the card closes, the question is not asked again, and no card is offered for a day. */
  async dismiss(
    sender: UserRef,
    data: Readonly<Record<string, unknown>>,
    lang: "zh" | "en",
    settle: (text: string) => Promise<unknown>,
  ): Promise<void> {
    const offered = this.offered.get(sender.id);
    if (offered === undefined || data.card !== offered.cardId) {
      await settle(lang === "zh" ? "这张卡片已经处理过了。" : "This card has already been dealt with.");
      return;
    }
    this.offered.delete(sender.id);
    this.quiet.set(sender.id, this.now() + DECLINED_MS);
    await settle(
      lang === "zh"
        ? "好的，先不连 GitHub；随时可以发 `/github bind`。"
        : "Not now, then. Send `/github bind` whenever you want to connect GitHub.",
    );
  }

  /** The scope line, when Claw reads this person's GitHub with their binding; never throws. */
  private async maybeHint(request: ConnectRequest, repos: readonly (readonly [string, string])[]): Promise<void> {
    let connection;
    try {
      connection = await this.deps.claw.settings.githubConnection(request.credential);
    } catch (err) {
      this.deps.logger.info("Claw's GitHub connection could not be read; no scope hint", { error: errorKind(err) });
      return;
    }
    if (connection === null || !connection.bindingReads || connection.readsWith !== "binding") {
      // (a GH_TOKEN, or nothing: a binding's scope is not what limits it)
      this.wide.set(request.sender.id, this.now() + CONNECTED_MS);
      return;
    }
    await this.hintWiderScope(request, repos);
  }

  /** The binding reads public repositories only and the message names one GitHub does not show publicly: one line says so. */
  private async hintWiderScope(
    request: ConnectRequest,
    repos: readonly (readonly [string, string])[],
  ): Promise<boolean> {
    const userId = request.sender.id;
    const status = await this.deps.credentials.status(userId);
    if (!status.ok) return false;
    const state = status.value;
    if (!usable(state) || !needsWiderScope(state.scopes)) {
      this.wide.set(userId, this.now() + CONNECTED_MS);
      return false;
    }
    let hidden: string | undefined;
    for (const [owner, name] of repos.slice(0, MAX_REPOS_LOOKED_AT)) {
      // (404 without a credential: private, internal, or not there)
      if ((await this.deps.pulls.repo(owner, name)) === "") {
        hidden = `${owner}/${name}`;
        break;
      }
    }
    if (hidden === undefined) return false;
    this.narrowHint.set(userId, this.now() + SHOWN_MS);
    const line =
      request.lang === "zh"
        ? `提示：${hidden} 不是公开仓库，而你的 GitHub（\`${state.login}\`）是用 \`public_repo\` 权限连接的，读不到私有和内部仓库。发 \`/github bind\` 重新授权一次（申请 \`repo\`；会写入的操作仍然每次先问你），然后再问一次。`
        : `Note: ${hidden} is not a public repository, and your GitHub (\`${state.login}\`) was connected with \`public_repo\`, which cannot read private or internal repositories. Send \`/github bind\` to connect it again with \`repo\` (anything that would write still waits for your approval each time), then ask again.`;
    try {
      await say(this.deps, request.conversation, line);
    } catch (err) {
      this.deps.logger.warn("the GitHub scope hint could not be sent", { error: errorName(err) });
      return false;
    }
    return true;
  }
}
