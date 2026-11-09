// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the remote-agent domain is given: its settings and the ports it works through. */
import type { DirectChat } from "../direct-chat/direct-chat.js";
import type { ClawRemoteAgentsPort } from "../ports/claw/remote-agents.js";
import type { JsonObject } from "../json.js";
import type { Lang } from "../locales/lang.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { Random } from "../ports/random.js";
import type { ConversationRefRepository, PrefsRepository } from "../ports/store/people.js";
import type {
  RemotePermissionRepository,
  RemoteSessionNameRepository,
  RemoteStateRepository,
} from "../ports/store/remote.js";
import type { Conversation } from "../ports/surface.js";
import type { ConnectorSetup } from "./connector/setup.js";
import type { FollowReach } from "./follow/speaker.js";
import type { FollowTimings } from "./follow/timings.js";
import type { RefusalErrors } from "./refusals.js";
import type { RemoteViews } from "./views.js";
import type { WindowMode } from "./window/view.js";

/** The per-person limits of what a remote agent may do without asking (`guardrails`). */
export type GuardedOperation = "remote_agent" | "approval";

export interface GuardRefusal {
  /** The sentence the person is told (English unless `zh`). */
  text(zh?: boolean): string;
}

export interface RemoteGuard {
  /** Count one operation, or refuse it (nothing counted). `ticket` names this count for `giveBack`. */
  take(
    person: string,
    operation: GuardedOperation,
    ticket: object,
    ids?: Readonly<Record<string, string | null>>,
  ): GuardRefusal | null;
  giveBack(person: string, operation: GuardedOperation, ticket: object | null): void;
}

/** The public-error helpers the domain uses beside the refusal ones. */
export interface RemoteErrors extends RefusalErrors {
  /** The text with a raw error at its end cut off: what may be shown, and the cut error (for the log). */
  splitErrorTail(text: string): { readonly kept: string; readonly tail: string };
  /** A fresh reference id for a sentence about a failure. */
  newRef(): string;
  withheldAs(where: string, detail: string, ids: Readonly<Record<string, string>>): string;
}

export interface RemoteSettings {
  /** Remote agents are on for this deployment. */
  readonly enabled: boolean;
  /** An attached chat hears its session between turns (REMOTE_PUSH_ENABLED). */
  readonly follow: boolean;
  /** Where the chat box goes when its person never said (REMOTE_WINDOW_DEFAULT). */
  readonly windowDefault: WindowMode;
  readonly timings: FollowTimings;
  /** How a watched conversation is followed. */
  readonly watchTimings: FollowTimings;
  /** The assistant's display name. */
  readonly botName: string;
}

export interface RemoteContext {
  readonly settings: RemoteSettings;
  readonly claw: ClawRemoteAgentsPort;
  /** The address this worker reaches Claw at: what the commands for a machine are checked against. */
  readonly clawBaseUrl: string;
  /** The connect commands of that address. */
  readonly setup: ConnectorSetup;
  readonly remoteState: RemoteStateRepository;
  readonly sessionNames: RemoteSessionNameRepository;
  readonly permissions: RemotePermissionRepository;
  readonly prefs: PrefsRepository;
  readonly references: ConversationRefRepository;
  /** The conversation a stored reference posts to. */
  conversationFor(reference: JsonObject): Conversation;
  /** What to read Claw with for a person with nobody to ask (null: none; throws `CredentialUnavailable` just now). */
  credentialFor(person: string): Promise<string | null>;
  readonly reach: FollowReach;
  readonly guard: RemoteGuard;
  /** One security event (`approval_answered`). */
  audit(event: "approval_answered", fields: Readonly<Record<string, string | number | null>>): void;
  readonly views: RemoteViews;
  readonly errors: RemoteErrors;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  sha1Hex(text: string): string;
  /** The language a person is answered in. */
  langOf(person: string): Lang;
  /** TEAMS_DIRECT_CHAT: whose 1:1 chat is the agent's window itself. */
  readonly directChat: DirectChat;
}
