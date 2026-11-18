// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Teams worker's own settings, read once from the environment (the Python worker's names, value for value): how it
 * reaches Teams (OUTBOUND_MODE, BOT_*), the queues (SERVICEBUS_*, INBOUND_QUEUE, OUTBOUND_QUEUE, RECEIVER_COUNT), its own
 * Azure identity (WORKER_IDENTITY_*), the install hint and the reply style (TEAMS_*). A value that is not one the worker
 * knows stops it at start: a typo must never quietly pick a path. Core's settings (Claw, store, limits) are read by core.
 */
import { pyRstrip, pyStrip, own } from "@primusclaw/personal-agent";

import { workerIdentityFromEnv, type WorkerIdentity } from "../azure/workload-identity.js";
import type { OutboundMode } from "../caps.js";
import { DEFAULT_STYLE, STREAM_SCOPES, type Style } from "./style.js";

export type Env = Readonly<Record<string, string | undefined>>;

export class TeamsConfigError extends Error {
  override name = "TeamsConfigError";
}

const ON = ["1", "true", "yes", "on"];
const OFF = ["0", "false", "no", "off"];

export type BotTokenSource = "imds" | "federated" | "secret";

export interface BotSettings {
  readonly tokenSource: BotTokenSource;
  readonly msiClientId: string;
  /** BOT_CLIENT_ID: the app registration's client id, with `secret`. */
  readonly clientId: string;
  /** BOT_CLIENT_SECRET, with `secret` ("" otherwise). Not enumerable: a dump of the settings does not show it. */
  readonly clientSecret: string;
  /** BOT_CLIENT_SECRET is set but BOT_TOKEN_SOURCE names another source, which wins (the worker warns at start). */
  readonly clientSecretIgnored: boolean;
  readonly tenantId: string;
  readonly assertionKeyFile: string;
  readonly assertionIssuer: string;
  readonly assertionSubject: string;
}

export interface BusSettings {
  /** The namespace's host name: the queues are reached as the worker's identity. "" : by the connection strings. */
  readonly namespace: string;
  readonly listenConnectionString: string;
  readonly sendConnectionString: string;
  readonly inboundQueue: string;
  readonly outboundQueue: string;
  readonly receiverCount: number;
}

export interface TeamsSettings {
  readonly outboundMode: OutboundMode;
  readonly bot: BotSettings;
  readonly bus: BusSettings;
  /** The worker's own identity, when SERVICEBUS_NAMESPACE or SECRETS_SOURCE=keyvault needs it. */
  readonly workerIdentity: WorkerIdentity | undefined;
  readonly installHintUrl: string;
  readonly style: Style;
}

function get(env: Env, name: string, fallback = ""): string {
  return pyStrip(own(env, name) ?? fallback);
}

function required(env: Env, name: string): string {
  const value = get(env, name);
  if (!value) throw new TeamsConfigError(`${name} is required`);
  return value;
}

/** An on/off setting, `fallback` when unset or empty. */
export function switchOf(env: Env, name: string, fallback: boolean): boolean {
  const raw = get(env, name).toLowerCase();
  if (!raw) return fallback;
  if (!ON.includes(raw) && !OFF.includes(raw)) throw new TeamsConfigError(`${name} must be on or off, not '${raw}'`);
  return ON.includes(raw);
}

const SCOPE_NAMES: Readonly<Record<string, string>> = {
  personal: "personal",
  "1:1": "personal",
  groupchat: "groupChat",
  group: "groupChat",
};

/** The scope a word of TEAMS_STREAMING names, "" for none (only the table's own words: `constructor` is none). */
function scopeName(word: string): string {
  return Object.hasOwn(SCOPE_NAMES, word) ? (SCOPE_NAMES[word] ?? "") : "";
}

/** TEAMS_STREAMING: `off`, or the chat kinds that get Teams' floating status (`personal`, `groupChat`, comma separated). */
export function streamScopes(raw: string): ReadonlySet<string> {
  const value = pyStrip(raw);
  if (!value) return new Set(STREAM_SCOPES);
  if (OFF.includes(value.toLowerCase())) return new Set();
  const scopes = value
    .split(",")
    .filter((part) => pyStrip(part))
    .map((part) => scopeName(pyStrip(part).toLowerCase()));
  if (!scopes.length || scopes.includes("")) {
    throw new TeamsConfigError(`TEAMS_STREAMING must be off or a list of personal, groupChat; not '${raw}'`);
  }
  return new Set(scopes);
}

export function styleFromEnv(env: Env): Style {
  const d = DEFAULT_STYLE;
  return {
    aiLabel: switchOf(env, "TEAMS_AI_LABEL", d.aiLabel),
    streaming: streamScopes(env["TEAMS_STREAMING"] ?? ""),
    streamText: switchOf(env, "TEAMS_STREAM_TEXT", d.streamText),
    assistantReceipt: switchOf(env, "TEAMS_ASSISTANT_RECEIPT", d.assistantReceipt),
    assistantProgress: switchOf(env, "TEAMS_ASSISTANT_PROGRESS", d.assistantProgress),
    assistantStreamSay: switchOf(env, "TEAMS_ASSISTANT_STREAM_SAY", d.assistantStreamSay),
    ownThumbsMobile: switchOf(env, "TEAMS_OWN_THUMBS_MOBILE", d.ownThumbsMobile),
    suggestedReplies: switchOf(env, "TEAMS_SUGGESTED_REPLIES", d.suggestedReplies),
    citations: switchOf(env, "TEAMS_CITATIONS", d.citations),
  };
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = get(env, name).toLowerCase() || fallback;
  const found = allowed.find((value) => value === raw);
  if (found === undefined) throw new TeamsConfigError(`${name} must be one of ${allowed.join(", ")}, not '${raw}'`);
  return found;
}

function httpsIssuer(env: Env): string {
  const issuer = pyRstrip(required(env, "BOT_ASSERTION_ISSUER"), "/");
  if (!issuer.startsWith("https://")) {
    throw new TeamsConfigError(
      "BOT_ASSERTION_ISSUER must be the https issuer URL registered in the federated credential",
    );
  }
  return issuer;
}

/** SERVICEBUS_NAMESPACE: the namespace's host name (<name>.servicebus.windows.net), or "" for the connection strings. */
export function busNamespace(raw: string): string {
  const value = pyStrip(raw).toLowerCase();
  if (value && (!value.endsWith(".servicebus.windows.net") || value.includes("/") || value.includes(":"))) {
    throw new TeamsConfigError(
      `SERVICEBUS_NAMESPACE must be the namespace's host name, <name>.servicebus.windows.net, not '${raw}'`,
    );
  }
  return value;
}

/**
 * BOT_TOKEN_SOURCE when it is set (it always wins); unset, `secret` when BOT_CLIENT_SECRET is set, else `imds`. So a
 * deployment that sets neither keeps the managed identity, and one that only adds an app registration's secret uses it.
 */
function tokenSourceOf(env: Env, secretSet: boolean): BotTokenSource {
  const fallback = secretSet ? "secret" : "imds";
  return oneOf<BotTokenSource>(env, "BOT_TOKEN_SOURCE", ["imds", "federated", "secret"], fallback);
}

function botFromEnv(env: Env, mode: OutboundMode): BotSettings {
  const secretSet = get(env, "BOT_CLIENT_SECRET") !== "";
  const tokenSource = tokenSourceOf(env, secretSet);
  const federated = tokenSource === "federated";
  const secret = tokenSource === "secret";
  // (only direct mode holds a bot token; set alone it would do nothing)
  if ((federated || secret) && mode !== "direct") {
    const what = get(env, "BOT_TOKEN_SOURCE") ? `BOT_TOKEN_SOURCE=${tokenSource}` : "BOT_CLIENT_SECRET";
    throw new TeamsConfigError(`${what} needs OUTBOUND_MODE=direct`);
  }
  const settings = {
    tokenSource,
    msiClientId: mode === "direct" && !secret ? required(env, "BOT_MSI_CLIENT_ID") : get(env, "BOT_MSI_CLIENT_ID"),
    clientId: secret ? required(env, "BOT_CLIENT_ID") : get(env, "BOT_CLIENT_ID"),
    clientSecretIgnored: secretSet && !secret,
    tenantId: federated || secret ? required(env, "BOT_TENANT_ID") : get(env, "BOT_TENANT_ID"),
    assertionKeyFile: federated ? required(env, "BOT_ASSERTION_KEY_FILE") : get(env, "BOT_ASSERTION_KEY_FILE"),
    assertionIssuer: federated ? httpsIssuer(env) : "",
    assertionSubject: federated ? required(env, "BOT_ASSERTION_SUBJECT") : get(env, "BOT_ASSERTION_SUBJECT"),
  };
  const clientSecret = secret ? required(env, "BOT_CLIENT_SECRET") : "";
  return Object.defineProperty(settings, "clientSecret", { value: clientSecret, enumerable: false }) as BotSettings;
}

function wholeNumber(env: Env, name: string, fallback: number): number {
  const raw = get(env, name);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new TeamsConfigError(`${name} must be a whole number, not '${raw}'`);
  return Number.parseInt(raw, 10);
}

/** The gate's test entry reaches no queue. */
const NO_QUEUES: BusSettings = {
  namespace: "",
  listenConnectionString: "",
  sendConnectionString: "",
  inboundQueue: "",
  outboundQueue: "",
  receiverCount: 0,
};

function busFromEnv(env: Env, namespace: string): BusSettings {
  return {
    namespace,
    listenConnectionString: namespace ? "" : required(env, "SERVICEBUS_LISTEN_CONNECTION_STRING"),
    sendConnectionString: namespace ? "" : required(env, "SERVICEBUS_SEND_CONNECTION_STRING"),
    inboundQueue: env["INBOUND_QUEUE"] ?? "primusclaw-inbound",
    outboundQueue: env["OUTBOUND_QUEUE"] ?? "primusclaw-outbound",
    receiverCount: wholeNumber(env, "RECEIVER_COUNT", 8),
  };
}

/** The worker's own identity, as a settings error when it is incomplete. */
function identityFor(env: Env, why: string): WorkerIdentity {
  try {
    return workerIdentityFromEnv(env, why);
  } catch (error) {
    throw new TeamsConfigError(error instanceof Error ? error.message : "the worker identity is incomplete", {
      cause: error,
    });
  }
}

/**
 * The Teams settings from `env`. `queues` false (the release gate's test entry: no Service Bus at all) skips the queue
 * settings, which are then empty.
 */
export function teamsSettingsFromEnv(env: Env, options: { readonly queues?: boolean } = {}): TeamsSettings {
  const mode = oneOf(env, "OUTBOUND_MODE", ["servicebus", "direct"], "servicebus") === "direct" ? "direct" : "queue";
  const namespace = busNamespace(env["SERVICEBUS_NAMESPACE"] ?? "");
  const keyvault = get(env, "SECRETS_SOURCE").toLowerCase() === "keyvault";
  const why = namespace ? "SERVICEBUS_NAMESPACE" : keyvault ? "SECRETS_SOURCE=keyvault" : "";
  const installHintUrl = get(env, "TEAMS_INSTALL_HINT_URL");
  if (installHintUrl && !installHintUrl.startsWith("https://")) {
    throw new TeamsConfigError("TEAMS_INSTALL_HINT_URL must be unset or an https link: a Teams deep link to the app");
  }
  const queues = options.queues ?? true;
  return {
    outboundMode: mode,
    bot: botFromEnv(env, mode),
    bus: queues ? busFromEnv(env, namespace) : NO_QUEUES,
    workerIdentity: why ? identityFor(env, why) : undefined,
    installHintUrl,
    style: styleFromEnv(env),
  };
}
