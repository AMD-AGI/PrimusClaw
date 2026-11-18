// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * @primusclaw/personal-agent-teams-ingress: the personal agent's Teams ingress, an Azure Function that verifies the
 * Bot Framework token of every activity Teams posts and puts the activity on the worker's inbound Service Bus queue.
 *
 * The release attaches it ready to deploy (personal-agent-teams-ingress-<version>.zip: docs/quickstart.md, "The
 * ingress"). This entry is for a Function app of one's own: `register(app, createIngress({ env: process.env, fetch,
 * log: consoleSink, serviceBus: SERVICE_BUS }))` is what the deployable package runs.
 */
export { hostedIngress, start } from "./app.js";
export { Auth, AuthError, authSettings, DEFAULT_ISSUERS, DEFAULT_OPENID_CONFIG_URL } from "./auth.js";
export type { Clock, Env, Fetch } from "./env.js";
export { consoleSink, contextSink, register, type Registrar } from "./functions.js";
export {
  clientIp,
  createIngress,
  Ingress,
  PREFETCH_WAIT_SECONDS,
  tokenRejected,
  urlHost,
  type Deps,
  type Request,
} from "./ingress.js";
export type { Level, LogRecord, LogSink } from "./log.js";
export { ACK_TYPE } from "./outbound.js";
export { boundedId, type QueueClient, type QueueMessage, type QueueSender, type ServiceBusFactory } from "./queue.js";
export { PLACEHOLDER_CARD, UNAVAILABLE_CARD, type Reply } from "./replies.js";
export { CLIENT_OPTIONS, SERVICE_BUS } from "./servicebus.js";
export {
  HOSTED_INSTANCE_SETTINGS,
  INBOUND_IDENTITY_PREFIX,
  OUTBOUND_CONNECTION_SETTING,
  OUTBOUND_IDENTITY_SETTING,
  OUTBOUND_QUEUE_SETTING,
  readSettings,
  type Settings,
} from "./settings.js";
