// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Integrations } from "../plugins/integrations.js";
import type { IdentityLookup } from "../plugins/identity-lookup.js";
import type { KeyRevoker } from "../plugins/key-revoker.js";
import type { TokenExchange } from "../plugins/token-exchange.js";
import type { ClawPort } from "../ports/claw/index.js";
import type { Clock } from "../ports/clock.js";
import type { Random } from "../ports/random.js";
import type { Logger, LogValue } from "../ports/logger.js";
import type { MetricsPort } from "../ports/metrics.js";
import type { RouteHandlers } from "../ports/routing.js";
import type { StorePort } from "../ports/store/index.js";
import type { ConversationRef, OutMessage, Surface } from "../ports/surface.js";
import type { JsonObject } from "../json.js";
import type { SecurityEventName } from "../observability/security-events.js";
import type {
  AssistantChat,
  ChannelContextBuilder,
  ConnectionsText,
  GithubChat,
  MessageText,
  NoteFactory,
  Observing,
  RemoteChat,
  ReviewStopReader,
  Subscriptions,
} from "./features.js";
import type { TurnRunner } from "./turn-runner.js";

/** What a deployment sets for the router (the Python `Agent.__init__` arguments that are settings). */
export interface RouterConfig {
  /** The console's address, for the links the router gives (`/primus-claw/teams-link`, the memory page). */
  readonly publicBaseUrl: string;
  readonly botName: string;
  /** Sessions are created with this Claw plugin ("" none). */
  readonly pluginId: string;
  /** Sessions are pinned to this model ("" Claw's default). */
  readonly model: string;
  /** What a review for a colleague runs on when its request named no model ("" the chat's model). */
  readonly reviewModel: string;
  /** A turn refused for want of a gateway key runs again on this model ("" never). */
  readonly fallbackModel: string;
  /** Ordinary chats run on exchanged tokens (TEAMS_EXCHANGE_FOR_CHAT) instead of the linked key. */
  readonly exchangeForChat: boolean;
  /** The parts of help that need Claw switches this worker cannot read. */
  readonly briefEnabled: boolean;
  readonly schedulesEnabled: boolean;
  readonly jobWatchEnabled: boolean;
  /** Answers on a phone get thumbs of the worker's own (TEAMS_OWN_THUMBS_MOBILE). */
  readonly ownThumbsMobile: boolean;
}

/** The repositories the router reads and writes (the W1 store, as far as routing goes). */
export type RouterStore = Pick<
  StorePort,
  | "links"
  | "references"
  | "prefs"
  | "members"
  | "sessions"
  | "repoHistory"
  | "turns"
  | "onboarding"
  | "idempotency"
  | "assistantMessages"
  | "notifySubs"
  | "now"
>;

/** The per-person limits (Python `limits.py`): messages per window and tasks at the same time. */
export interface RouterLimits {
  readonly maxConcurrentTasks: number;
  /** How long a message to the assistant may hold a task slot while its work item has not shown on the board. */
  readonly assistantPendingSeconds: number;
  /** Counts a message of `userId`; when refused, whether the person is told this time and when they may write again. */
  checkMessage(userId: string): { readonly allowed: true } | RateRefusal;
  /** What a refused message says, in `lang`. */
  rateNotice(lang: "en" | "zh", retryAfterSeconds: number): string;
  /** What a refused task says, in `lang`: `running` tasks, `what` the one refused ("" none named). */
  concurrencyNotice(lang: "en" | "zh", running: number, what: string): string;
}

export interface RateRefusal {
  readonly allowed: false;
  readonly notify: boolean;
  readonly retryAfterSeconds: number;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** Stored conversation references, as the channel reads and writes them. */
export interface ChannelRefs {
  /** The reference a stored one is (Teams: the Bot Framework reference the Python worker stored); undefined: not one. */
  refOf(stored: JsonObject): ConversationRef | undefined;
}

/** Notices held by quiet hours or a pause (Python `proactive.Proactive`). */
export interface ProactiveHold {
  /** Why the person is muted now ("quiet" or "paused"); null when nothing mutes them. */
  muted(userId: string): string | null;
  /** Deliver what was held for the person. */
  release(userId: string): Promise<void>;
}

/** Everything the router is built with. A feature that is off is given as undefined (GitHub, notifications). */
export interface RouterDeps {
  readonly config: RouterConfig;
  readonly surface: Surface;
  readonly channel: ChannelRefs;
  readonly store: RouterStore;
  readonly claw: ClawPort;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  readonly metrics: MetricsPort;
  readonly securityEvent: (name: SecurityEventName, fields: Readonly<Record<string, LogValue>>) => void;
  readonly identity: IdentityLookup;
  readonly keyRevoker: KeyRevoker;
  readonly exchange: TokenExchange;
  readonly limits: RouterLimits;
  readonly assistant: AssistantChat;
  readonly remote: RemoteChat;
  readonly turns: TurnRunner;
  readonly proactive: ProactiveHold;
  readonly observing: Observing;
  readonly github: GithubChat | undefined;
  /** The review-stop words of a group (with the review service on). */
  readonly reviewStop: ReviewStopReader | undefined;
  /** What a chat can hand back to this worker (the review service's `review_for_other`; empty without it). */
  readonly handoffs: readonly string[];
  readonly channelContext: ChannelContextBuilder;
  readonly messageText: MessageText;
  /** `/whoami`'s connection lines (the review service's renderer, which also says them without it). */
  readonly connectionsText: ConnectionsText;
  /** The "Report a problem" card under a message that says something went wrong (feedback's view); undefined: none. */
  readonly reportView: (userId: string, scope: string) => OutMessage | undefined;
  /** The note card a settled click ends as. */
  readonly note: NoteFactory;
  readonly subscriptions: Subscriptions | undefined;
  readonly handlers: RouteHandlers;
  readonly integrations: Integrations;
}
