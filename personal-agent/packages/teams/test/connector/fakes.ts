// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Fakes for the Bot Connector tests: IMDS, Entra ID's token endpoint and the Bot Connector behind one injected fetch
 * (requests recorded, answers scripted), the outbound queue as the fallback, a recording logger, and a driver that moves
 * a fake clock until a promise settles.
 */
import type { LogFields, Logger } from "@primusclaw/personal-agent";
import type { JsonObject } from "../../src/cards/json.js";
import { ConnectorOutbox } from "../../src/connector/outbox.js";
import type { ConnectorLimits } from "../../src/connector/limits.js";
import { ImdsTokenProvider } from "../../src/connector/tokens/imds.js";
import type { Delivered, Outbox, PublishOptions, TeamsEnvelope } from "../../src/outbound/outbox.js";
import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";

export const CLIENT_ID = "00000000-0000-0000-0000-0000000000a1";
export const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
export const SECRET_TEXT = "the user's private question and the agent's answer";

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly host: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A scripted answer: a response, a function of the call (it may throw: a network error), or an error to throw. */
export type Answer = Response | Error | ((call: Call, n: number) => Response);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function pick(answers: readonly Answer[], n: number, call: Call): Response {
  const answer = answers[Math.min(n, answers.length) - 1];
  if (answer === undefined) throw new Error("no scripted answer");
  if (answer instanceof Error) throw answer;
  return typeof answer === "function" ? answer(call, n) : answer.clone();
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/** IMDS, Entra ID and the Bot Connector behind one fetch. */
export class FakeTeams {
  readonly imds: Call[] = [];
  readonly tokenRequests: Call[] = [];
  /** What reached the Connector, in arrival order. */
  readonly calls: Call[] = [];
  /** The texts in the order the Connector finished them (what Teams shows). */
  readonly committed: string[] = [];
  imdsStatus = 200;
  imdsDelayMs = 0;
  /** IMDS answers by call number (overrides `imdsStatus` while it lasts). */
  imdsStatuses: number[] = [];
  expiresIn = 86399;
  answers: Answer[] = [json(201, { id: "teams-1" })];
  /** Entra's answers in turn (the last repeats); undefined: a fresh token. */
  entra: (Answer | undefined)[] = [undefined];
  delayMs: (call: Call) => number = () => 0;
  minted = 0;

  constructor(readonly clock: FakeClock) {}

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const call: Call = {
      method: init?.method ?? "GET",
      url: url.toString(),
      host: url.hostname,
      headers: headersOf(init),
      body: typeof init?.body === "string" ? init.body : "",
    };
    const signal = init?.signal ?? undefined;
    if (url.hostname === "169.254.169.254") return this.imdsAnswer(call, signal);
    if (url.hostname === "login.microsoftonline.com") return this.entraAnswer(call);
    this.calls.push(call);
    const delay = this.delayMs(call);
    if (delay > 0) await this.clock.sleep(delay, signal);
    signal?.throwIfAborted();
    const text = call.body ? (JSON.parse(call.body) as JsonObject)["text"] : ""; // (a delete has no body)
    this.committed.push(typeof text === "string" ? text : JSON.stringify(text ?? null));
    return pick(this.answers, this.calls.length, call);
  }) as typeof fetch;

  private async imdsAnswer(call: Call, signal: AbortSignal | undefined): Promise<Response> {
    this.imds.push(call);
    if (this.imdsDelayMs > 0) await this.clock.sleep(this.imdsDelayMs, signal);
    const status = this.imdsStatuses[this.imds.length - 1] ?? this.imdsStatus;
    if (status !== 200) return json(status, { error: "identity_not_found" });
    this.minted += 1;
    return json(200, { access_token: `token-${String(this.minted)}`, expires_in: String(this.expiresIn) });
  }

  private entraAnswer(call: Call): Response {
    this.tokenRequests.push(call);
    const answer = this.entra[Math.min(this.tokenRequests.length, this.entra.length) - 1];
    if (answer !== undefined) return pick([answer], 1, call);
    this.minted += 1;
    return json(200, {
      token_type: "Bearer",
      expires_in: this.expiresIn,
      access_token: `fed-token-${String(this.minted)}`,
    });
  }

  bodies(): JsonObject[] {
    return this.calls.map((c) => JSON.parse(c.body) as JsonObject);
  }

  /** The form of the `i`th token request. */
  form(i = 0): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(this.tokenRequests[i]?.body ?? ""));
  }
}

/** The fallback: records envelopes (and the options they came with). */
export class Queue implements Outbox {
  readonly sent: TeamsEnvelope[] = [];
  readonly options: (PublishOptions | undefined)[] = [];
  constructor(private readonly fail = false) {}

  publish(envelope: TeamsEnvelope, options?: PublishOptions): Promise<Delivered | undefined> {
    if (this.fail) return Promise.reject(new Error("the queue refused the send"));
    this.sent.push(envelope);
    this.options.push(options);
    return Promise.resolve(undefined);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  texts(): unknown[] {
    return this.sent.map((e) => e.activity["text"]);
  }
}

export interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

export class RecordingLogger implements Logger {
  constructor(readonly records: LogRecord[] = []) {}
  debug(message: string, fields: LogFields = {}): void {
    this.records.push({ level: "debug", message, fields });
  }
  info(message: string, fields: LogFields = {}): void {
    this.records.push({ level: "info", message, fields });
  }
  warn(message: string, fields: LogFields = {}): void {
    this.records.push({ level: "warn", message, fields });
  }
  error(message: string, fields: LogFields = {}): void {
    this.records.push({ level: "error", message, fields });
  }
  child(): Logger {
    return this;
  }
  /** Every record as one line of text (message and fields). */
  text(): string {
    return this.records.map((r) => `${r.message} ${JSON.stringify(r.fields)}`).join("\n");
  }
}

/** Await `work`, moving `clock` forward in small steps whenever nothing else can happen (sleeps fire at their due time). */
export async function settle<T>(clock: FakeClock, work: Promise<T>, stepMs = 50, maxSteps = 20_000): Promise<T> {
  const state = { done: false };
  work.then(
    () => (state.done = true),
    () => (state.done = true),
  );
  for (let i = 0; i < maxSteps; i++) {
    await flushMicrotasks();
    if (state.done) return work;
    await clock.advance(stepMs);
  }
  throw new Error("settle: the work never finished");
}

export function reference(conversation = "19:abc@thread.v2", serviceUrl = SERVICE_URL): JsonObject {
  return {
    serviceUrl,
    conversation: { id: conversation },
    bot: { id: "28:bot" },
    user: { id: "29:user", aadObjectId: "aad-1" },
    activityId: "root-1",
    channelId: "msteams",
  };
}

export function textActivity(text: string): JsonObject {
  return { type: "message", text, textFormat: "markdown" };
}

export function envelope(
  text = "hi",
  options: { operation?: TeamsEnvelope["operation"]; ref?: JsonObject; activityId?: string; ack?: string } = {},
): TeamsEnvelope {
  const out: TeamsEnvelope = {
    operation: options.operation ?? "send",
    reference: options.ref ?? reference(),
    activity: textActivity(text),
  };
  if (options.activityId) out.activity_id = options.activityId;
  if (options.ack) out.ack = options.ack;
  return out;
}

export function deleteEnvelope(ref: JsonObject, activityId: string): TeamsEnvelope {
  return { operation: "delete", reference: ref, activity: { type: "message" }, activity_id: activityId };
}

export interface Built {
  readonly outbox: ConnectorOutbox;
  readonly teams: FakeTeams;
  readonly queue: Queue;
  readonly clock: FakeClock;
  /** The backoff waits, in seconds. */
  readonly slept: number[];
  readonly logger: RecordingLogger;
}

export function build(
  options: { teams?: FakeTeams; queue?: Queue; clock?: FakeClock; limits?: Partial<ConnectorLimits> } = {},
): Built {
  const clock = options.clock ?? options.teams?.clock ?? new FakeClock();
  const teams = options.teams ?? new FakeTeams(clock);
  const queue = options.queue ?? new Queue();
  const logger = new RecordingLogger();
  const slept: number[] = [];
  const tokens = new ImdsTokenProvider(CLIENT_ID, { clock, fetch: teams.fetch, logger });
  const outbox = new ConnectorOutbox({
    tokens,
    fallback: queue,
    clock,
    fetch: teams.fetch,
    logger,
    sleep: (ms, signal) => {
      slept.push(ms / 1000);
      return clock.sleep(ms, signal);
    },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { outbox, teams, queue, clock, slept, logger };
}
