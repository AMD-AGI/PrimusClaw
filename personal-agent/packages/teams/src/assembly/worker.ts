// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker process (`BuildWorker`, the Python worker's `main.run`): secrets, settings, the store, the Claw client, how it
 * reaches Teams, the features behind the router, the HTTP endpoints and /metrics, the inbound queue's consumer (or, in the
 * release gate's test entry, its routes on the loopback instead), and the features' timers. Nothing runs until `run`.
 */
import {
  neutralPlugins,
  NOTE,
  redactText,
  SecurityLog,
  type Clock,
  type Logger,
  type Plugins,
  type RequestScope,
} from "@primusclaw/personal-agent";
import {
  alsRequestScope,
  buildServer,
  ChatLog,
  createClawClient,
  cryptoRandom,
  HttpTokenExchange,
  lineLogger,
  openWorkerStore,
  PrometheusMetrics,
  readSettings,
  systemClock,
  type HttpRoute,
} from "@primusclaw/personal-agent-runtime";

import { teamsMasker } from "../activity/redact-activity.js";
import { teamsSettingsFromEnv } from "../config/env.js";
import { gateEntryFromEnv, LOOPBACK, type GateEntry } from "../gate/entry-env.js";
import { gateRoutes } from "../gate/routes.js";
import { TeamsFileFetcher } from "../inbound/fetcher.js";
import { AckRegistry } from "../messenger/acks.js";
import { InboundConsumer } from "../servicebus/consumer.js";
import type { BusClient } from "../servicebus/client.js";
import { TeamsSurface } from "../surface.js";
import { RENDERERS } from "../views/index.js";
import type { BuildWorker, PluginFactory, WorkerEnv, WorkerOptions, WorkerServices } from "../worker-api.js";
import { buildFeatures, type AssemblyBase, type Features } from "./features.js";
import { metricsRoutes, workerRoutes } from "./http.js";
import { inboundHandler } from "./inbound.js";
import {
  busClients,
  busConnections,
  gateOutbound,
  productionOutbound,
  workerCredential,
  type Outbound,
} from "./outbound.js";
import { platformPlugins } from "./plugins.js";
import { workerServices } from "./worker-services.js";
import { closeAll, runner } from "./runner.js";
import { loadSecrets } from "./secrets.js";

/** The largest body the worker's endpoint takes (a gate's file-carrying activity is the largest). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const BOT_NAME = "Clawy";

interface Basics {
  readonly clock: Clock;
  /** The worker's logger: its lines also kept per chat for a report's scene (`chatLog`). */
  readonly logger: Logger;
  readonly fetch: typeof fetch;
  /** The one request scope: the router enters it per inbound event; the locale, audit ids and kept log lines read it. */
  readonly requestScope: RequestScope;
  readonly chatLog: ChatLog;
}

function basics(options: WorkerOptions): Basics {
  const clock = options.clock ?? systemClock;
  const write = (line: string): void => {
    process.stderr.write(line + "\n");
  };
  const requestScope = alsRequestScope();
  const chatLog = new ChatLog(
    requestScope,
    (text) => redactText(text).text,
    () => clock.epochMs() / 1000,
  );
  const inner = options.logger ?? lineLogger({ level: "info", now: () => clock.epochMs(), write });
  return {
    clock,
    logger: chatLog.logger(inner, "teams_agent"),
    fetch: options.fetch ?? globalThis.fetch,
    requestScope,
    chatLog,
  };
}

interface Transport {
  readonly outbound: Outbound;
  readonly inbound: BusClient | undefined;
}

function transport(teams: AssemblyBase["teams"], gate: GateEntry | undefined, deps: Basics): Transport {
  if (gate !== undefined) return { outbound: gateOutbound(gate, deps), inbound: undefined };
  const credential = workerCredential(teams, deps);
  const [inbound, out] = busClients(busConnections(teams, credential));
  return { outbound: productionOutbound(teams, out, deps), inbound };
}

function surfaceOf(teams: AssemblyBase["teams"], outbound: Outbound, gate: GateEntry | undefined, deps: Basics) {
  const acks = new AckRegistry(deps.clock, deps.logger);
  const surface = new TeamsSurface({
    mode: teams.outboundMode === "direct" || gate !== undefined ? "direct" : "queue",
    outbox: outbound.outbox,
    acks,
    clock: deps.clock,
    random: cryptoRandom,
    style: teams.style,
    renderers: RENDERERS,
    masker: teamsMasker((text) => redactText(text), NOTE),
    files: new TeamsFileFetcher({
      fetch: (url, init) => deps.fetch(url, init),
      clock: deps.clock,
      tokens: outbound.tokens,
      hosts: outbound.policy,
      plainPrefix: gate?.filesPrefix ?? "",
      logger: deps.logger,
    }),
    logger: deps.logger,
  });
  return { acks, surface };
}

async function assemblyBase(env: WorkerEnv, gate: GateEntry | undefined, deps: Basics) {
  const secrets = await loadSecrets(env, deps);
  const settings = readSettings(env, secrets);
  const teams = teamsSettingsFromEnv(env, { queues: gate === undefined });
  const metrics = new PrometheusMetrics(deps.clock);
  const securityLog = new SecurityLog(deps.logger, metrics, deps.requestScope);
  const store = openWorkerStore(settings, {
    securityEvent: (event, fields) => securityLog.event(event, fields),
    logger: deps.logger,
    clock: deps.clock,
    random: cryptoRandom,
  });
  const claw = createClawClient({
    baseUrl: settings.clawApiUrl,
    clock: deps.clock,
    logger: deps.logger,
    pluginId: settings.claw.pluginId,
    model: settings.models.chat,
    ruleToolId: settings.claw.ruleToolId,
    clientLabel: settings.claw.clientLabel,
    fetch: (url, init) => deps.fetch(url, init),
  });
  return { secrets, settings, teams, metrics, securityLog, store, claw };
}

type Parts = Awaited<ReturnType<typeof assemblyBase>>;

/**
 * The plugins: given, or built by the deployment's factory with the worker's services (once the store and the channel
 * exist, before the features: what the router is built with must be known then); then the platform services where they
 * are neutral (`platformPlugins`), and the exchange.
 */
function pluginsOf(
  given: Plugins | PluginFactory,
  env: WorkerEnv,
  parts: Parts,
  services: WorkerServices,
  deps: Basics,
) {
  const own = typeof given === "function" ? neutralPlugins(given(services)) : given;
  const plugins = platformPlugins(own, {
    env,
    settings: parts.settings,
    secrets: parts.secrets,
    fetch: deps.fetch,
    now: () => deps.clock.epochMs() / 1000,
    logger: deps.logger,
  });
  const exchange = parts.settings.exchange.enabled
    ? new HttpTokenExchange(parts.settings.exchange, deps.clock, deps.fetch)
    : plugins.tokenExchange;
  return { plugins, exchange };
}

function routesOf(
  base: AssemblyBase,
  features: Features,
  handle: (body: Parameters<ReturnType<typeof inboundHandler>>[0]) => Promise<void>,
  gate: GateEntry | undefined,
): HttpRoute[] {
  const routes = workerRoutes({
    store: base.store,
    claw: base.claw,
    clock: base.clock,
    metrics: base.metrics,
    logger: base.logger,
    plugins: base.plugins,
    proactive: (base.env["PROACTIVE_ENABLED"] ?? "") === "1",
    gone: base.settings.clawEventsGone,
    deliverEvent: features.deliverEvent,
  });
  if (gate === undefined) return routes;
  return [
    ...routes,
    ...gateRoutes({
      handle,
      links: base.store.links,
      members: base.store.members,
      notifySubs: base.store.notifySubs,
      sessions: base.store.sessions,
      exchange: base.exchange,
      subscriptions: features.gate.subscriptions,
      madeSessions: features.gate.madeSessions,
      logger: base.logger,
    }),
  ];
}

export const buildWorker: BuildWorker = async (env, plugins, options = {}) => {
  const deps = basics(options);
  const gate = gateEntryFromEnv(env);
  const parts = await assemblyBase(env, gate, deps);
  const { outbound, inbound } = transport(parts.teams, gate, deps);
  const { acks, surface } = surfaceOf(parts.teams, outbound, gate, deps);
  const bound = workerServices({ ...parts, surface, logger: deps.logger, botName: BOT_NAME });
  const resolved = pluginsOf(plugins, env, parts, bound.services, deps);
  const base: AssemblyBase = { ...parts, ...deps, ...resolved, surface, random: cryptoRandom, env };
  const features = buildFeatures(base);
  bound.bind(features.router);
  const handle = inboundHandler({
    acks,
    route: (event) => features.router.handle(event),
    botName: BOT_NAME,
    logger: deps.logger,
  });
  const consumer =
    inbound === undefined
      ? undefined
      : new InboundConsumer({
          client: inbound,
          queue: parts.teams.bus.inboundQueue,
          handle,
          receivers: parts.teams.bus.receiverCount,
          clock: deps.clock,
          logger: deps.logger,
          stats: {
            processed: (lag, ms, ok) => {
              parts.metrics.processed(lag ?? null, ms, ok);
            },
          },
        });
  return runner({
    app: buildServer({ routes: routesOf(base, features, handle, gate), maxBodyBytes: MAX_BODY_BYTES }),
    metricsApp: buildServer({ routes: metricsRoutes(() => parts.metrics.render()), maxBodyBytes: 1024 }),
    host: gate === undefined ? "0.0.0.0" : LOOPBACK,
    port: parts.settings.listenPort,
    metricsPort: parts.settings.metricsPort,
    consumer,
    start: () => features.start(),
    timers: features.timers,
    clock: deps.clock,
    logger: deps.logger,
    close: () =>
      closeAll(deps.logger, [
        () => bound.idle(),
        () => outbound.close(),
        () => inbound?.close(),
        () => {
          parts.store.close();
        },
      ]),
  });
};
