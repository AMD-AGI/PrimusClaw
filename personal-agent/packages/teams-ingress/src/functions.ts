// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The deployed shape: the function names, the route, its auth level and the outbound trigger's binding, registered on
 * `@azure/functions`' `app` (src/main.ts) or, in tests, on a recorder. Each invocation's log records go to its
 * InvocationContext, so the host files them under that invocation.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

import { type Ingress } from "./ingress.js";
import { type LogRecord, type LogSink } from "./log.js";
import { OUTBOUND_CONNECTION_SETTING } from "./settings.js";

/** The registration calls of `@azure/functions`' `app` that the ingress makes. */
export interface Registrar {
  http(
    name: string,
    options: {
      route: string;
      methods: "POST"[];
      authLevel: "anonymous";
      handler: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
    },
  ): void;
  serviceBusQueue(
    name: string,
    options: {
      connection: string;
      queueName: string;
      handler: (message: unknown, context: InvocationContext) => Promise<void>;
    },
  ): void;
}

/** The arguments a record is logged with: its message, and the error it carries. */
const args = (record: LogRecord): unknown[] =>
  record.error === undefined ? [record.message] : [record.message, record.error];

/** Log records into an invocation's context. */
export function contextSink(context: InvocationContext): LogSink {
  return (record) => {
    const a = args(record);
    if (record.level === "debug") context.debug(...a);
    else if (record.level === "info") context.info(...a);
    else if (record.level === "warning") context.warn(...a);
    else context.error(...a);
  };
}

/** Log records outside an invocation (at start-up): the console, which the Functions host collects. */
export const consoleSink: LogSink = (record) => {
  const a = args(record);
  if (record.level === "debug") console.debug(...a);
  else if (record.level === "info") console.info(...a);
  else if (record.level === "warning") console.warn(...a);
  else console.error(...a);
};

/** Register the messaging endpoint, and the outbound trigger when its connection is configured. */
export function register(app: Registrar, ingress: Ingress): void {
  // The bot's messaging endpoint is https://<app>/api/messages; Bot Framework sends no function key.
  app.http("messages", {
    route: "messages",
    methods: ["POST"],
    authLevel: "anonymous",
    handler: async (request, context) => {
      const reply = await ingress.messages(
        { headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) },
        contextSink(context),
      );
      return { status: reply.status, body: reply.body, headers: { "Content-Type": reply.contentType } };
    },
  });
  if (ingress.settings.outboundConfigured) {
    // The host resolves the connection (a connection string under the setting, or "<setting>__fullyQualifiedNamespace"
    // for an identity) and the queue name expression.
    app.serviceBusQueue("outbound", {
      connection: OUTBOUND_CONNECTION_SETTING,
      queueName: ingress.settings.outboundQueueExpression,
      handler: (message, context) => ingress.outbound(message, contextSink(context)),
    });
  }
}
