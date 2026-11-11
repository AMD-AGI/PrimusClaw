// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Runs a parity case through the ingress with the fakes the Python side had (a recording Service Bus, no credential
 * objects, the Bot Connector's network send scripted) and real HTTP to the local OpenID/JWKS/identity server.
 */
import { register, type Registrar } from "../../src/functions.js";
import { createIngress, type Ingress } from "../../src/ingress.js";
import { type QueueClient, type ServiceBusFactory } from "../../src/queue.js";
import { type LogRecord } from "../../src/log.js";

export interface Case {
  name: string;
  kind: "http" | "outbound";
  env: Record<string, string>;
  headers?: Record<string, string>;
  /** base64 */
  body: string;
  connector?: { status?: number; body?: string; error?: boolean }[];
  failSends?: number[];
}

export interface Result {
  functions?: string[];
  outboundBinding?: [string, string];
  status?: number;
  body?: string;
  json?: boolean;
  exception?: string;
  raised?: string | null;
  sent: Record<string, unknown>[];
  built: [string, string, string | null][];
  calls: Record<string, unknown>[];
  logs: [string, string, string][];
  everything: string;
  driverError?: string;
}

class ConnectionError extends Error {
  override name = "ConnectionError";
}

const errorText = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error);

/** A recording Service Bus whose senders fail the sends `failSends` lists (one entry per sender, in order). */
function recordingBus(result: Result, failSends: number[]): ServiceBusFactory {
  const client = (conn: string): QueueClient => ({
    createSender(queue) {
      let fail = failSends.shift() ?? 0;
      return {
        sendMessages(message) {
          if (fail) {
            fail -= 1;
            return Promise.reject(new ConnectionError("link detached"));
          }
          result.sent.push({
            conn,
            queue,
            body: message.body.toString("base64"),
            contentType: message.contentType,
            correlationId: message.correlationId,
            sessionId: message.sessionId,
            messageId: message.messageId,
            applicationProperties: null,
          });
          return Promise.resolve();
        },
        createMessageBatch: () => Promise.resolve(undefined),
        close: () => Promise.resolve(),
      };
    },
  });
  return {
    fromIdentity(namespace, clientId) {
      result.built.push(["identity", namespace, clientId]);
      return client(namespace);
    },
    fromConnectionString(conn) {
      result.built.push(["connection_string", conn, null]);
      return client(conn);
    },
  };
}

/** Real HTTP to the local server; the Bot Connector's answers scripted by `connector`, every call recorded. */
function scriptedFetch(result: Result, connector: NonNullable<Case["connector"]>): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (new URL(url).hostname === "127.0.0.1") return fetch(input, init);
    const headers = new Headers(init?.headers);
    result.calls.push({
      method: init?.method ?? "GET",
      url: new URL(url).href,
      body: typeof init?.body === "string" ? init.body : null,
      // whether the bearer is the identity endpoint's token (a boolean: the token itself is never printed)
      bearerIsIdentityToken: headers.get("Authorization") === "Bearer msi-token",
      contentType: headers.get("Content-Type"),
    });
    const script = connector.shift() ?? { status: 200, body: '{"id": "posted-1"}' };
    if (script.error) return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(
      new Response(script.body ?? "", {
        status: script.status ?? 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    );
  };
}

/** What the ingress registers: the function names, and the outbound trigger's queue and connection. */
function registrations(ingress: Ingress, result: Result): void {
  const registered = new Map<string, Readonly<Record<string, unknown>>>();
  const recorder: Registrar = {
    http: (name, options) => {
      registered.set(name, options);
    },
    serviceBusQueue: (name, options) => {
      registered.set(name, options);
    },
  };
  register(recorder, ingress);
  result.functions = [...registered.keys()].sort();
  const outbound = registered.get("outbound");
  if (outbound) result.outboundBinding = [String(outbound["queueName"]), String(outbound["connection"])];
}

async function handle(ingress: Ingress, c: Case, result: Result): Promise<void> {
  const body = Buffer.from(c.body, "base64");
  if (c.kind === "http") {
    try {
      const reply = await ingress.messages({ headers: new Headers(c.headers ?? {}), body });
      result.status = reply.status;
      result.body = reply.body.toString("base64");
      result.json = reply.contentType === "application/json";
    } catch (error) {
      // The host answers an unhandled exception with a 500.
      result.status = 500;
      result.exception = error instanceof Error ? error.name : "Error";
    }
    return;
  }
  try {
    await ingress.outbound(body);
    result.raised = null;
  } catch (error) {
    result.raised = error instanceof Error ? error.message : String(error);
  }
}

export async function runCase(c: Case): Promise<Result> {
  const result: Result = { sent: [], built: [], calls: [], logs: [], everything: "" };
  const records: LogRecord[] = [];
  try {
    const ingress = createIngress({
      env: { ...c.env },
      fetch: scriptedFetch(result, [...(c.connector ?? [])]),
      log: (record) => records.push(record),
      serviceBus: recordingBus(result, [...(c.failSends ?? [])]),
    });
    registrations(ingress, result);
    await handle(ingress, c, result);
  } catch (error) {
    result.driverError = errorText(error);
  }
  result.logs = records.map((r) => [r.logger, r.level, r.message]);
  result.everything = records
    .map((r) => `${r.level} ${r.logger} ${r.message}${r.error === undefined ? "" : ` ${errorText(r.error)}`}`)
    .join("\n");
  return result;
}
