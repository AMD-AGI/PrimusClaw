// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The ingress's settings: the names the Python Function read (PRIMUSCLAW_* and BOT_*), so a Function app moving to
 * this one keeps its app settings as they are. docs/configuration.md lists them.
 */
import { type Env } from "./env.js";
import { hostname, lstripChars, rstripChars, strip, urlsplit } from "./py.js";

export const INBOUND_IDENTITY_PREFIX = "PRIMUSCLAW_SERVICEBUS";
export const OUTBOUND_CONNECTION_SETTING = "PRIMUSCLAW_OUTBOUND_SERVICEBUS";
export const OUTBOUND_QUEUE_SETTING = "PRIMUSCLAW_OUTBOUND_QUEUE";
export const OUTBOUND_IDENTITY_SETTING = `${OUTBOUND_CONNECTION_SETTING}__fullyQualifiedNamespace`;

// A hosted Functions instance. The host takes its instance id from WEBSITE_POD_NAME or CONTAINER_NAME on Linux
// Consumption and Flex Consumption and from WEBSITE_INSTANCE_ID on the other plans.
export const HOSTED_INSTANCE_SETTINGS = ["WEBSITE_POD_NAME", "CONTAINER_NAME", "WEBSITE_INSTANCE_ID"] as const;

export interface Settings {
  botAppId: string;
  inboundConnectionString: string;
  inboundNamespace: string;
  inboundCredential: string;
  inboundIdentityClientId: string;
  inboundQueue: string;
  outboundQueueExpression: string;
  outboundConfigured: boolean;
  hosted: boolean;
}

/** The settings, as the Python Function read them at import. */
export function readSettings(env: Env): Settings {
  const botAppId = env["PRIMUSCLAW_BOT_APP_ID"] ?? "";
  // Identity-based access to the inbound queue: the same "<prefix>__<property>" shape the Functions host reads for a
  // trigger's connection. "__credential=managedidentity" without "__clientId" selects the app's system-assigned
  // identity, and "__clientId" names a user-assigned one. Without "__credential" the sender keeps its original
  // default, the bot's user-assigned identity. Whichever identity it is needs "Azure Service Bus Data Sender" on the
  // inbound queue.
  const inboundCredential = strip(env[`${INBOUND_IDENTITY_PREFIX}__credential`] ?? "").toLowerCase();
  return {
    botAppId,
    inboundConnectionString: env["PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING"] ?? "",
    inboundNamespace: strip(env[`${INBOUND_IDENTITY_PREFIX}__fullyQualifiedNamespace`] ?? ""),
    inboundCredential,
    inboundIdentityClientId:
      strip(env[`${INBOUND_IDENTITY_PREFIX}__clientId`] ?? "") || (inboundCredential ? "" : botAppId),
    inboundQueue: env["PRIMUSCLAW_SERVICEBUS_QUEUE"] ?? "primusclaw-inbound",
    // A trigger's queue name must resolve at host start, so an unset setting falls back to the default name instead
    // of an unresolvable %expression%.
    outboundQueueExpression: env[OUTBOUND_QUEUE_SETTING] ? `%${OUTBOUND_QUEUE_SETTING}%` : "primusclaw-outbound",
    // A trigger whose connection setting is absent cannot listen and would stop the whole host from indexing; leaving
    // it unregistered keeps the HTTP route up. The host accepts either a connection string under the setting itself
    // or an identity-based connection under "<setting>__fullyQualifiedNamespace".
    outboundConfigured: Boolean(env[OUTBOUND_CONNECTION_SETTING] || env[OUTBOUND_IDENTITY_SETTING]),
    hosted: HOSTED_INSTANCE_SETTINGS.some((name) => env[name]),
  };
}

/** `<ns>.servicebus.windows.net` from the setting, tolerating an `sb://` form. */
export function namespaceHost(value: string): string {
  let host = strip(value);
  if (host.includes("://")) host = hostname(urlsplit(host)) ?? "";
  return rstripChars(lstripChars(host, "/"), "/");
}
