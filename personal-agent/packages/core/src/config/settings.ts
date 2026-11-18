// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { GroupContextSettings } from "../group-context/buffer.js";
import type { SecretsSourceName } from "../ports/secret-source.js";
import type { LinkLimits } from "../ports/store/link.js";

/**
 * The worker's channel-neutral settings, read once at start (the runtime's `readSettings` from the environment; the
 * environment variable each field comes from is named beside it). A channel adds its own (the Teams package: outbound
 * mode, bot token, Service Bus, reply style). Nothing here has a built-in address: a deployment says its own.
 */
export interface Settings {
  /** PA_DB_PATH (default /data/state.db). */
  readonly dbPath: string;
  /** PA_ENCRYPTION_KEYS, comma separated Fernet keys: the first encrypts, all decrypt. */
  readonly encryptionKeys: readonly string[];
  /** CLAW_API_URL, without a trailing slash. */
  readonly clawApiUrl: string;
  /** SAFE_API_URL, without a trailing slash (the platform API; its LLM gateway reads review requests). */
  readonly safeApiUrl: string;
  /** PUBLIC_BASE_URL, without a trailing slash: where this deployment is reached. */
  readonly publicBaseUrl: string;
  /** PORT (default 8080): the public listener. */
  readonly listenPort: number;
  /** METRICS_PORT (default 9090), never PORT. */
  readonly metricsPort: number;
  /**
   * PERSONAL_AGENT_BOT_NAME (default `BOT_NAME`, "PrimusClaw Assistant"): the name the bot goes by in this deployment, in every
   * text that names it and in what an @mention of it is read as.
   */
  readonly botName: string;
  readonly claw: ClawSettings;
  readonly exchange: ExchangeSettings;
  readonly models: ModelSettings;
  readonly githubReview: GithubReviewSettings;
  readonly assistant: AssistantSettings;
  /** PA_CLAW_EVENTS_GONE: an event for a person with no chat is answered 410 Gone instead of 200 `dropped`. */
  readonly clawEventsGone: boolean;
  /** PA_DIRECT_CHAT and PA_DIRECT_CHAT_USERS (lower-cased; empty with `on` is everybody). */
  readonly directChat: { readonly enabled: boolean; readonly users: ReadonlySet<string> };
  /** PA_ON_BEHALF_USERS: Claw user ids (as written) whose own key may post into their own chat. */
  readonly onBehalfUsers: ReadonlySet<string>;
  /** PA_OBSERVE_USERS (lower-cased): who may turn on observing a group chat. */
  readonly observeUsers: ReadonlySet<string>;
  /**
   * PA_GROUP_CONTEXT_MESSAGES (30; 0 off), PA_GROUP_CONTEXT_HOURS (4), PA_GROUP_CONTEXT_CHARS (500), PA_GROUP_CONTEXT_GRANTED (off): the recent
   * messages of a group chat kept in memory as background for an @mention.
   */
  readonly groupContext: GroupContextSettings;
  /** PA_LIMIT_<OPERATION>: the per-person limits of operations that act with someone's authority. */
  readonly sensitiveLimits: ReadonlyMap<string, Limit>;
  /** PA_LINK_MAX_FAILURES_PER_USER (5) / PA_LINK_MAX_FAILURES_GLOBAL (100) / PA_LINK_ATTEMPT_WINDOW_SECONDS (600). */
  readonly linkLimits: LinkLimits;
  readonly userLimits: UserLimits;
  /** SECRETS_SOURCE (env | keyvault). */
  readonly secretsSource: SecretsSourceName;
}

/** How this worker talks to Claw. */
export interface ClawSettings {
  /** CLAW_PLUGIN_ID; null creates plain sessions. */
  readonly pluginId: number | null;
  /** CLAW_RULE_TOOL_ID: the rule tool whose text rides on every message; null none. */
  readonly ruleToolId: number | null;
  /** CLAW_CLIENT_LABEL (default "personal-agent"): what Claw's audit trail calls this client (`X-Claw-Client`). */
  readonly clientLabel: string;
}

/** Token exchange with the identity service (RFC 8693). */
export interface ExchangeSettings {
  /** PA_EXCHANGE_ENABLED. */
  readonly enabled: boolean;
  /** PA_EXCHANGE_TOKEN_URL (default PUBLIC_BASE_URL/oauth/token); "" when off. */
  readonly tokenUrl: string;
  /** PA_EXCHANGE_CLIENT_ID, required when on. */
  readonly clientId: string;
  /** The secret PA_EXCHANGE_CLIENT_SECRET, required when on. */
  readonly clientSecret: string;
  /** PA_EXCHANGE_ISSUER (default teams.microsoft.com). */
  readonly issuer: string;
  /** PA_EXCHANGE_AUDIENCE (default claw-api). */
  readonly audience: string;
  /** PA_EXCHANGE_SCOPE (default claw.api). */
  readonly scope: string;
  /** PA_EXCHANGE_BINDING_REQUEST_URL (default PUBLIC_BASE_URL/oauth/binding-requests); "" when off. */
  readonly bindingRequestUrl: string;
  /** PA_EXCHANGE_FOR_CHAT: ordinary chats use a bound person's exchanged token instead of their linked key. */
  readonly forChat: boolean;
}

/** The models sessions ask for ("" sends none: Claw's default applies). */
export interface ModelSettings {
  /** PERSONAL_AGENT_MODEL. */
  readonly chat: string;
  /** PERSONAL_AGENT_FALLBACK_MODEL: a turn refused for want of a model key is run again on it, once ("" no second run). */
  readonly fallback: string;
  /** PERSONAL_AGENT_REVIEW_MODEL: a review whose request names none ("" PERSONAL_AGENT_MODEL). */
  readonly review: string;
}

/** Reviewing and merging a pull request for a colleague. */
export interface GithubReviewSettings {
  /** PA_GITHUB_REVIEW_ENABLED (needs the exchange). */
  readonly enabled: boolean;
  /** PA_GITHUB_REVIEW_OWNERS: the GitHub owners whose pull requests are taken; required when on. */
  readonly owners: readonly string[];
  /** PA_REVIEW_INTENT_MODEL (else PERSONAL_AGENT_MODEL) when on; "" requests are read by the rules alone. */
  readonly intentModel: string;
  /** PA_GITHUB_CREDENTIAL_URL (default PUBLIC_BASE_URL/oauth/external-credentials) when on. */
  readonly credentialUrl: string;
  /** PA_GITHUB_CLIENT_ID: the OAuth client of the device flow (default: the GitHub CLI's public client). */
  readonly clientId: string;
}

/** A person's assistant in Claw. */
export interface AssistantSettings {
  /** ASSISTANT_ENABLED. */
  readonly enabled: boolean;
  /** ASSISTANT_USERS (lower-cased; empty: everybody). */
  readonly users: ReadonlySet<string>;
  /** ASSISTANT_REPLY_WINDOW_SECONDS (default 1800). */
  readonly replyWindowSeconds: number;
  /** PA_ASSISTANT_UNDERSTANDING(_USERS): whose every message the assistant understands first (empty: nobody). */
  readonly understandingUsers: ReadonlySet<string>;
}

/** How many in a window; `count` 0: no limit. */
export interface Limit {
  readonly count: number;
  readonly windowSeconds: number;
}

/** PA_USER_MESSAGE_LIMIT per PA_USER_MESSAGE_WINDOW_SECONDS, PA_USER_MAX_CONCURRENT_TASKS. */
export interface UserLimits {
  readonly messageLimit: number;
  readonly messageWindowSeconds: number;
  readonly maxConcurrentTasks: number;
}

/** A setting that is missing or malformed: the worker stops at start (a typo must not quietly pick a value). */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}
