// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How this worker reaches Teams, as its settings say: the outbound queue by default; in direct mode the Bot Connector, with
 * the queue behind it as the fallback and the bot's token from IMDS, by workload identity federation or with an app
 * registration's client secret; in the release
 * gate's test entry the gate's recording connector alone, with a made-up token and no queue at all.
 */
import { readFileSync } from "node:fs";

import type { Clock, Logger } from "@primusclaw/personal-agent";
import { silentLogger } from "@primusclaw/personal-agent";

import { FederatedCredential, readWorkerKey } from "../azure/workload-identity.js";
import type { TeamsSettings } from "../config/env.js";
import { DEFAULT_CONNECTOR_HOSTS, onlyConnector, type ServiceUrlPolicy } from "../connector/hosts.js";
import { ConnectorOutbox } from "../connector/outbox.js";
import type { TokenSource } from "../connector/tokens/cached.js";
import { ClientSecretTokenProvider } from "../connector/tokens/client-secret.js";
import { FederatedTokenProvider } from "../connector/tokens/federated.js";
import { ImdsTokenProvider } from "../connector/tokens/imds.js";
import type { GateEntry } from "../gate/entry-env.js";
import { GateToken, NoQueue } from "../gate/no-queue.js";
import type { Outbox } from "../outbound/outbox.js";
import { azureBusClient, type BusClient, type BusConnection } from "../servicebus/client.js";
import { ServiceBusOutbox } from "../servicebus/outbox.js";

/** The longest a session's lock is renewed for while one conversation's messages are handled. */
export const LOCK_RENEWAL_MS = 5 * 60_000;

export interface AssemblyDeps {
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
  /** Reads a key file (default: the file system). */
  readonly readFile?: (path: string) => Buffer;
}

export class StartupError extends Error {
  override name = "StartupError";
}

/** The bot's token in direct mode (BOT_TOKEN_SOURCE). A federated key that cannot be read stops the worker here, at start. */
export function botTokenSource(settings: TeamsSettings, deps: AssemblyDeps): TokenSource {
  const { bot } = settings;
  const logger = deps.logger ?? silentLogger;
  const base = { clock: deps.clock, logger, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  if (bot.clientSecretIgnored) {
    logger.warn("BOT_CLIENT_SECRET is set but not used: BOT_TOKEN_SOURCE names another source", {
      tokenSource: bot.tokenSource,
    });
  }
  if (bot.tokenSource === "secret") {
    // (the settings checked all three: the provider cannot refuse them)
    const provider = new ClientSecretTokenProvider({
      ...base,
      clientId: bot.clientId,
      tenantId: bot.tenantId,
      clientSecret: bot.clientSecret,
    });
    logger.info("bot token source: secret", { clientId: bot.clientId, tenantId: bot.tenantId });
    return provider;
  }
  if (bot.tokenSource !== "federated") {
    logger.info("bot token source: imds", { clientId: bot.msiClientId });
    return new ImdsTokenProvider(bot.msiClientId, base);
  }
  let keyPem: Buffer;
  try {
    keyPem = (deps.readFile ?? readFileSync)(bot.assertionKeyFile);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "error";
    throw new StartupError(`BOT_ASSERTION_KEY_FILE cannot be read (${code})`, { cause: error });
  }
  try {
    const provider = new FederatedTokenProvider({
      ...base,
      clientId: bot.msiClientId,
      tenantId: bot.tenantId,
      keyPem,
      issuer: bot.assertionIssuer,
      subject: bot.assertionSubject,
    });
    logger.info("bot token source: federated", { clientId: bot.msiClientId, tenantId: bot.tenantId });
    return provider;
  } catch (error) {
    throw new StartupError(`BOT_ASSERTION_KEY_FILE: ${error instanceof Error ? error.message : "unusable"}`, {
      cause: error,
    });
  }
}

/** The worker identity's credential (one for both queues and the vault), when the settings name the identity. */
export function workerCredential(settings: TeamsSettings, deps: AssemblyDeps): FederatedCredential | undefined {
  const identity = settings.workerIdentity;
  if (identity === undefined) return undefined;
  return new FederatedCredential(identity, readWorkerKey(identity, deps.readFile), {
    clock: deps.clock,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

/** (inbound, outbound): the worker identity on the namespace when SERVICEBUS_NAMESPACE is set, else the connection strings. */
export function busConnections(
  settings: TeamsSettings,
  credential: FederatedCredential | undefined,
): readonly [BusConnection, BusConnection] {
  const { bus } = settings;
  if (!bus.namespace) return [bus.listenConnectionString, bus.sendConnectionString];
  if (credential === undefined) throw new StartupError("SERVICEBUS_NAMESPACE needs the worker identity");
  const identity: BusConnection = { namespace: bus.namespace, credential };
  return [identity, identity];
}

export interface Outbound {
  readonly outbox: Outbox;
  /** The bot's token, which also fetches a pasted image (direct mode and the gate only). */
  readonly tokens: TokenSource | undefined;
  /** Where the bot's token may go. */
  readonly policy: ServiceUrlPolicy;
  close(): Promise<void>;
}

/** The release gate's test entry: the recording connector and nothing else (Microsoft's hosts included). */
export function gateOutbound(gate: GateEntry, deps: AssemblyDeps): Outbound {
  const tokens = new GateToken(gate.runId);
  const policy = onlyConnector(gate.connectorUrl);
  (deps.logger ?? silentLogger).warn("release gate test entry: outbound to the recording connector only; no queue", {
    runId: gate.runId,
  });
  const outbox = new ConnectorOutbox({
    tokens,
    fallback: new NoQueue(deps.logger),
    clock: deps.clock,
    policy,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return { outbox, tokens, policy, close: () => outbox.close() };
}

/** The queue by default; in direct mode the Bot Connector with the queue behind it as the fallback. */
export function productionOutbound(settings: TeamsSettings, outbound: BusClient, deps: AssemblyDeps): Outbound {
  const queue = new ServiceBusOutbox(outbound, settings.bus.outboundQueue, deps.clock, deps.logger);
  if (settings.outboundMode !== "direct") {
    return { outbox: queue, tokens: undefined, policy: DEFAULT_CONNECTOR_HOSTS, close: () => queue.close() };
  }
  (deps.logger ?? silentLogger).info("outbound mode: direct to the Bot Connector (the queue is the fallback)");
  const tokens = botTokenSource(settings, deps);
  const outbox = new ConnectorOutbox({
    tokens,
    fallback: queue,
    clock: deps.clock,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return {
    outbox,
    tokens,
    policy: DEFAULT_CONNECTOR_HOSTS,
    close: async () => {
      await outbox.close();
      await queue.close();
    },
  };
}

/** The SDK clients of the two queues. */
export function busClients(connections: readonly [BusConnection, BusConnection]): readonly [BusClient, BusClient] {
  return [azureBusClient(connections[0], LOCK_RENEWAL_MS), azureBusClient(connections[1], LOCK_RENEWAL_MS)];
}
