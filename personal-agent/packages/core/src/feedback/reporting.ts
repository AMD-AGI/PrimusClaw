// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import { FEEDBACK_TEXT as T } from "../locales/feedback.js";
import type { IdentityLookup, KeyOwner } from "../plugins/identity-lookup.js";
import type { ClawAssistantPort } from "../ports/claw/assistant.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { RouteBase } from "../ports/routing.js";
import type { SessionRepository } from "../ports/store/sessions.js";
import { textMessage, type OutMessage, type UserRef } from "../ports/surface.js";
import { withDeadline } from "./deadline.js";
import type { FeedbackService, ReportResult } from "./service.js";
import { offerTitle } from "./views.js";

/**
 * The one path every report takes, from `/feedback`, a thumbs-down or the Report a problem button: the scene is read,
 * the issue filed (or the earlier one commented), the person told, and in a 1:1 chat offered to add their last question
 * and answer. It runs before the account check, so a person who cannot link yet can still report that.
 */

/** A report waits this long, at most, for the reporter's name and email from the platform the key belongs to. */
const REPORTER_LOOKUP_MS = 5_000;

export interface ReportingDeps {
  readonly service: FeedbackService;
  readonly sessions: Pick<SessionRepository, "getSession">;
  readonly assistant: Pick<ClawAssistantPort, "session">;
  /** A 1:1 chat that talks to the person's assistant: its turns are in the assistant's session, which the report's scene is then. */
  readonly assistantOn: (userId: string) => boolean;
  /** The person's Claw credential if they have one; never asks them for it (`undefined`: not linked). */
  readonly credential: (sender: UserRef) => Promise<string | undefined>;
  readonly identity: IdentityLookup;
  readonly clock: Clock;
  readonly log: Logger;
}

export function replyText(result: ReportResult): string {
  const issue = { number: result.number ?? 0, url: result.url ?? "" };
  if (result.kind === "filed") return T.filed(issue);
  if (result.kind === "commented") return T.commented(issue);
  return result.kind === "unconfigured" ? T.unconfigured : T.failed;
}

export class FeedbackReporting {
  constructor(private readonly deps: ReportingDeps) {}

  async file(route: RouteBase, text: string): Promise<void> {
    const { sender, scope, conversation } = route;
    const key = await this.deps.credential(sender);
    const { name, email } = await this.reporterOf(sender, key);
    const result = await this.deps.service.report(
      { userId: sender.id, name, email, scope, conversationId: conversation.ref.id },
      text,
      key,
      await this.sessionOf(sender, scope, key),
    );
    await conversation.send(textMessage(replyText(result)));
    const offer = !scope && key ? this.deps.service.makeOffer(sender.id, result) : undefined; // 1:1 only
    if (offer) await conversation.send(offerMessage(offer.offerId, offer.issueNumber));
  }

  /**
   * The session whose turns the report shows: the one the chat talks to. A 1:1 chat with the assistant on talks to the assistant's
   * session (as a thumb's vote is cast there, `thumbs.ts`), so its turns are the ones reported, not the plain chat session's. When the
   * assistant's session cannot be read, the report goes without turns rather than with another session's.
   */
  private async sessionOf(sender: UserRef, scope: string, key: string | undefined): Promise<string | undefined> {
    if (scope || !key || !this.deps.assistantOn(sender.id))
      return this.deps.sessions.getSession(sender.id, scope) ?? undefined;
    try {
      return (await this.deps.assistant.session(key)).sessionId;
    } catch (err) {
      this.deps.log.warn("feedback: the assistant's session could not be read", { why: errorName(err) });
      return undefined;
    }
  }

  /** What the channel gave, and for what is missing, what the key's platform says; a slow or failed lookup is skipped. */
  private async reporterOf(sender: UserRef, key: string | undefined): Promise<{ name: string; email: string }> {
    let { name, email } = sender;
    if (key && !(name && email)) {
      let found: KeyOwner | undefined;
      try {
        found = await withDeadline(this.deps.clock, REPORTER_LOOKUP_MS, () => this.deps.identity.ownerOfKey(key));
      } catch (err) {
        this.deps.log.warn("feedback: the reporter's profile could not be read", { why: errorName(err) });
      }
      if (found) {
        name = name || found.name;
        email = email || found.email;
      }
    }
    return { name, email };
  }
}

export function offerMessage(offerId: string, issueNumber: number): OutMessage {
  return {
    body: {
      type: "view",
      view: { name: "feedbackOffer", model: { offerId, issueNumber } },
      fallbackText: offerTitle(issueNumber),
    },
  };
}
