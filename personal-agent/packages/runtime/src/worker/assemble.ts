// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker process on a surface (the Python worker's `main.run`): secrets, settings, the store, the Claw client, the
 * surface's outbound side, the features behind the router, the HTTP endpoints and /metrics, the surface's inbound side, and
 * the features' timers. Nothing runs until `run`. What is the surface's own (its settings, how it is reached, where its
 * events come from) is its `SurfaceAdapter`'s.
 */
import {
  InboundStats,
  integrationRegistry,
  neutralPlugins,
  type MetricsPort,
  redactText,
  SecurityLog,
  SecretsUnavailable,
  type Clock,
  type IntegrationRegistry,
  type Integrations,
  type Logger,
  type Plugins,
  type RequestScope,
  type SecretName,
} from "@primusclaw/personal-agent";
import {
  alsRequestScope,
  buildServer,
  ChatLog,
  createClawClient,
  cryptoRandom,
  EnvSecretSource,
  healthzRoute,
  HttpTokenExchange,
  lineLogger,
  openWorkerStore,
  PrometheusMetrics,
  readSettings,
  secretsSourceOf,
  systemClock,
  wantedSecrets,
  warnLegacySettings,
} from "@primusclaw/personal-agent-runtime";

import { buildInfoText, withBuildInfo } from "./build-info.js";
import { buildFeatures, type AssemblyBase } from "./features.js";
import { metricsRoutes, workerRoutes } from "./http.js";
import { platformPlugins } from "./plugins.js";
import { closeAll, runner } from "./runner.js";
import type { ConfiguredSurface, PreparedSurface, SurfaceAdapter } from "./surface-adapter.js";
import type { PluginFactory, Worker, WorkerEnv, WorkerOptions, WorkerServices } from "./worker-api.js";
import { workerServices } from "./worker-services.js";

/** The largest body the worker's endpoint takes (a test entry's file-carrying activity is the largest). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface Basics {
  readonly clock: Clock;
  /** The worker's logger: its lines also kept per chat for a report's scene (`chatLog`). */
  readonly logger: Logger;
  readonly fetch: typeof fetch;
  /** The one request scope: the router enters it per inbound event; the locale, audit ids and kept log lines read it. */
  readonly requestScope: RequestScope;
  readonly chatLog: ChatLog;
}

function basics(name: string, options: WorkerOptions): Basics {
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
    logger: chatLog.logger(inner, `${name}_agent`),
    fetch: options.fetch ?? globalThis.fetch,
    requestScope,
    chatLog,
  };
}

/**
 * The metrics, with the inbound path also counted for its `inbound_stats` line (Python `InboundStats(metrics=...)`: one line
 * a minute of what was handled, how long it waited and took, what failed and what a limit refused).
 */
export function withInboundStats(prometheus: PrometheusMetrics, stats: InboundStats): MetricsPort {
  return {
    eventDelivered: (eventType, handleSeconds, since) => {
      prometheus.eventDelivered(eventType, handleSeconds, since);
    },
    securityEvent: (record) => {
      prometheus.securityEvent(record);
    },
    processed: (lagMs, handleMs, ok) => {
      stats.processed(lagMs, handleMs, ok);
    },
    limited: (reason) => {
      stats.limited(reason);
    },
    filesDropped: (path, count) => {
      prometheus.filesDropped(path, count);
    },
  };
}

/** The secrets from the environment, the one source a surface without its own `loadSecrets` has. */
export async function envSecrets(
  env: WorkerEnv,
  names: readonly SecretName[],
): Promise<ReadonlyMap<SecretName, string>> {
  const source = secretsSourceOf(env);
  if (source !== "env") throw new SecretsUnavailable(`SECRETS_SOURCE=${source} is not one this surface reads`);
  return new EnvSecretSource(env).load([...names]);
}

async function assemblyBase(env: WorkerEnv, prepared: PreparedSurface, deps: Basics) {
  warnLegacySettings(env, deps.logger);
  const names = wantedSecrets(env);
  const secrets = await (prepared.loadSecrets ? prepared.loadSecrets(names, deps) : envSecrets(env, names));
  const settings = readSettings(env, secrets);
  const configured: ConfiguredSurface = prepared.configure(settings);
  const prometheus = new PrometheusMetrics(deps.clock);
  const metrics = withInboundStats(prometheus, new InboundStats(deps.clock, deps.logger, prometheus));
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
  const shape = configured.shape;
  return { secrets, settings, configured, shape, metrics, prometheus, securityLog, store, claw };
}

type Parts = Awaited<ReturnType<typeof assemblyBase>>;

/**
 * `integrations` with what `register` adds to them (`WorkerOptions.registerIntegrations`): a registry that starts with
 * every server and line already there, in their order, then takes the deployment's. Without `register`, `integrations`.
 */
export function withRegistered(
  integrations: Integrations,
  register: ((registry: IntegrationRegistry) => void) | undefined,
): Integrations {
  if (register === undefined) return integrations;
  const registry = integrationRegistry();
  for (const [name, shown] of integrations.mcpServers) {
    registry.addMcpServer(name, shown, { query: integrations.queryServers.has(name) });
  }
  for (const line of integrations.connectionLines) registry.addConnectionLine(line);
  register(registry);
  return registry;
}

/**
 * The plugins: given, or built by the deployment's factory with the worker's services (once the store and the channel
 * exist, before the features: what the router is built with must be known then), with the integrations the options
 * register; then the platform services where they are neutral (`platformPlugins`), and the exchange.
 */
function pluginsOf(
  given: Plugins | PluginFactory,
  env: WorkerEnv,
  parts: Parts,
  services: WorkerServices,
  deps: Basics & { readonly registerIntegrations: WorkerOptions["registerIntegrations"] },
) {
  const built = typeof given === "function" ? neutralPlugins(given(services)) : given;
  const own = { ...built, integrations: withRegistered(built.integrations, deps.registerIntegrations) };
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

/**
 * Build the worker on the surface `adapter` from `env` with `plugins` (or a factory that builds them with the worker's
 * services). Rejects at start, before anything is served, when the settings are not usable: a worker that starts must be
 * able to answer. A surface package's own `buildWorker` is this with its adapter.
 */
export async function assembleWorker(
  adapter: SurfaceAdapter,
  env: WorkerEnv,
  plugins: Plugins | PluginFactory,
  options: WorkerOptions = {},
): Promise<Worker> {
  const deps = basics(adapter.name, options);
  const prepared = adapter.prepare(env);
  const parts = await assemblyBase(env, prepared, deps);
  const opened = parts.configured.open({ ...deps, random: cryptoRandom });
  const surface = opened.surface;
  const bound = workerServices({
    ...parts,
    surface,
    logger: deps.logger,
    restoreRef: (stored) => parts.shape.restoreRef(stored),
    typedEvent: (conversation, messageId, text) => opened.typedEvent(conversation, messageId, text),
  });
  const resolved = pluginsOf(plugins, env, parts, bound.services, {
    ...deps,
    registerIntegrations: options.registerIntegrations,
  });
  const base: AssemblyBase = { ...parts, ...deps, ...resolved, surface, random: cryptoRandom, env };
  const features = buildFeatures(base);
  bound.bind(features.router);
  const connected = opened.connect({
    route: (event) => features.router.handle(event),
    groupContext: features.groupContext,
    store: parts.store,
    exchange: resolved.exchange,
    gate: features.gate,
    metrics: parts.metrics,
    clock: deps.clock,
    logger: deps.logger,
  });
  const routes = workerRoutes({
    store: base.store,
    claw: base.claw,
    clock: base.clock,
    metrics: base.metrics,
    logger: base.logger,
    plugins: base.plugins,
    proactive: (env["PROACTIVE_ENABLED"] ?? "") === "1",
    gone: base.settings.clawEventsGone,
    deliverEvent: features.deliverEvent,
  });
  return runner({
    app: buildServer({
      routes: [...routes, ...connected.routes],
      maxBodyBytes: MAX_BODY_BYTES,
      accessLog: deps.logger,
      quietRoutes: [healthzRoute.path],
    }),
    metricsApp: buildServer({
      routes: metricsRoutes(
        withBuildInfo(() => parts.prometheus.render(), buildInfoText(parts.shape.version, process.version)),
      ),
      maxBodyBytes: 1024,
    }),
    host: parts.configured.host,
    port: parts.settings.listenPort,
    metricsPort: parts.settings.metricsPort,
    consumer: connected.source,
    start: () => features.start(),
    timers: features.timers,
    clock: deps.clock,
    logger: deps.logger,
    close: () =>
      closeAll(deps.logger, [
        () => {
          features.stop();
        },
        () => bound.idle(),
        ...opened.closes,
        () => {
          parts.store.close();
        },
      ]),
  });
}
