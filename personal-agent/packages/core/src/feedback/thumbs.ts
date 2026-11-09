// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawError, errorKind } from "../claw/errors.js";
import { errorName } from "../errors.js";
import { FEEDBACK_TEXT as T } from "../locales/feedback.js";
import type { ClawAssistantPort } from "../ports/claw/assistant.js";
import type { ClawSessionsPort } from "../ports/claw/sessions.js";
import type { Logger } from "../ports/logger.js";
import type { ClickHandler, ClickRoute, RouteBase } from "../ports/routing.js";
import type { SessionRepository } from "../ports/store/sessions.js";
import { textMessage, type InboundVote, type OutMessage, type UserRef } from "../ports/surface.js";
import { cpHead, pyStrip } from "../text/py-text.js";
import type { Mask } from "./issue-text.js";
import type { FeedbackReporting } from "./reporting.js";
import { THUMB_COMMENT_MAX } from "./views.js";

/**
 * Thumbs under an answer: the channel's own (a vote event with the comment its form took) and the bot's own card where
 * the channel's do not reach the worker (Teams mobile). Every thumb is counted and is the person's vote on that answer
 * in Claw (`PUT /v1/sessions/:id/feedback`); a thumbs-down, with or without words, is also filed like /feedback. The
 * vote and the filing run in the background: the click is never held while the session is read and the issue filed.
 */

/** What Claw's answer feedback accepts as a message id (Claw's `FEEDBACK_MESSAGE_ID_PATTERN`). */
const VOTE_MESSAGE_ID = /^[A-Za-z0-9._:@-]{1,100}$/;
/** The comment a vote carries, clipped (Claw takes up to 8192). */
export const VOTE_REASON_MAX = 2000;

export type Reaction = "like" | "dislike";

export interface ThumbsDeps {
  readonly reporting: FeedbackReporting;
  readonly sessions: Pick<SessionRepository, "getSession">;
  readonly claw: {
    readonly sessions: Pick<ClawSessionsPort, "vote">;
    readonly assistant: Pick<ClawAssistantPort, "session">;
  };
  readonly credential: (sender: UserRef) => Promise<string | undefined>;
  /** A 1:1 chat that talks to the person's assistant (its answers are in the assistant's session). */
  readonly assistantOn: (userId: string) => boolean;
  /** SHA-256 of a text, as lowercase hex (the runtime's crypto). */
  readonly sha256Hex: (text: string) => string;
  readonly mask: Mask;
  readonly log: Logger;
}

/** The key a thumb is stored under in Claw: `teams:<message id>`, hashed when Claw would refuse it as it is. */
export function voteMessageId(sha256Hex: (text: string) => string, messageId: string): string | undefined {
  if (!pyStrip(messageId)) return undefined;
  const key = `teams:${messageId}`;
  return VOTE_MESSAGE_ID.test(key) ? key : `teams:${sha256Hex(messageId).slice(0, 40)}`;
}

export class FeedbackThumbs {
  private readonly counts = { like: 0, dislike: 0 };
  private readonly background = new Set<Promise<void>>();

  constructor(private readonly deps: ThumbsDeps) {}

  /** The bot's own thumbs card and the comment card a thumbs-down turns it into. */
  readonly clicks: ClickHandler = {
    verbs: ["thumb", "thumb_note"],
    beforeCredential: async (click) => {
      await this.click(click);
      return true;
    },
    inGroup: async (click) => {
      await this.click(click);
      return true;
    },
  };

  /** The thumbs counted since start. */
  get counted(): Readonly<Record<Reaction, number>> {
    return { ...this.counts };
  }

  /** Resolves when every vote and report started so far has finished (for an orderly stop, and for tests). */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  /** The channel's own thumbs: the person has written their comment in the channel's form. */
  onVote(route: RouteBase, vote: InboundVote): void {
    this.count(vote.reaction, route.scope);
    this.vote(route, vote.messageId, vote.reaction, vote.comment);
    this.deps.log.info("feedback thumb from the channel's own thumbs", {
      platform: vote.clientPlatform || "unknown",
    });
    if (vote.reaction === "dislike") this.fileThumb(route, vote.comment);
  }

  private async click(click: ClickRoute): Promise<void> {
    if (click.action.data["primusclaw"] === "thumb_note") {
      await this.noteClick(click);
      return;
    }
    const reaction = click.action.data["reaction"];
    if (reaction !== "like" && reaction !== "dislike") {
      await click.settle(T.buttonInactive);
      return;
    }
    this.count(reaction, click.scope);
    this.vote(click, click.action.cardMessageId, reaction, "");
    if (reaction === "like") {
      await click.settle(T.thumbsUp);
      return;
    }
    const card: OutMessage = {
      body: { type: "view", view: { name: "thumbComment", model: {} }, fallbackText: T.thumbsDownAsk },
    };
    await click.settle(card, { fallback: T.thumbsDownAsk });
  }

  /** Send or Skip under a thumbs-down: filed with what was typed (Skip: without), the card ends as a note. */
  private async noteClick(click: ClickRoute): Promise<void> {
    const { data } = click.action;
    const comment = typeof data["comment"] === "string" ? data["comment"] : "";
    const words = data["skip"] === true ? "" : cpHead(pyStrip(comment), THUMB_COMMENT_MAX);
    if (words) this.vote(click, click.action.cardMessageId, "dislike", words); // same message: replaces the tap's vote
    this.fileThumb(click, words);
    await click.settle(T.filing);
  }

  private count(reaction: Reaction, scope: string): void {
    this.counts[reaction] += 1;
    this.deps.log.info("feedback thumb", {
      reaction,
      chat: scope ? "group" : "1:1",
      like: this.counts.like,
      dislike: this.counts.dislike,
    });
  }

  private track(work: () => Promise<void>): void {
    const task = work().finally(() => this.background.delete(task));
    this.background.add(task);
  }

  /** The vote, in the background, never said to the person: one that is not recorded is logged with why. */
  private vote(route: RouteBase, messageId: string, reaction: Reaction, words: string): void {
    this.track(async () => {
      let outcome: string;
      try {
        outcome = await this.voteInClaw(route, messageId, reaction, words);
      } catch (err) {
        outcome = err instanceof ClawError ? `refused (${String(err.status)})` : `failed (${errorName(err)})`;
      }
      this.deps.log.info("feedback vote", { reaction, chat: route.scope ? "group" : "1:1", outcome });
    });
  }

  private async voteInClaw(route: RouteBase, messageId: string, reaction: Reaction, words: string): Promise<string> {
    const key = voteMessageId(this.deps.sha256Hex, messageId);
    if (key === undefined) return "no message to vote on";
    const credential = await this.deps.credential(route.sender);
    if (!credential) return "not linked";
    const sessionId =
      !route.scope && this.deps.assistantOn(route.sender.id)
        ? (await this.deps.claw.assistant.session(credential)).sessionId
        : this.deps.sessions.getSession(route.sender.id, route.scope);
    if (!sessionId) return "no session";
    // The comment is what the person typed in a form: masked like any message before it is stored, and clipped.
    const reason = pyStrip(words) ? cpHead(this.deps.mask(pyStrip(words)), VOTE_REASON_MAX) : undefined;
    await this.deps.claw.sessions.vote(credential, sessionId, key, reaction === "like" ? "up" : "down", reason);
    return "recorded";
  }

  /** A thumbs-down is filed like /feedback, in the background. */
  private fileThumb(route: RouteBase, words: string): void {
    const text = words ? `(thumbs down) ${words}` : "(thumbs down, no comment)";
    this.track(async () => {
      try {
        await this.deps.reporting.file(route, text);
      } catch (err) {
        this.deps.log.error("filing a thumbs-down report failed", { why: errorKind(err) });
        await route.conversation.send(textMessage(T.thumbReportFailed)).catch((sendErr: unknown) => {
          this.deps.log.warn("telling the person that the report failed did not work either", {
            why: errorKind(sendErr),
          });
        });
      }
    });
  }
}
