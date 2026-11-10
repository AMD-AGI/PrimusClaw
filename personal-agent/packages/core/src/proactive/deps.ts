// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the delivery of unasked messages needs (teams_agent/proactive.py `Proactive.__init__`, and what it imported). */
import type { RequestScope } from "../ports/request-scope.js";
import type { DirectChat } from "../direct-chat/direct-chat.js";
import type { JsonObject } from "../json.js";
import type { ClawWorkItemsPort } from "../ports/claw/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { StorePort } from "../ports/store/index.js";
import type { Conversation, Envelope, OutMessage } from "../ports/surface.js";
import type { Receipts } from "../assistant/receipts.js";
import type { DeliveryLink, SayPlanner } from "../assistant/say.js";
import type { SaidMessages } from "./said-memory.js";

export type ProactiveStore = Pick<
  StorePort,
  | "now"
  | "prefs"
  | "held"
  | "references"
  | "approvals"
  | "remotePermissions"
  | "remoteState"
  | "turns"
  | "links"
  | "assistantCards"
>;

/** A permission request an agent on the person's machine pushed (`assistant.say` with `remote.ask`), to be drawn as its card. */
export interface RemoteAskRequest {
  readonly ask: Readonly<Record<string, unknown>>;
  readonly options: readonly unknown[];
  readonly sessionId: string;
  readonly machine: string;
  readonly agent: string;
  /** Which work item asks ("#seq title"; "" none). */
  readonly about: string;
  readonly expiresAt: number;
  readonly zone: string;
  readonly lang: string;
}

/** The remote agents' side of a push (W6/W6b): reading a request's options, its card, and what an agent said on its own. */
export interface RemotePushViews {
  /** The options a request offers (remote_view.parse_options); [] when none can be answered. */
  options(raw: unknown): readonly unknown[];
  askCard(request: RemoteAskRequest): OutMessage;
  /** What a remote agent (`label`) said on its own, as messages (remote_view.unsolicited_parts). */
  saidParts(label: string, text: string): readonly string[];
}

/** The turns' side of a run's end (W4b): a lost turn's answer, and what the session changed. */
export interface RunFollowUps {
  /** The messages of a finished run's answer after `lead` (turn.last_answer + answer_parts); undefined when it cannot be read. */
  lostAnswer(key: string, sessionId: string, lead: string): Promise<readonly string[] | undefined>;
  /** The card of what the session changed, when the sandbox still has it (best effort, never throws). */
  offerChanges(key: string, sessionId: string, conversation: Conversation): Promise<void>;
}

export interface ProactiveDeps {
  readonly store: ProactiveStore;
  /** The conversation a stored reference posts to. */
  readonly conversationFor: (reference: JsonObject) => Conversation;
  /**
   * Publish a stored envelope as it was built (it carries its own conversation: a group's card goes back to that group), the
   * Python worker's `outbox.publish(card.envelope)`.
   */
  readonly deliverStored: (envelope: Envelope) => Promise<void>;
  /** `post` gives back the new message's id (it can be added to later). */
  readonly messageIds: boolean;
  readonly say: SayPlanner;
  readonly receipts: Receipts;
  readonly directChat: DirectChat;
  readonly said: SaidMessages;
  /** Claw's links for delivered files; undefined: files are named. */
  readonly deliveryLink: DeliveryLink | undefined;
  /** Whether an item's automatic replies are still on (undefined: what was recorded stands). */
  readonly claw: Pick<ClawWorkItemsPort, "watches"> | undefined;
  readonly remote: RemotePushViews;
  readonly runs: RunFollowUps | undefined;
  readonly publicBaseUrl: string;
  /** ASSISTANT_REPLY_WINDOW_SECONDS. */
  readonly replyWindowSeconds: number;
  readonly clock: Clock;
  readonly logger: Logger;
  /** A run's event as a card may show it (`publicRunEvent` bound to the public-error service): internal errors withheld. */
  readonly publicEvent: (event: JsonObject) => JsonObject;
  /** The bot's display name (branding; "Clawy" by default). */
  readonly botName: string;
  /**
   * The inbound event being handled, if any (Python CLIENT_LOCALE): held messages released while a message of the person's is
   * handled (`/resume`, quiet hours off) answer in their client's language; a push or a sweep reads none. Default: none.
   */
  readonly requestScope?: RequestScope;
}
