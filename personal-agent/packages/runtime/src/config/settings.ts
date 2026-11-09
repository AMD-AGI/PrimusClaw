// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ConfigError,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_MESSAGE_WINDOW_SECONDS,
  parseLimits,
  type AssistantSettings,
  type ExchangeSettings,
  type GithubReviewSettings,
  type SecretName,
  type Settings,
  type SecretsSourceName,
} from "@primusclaw/personal-agent";
import { DEFAULT_CLIENT_LABEL } from "../claw/client.js";
import { type Env, EnvReader, pyRepr, withoutTrailingSlash } from "./env.js";
import { secretsSourceOf } from "./secrets.js";

/** The public client id of the GitHub CLI: an OAuth app most organizations already allow; its device flow needs no secret. */
export const GITHUB_CLI_CLIENT_ID = "178c6fc778ccc68e1d6a";
/** The default of ASSISTANT_REPLY_WINDOW_SECONDS. */
export const ASSISTANT_REPLY_WINDOW_SECONDS = 30 * 60;

/** What a setting reads its secrets from: the values a source loaded, and which source that was. */
interface Secrets {
  readonly values: ReadonlyMap<SecretName, string>;
  readonly source: SecretsSourceName;
}

/**
 * The worker's channel-neutral settings from the environment (the Python worker's `Settings.from_env`, without the
 * Teams fields). `secrets` are what the deployment's SecretSource loaded; a name it holds is taken from there and never
 * from the environment, and with SECRETS_SOURCE=keyvault a secret it does not hold stops the worker. Every malformed
 * value stops it too (ConfigError), with the message the Python worker gave.
 */
export function readSettings(env: Env, secrets: ReadonlyMap<SecretName, string> = new Map()): Settings {
  const read = new EnvReader(env);
  const store: Secrets = { values: secrets, source: secretsSourceOf(env) };
  const publicBaseUrl = withoutTrailingSlash(read.required("PUBLIC_BASE_URL"));
  const exchange = exchangeSettings(read, store, publicBaseUrl);
  const listenPort = read.int("PORT", "8080");
  const metricsPort = read.positiveInt("METRICS_PORT", 9090);
  if (metricsPort === listenPort) {
    throw new ConfigError(`METRICS_PORT must differ from PORT (${String(listenPort)})`);
  }
  return {
    dbPath: read.raw("TEAMS_DB_PATH", "/data/state.db"),
    encryptionKeys: secret(read, store, "TEAMS_ENCRYPTION_KEYS")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k !== ""),
    clawApiUrl: withoutTrailingSlash(read.required("CLAW_API_URL")),
    safeApiUrl: withoutTrailingSlash(read.required("SAFE_API_URL")),
    publicBaseUrl,
    listenPort,
    metricsPort,
    claw: {
      pluginId: read.optionalInt("CLAW_PLUGIN_ID"),
      ruleToolId: read.optionalInt("CLAW_RULE_TOOL_ID"),
      clientLabel: read.text("CLAW_CLIENT_LABEL") || DEFAULT_CLIENT_LABEL,
    },
    exchange,
    models: {
      chat: read.text("CLAWY_MODEL"),
      fallback: read.text("CLAWY_FALLBACK_MODEL"),
      review: read.text("CLAWY_REVIEW_MODEL"),
    },
    githubReview: githubReviewSettings(read, publicBaseUrl),
    assistant: assistantSettings(read),
    clawEventsGone: read.isOn("TEAMS_CLAW_EVENTS_GONE"),
    directChat: directChat(read),
    onBehalfUsers: new Set(read.list("TEAMS_ON_BEHALF_USERS")),
    observeUsers: new Set(read.list("TEAMS_OBSERVE_USERS", true)),
    sensitiveLimits: limitsOf(read),
    linkLimits: {
      perUser: read.positiveInt("TEAMS_LINK_MAX_FAILURES_PER_USER", 5),
      global: read.positiveInt("TEAMS_LINK_MAX_FAILURES_GLOBAL", 100),
      windowSeconds: read.positiveInt("TEAMS_LINK_ATTEMPT_WINDOW_SECONDS", 600),
    },
    userLimits: {
      messageLimit: read.positiveInt("TEAMS_USER_MESSAGE_LIMIT", DEFAULT_MESSAGE_LIMIT),
      messageWindowSeconds: read.positiveInt("TEAMS_USER_MESSAGE_WINDOW_SECONDS", DEFAULT_MESSAGE_WINDOW_SECONDS),
      maxConcurrentTasks: read.positiveInt("TEAMS_USER_MAX_CONCURRENT_TASKS", DEFAULT_MAX_CONCURRENT_TASKS),
    },
    secretsSource: store.source,
  };
}

/** A secret: what the source loaded, else (SECRETS_SOURCE=env only) the environment's value. */
function secret(read: EnvReader, store: Secrets, name: SecretName): string {
  const loaded = store.values.get(name);
  if (loaded !== undefined) return loaded;
  if (store.source === "keyvault") {
    // never the environment's value: it may be the stale one the vault replaced
    throw new ConfigError(`SECRETS_SOURCE=keyvault but ${name} was not read from the vault`);
  }
  return read.required(name);
}

function exchangeSettings(read: EnvReader, store: Secrets, publicBaseUrl: string): ExchangeSettings {
  const enabled = read.isOn("TEAMS_EXCHANGE_ENABLED");
  const forChat = read.isOn("TEAMS_EXCHANGE_FOR_CHAT");
  if (read.isOn("TEAMS_GITHUB_REVIEW_ENABLED") && !enabled) {
    throw new ConfigError("TEAMS_GITHUB_REVIEW_ENABLED needs TEAMS_EXCHANGE_ENABLED");
  }
  if (forChat && !enabled) throw new ConfigError("TEAMS_EXCHANGE_FOR_CHAT needs TEAMS_EXCHANGE_ENABLED");
  return {
    enabled,
    tokenUrl: enabled ? read.raw("TEAMS_EXCHANGE_TOKEN_URL", `${publicBaseUrl}/oauth/token`) : "",
    clientId: enabled ? read.required("TEAMS_EXCHANGE_CLIENT_ID") : "",
    clientSecret: enabled ? secret(read, store, "TEAMS_EXCHANGE_CLIENT_SECRET") : "",
    issuer: read.raw("TEAMS_EXCHANGE_ISSUER", "teams.microsoft.com"),
    audience: read.raw("TEAMS_EXCHANGE_AUDIENCE", "claw-api"),
    scope: read.raw("TEAMS_EXCHANGE_SCOPE", "claw.api"),
    bindingRequestUrl: enabled
      ? read.raw("TEAMS_EXCHANGE_BINDING_REQUEST_URL", `${publicBaseUrl}/oauth/binding-requests`)
      : "",
    forChat,
  };
}

/** The review for a colleague; the exchange's own check refuses it without the exchange. */
function githubReviewSettings(read: EnvReader, publicBaseUrl: string): GithubReviewSettings {
  const enabled = read.isOn("TEAMS_GITHUB_REVIEW_ENABLED");
  const owners = read.list("TEAMS_GITHUB_REVIEW_OWNERS");
  if (enabled && owners.length === 0) {
    throw new ConfigError(
      "TEAMS_GITHUB_REVIEW_ENABLED needs TEAMS_GITHUB_REVIEW_OWNERS (the GitHub owners whose pull requests are taken)",
    );
  }
  return {
    enabled,
    owners,
    intentModel: enabled ? read.text("TEAMS_REVIEW_INTENT_MODEL") || read.text("CLAWY_MODEL") : "",
    credentialUrl: enabled
      ? withoutTrailingSlash(read.raw("TEAMS_GITHUB_CREDENTIAL_URL", `${publicBaseUrl}/oauth/external-credentials`))
      : "",
    clientId: read.text("TEAMS_GITHUB_CLIENT_ID", GITHUB_CLI_CLIENT_ID) || GITHUB_CLI_CLIENT_ID,
  };
}

function assistantSettings(read: EnvReader): AssistantSettings {
  const window = read.text("ASSISTANT_REPLY_WINDOW_SECONDS");
  if (window !== "" && !(/^[0-9]+$/.test(window) && Number(window) > 0)) {
    throw new ConfigError(`ASSISTANT_REPLY_WINDOW_SECONDS must be a positive number of seconds, not ${pyRepr(window)}`);
  }
  const enabled = read.isOn("ASSISTANT_ENABLED");
  const understanding = read.switch("TEAMS_ASSISTANT_UNDERSTANDING", false);
  const users = new Set(read.list("ASSISTANT_USERS", true));
  const listed = new Set(read.list("TEAMS_ASSISTANT_UNDERSTANDING_USERS", true));
  const understandingUsers = understanding ? (listed.size > 0 ? listed : users) : new Set<string>();
  if (understanding && understandingUsers.size === 0) {
    throw new ConfigError(
      "TEAMS_ASSISTANT_UNDERSTANDING is on but TEAMS_ASSISTANT_UNDERSTANDING_USERS names nobody (and ASSISTANT_USERS is empty)",
    );
  }
  if (understandingUsers.size > 0 && !enabled) {
    throw new ConfigError("TEAMS_ASSISTANT_UNDERSTANDING needs ASSISTANT_ENABLED");
  }
  if (users.size > 0 && [...understandingUsers].some((u) => !users.has(u))) {
    throw new ConfigError("TEAMS_ASSISTANT_UNDERSTANDING_USERS names people who are not in ASSISTANT_USERS");
  }
  return {
    enabled,
    users,
    replyWindowSeconds: window === "" ? ASSISTANT_REPLY_WINDOW_SECONDS : Number(window),
    understandingUsers,
  };
}

function directChat(read: EnvReader): Settings["directChat"] {
  return {
    enabled: read.switch("TEAMS_DIRECT_CHAT", false),
    users: new Set(read.list("TEAMS_DIRECT_CHAT_USERS", true)),
  };
}

/** TEAMS_LIMIT_<OPERATION>; a malformed one stops the worker with the message the guardrails give. */
function limitsOf(read: EnvReader): Settings["sensitiveLimits"] {
  try {
    return parseLimits((name) => read.raw(name));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
}
