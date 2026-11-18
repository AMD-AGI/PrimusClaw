// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the review delegation service is built from: ports (store, Claw, GitHub, the channel, the token exchange, time),
 * and the hooks of the chat it runs in (the router starts its turns, admits its tasks and onboards people). Nothing here
 * is a concrete adapter: the assembly passes them, and tests pass fakes.
 */

import type { JsonObject } from "../../json.js";
import type { Guardrails } from "../../guardrails/guardrails.js";
import type { Lang } from "../../locales/lang.js";
import type { TokenExchange } from "../../plugins/token-exchange.js";
import type { ClawPort } from "../../ports/claw/index.js";
import type { Clock } from "../../ports/clock.js";
import type { DeviceFlow, GithubCredentials, IntentReader, PullReader } from "../../ports/github.js";
import type { Logger } from "../../ports/logger.js";
import type { StorePort } from "../../ports/store/index.js";
import type { Conversation, ConversationRef, InboundMessage, Surface, UserRef } from "../../ports/surface.js";
import type { PublicErrors } from "../../public-error/public-errors.js";
import type { ReviewTurn } from "../review-turn.js";
import type { ReviewTurnOptions } from "../../turn/runner.js";
import type { Redact } from "../summary.js";

/** The per-person limits of the operations that act with someone's authority (W2's `Guardrails`). */
export type Guard = Pick<Guardrails, "take" | "giveBack">;

/** The audit trail of what was done with a person's GitHub account (`guardrails.audit`). */
export type Audit = (event: string, fields: Readonly<Record<string, unknown>>) => void;

/** The task slots a request's reviews may use (`Agent._admit_reviews`). */
export interface ReviewTaskSlots {
  readonly granted: number;
  readonly running: number;
  readonly limit: number;
  /** The Claw items the slots hold (counted once on the asker's board). */
  readonly itemIds: Set<string>;
  /** A review is now followed as a turn (or did not start): its slot is let go. */
  followed(itemId: string): void;
  release(): void;
}

/** A review turn the router started: `ended` settles when the turn has ended, whichever way. */
export interface StartedReviewTurn {
  readonly ended: Promise<void>;
}

export interface StartReviewTurn {
  readonly message: InboundMessage;
  readonly sender: UserRef;
  /** The asker's exchanged identity token. */
  readonly token: string;
  readonly prompt: string;
  readonly conversation: Conversation;
  readonly scope: string;
  readonly review: ReviewTurn;
  /** The asker's own linked key, the model key of a review of their own ('' none). */
  readonly modelKey: string;
  /** What the turn engine is given for a review (`TurnRun.review.turn`). */
  readonly turn: ReviewTurnOptions;
}

/** What the chat the service runs in does for it. */
export interface ReviewHost {
  /** Starts the review's turn; undefined when it did not start (the asker was told why). */
  startTurn(request: StartReviewTurn): Promise<StartedReviewTurn | undefined>;
  /** The usual onboarding of a group member who is not connected (`identity`: they connect at the identity service). */
  onboard(message: InboundMessage, sender: UserRef, conversation: Conversation, scope: string): Promise<void>;
  /** The steps that link a person's own Primus key (`/link`), after `lead`. */
  askLink(person: UserRef, conversation: Conversation, lead: string): Promise<void>;
  /** The card that binds a person at the identity service, after `lead`. */
  connectIdentity(person: UserRef, conversation: Conversation, lead: string): Promise<void>;
  /** The task slots `count` reviews may use; undefined: no task limit here. */
  admitReviews?(message: InboundMessage, sender: UserRef, count: number, modelKey: string): Promise<ReviewTaskSlots>;
  /** '' when what waits for this person reaches their chat (their subscription made or mended first), else why not. */
  reviewerReach?(userId: string): Promise<string>;
}

/** The channel's fields a followed review keeps to reach the reviewer again after a restart (Teams: service url, tenant, bot). */
export type FollowWire = (asked: ConversationRef) => Readonly<Record<string, string>>;

/** A conversation reference again, from what the store kept of it (the channel's own reference); undefined when unreadable. */
export type RestoreRef = (stored: JsonObject) => ConversationRef | undefined;

export interface ReviewDeps {
  readonly store: StorePort;
  readonly claw: ClawPort;
  readonly credentials: GithubCredentials;
  readonly device: DeviceFlow;
  readonly pulls: PullReader;
  /** undefined: requests are read by the rules alone. */
  readonly intent: IntentReader | undefined;
  readonly surface: Surface;
  readonly exchange: TokenExchange;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly errors: PublicErrors;
  /** Credential shapes masked: what a group, and a reviewer's own chat, are sent. */
  readonly mask: Redact;
  readonly guard: Guard;
  readonly audit: Audit;
  readonly host: ReviewHost;
  readonly followWire: FollowWire;
  readonly restoreRef: RestoreRef;
  /** The owners whose public repositories may be reviewed (REVIEW owners). */
  readonly owners: readonly string[];
  /** The "Add the app" link on a card for a person who may not have the app ('' none). */
  readonly installUrl: string;
  /** What a review runs on when its request names no model ('' Claw's default). */
  readonly defaultModel: string;
  /** The bot's name in this deployment (`Settings.botName`), in every text that names it. */
  readonly botName: string;
}

/** The language of a text a person wrote, as the review service answers in it. */
export type ReviewLang = Lang;
