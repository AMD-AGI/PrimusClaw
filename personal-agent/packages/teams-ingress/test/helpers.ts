// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Shared fixtures for the ported tests: throwaway RSA keys and tokens signed with them, a log collector (pytest's
 * caplog), a recording Service Bus, fake HTTP, and an Ingress built from a settings dict the way the Python tests
 * reloaded function_app with monkeypatched environment variables.
 */
import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Fetch } from "../src/env.js";
import { createIngress, type Deps, type Ingress } from "../src/ingress.js";
import { type VerificationKey } from "../src/jwt.js";
import { type LogRecord } from "../src/log.js";
import { type QueueClient, type QueueMessage, type QueueSender, type ServiceBusFactory } from "../src/queue.js";
import { type Reply } from "../src/replies.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE = join(HERE, "..");

/** `value`, asserted to be there. */
export function defined<T>(value: T | undefined | null, what = "a value"): T {
  assert.ok(value !== undefined && value !== null, `expected ${what}`);
  return value;
}

/** The item at `index`, asserted to be there. */
export function nth<T>(items: readonly T[], index: number): T {
  return defined(items[index], `an item at ${String(index)} of ${String(items.length)}`);
}

// --- keys and tokens ----------------------------------------------------------------------------------------------

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: VerificationKey;
}

export function rsaKey(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { privateKey, publicKey, jwk: { kty: "RSA", n: jwk.n, e: jwk.e } };
}

export const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** jwt.encode(claims, key, algorithm="RS256", headers=extra): PyJWT's compact JSON and sorted header. */
export function encodeJwt(claims: Record<string, unknown>, key: KeyPair, extraHeader: Record<string, unknown> = {}) {
  const header = Object.fromEntries(Object.entries({ alg: "RS256", typ: "JWT", ...extraHeader }).sort());
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(sign("RSA-SHA256", Buffer.from(input), key.privateKey))}`;
}

/** An unsigned token (alg "none"), as PyJWT encodes one. */
export function unsignedJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.`;
}

/** The algorithm-confusion forgery: HS256 with the RSA public key's PEM as the HMAC secret. */
export function hmacForgery(claims: Record<string, unknown>, key: KeyPair): string {
  const pem = key.publicKey.export({ format: "pem", type: "spki" });
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(createHmac("sha256", pem).update(input).digest())}`;
}

export const now = (): number => Math.trunc(Date.now() / 1000);

/** Claims with overrides; an override of null removes the claim (the Python helper's `None`). */
export function claims(base: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return Object.fromEntries(Object.entries({ ...base, ...overrides }).filter(([, v]) => v !== null));
}

// --- logs ----------------------------------------------------------------------------------------------------------

export class Caplog {
  readonly records: LogRecord[] = [];
  readonly sink = (record: LogRecord): void => {
    this.records.push(record);
  };

  /** The message text of every record, and its error's text, as a Formatter with exc_info would print them. */
  get text(): string {
    return this.records
      .map(
        (r) =>
          `${r.level.toUpperCase()} ${r.logger} ${r.message}${r.error === undefined ? "" : ` ${errorText(r.error)}`}`,
      )
      .join("\n");
  }

  messages(): string[] {
    return this.records.map((r) => r.message);
  }

  events(): Record<string, unknown>[] {
    return this.records
      .filter((r) => r.logger === "clawy.security")
      .map((r) => JSON.parse(r.message) as Record<string, unknown>);
  }

  clear(): void {
    this.records.length = 0;
  }
}

// --- Service Bus ---------------------------------------------------------------------------------------------------

export interface Sent {
  conn: string;
  queue: string;
  message: QueueMessage;
}

/** A Service Bus factory whose senders record what they send, with the connection they were built from. */
export class RecordingBus implements ServiceBusFactory {
  readonly sent: Sent[] = [];
  readonly built: { kind: "identity" | "connection_string"; target: string; clientId: string | null }[] = [];
  fail: ((what: "fromConnectionString" | "fromIdentity") => void) | null = null;

  fromIdentity(namespace: string, clientId: string | null): QueueClient {
    this.fail?.("fromIdentity");
    this.built.push({ kind: "identity", target: namespace, clientId });
    return this.client(namespace);
  }

  fromConnectionString(connectionString: string): QueueClient {
    this.fail?.("fromConnectionString");
    this.built.push({ kind: "connection_string", target: connectionString, clientId: null });
    return this.client(connectionString);
  }

  private client(conn: string): QueueClient {
    const sent = this.sent;
    return {
      createSender(queue: string): QueueSender {
        return {
          sendMessages: (message) => {
            sent.push({ conn, queue, message });
            return Promise.resolve();
          },
          createMessageBatch: () => Promise.resolve(undefined),
          close: () => Promise.resolve(),
        };
      },
    };
  }
}

/** A fetch input as a URL string. */
export function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input;
}

/** An error as a log Formatter with exc_info prints it: its stack, or its text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error);
}

/** The JSON document a queue message carries. */
export const bodyOf = (message: QueueMessage): unknown => JSON.parse(message.body.toString("utf8"));

// --- HTTP ----------------------------------------------------------------------------------------------------------

export interface FakeResponseInit {
  status?: number;
  body?: unknown;
}

/** The Python tests' FakeResponse: a body of `{"id": "posted-1"}` unless a truthy one is given. */
export function fakeResponse(status = 200, body?: unknown): Response {
  const isEmpty = body === undefined || body === null || (typeof body === "object" && Object.keys(body).length === 0);
  return new Response(JSON.stringify(isEmpty ? { id: "posted-1" } : body), { status });
}

export interface TokenAsk {
  url: string;
  params: Record<string, string>;
  headers: Record<string, string>;
}

export interface ConnectorCall {
  method: string;
  url: string;
  json: Record<string, unknown>;
  headers: Record<string, string>;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

/**
 * Fake HTTP for the outbound path: GETs are the managed-identity token endpoint, POSTs and PUTs the Bot Connector.
 * `connector` answers the Connector calls (default: 200 with an id).
 */
export class FakeHttp {
  readonly tokensAsked: TokenAsk[] = [];
  readonly calls: ConnectorCall[] = [];
  connector: (call: ConnectorCall) => Response | Promise<Response> = () => fakeResponse(200);
  get: ((url: URL, init?: RequestInit) => Response | Promise<Response>) | null = null;

  readonly fetch: Fetch = (input, init) => Promise.resolve(this.answer(urlOf(input), init));

  private answer(raw: string, init?: RequestInit): Response | Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      const url = new URL(raw);
      if (this.get) return this.get(url, init);
      const params = Object.fromEntries(url.searchParams.entries());
      this.tokensAsked.push({ url: `${url.origin}${url.pathname}`, params, headers: headersOf(init) });
      return new Response(JSON.stringify({ access_token: `tok-${params["client_id"] ?? ""}`, expires_in: 3600 }), {
        status: 200,
      });
    }
    const body = typeof init?.body === "string" ? init.body : "";
    const call = { method, url: raw, json: JSON.parse(body) as Record<string, unknown>, headers: headersOf(init) };
    this.calls.push(call);
    return this.connector(call);
  }
}

/** HTTP that must not be used. */
export const noNetwork: Fetch = (input) => Promise.reject(new Error(`no network in tests: ${urlOf(input)}`));

// --- the Function --------------------------------------------------------------------------------------------------

export interface Loaded {
  ingress: Ingress;
  log: Caplog;
  bus: RecordingBus;
  http: FakeHttp;
  spawned: string[];
}

/** function_app as if imported with exactly `env` set (and no hosted-instance setting unless given). */
export function load(env: Record<string, string>, overrides: Partial<Deps> = {}): Loaded {
  const log = new Caplog();
  const bus = new RecordingBus();
  const http = new FakeHttp();
  const spawned: string[] = [];
  const ingress = createIngress({
    env: { ...env },
    fetch: http.fetch,
    log: log.sink,
    serviceBus: bus,
    spawn: (name) => {
      spawned.push(name);
    },
    ...overrides,
  });
  return { ingress, log, bus, http, spawned };
}

export function request(body: unknown, headers: Record<string, string> = { Authorization: "Bearer x" }) {
  const raw =
    body instanceof Uint8Array
      ? body
      : typeof body === "string"
        ? Buffer.from(body)
        : Buffer.from(JSON.stringify(body));
  return { headers: new Headers(headers), body: raw };
}

export function post(ingress: Ingress, body: unknown, headers?: Record<string, string>): Promise<Reply> {
  return ingress.messages(request(body, headers));
}

/** The JSON of a reply's body. */
export const json = (reply: Reply): unknown => JSON.parse(reply.body.toString("utf8"));

/** Assert a promise rejects with an error whose message matches `pattern`; returns the error. */
export async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`expected an error matching ${String(pattern)}, got: ${message}`, { cause: error });
    }
    return error instanceof Error ? error : new Error(message);
  }
  throw new Error(`expected an error matching ${String(pattern)}, but it resolved`);
}

// --- the shared fixtures of test_ingress.py ------------------------------------------------------------------

export const SERVICE_URL = "https://smba.trafficmanager.net/teams";
export const CONVERSATION = { id: "19:abc@thread.v2" };
export const REFERENCE = {
  serviceUrl: SERVICE_URL,
  conversation: CONVERSATION,
  bot: { id: "28:bot" },
  user: { id: "29:user" },
  activityId: "reply-to-1",
  channelId: "msteams",
};

export const FULL_ENV: Record<string, string> = {
  PRIMUSCLAW_BOT_APP_ID: "claw-app",
  PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING: "cs-claw-in",
  PRIMUSCLAW_OUTBOUND_SERVICEBUS: "cs-claw-out",
  IDENTITY_ENDPOINT: "http://identity.local/token",
  IDENTITY_HEADER: "hdr",
};

export const MESSAGE = { type: "message", id: "a1", serviceUrl: SERVICE_URL, conversation: CONVERSATION };
