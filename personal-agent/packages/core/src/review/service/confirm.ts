// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A write Claw holds for the reviewer's own confirmation (a high-risk merge, or a held review): recorded with its owner, one
 * card to that person alone and the group told; and THE answer to it, pressed on the card or typed in their 1:1 chat. The
 * card is never trusted: the confirmation, and whose it is, come from the store. Claw is answered with the person's
 * exchanged token only, one claim makes a double answer lose, and what Claw says is told to the reviewer and the group.
 */

import { ClawError } from "../../claw/errors.js";
import { clipPrSummary } from "../summary.js";
import { errorName } from "../../errors.js";
import { cpHead, squashSpaces } from "../../text/py-text.js";
import { correlationId } from "../../guardrails/correlation.js";
import type { JsonObject } from "../../json.js";
import { noteMessage } from "../../note/note.js";
import type { GithubConfirmation } from "../../ports/store/github.js";
import type { Conversation, OutMessage, UserRef } from "../../ports/surface.js";
import { decisionWords, namesReviewAndMerge, pickRow, readTypedAnswer, typedMode } from "../../typed-answer/index.js";
import { expiryOf, heldReview, namesPull } from "../held.js";
import { plainText } from "../../review-text/names.js";
import { checksText, heldWords, outcomeLines } from "../outcome.js";
import { slug, shortName } from "../../review-text/pull-ref.js";
import { serviceRefusal } from "../refusals.js";
import type { ReviewTurn } from "../review-turn.js";
import { githubConfirmButtons, githubConfirmMessage } from "../views.js";
import { say, stored } from "./chat.js";
import type { ReviewDeps } from "./deps.js";
import { clawFailure, tokenFor } from "./identity.js";
import type { GithubAccount } from "./account.js";
import type { Notices } from "./notices.js";

/** How an answer to a held write ended. */
export interface Answered {
  /** What the person is told. */
  readonly text: string;
  /** Still pending: the buttons stay, and they may answer again. */
  readonly open: boolean;
  /** They must connect their Primus account first. */
  readonly connect: boolean;
  /** What the group that asked is told ('' none). */
  readonly group: string;
}

const answered = (text: string, more: Partial<Answered> = {}): Answered => ({
  text,
  open: false,
  connect: false,
  group: "",
  ...more,
});

/** How a click is settled (the router's `ClickRoute.settle`). */
export type Settle = (card: OutMessage | string, fallback?: string) => Promise<unknown>;

export class HeldWrites {
  constructor(
    private readonly deps: ReviewDeps,
    private readonly notices: Notices,
    private readonly account: GithubAccount,
  ) {}

  /** One write Claw holds, offered to the reviewer; a record that is not for this review is not sent. */
  async offer(review: ReviewTurn, item: Readonly<Record<string, unknown>>, asked: Conversation): Promise<void> {
    const confirmationId = plainText(item.id);
    const held = this.heldOf(review, item, confirmationId);
    if (held === undefined) return;
    const kind = held === null ? "merge" : "review";
    const event = held === null ? "" : plainText(held.event);
    const added = this.deps.store.githubConfirmations.addGithubConfirmation({
      confirmationId,
      sessionId: review.sessionId,
      actorId: review.actorId,
      requesterId: review.requesterId,
      repo: slug(review.pull),
      pr: review.pull.number,
      reference: (review.asked?.wire ?? {}) as JsonObject,
      expiresAt: expiryOf(item.expires_at, this.deps.store.now()),
      kind,
      event,
    });
    if (!added) return; // (already offered)
    const who = review.actorName || "对方";
    const pull = shortName(review.pull);
    const sent = await this.sendCard(review, item, confirmationId, held ?? undefined);
    if (!sent) this.deps.store.githubConfirmations.forgetGithubConfirmation(confirmationId);
    let text: string;
    if (held !== null) {
      text = sent
        ? `${pull} 的 ${event} review 要用 ${who} 的账号发出：我已私信 ${who} 请其确认，${who} 确认之前不会发布。`
        : `${pull} 的 ${event} review 需要 ${who} 本人确认，但我没能私信 ${who}，所以没有发布。`;
    } else {
      text = sent
        ? `${pull} 是高风险变更：我已私信 ${who} 请其确认，${who} 确认之前不会合入。`
        : `${pull} 是高风险变更，需要 ${who} 本人确认，但我没能私信 ${who}，所以没有合入。`;
    }
    await say(this.deps, asked, text);
  }

  /**
   * What Claw's record holds: the review it holds (null for a merge), or undefined when it is not for this review, or holds
   * nothing a card can show (a card that names another pull request would be answered as if it were this one).
   */
  private heldOf(
    review: ReviewTurn,
    item: Readonly<Record<string, unknown>>,
    confirmationId: string,
  ): Readonly<Record<string, unknown>> | null | undefined {
    if (!confirmationId || plainText(item.actor_user_id) !== review.actorUserId || !namesPull(item, review.pull)) {
      this.deps.logger.warn("a confirmation that is not for this review was ignored");
      return undefined;
    }
    const kind = Object.hasOwn(item, "kind") ? item.kind : "merge";
    if (kind === "merge") return null;
    const held = kind === "review" ? heldReview(item) : undefined;
    if (held === undefined) this.deps.logger.warn("a confirmation this worker has no card for was not offered");
    return held;
  }

  private async sendCard(
    review: ReviewTurn,
    item: Readonly<Record<string, unknown>>,
    confirmationId: string,
    held: Readonly<Record<string, unknown>> | undefined,
  ): Promise<boolean> {
    try {
      const chat = await this.notices.reviewerChat(review);
      if (chat === undefined) throw new Error("no 1:1 chat with the reviewer");
      const reasons = Array.isArray(item.reasons) ? item.reasons.filter((r): r is string => typeof r === "string") : [];
      // (where the merge lands, as GitHub says now)
      const base = held === undefined ? await this.deps.pulls.base(review.pull) : "";
      const comments = held?.comments;
      await chat.send(
        githubConfirmMessage({
          confirmationId,
          repo: slug(review.pull),
          number: review.pull.number,
          title: plainText(item.title),
          author: plainText(item.author),
          headSha: plainText(item.head_sha).slice(0, 12),
          reasons,
          checks: checksText(item.checks),
          requester: review.requesterName,
          room: "",
          review:
            held === undefined
              ? undefined
              : {
                  event: plainText(held.event),
                  body: this.deps.mask(plainText(held.body)),
                  comments: Array.isArray(comments) ? comments.length : 0,
                },
          model: review.ranModel,
          hint: !this.deps.store.members.clickedPersonally(review.actorId),
          installUrl: this.deps.installUrl,
          base,
          login: review.actorLogin,
          lang: review.lang,
          summary: clipPrSummary(item.pr_summary) || clipPrSummary(review.prSummary),
        }),
      );
      return true;
    } catch (err) {
      this.deps.logger.warn("the confirmation card could not be sent", { error: errorName(err) });
      return false;
    }
  }

  /** A click on Merge / Do not merge (Post review / Do not post). */
  async click(
    sender: UserRef,
    data: Readonly<Record<string, unknown>>,
    settle: Settle,
    conversation: Conversation,
  ): Promise<void> {
    const confirmationId = plainText(data.confirmation);
    const decision = data.decision;
    const row = confirmationId ? this.deps.store.githubConfirmations.getGithubConfirmation(confirmationId) : null;
    if ((decision !== "allow" && decision !== "deny") || row === null) {
      await settle("That choice is no longer active.");
      return;
    }
    const words = heldWords(row);
    const again = githubConfirmButtons(confirmationId, row.kind === "review");
    if (row.actorId !== sender.id) {
      const text = "Only the person this was asked of can answer it.";
      await settle(noteMessage({ text, title: words.title, buttons: again }), text);
      return;
    }
    const answer = await this.answer(row, sender, decision, false);
    if (answer.open) await settle(noteMessage({ text: answer.text, title: words.title, buttons: again }), answer.text);
    else await settle(answer.text);
    await this.afterAnswer(row, sender, conversation, answer);
  }

  /** What follows an answer: the card that connects the person when needed, and the group told how it ended. */
  private async afterAnswer(
    row: GithubConfirmation,
    sender: UserRef,
    conversation: Conversation,
    answer: Answered,
  ): Promise<void> {
    if (answer.connect) {
      try {
        await this.deps.host.connectIdentity(sender, conversation, "");
      } catch (err) {
        this.deps.logger.warn("the card that connects a reviewer could not be sent", { error: errorName(err) });
      }
    }
    if (!answer.group) return;
    try {
      const group = stored(this.deps, row.reference);
      if (group !== undefined) await say(this.deps, group, answer.group);
    } catch (err) {
      this.deps.logger.warn("the group could not be told how a confirmation ended", { error: errorName(err) });
    }
  }

  /** THE answer of the person a held write waits for. `row` is the store's and its owner is `sender` (the caller checked). */
  async answer(
    row: GithubConfirmation,
    sender: UserRef,
    decision: "allow" | "deny",
    typed: boolean,
  ): Promise<Answered> {
    const words = heldWords(row);
    const [again, againCap] = typed ? ["reply again", "Reply again"] : ["press a button again", "Press a button again"];
    if (row.state !== "pending") return answered("That was already answered.");
    if (this.deps.store.now() >= row.expiresAt) {
      this.deps.store.githubConfirmations.moveGithubConfirmation(row.confirmationId, "done");
      return answered(
        `This confirmation ran out, so ${words.thing} was not ${words.verb}. Ask for a new review if you still want it.`,
      );
    }
    const operation = words.review ? "pr_review" : "pr_merge";
    const correlation = correlationId(row.sessionId, row.repo.toLowerCase(), row.pr);
    const audited = {
      operation,
      aad_object_id: sender.id,
      session_id: row.sessionId || null,
      approval_id: row.confirmationId,
      repo: row.repo,
      pr_number: row.pr,
      decision: decision === "allow" ? "confirm" : "decline",
      correlation_id: correlation,
    };
    // A confirmation is limited per person (declining never is); it stays pending, to be answered again later
    const ticket = {};
    if (decision === "allow") {
      const limited = this.deps.guard.take(sender.id, operation, ticket, {
        session_id: audited.session_id,
        approval_id: row.confirmationId,
        repo: row.repo,
        pr_number: row.pr,
        correlation_id: correlation,
      });
      if (limited !== null) return answered(limited.text(), { open: true });
    }
    // (nothing was confirmed after all: it does not use up the person's allowance)
    const giveBack = (): void => {
      if (decision === "allow") this.deps.guard.giveBack(sender.id, operation, ticket);
    };
    return this.decide(row, sender, decision, { again, againCap, audited, giveBack });
  }

  private async decide(
    row: GithubConfirmation,
    sender: UserRef,
    decision: "allow" | "deny",
    a: { again: string; againCap: string; audited: Readonly<Record<string, unknown>>; giveBack: () => void },
  ): Promise<Answered> {
    const words = heldWords(row);
    // Before the answer is claimed, so a person who is not connected loses nothing: the confirmation stays pending.
    const token = await tokenFor(this.deps, sender.id);
    if (!("token" in token)) {
      a.giveBack();
      if (token.failed === "not_bound") {
        return answered(
          `This chat is not connected to your Primus account through the identity service, so I cannot answer for you. Connect with the card below, then ${a.again}.`,
          { open: true, connect: true },
        );
      }
      this.deps.logger.warn("the token to answer a confirmation could not be exchanged", { error: token.reason });
      return answered(`I could not reach the Primus platform to answer for you. ${a.againCap} in a moment.`, {
        open: true,
      });
    }
    const confirmations = this.deps.store.githubConfirmations;
    if (!confirmations.moveGithubConfirmation(row.confirmationId, "sending")) {
      a.giveBack(); // (a double tap loses here)
      return answered("That was already answered.");
    }
    const retry = (text: string): Answered => {
      confirmations.moveGithubConfirmation(row.confirmationId, "pending", { onlyFrom: "sending" });
      return answered(text, { open: true });
    };
    let outcome: Readonly<Record<string, unknown>>;
    try {
      outcome = await this.deps.claw.mergeConfirmations.decide(token.token, row.confirmationId, decision);
    } catch (err) {
      if (!clawFailure(err)) throw err;
      a.giveBack();
      if (!(err instanceof ClawError)) {
        this.deps.audit("merge_confirmed", { outcome: "failure", ...a.audited });
        return retry(`I could not reach PrimusClaw. Please ${a.again} in a moment.`);
      }
      const gone = [404, 409, 410].includes(err.status);
      this.deps.audit("merge_confirmed", {
        outcome: gone ? "expired" : "failure",
        status: err.status || null,
        ...a.audited,
      });
      if (gone) {
        confirmations.moveGithubConfirmation(row.confirmationId, "done", { onlyFrom: "sending" });
        return answered(`This confirmation is no longer active, so nothing was ${words.verb}.`);
      }
      if (err.status === 403) return retry(serviceRefusal(err.code, `Nothing was ${words.verb}.`));
      return retry(`PrimusClaw did not accept the answer (error ${String(err.status)}). ${a.againCap} in a moment.`);
    }
    return this.decided(row, sender, outcome, a.audited, a.giveBack, retry, a.againCap);
  }

  private decided(
    row: GithubConfirmation,
    sender: UserRef,
    outcome: Readonly<Record<string, unknown>>,
    audited: Readonly<Record<string, unknown>>,
    giveBack: () => void,
    retry: (text: string) => Answered,
    againCap: string,
  ): Answered {
    const words = heldWords(row);
    const status = plainText(outcome.status);
    // Claw's word: done as asked (merged, queued, posted, or dropped on a decline), ran out or went stale, or not done
    const done = [words.done, "queued", "denied"].includes(status);
    if (!done && outcome.wrote !== true) giveBack(); // (a try that already wrote to GitHub keeps its count)
    const result = done ? "success" : status === "expired" || status === "stale" ? "expired" : "failure";
    this.deps.audit("merge_confirmed", { outcome: result, ...audited });
    if (status === "merged" && !words.review) {
      const merged = Object.fromEntries(
        Object.entries(audited).filter(([k]) => k !== "decision" && k !== "approval_id"),
      );
      this.deps.audit("pr_merged", { outcome: "merged", ...merged });
    }
    if (status === "retry") {
      // (Claw could not try it just now and kept it open: the answer is not used up)
      const reason = this.deps.errors.publicReason(squash(plainText(outcome.reason)), "github_retry", {
        pr: `${row.repo}#${String(row.pr)}`,
      });
      return retry(
        `PrimusClaw could not try the ${words.review ? "review" : "merge"} just now${reason ? ` (${reason})` : ""}, and the confirmation is still open. ${againCap} in a moment.`,
      );
    }
    this.deps.store.githubConfirmations.moveGithubConfirmation(row.confirmationId, "done", { onlyFrom: "sending" });
    const [card, group] = outcomeLines(row, words, outcome, sender.name || "对方", this.deps.errors);
    return answered(card, { group });
  }

  /**
   * A 1:1 message that answers, in the person's own words, what waits for them: held writes (by number, or all), or the
   * confirmation setting. It decides exactly as a press does. True when the message was one (handled).
   */
  async typed(sender: UserRef, text: string, conversation: Conversation): Promise<boolean> {
    // (a request to review and merge is never an answer to one, whatever a reading says)
    if (Array.from(text).length > 300 || !decisionWords(text) || namesReviewAndMerge(text)) return false;
    const pending = this.deps.store.githubConfirmations.pendingGithubConfirmations(sender.id);
    const mode = typedMode(text);
    const reading = pending.length || mode !== null ? await this.readAnswer(sender, text, pending) : undefined;
    if (reading === "none") return false;
    // (no reading: only a message that is nothing but an answer counts)
    const strict = reading !== "answer";
    if (mode !== null && !/\p{Nd}/u.test(text)) {
      const chosen = !strict || mode.bare ? mode.mode : "";
      if (!chosen) return false;
      const [answer, connect] = await this.account.chooseMode(sender, chosen);
      await say(this.deps, conversation, answer);
      if (connect) await this.account.connectFirst(sender, conversation);
      return true;
    }
    return this.typedDecisions(sender, text, pending, strict, conversation);
  }

  private async typedDecisions(
    sender: UserRef,
    text: string,
    pending: readonly GithubConfirmation[],
    strict: boolean,
    conversation: Conversation,
  ): Promise<boolean> {
    const typed = readTypedAnswer(
      text,
      pending.map((r) => [r.repo, r.pr] as const),
      strict,
    );
    if (typed === null) return false;
    if (typed.question) {
      await say(this.deps, conversation, typed.question);
      return true;
    }
    const chosen: [GithubConfirmation, "allow" | "deny"][] = [];
    // (every one is settled before any is answered: a question decides nothing)
    for (const [[repo, pr], decision] of typed.decisions) {
      const rows = pending
        .filter((r) => r.repo === repo && r.pr === pr)
        .map((r) => ({ ...r, created_at: r.createdAt, confirmation_id: r.confirmationId, row: r }));
      const [first, ...rest] = rows;
      if (first === undefined) continue;
      const row = pickRow([first, ...rest], text);
      if (typeof row === "string") {
        await say(this.deps, conversation, row);
        return true;
      }
      chosen.push([row.row, decision]);
    }
    const lines: string[] = [];
    let connect = false;
    for (const [row, decision] of chosen) {
      const answer = await this.answer(row, sender, decision, true);
      lines.push(`${row.repo}#${String(row.pr)}: ${answer.text}`);
      connect ||= answer.connect;
      await this.afterAnswer(row, sender, conversation, { ...answer, connect: false });
    }
    await say(this.deps, conversation, lines.join("\n\n"));
    if (connect) {
      try {
        await this.deps.host.connectIdentity(sender, conversation, "");
      } catch (err) {
        this.deps.logger.warn("the card that connects a reviewer could not be sent", { error: errorName(err) });
      }
    }
    return true;
  }

  /** The model's word on whether a 1:1 message answers what waits for the person: 'answer', 'none', or undefined. */
  private async readAnswer(
    sender: UserRef,
    text: string,
    pending: readonly GithubConfirmation[],
  ): Promise<"answer" | "none" | undefined> {
    const key = this.deps.intent === undefined ? null : this.deps.store.links.getKey(sender.id);
    if (!key || this.deps.intent === undefined) return undefined;
    const listed = pending.map((r) => ({
      pull_request: `${r.repo}#${String(r.pr)}`,
      waits: r.kind === "review" ? `${r.event} review to post` : "merge",
    }));
    const raw = await this.deps.intent.readAnswer(key, text, listed);
    const intent = raw?.intent;
    return intent === "answer" || intent === "none" ? intent : undefined;
  }
}

function squash(text: string): string {
  return cpHead(squashSpaces(text), 200);
}
