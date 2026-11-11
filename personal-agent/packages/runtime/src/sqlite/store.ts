// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The StorePort on one SQLite file (`/data/state.db`), table for table and column for column the Python worker's, so
 * either worker opens what the other wrote. Single process by design: the deployment runs one replica (Recreate).
 */
import {
  ATTEMPT_WINDOW_SECONDS,
  MAX_FAILED_ATTEMPTS,
  MAX_FAILED_ATTEMPTS_GLOBAL,
  epochSeconds,
  type Clock,
  type LinkLimits,
  type Random,
  type StorePort,
} from "@primusclaw/personal-agent";

import { cryptoRandom } from "../crypto-random.js";
import { systemClock } from "../system-clock.js";
import { SqliteApprovalRepository } from "./approval-repository.js";
import {
  SqliteAssistantButtonRepository,
  SqliteAssistantCardRepository,
  SqliteAssistantMessageRepository,
} from "./assistant-repository.js";
import { type SecurityEventSink, type StoreContext, StoreSecrets, tokenHex } from "./context.js";
import { Database } from "./database.js";
import { SqliteFeedbackRepository } from "./feedback-repository.js";
import { SqliteGithubConfirmationRepository, SqliteReviewDelegationRepository } from "./github-repository.js";
import { SqliteIdempotencyRepository } from "./idempotency-repository.js";
import { SqliteLinkRepository } from "./link-repository.js";
import { SqliteMemberDirectoryRepository } from "./member-repository.js";
import { migrate } from "./migrations.js";
import { SqliteNotifySubscriptionRepository } from "./notify-repository.js";
import { SqliteObserveRepository } from "./observe-repository.js";
import { SqliteGroupContextRepository } from "./group-context-repository.js";
import { SqliteOnboardingRepository } from "./onboarding-repository.js";
import {
  SqliteConversationRefRepository,
  SqliteHeldEventRepository,
  SqlitePrefsRepository,
} from "./people-repository.js";
import { type ReencryptCounts, reencrypt } from "./reencrypt.js";
import { SqliteRemotePermissionRepository, SqliteRemoteSessionNameRepository } from "./remote-repository.js";
import { SqliteRemoteStateRepository } from "./remote-state-repository.js";
import { SqliteRepoHistoryRepository, SqliteSessionRepository } from "./session-repository.js";
import { SqliteTurnAnswerRepository } from "./turn-repository.js";

export const DEFAULT_LINK_LIMITS: LinkLimits = {
  perUser: MAX_FAILED_ATTEMPTS,
  global: MAX_FAILED_ATTEMPTS_GLOBAL,
  windowSeconds: ATTEMPT_WINDOW_SECONDS,
};

export interface SqliteStoreOptions {
  /** The database file (`TEAMS_DB_PATH`), or ":memory:". */
  readonly path: string;
  /** TEAMS_ENCRYPTION_KEYS: the first encrypts, all decrypt. At least one. */
  readonly encryptionKeys: readonly string[];
  readonly clock?: Clock;
  readonly random?: Random;
  readonly linkLimits?: LinkLimits;
  /**
   * Where `link_attempt` / `link_lockout` go: the security-event log, which filters the fields it logs. Required, so a
   * worker cannot be assembled that links people without an audit trail (the Python store always logs them).
   */
  readonly securityEvent: SecurityEventSink;
}

export class SqliteStore implements StorePort {
  readonly links;
  readonly references;
  readonly prefs;
  readonly held;
  readonly members;
  readonly notifySubs;
  readonly approvals;
  readonly observe;
  readonly groupContext;
  readonly assistantCards;
  readonly assistantButtons;
  readonly assistantMessages;
  readonly remoteState;
  readonly remoteSessionNames;
  readonly remotePermissions;
  readonly sessions;
  readonly repoHistory;
  readonly turns;
  readonly feedback;
  readonly onboarding;
  readonly githubConfirmations;
  readonly reviewDelegation;
  readonly idempotency;
  readonly #ctx: StoreContext;

  constructor(options: SqliteStoreOptions) {
    const clock = options.clock ?? systemClock;
    const random = options.random ?? cryptoRandom;
    const secrets = new StoreSecrets(options.encryptionKeys);
    const db = new Database(options.path);
    migrate(db);
    const ctx: StoreContext = { db, now: () => epochSeconds(clock), random, secrets };
    this.#ctx = ctx;
    this.links = new SqliteLinkRepository(ctx, options.linkLimits ?? DEFAULT_LINK_LIMITS, options.securityEvent);
    this.references = new SqliteConversationRefRepository(ctx);
    this.prefs = new SqlitePrefsRepository(ctx);
    this.held = new SqliteHeldEventRepository(ctx);
    this.members = new SqliteMemberDirectoryRepository(ctx);
    this.notifySubs = new SqliteNotifySubscriptionRepository(ctx);
    this.approvals = new SqliteApprovalRepository(ctx);
    this.observe = new SqliteObserveRepository(ctx);
    this.groupContext = new SqliteGroupContextRepository(ctx);
    this.assistantCards = new SqliteAssistantCardRepository(ctx);
    this.assistantButtons = new SqliteAssistantButtonRepository(ctx);
    this.assistantMessages = new SqliteAssistantMessageRepository(ctx);
    this.remoteState = new SqliteRemoteStateRepository(ctx);
    this.remoteSessionNames = new SqliteRemoteSessionNameRepository(ctx);
    this.remotePermissions = new SqliteRemotePermissionRepository(ctx);
    this.sessions = new SqliteSessionRepository(ctx);
    this.repoHistory = new SqliteRepoHistoryRepository(ctx);
    // This process: a turn recorded by another one died with it.
    this.turns = new SqliteTurnAnswerRepository(ctx, tokenHex(random, 8));
    this.feedback = new SqliteFeedbackRepository(ctx);
    this.onboarding = new SqliteOnboardingRepository(ctx);
    this.githubConfirmations = new SqliteGithubConfirmationRepository(ctx);
    this.reviewDelegation = new SqliteReviewDelegationRepository(ctx);
    this.idempotency = new SqliteIdempotencyRepository(ctx);
  }

  now(): number {
    return this.#ctx.now();
  }

  /** Move every stored secret to the first key (run at start, before serving). */
  reencrypt(): ReencryptCounts {
    return reencrypt(this.#ctx);
  }

  close(): void {
    this.#ctx.db.close();
  }
}
