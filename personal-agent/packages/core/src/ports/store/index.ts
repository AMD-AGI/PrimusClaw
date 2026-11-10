// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The store port: durable state as repositories grouped by aggregate. One implementation (runtime's SQLite store)
 * keeps all of them in one database file whose tables and columns are the Python worker's, so either worker can open it.
 *
 * Naming: `userId` is the person's stable channel id (the Entra object id on Teams, column `aad_id`); `clawUserId` is
 * the Claw account a link records; `channelUserId` is the channel's own user id (Teams' `29:` id). Times are epoch
 * seconds from the injected clock.
 *
 * Every method is synchronous: the store is local and each method is one indivisible step, which is what the
 * check-then-write methods (`redeemPending`, `claimEvent`, `move*` with `onlyFrom`) rely on.
 */
import type { ApprovalRepository } from "./approvals.js";
import type { AssistantButtonRepository, AssistantCardRepository, AssistantMessageRepository } from "./assistant.js";
import type { FeedbackRepository } from "./feedback.js";
import type { GithubConfirmationRepository, ReviewDelegationRepository } from "./github.js";
import type { IdempotencyRepository } from "./idempotency.js";
import type { LinkRepository } from "./link.js";
import type { NotifySubscriptionRepository } from "./notify.js";
import type { ObserveRepository } from "./observe.js";
import type { OnboardingRepository } from "./onboarding.js";
import type {
  ConversationRefRepository,
  HeldEventRepository,
  MemberDirectoryRepository,
  PrefsRepository,
} from "./people.js";
import type { RemotePermissionRepository, RemoteSessionNameRepository, RemoteStateRepository } from "./remote.js";
import type { RepoHistoryRepository, SessionRepository } from "./sessions.js";
import type { TurnAnswerRepository } from "./turns.js";

export interface StorePort {
  readonly links: LinkRepository;
  readonly references: ConversationRefRepository;
  readonly prefs: PrefsRepository;
  readonly held: HeldEventRepository;
  readonly members: MemberDirectoryRepository;
  readonly notifySubs: NotifySubscriptionRepository;
  readonly approvals: ApprovalRepository;
  readonly observe: ObserveRepository;
  readonly assistantCards: AssistantCardRepository;
  readonly assistantButtons: AssistantButtonRepository;
  readonly assistantMessages: AssistantMessageRepository;
  readonly remoteState: RemoteStateRepository;
  readonly remoteSessionNames: RemoteSessionNameRepository;
  readonly remotePermissions: RemotePermissionRepository;
  readonly sessions: SessionRepository;
  readonly repoHistory: RepoHistoryRepository;
  readonly turns: TurnAnswerRepository;
  readonly feedback: FeedbackRepository;
  readonly onboarding: OnboardingRepository;
  readonly githubConfirmations: GithubConfirmationRepository;
  readonly reviewDelegation: ReviewDelegationRepository;
  readonly idempotency: IdempotencyRepository;
  /** The store's clock, in epoch seconds. */
  now(): number;
}

export type * from "./approvals.js";
export type * from "./assistant.js";
export type * from "./feedback.js";
export type * from "./github.js";
export type * from "./idempotency.js";
export type * from "./link.js";
export type * from "./notify.js";
export type * from "./observe.js";
export type * from "./onboarding.js";
export type * from "./people.js";
export type * from "./remote.js";
export type * from "./sessions.js";
export type * from "./turns.js";
export { isJsonObject } from "./json.js";
export * from "./policy.js";
