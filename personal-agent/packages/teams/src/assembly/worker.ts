// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker on Teams (`BuildWorker`): runtime's worker assembly with the Teams surface. What is Teams' own is here:
 * its settings (OUTBOUND_MODE, BOT_*, SERVICEBUS_*, the reply style), secrets from Azure Key Vault, how it reaches Teams
 * (the outbound queue or the Bot Connector), its `TeamsSurface` with the Adaptive Card renderers, the inbound queue's
 * consumer, and the release gate's test entry (its routes on the loopback instead of the queue).
 */
import {
  NOTE,
  redactText,
  type ConversationKind,
  type ConversationRef,
  type JsonObject,
  type Logger,
} from "@primusclaw/personal-agent";
import { cryptoRandom } from "@primusclaw/personal-agent-runtime";
import {
  assembleWorker,
  type BuildWorker,
  type ConfiguredSurface,
  type ConnectContext,
  type OpenedSurface,
  type ReplyStyle,
  type SurfaceAdapter,
  type SurfaceDeps,
  type SurfaceShape,
  type WorkerEnv,
} from "@primusclaw/personal-agent-runtime/worker";

import { toInboundEvent } from "../activity/inbound/to-event.js";
import { activityOfReference } from "../activity/outbound.js";
import { teamsMasker } from "../activity/redact-activity.js";
import { restoreConversationRef } from "../activity/reference.js";
import { isObject, type JsonObject as WireJson } from "../cards/json.js";
import { teamsSettingsFromEnv, type TeamsSettings } from "../config/env.js";
import { streamsIn, type Style } from "../config/style.js";
import { gateEntryFromEnv, LOOPBACK, type GateEntry } from "../gate/entry-env.js";
import { gateRoutes } from "../gate/routes.js";
import { TeamsFileFetcher } from "../inbound/fetcher.js";
import { AckRegistry } from "../messenger/acks.js";
import { teamsVersion } from "../observability/build-info.js";
import { InboundConsumer } from "../servicebus/consumer.js";
import type { BusClient } from "../servicebus/client.js";
import { TeamsSurface } from "../surface.js";
import { RENDERERS } from "../views/index.js";
import { inboundHandler } from "./inbound.js";
import {
  busClients,
  busConnections,
  gateOutbound,
  productionOutbound,
  workerCredential,
  type Outbound,
} from "./outbound.js";
import { loadSecrets } from "./secrets.js";

const BOT_NAME = "Clawy";

/** The Teams style's reading of a conversation kind (`style.streams_in`'s conversation types). */
export function conversationTypeOf(kind: string): string {
  if (kind === "personal") return "personal";
  return kind === "group" ? "groupChat" : "channel";
}

/** The switches of the Teams reply style the features read. */
export function replyStyle(style: Style): ReplyStyle {
  return {
    streamText: style.streamText,
    assistantReceipt: style.assistantReceipt,
    assistantProgress: style.assistantProgress,
    assistantStreamSay: style.assistantStreamSay,
    ownThumbsMobile: style.ownThumbsMobile,
    suggestedReplies: style.suggestedReplies,
    citations: style.citations,
    streamsIn: (kind: ConversationKind) => streamsIn(style, conversationTypeOf(kind)),
  };
}

/** A stored reference as the surface posts to it; one that names no conversation still gets one (its send then fails). */
export function refOf(reference: JsonObject): ConversationRef {
  const restored = restoreConversationRef(reference);
  if (restored !== undefined) return restored;
  const conversation = reference["conversation"];
  const type = isObject(conversation) ? conversation["conversationType"] : undefined;
  return { id: "", kind: type === "groupChat" ? "group" : "personal", tenantId: "", wire: reference };
}

/** The Teams fields a followed review keeps to open the reviewer's chat again (Python: service_url, tenant, bot_id). */
export function followWire(asked: ConversationRef): Readonly<Record<string, string>> {
  const wire = asked.wire as JsonObject;
  const bot = wire["bot"];
  const botId = typeof bot === "object" && bot !== null && !Array.isArray(bot) ? (bot as JsonObject)["id"] : undefined;
  const serviceUrl = wire["serviceUrl"];
  return {
    service_url: typeof serviceUrl === "string" ? serviceUrl : "",
    tenant: asked.tenantId,
    bot_id: typeof botId === "string" ? botId : "",
  };
}

/** What the features read of Teams besides its port. */
export function teamsShape(teams: Pick<TeamsSettings, "style" | "installHintUrl">): SurfaceShape {
  return {
    style: replyStyle(teams.style),
    installHintUrl: teams.installHintUrl,
    restoreRef: (stored) => restoreConversationRef(stored),
    refOf,
    followWire,
    surfaceId: "teams",
    channelName: "Teams",
    version: teamsVersion(),
  };
}

/**
 * `text` as the activity Teams would have sent for the person's own message `messageId` in a stored conversation, read as
 * core's event (what a plugin's `handleAsTyped` hands the router); undefined when it cannot be read.
 */
export function teamsTypedEvent(logger: Logger): OpenedSurface["typedEvent"] {
  return (conversation, messageId, text) => {
    const activity: WireJson = { ...activityOfReference(conversation.wire as WireJson, messageId), text };
    const read = toInboundEvent(activity, { botName: BOT_NAME, logger });
    return read.ok ? read.value : undefined;
  };
}

interface Transport {
  readonly outbound: Outbound;
  readonly inbound: BusClient | undefined;
}

function transport(teams: TeamsSettings, gate: GateEntry | undefined, deps: SurfaceDeps): Transport {
  if (gate !== undefined) return { outbound: gateOutbound(gate, deps), inbound: undefined };
  const credential = workerCredential(teams, deps);
  const [inbound, out] = busClients(busConnections(teams, credential));
  return { outbound: productionOutbound(teams, out, deps), inbound };
}

function surfaceOf(teams: TeamsSettings, outbound: Outbound, gate: GateEntry | undefined, deps: SurfaceDeps) {
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

function connect(
  teams: TeamsSettings,
  parts: { readonly acks: AckRegistry; readonly inbound: BusClient | undefined; readonly gate: GateEntry | undefined },
  context: ConnectContext,
) {
  const { acks, inbound, gate } = parts;
  const handle = inboundHandler({
    acks,
    route: context.route,
    botName: BOT_NAME,
    logger: context.logger,
    groupContext: context.groupContext,
  });
  const source =
    inbound === undefined
      ? undefined
      : new InboundConsumer({
          client: inbound,
          queue: teams.bus.inboundQueue,
          handle,
          receivers: teams.bus.receiverCount,
          clock: context.clock,
          logger: context.logger,
          stats: {
            processed: (lag, ms, ok) => {
              context.metrics.processed(lag ?? null, ms, ok);
            },
          },
        });
  const routes =
    gate === undefined
      ? []
      : gateRoutes({
          handle,
          links: context.store.links,
          members: context.store.members,
          notifySubs: context.store.notifySubs,
          sessions: context.store.sessions,
          exchange: context.exchange,
          subscriptions: context.gate.subscriptions,
          madeSessions: context.gate.madeSessions,
          logger: context.logger,
        });
  return { routes, source };
}

function opened(teams: TeamsSettings, gate: GateEntry | undefined, deps: SurfaceDeps): OpenedSurface {
  const { outbound, inbound } = transport(teams, gate, deps);
  const { acks, surface } = surfaceOf(teams, outbound, gate, deps);
  return {
    surface,
    typedEvent: teamsTypedEvent(deps.logger),
    connect: (context) => connect(teams, { acks, inbound, gate }, context),
    closes: [() => outbound.close(), () => inbound?.close()],
  };
}

/**
 * The Teams surface: the release gate's test entry is read first (TEAMS_GATE_ENTRY), the secrets come from where
 * SECRETS_SOURCE says (the environment or Azure Key Vault), and the Teams settings are read after core's.
 */
export function teamsSurface(): SurfaceAdapter {
  return {
    name: "teams",
    prepare(env: WorkerEnv) {
      const gate = gateEntryFromEnv(env);
      return {
        loadSecrets: (_names, deps) => loadSecrets(env, deps),
        configure(): ConfiguredSurface {
          const teams = teamsSettingsFromEnv(env, { queues: gate === undefined });
          return {
            host: gate === undefined ? "0.0.0.0" : LOOPBACK,
            shape: teamsShape(teams),
            open: (deps) => opened(teams, gate, deps),
          };
        },
      };
    },
  };
}

export const buildWorker: BuildWorker = (env, plugins, options = {}) =>
  assembleWorker(teamsSurface(), env, plugins, options);
