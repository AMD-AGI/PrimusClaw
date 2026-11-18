// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The echo surface as the worker runs it (`SurfaceAdapter`): its settings, its `Surface`, how a stored reference is read
 * back, and its inbound side, a webhook on the worker's own server (`POST /echo/v1/events`) as a platform's events API
 * would post to. `buildEchoWorker` is what a surface package's `buildWorker` is: `assembleWorker` with its adapter.
 */
import {
  SURFACE_CHANNEL,
  type ConversationRef,
  type InboundEvent,
  type JsonObject,
  type MessageId,
  type Plugins,
  type SurfaceCaps,
  type UserRef,
} from "@primusclaw/personal-agent";
import { bodyJson, json, type HttpRoute } from "@primusclaw/personal-agent-runtime";
import {
  assembleWorker,
  type ConnectContext,
  type SurfaceAdapter,
  type SurfaceShape,
  type Worker,
  type WorkerEnv,
  type WorkerOptions,
  type PluginFactory,
} from "@primusclaw/personal-agent-runtime/worker";

import { chatOf, ECHO_CAPS, EchoSurface } from "./surface.js";
import type { EchoChat, EchoEvent, EchoPerson, EchoWire } from "./wire.js";

export const EVENTS_PATH = "/echo/v1/events";

/** The echo chat as core's conversation reference: `wire` is what is stored, and handed back to post there later. */
export function refOf(chat: EchoChat, messageId: MessageId = "", from?: EchoPerson): ConversationRef {
  const wire: EchoWire = {
    chat: { id: chat.id, kind: chat.kind },
    messageId,
    ...(from === undefined ? {} : { from: { id: from.id, name: from.name } }),
  };
  return { id: chat.id, kind: chat.kind, tenantId: "", wire };
}

function userOf(person: EchoPerson): UserRef {
  return { id: person.id, channelUserId: person.id, name: person.name, email: "" };
}

/** One echo event as core's; undefined for what is not one core acts on. */
export function toInboundEvent(event: EchoEvent): InboundEvent | undefined {
  const base = {
    id: event.id,
    sender: userOf(event.from),
    conversation: refOf(event.chat, event.id, event.from),
    locale: "en-US",
    clientPlatform: "Web",
  };
  if (event.type === "press") {
    const data: JsonObject = { ...(event.data as JsonObject), ...event.inputs };
    const verb = typeof data["primusclaw"] === "string" ? data["primusclaw"] : "";
    return { ...base, type: "action", verb, invoke: false, clickVerb: verb, data, cardMessageId: event.messageId };
  }
  return {
    ...base,
    type: "message",
    text: event.text,
    mentioned: event.mentionsBot === true,
    targeted: false,
    namesBotFirst: false,
    conversationName: "",
    mentions: [],
    links: [],
    quotes: [],
    files: [],
    unreadableFiles: [],
    provenance: "typed",
  };
}

/** A body the echo app posts, read as its event; undefined when it is not one. */
function eventOf(body: unknown): EchoEvent | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const event = body as Partial<EchoEvent>;
  const known = event.type === "message" || event.type === "press";
  return known && typeof event.id === "string" && chatOf({ chat: event.chat }) !== undefined && event.from !== undefined
    ? (event as EchoEvent)
    : undefined;
}

function eventsRoute(context: ConnectContext): HttpRoute {
  return {
    method: "POST",
    path: EVENTS_PATH,
    async handle(request) {
      const event = eventOf(bodyJson(request));
      const inbound = event === undefined ? undefined : toInboundEvent(event);
      if (inbound === undefined) return json(400, { error: "not_an_event" });
      await context.route(inbound);
      return json(200, { status: "handled" });
    },
  };
}

/**
 * What the features read of the echo app besides its port. The reply style is the app's own settings, not its caps: core asks
 * for a live stream wherever the style says so, and a surface that cannot stream refuses it (`openStream`), after which core
 * shows the same thing without one.
 */
export function echoShape(caps: SurfaceCaps): SurfaceShape {
  return {
    style: {
      streamText: true,
      assistantReceipt: true,
      assistantProgress: true,
      assistantStreamSay: true,
      ownThumbsMobile: false,
      suggestedReplies: caps.suggestions,
      citations: caps.citations,
      streamsIn: (kind) => kind !== "channel",
    },
    installHintUrl: "",
    restoreRef: (stored) => {
      const chat = chatOf(stored);
      return chat === undefined ? undefined : { id: chat.id, kind: chat.kind, tenantId: "", wire: stored };
    },
    refOf: (stored) => {
      const chat = chatOf(stored);
      return chat === undefined ? { id: "", kind: "personal", tenantId: "", wire: stored } : refOf(chat);
    },
    followWire: () => ({}),
    surfaceId: caps.channel,
    channelName: caps.shortName,
    version: "0.0.0",
  };
}

/** The echo surface; `caps` (default `ECHO_CAPS`) say what its app can do. `surfaces` receives the surface once opened. */
export function echoSurface(
  caps: SurfaceCaps = ECHO_CAPS,
  opened: (surface: EchoSurface) => void = () => undefined,
): SurfaceAdapter {
  if (!SURFACE_CHANNEL.test(caps.channel)) throw new Error(`not a channel id: ${caps.channel}`);
  return {
    name: caps.channel,
    prepare: (env: WorkerEnv) => ({
      configure: () => ({
        host: env["ECHO_HOST"] ?? "127.0.0.1",
        shape: echoShape(caps),
        open: () => {
          const surface = new EchoSurface(caps);
          opened(surface);
          return {
            surface,
            typedEvent: (conversation, messageId, text) => {
              const chat = chatOf(conversation.wire);
              const from = (conversation.wire as Partial<EchoWire>).from;
              if (chat === undefined || from === undefined) return undefined;
              return toInboundEvent({ type: "message", id: messageId, chat, from, text });
            },
            connect: (context) => ({ routes: [eventsRoute(context)], source: undefined }),
            closes: [],
          };
        },
      }),
    }),
  };
}

/** The worker on the echo app: what a surface package exports as its `buildWorker`. */
export function buildEchoWorker(
  env: WorkerEnv,
  plugins: Plugins | PluginFactory,
  options: WorkerOptions & { readonly caps?: SurfaceCaps; readonly opened?: (surface: EchoSurface) => void } = {},
): Promise<Worker> {
  return assembleWorker(echoSurface(options.caps, options.opened), env, plugins, options);
}
