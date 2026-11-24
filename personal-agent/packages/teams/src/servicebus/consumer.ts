// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The inbound queue: several receivers, each taking the next conversation session that has messages and handling them in
 * order until the session has been quiet for IDLE_MS. A body that is not a JSON object is dead-lettered at once (it can never
 * succeed); a handler failure abandons the message, so the broker redelivers it and, after its maximum delivery count,
 * dead-letters it. Either way the session moves on: one poison message never blocks a conversation. Every message taken
 * gets one line (`inbound message`): its id, what came of it (completed, abandoned, dead_lettered), how long it waited in
 * the queue and how long it took; never its body. For an activity that decodes, the line also says when the client sent it
 * (`clientTiming`), so a message that reached Teams late can be told apart from one the person sent late.
 *
 * Stopping (the pod's SIGTERM, a cutover) drains: no session is taken any more and the waits for one or for the next
 * message end at once; a message being handled is finished and settled; a message that arrives after the stop is
 * abandoned (outcome `released`), and every session is closed, so its lock is released and the next worker takes its
 * messages without waiting for the lock to expire. Nothing taken is left unsettled on purpose.
 *
 * A call on the broker that hangs (a dead AMQP connection the SDK does not notice: the ingress met one, #896) is given up
 * after its deadline: the receiver is dropped, a new connection opened (`BusClient.reopen`), and the session taken again,
 * so a wedged receiver re-arms itself instead of leaving its conversations waiting (`inbound receiver re-armed`). The old
 * connection is closed only once no receiver still holds a session taken on it: another receiver may be handling a message
 * there, and closing the connection under it would drop its session lock, so the broker would hand the same message to a
 * receiver on the new connection while the first is still handling it (a duplicate reply).
 *
 * A session is held for at most SESSION_HOLD_MS of messages: then it is closed and taken again, so the lock renewal of
 * the bus client (which must outlast that hold, plus the wait for one more message, plus the longest message handled)
 * never runs out while a message is in hand; a lapsed lock would hand that message to another receiver (a duplicate).
 */
import type { Clock, Logger } from "@primusclaw/personal-agent";
import { errorName, silentLogger } from "@primusclaw/personal-agent";

import { isObject, type JsonObject } from "../cards/json.js";
import type { BusClient, Received, SessionReceiver } from "./client.js";

/** A session that has had no message for this long is released for the next one. */
export const IDLE_MS = 20_000;
/** After an error of the broker (not the idle timeout), wait this long before trying again. */
export const BACKOFF_MS = 3_000;
/** After finding no session with messages, wait this long before asking again. */
export const NO_SESSION_PAUSE_MS = 1_000;
/**
 * A call for the next session that has not answered in this long is on a wedged connection. The SDK gives up on it by
 * itself after its operation timeout (60 s), with the documented ServiceTimeout, when no session has messages.
 */
export const ACCEPT_DEADLINE_MS = 120_000;
/** A wait for the next message (at most IDLE_MS) that has not ended this much later is on a wedged connection. */
export const RECEIVE_DEADLINE_MS = IDLE_MS + 40_000;
/** A settlement (the SDK retries one itself) or a close that has not ended in this long is on a wedged connection. */
export const SETTLE_DEADLINE_MS = 60_000;
/**
 * A receiver that has held one session this long takes no further message from it: it closes the session, and the next
 * accept takes it (or another) again. The session's lock is renewed for a bounded time from the accept (the bus client's
 * lock renewal), so a busy conversation never keeps one lock past that bound while its messages keep coming.
 */
export const SESSION_HOLD_MS = 4 * 60_000;

/** What the handled messages are counted in: how long each waited in the queue and took to handle. */
export interface InboundStats {
  processed(queueLagMs: number | undefined, handleMs: number, ok: boolean): void;
  /** A call on the broker hung and the receivers' connection was re-opened (once per connection, however many hung). */
  rearmed?(): void;
}

/** A call on the broker that did not answer within its deadline. */
export class WedgedCall extends Error {
  override name = "WedgedCall";
  constructor(readonly call: string) {
    super(`${call} did not answer in time`);
  }
}

/** Whether a broker error is the documented "no session has messages" timeout of acceptNextSession. */
export function isIdleTimeout(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ServiceTimeout" || code === "SessionCannotBeLocked";
}

/**
 * How long `message` waited in the queue before the worker took it: from the broker's enqueue time to the start of
 * handling (now, less `handleMs`). undefined when the broker gave no enqueue time. A growing lag is the queue backing up.
 */
export function queueLagMs(message: Received, nowEpochMs: number, handleMs = 0): number | undefined {
  if (!message.enqueuedAt) return undefined;
  return Math.max(Math.trunc(nowEpochMs - message.enqueuedAt.getTime()) - handleMs, 0);
}

/** A client lag beyond this is a wrong clock, not a held message: it is logged raw and not as `client_lag_ms`. */
export const MAX_CLIENT_LAG_MS = 24 * 60 * 60_000;

// An ISO 8601 date-time with an explicit zone, as Teams writes `timestamp` ("...T07:00:16.1234567Z") and
// `localTimestamp` ("...T15:00:00.123+08:00"). Only a value of this shape is logged, so no other text reaches the line.
const ISO_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
// The client's own id of the message, as a client may set it in channelData; only an id of these characters is logged.
const CLIENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CLIENT_ID_KEYS = ["clientActivityID", "clientActivityId", "clientmessageid", "clientMessageId"] as const;
// A Teams message id in a 1:1 chat ("1794985216123") is the epoch milliseconds at which the service took the message.
const EPOCH_MS_ID = /^\d{13}$/;

/** When the client sent an activity and when the service took it, as the activity says; every field may be absent. */
export interface ClientTiming {
  /** The activity's `localTimestamp`: the client's own clock when it sent the message, with its zone offset. */
  readonly client_ts?: string;
  /** The client's id of the message from `channelData`, when the client gave one. */
  readonly client_msg_id?: string;
  /** When the service took the message: the activity's `timestamp`, else the epoch milliseconds of a 1:1 message id. */
  readonly server_ts?: string;
  /** `server_ts` less `client_ts`, signed, as measured: negative when the client's clock runs ahead. */
  readonly client_lag_raw_ms?: number;
  /** The same lag when it can be one (0 to MAX_CLIENT_LAG_MS); absent when the clocks disagree beyond that. */
  readonly client_lag_ms?: number;
}

/** Epoch milliseconds of an ISO_TIME value; fractions past the millisecond are dropped. */
function isoEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_TIME.exec(value);
  if (!match) return undefined;
  const [, base, fraction = "", zone] = match;
  const ms = Date.parse(`${base}.${fraction.padEnd(3, "0").slice(0, 3)}${zone}`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * When `activity` was sent by the client and taken by the service, for the `inbound message` line. Teams sets
 * `timestamp` (the service's clock) and `localTimestamp` (the client's clock) on every message; the difference is how long
 * the client held the message, plus the skew between the two clocks. A difference below zero or above
 * MAX_CLIENT_LAG_MS is skew, so it is kept only as `client_lag_raw_ms`. Never reads the text or who sent it.
 */
export function clientTiming(activity: JsonObject): ClientTiming {
  const timing: { -readonly [K in keyof ClientTiming]: ClientTiming[K] } = {};
  const local = activity["localTimestamp"];
  const clientMs = isoEpochMs(local);
  if (clientMs !== undefined) timing.client_ts = local as string;
  const channelData = activity["channelData"];
  if (isObject(channelData)) {
    for (const key of CLIENT_ID_KEYS) {
      const id = channelData[key];
      if (typeof id === "string" && CLIENT_ID.test(id)) {
        timing.client_msg_id = id;
        break;
      }
    }
  }
  const stamp = activity["timestamp"];
  const id = activity["id"];
  let serverMs = isoEpochMs(stamp);
  if (serverMs !== undefined) timing.server_ts = stamp as string;
  else if (typeof id === "string" && EPOCH_MS_ID.test(id)) {
    serverMs = Number(id);
    timing.server_ts = new Date(serverMs).toISOString();
  }
  if (clientMs !== undefined && serverMs !== undefined) {
    const lag = serverMs - clientMs;
    timing.client_lag_raw_ms = lag;
    if (lag >= 0 && lag <= MAX_CLIENT_LAG_MS) timing.client_lag_ms = lag;
  }
  return timing;
}

export interface ConsumerParts {
  readonly client: BusClient;
  readonly queue: string;
  readonly handle: (activity: JsonObject) => Promise<void>;
  readonly receivers: number;
  readonly clock: Clock;
  readonly stats?: InboundStats;
  readonly logger?: Logger;
}

function decode(body: Uint8Array): JsonObject {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!isObject(parsed)) throw new SyntaxError("body is not a JSON object");
  return parsed;
}

export class InboundConsumer {
  private readonly stopping = new AbortController();
  private readonly logger: Logger;
  /** Which connection the receivers are on: a receiver re-opens it only if no other has since it took its session. */
  private generation = 0;
  /** How many receivers are in a pass on each connection (by generation): a session taken there may be in hand. */
  private readonly holders = new Map<number, number>();
  /** The close of each connection given up on, run once its last holder lets go. */
  private readonly retiring = new Map<number, () => Promise<void>>();

  constructor(private readonly parts: ConsumerParts) {
    this.logger = parts.logger ?? silentLogger;
  }

  /** (a method, not a getter: the stop comes between two reads, which a narrowed property would hide) */
  private isStopped(): boolean {
    return this.stopping.signal.aborted;
  }

  /** Run the receivers until `stop`; resolves once each has settled what it took and closed its session. */
  async run(): Promise<void> {
    await Promise.all(Array.from({ length: this.parts.receivers }, () => this.loop()));
  }

  /** Take nothing more: the waits end now, a message being handled is finished, and `run` resolves after the drain. */
  stop(): void {
    if (this.isStopped()) return;
    this.logger.info("inbound consumer stopping: draining the sessions it holds");
    this.stopping.abort(new DOMException("the worker is stopping", "AbortError"));
  }

  /**
   * `call`, given up as wedged (WedgedCall) when it has not answered within `ms`; with `stoppable`, ended (rejected) by
   * the stop too. The deadline is this consumer's own timer, so an SDK call that ignores its abort signal still ends.
   */
  private async within<T>(call: string, ms: number, work: Promise<T>, stoppable = false): Promise<T> {
    const timer = new AbortController();
    const signal = stoppable ? AbortSignal.any([timer.signal, this.stopping.signal]) : timer.signal;
    const deadline = this.parts.clock.sleep(ms, signal).then(
      () => {
        throw new WedgedCall(call);
      },
      (error: unknown) => {
        if (stoppable && this.isStopped()) throw error;
        return new Promise<never>(() => undefined); // (the call answered first: the deadline never settles the race)
      },
    );
    work.catch(() => undefined); // (a call given up on may still fail later; nobody waits for it then)
    try {
      return await Promise.race([work, deadline]);
    } finally {
      timer.abort();
    }
  }

  private async loop(): Promise<void> {
    while (!this.isStopped()) {
      const generation = this.generation;
      this.hold(generation);
      let failed: { error: unknown; rearmed: boolean } | undefined;
      try {
        failed = await this.pass(generation);
      } finally {
        this.letGo(generation);
      }
      if (failed !== undefined && !this.isStopped()) await this.pause(failed.error, generation, failed.rearmed);
    }
  }

  /** Take a session on the current connection and handle it until it goes quiet; what failed, for the pause after. */
  private async pass(generation: number): Promise<{ error: unknown; rearmed: boolean } | undefined> {
    let receiver: SessionReceiver;
    const accepting = this.parts.client.acceptNextSession(this.parts.queue, this.stopping.signal);
    try {
      receiver = await this.within("accept", ACCEPT_DEADLINE_MS, accepting, true);
    } catch (error) {
      // (a session the broker hands over after it was given up on is closed at once, so its lock is not held)
      accepting.then((late) => late.close()).catch(() => undefined);
      return { error, rearmed: false };
    }
    let failed: { error: unknown; rearmed: boolean } | undefined;
    try {
      await this.drain(receiver);
    } catch (error) {
      failed = { error, rearmed: true };
      // (a hung call opens a new connection first: closing a receiver on a wedged one would hang as well)
      if (error instanceof WedgedCall && !this.isStopped()) this.rearm(error.call, generation);
    }
    // (closed before any pause: the session's lock is released for whoever takes it next)
    await this.within("close", SETTLE_DEADLINE_MS, receiver.close()).catch((error: unknown) => {
      this.logger.info("closing a session receiver failed", { error: errorName(error) });
    });
    return failed;
  }

  private hold(generation: number): void {
    this.holders.set(generation, (this.holders.get(generation) ?? 0) + 1);
  }

  private letGo(generation: number): void {
    const left = (this.holders.get(generation) ?? 1) - 1;
    if (left > 0) this.holders.set(generation, left);
    else {
      this.holders.delete(generation);
      this.retire(generation);
    }
  }

  /** Close a connection given up on, once no receiver holds a session taken on it (a wedged close is not waited for). */
  private retire(generation: number): void {
    const close = this.retiring.get(generation);
    if (close === undefined || this.holders.has(generation)) return;
    this.retiring.delete(generation);
    void close().catch((error: unknown) => {
      this.logger.info("closing a re-opened inbound connection failed", { error: errorName(error) });
    });
  }

  private async pause(error: unknown, generation: number, rearmed = false): Promise<void> {
    if (isIdleTimeout(error)) {
      // (documented: accepting the next session times out when no session has messages)
      await this.parts.clock.sleep(NO_SESSION_PAUSE_MS, this.stopping.signal).catch(() => undefined);
      return;
    }
    if (!(error instanceof WedgedCall)) this.logger.warn("inbound receiver error", { error: errorName(error) });
    else if (!rearmed && !this.isStopped()) this.rearm(error.call, generation);
    await this.parts.clock.sleep(BACKOFF_MS, this.stopping.signal).catch(() => undefined);
  }

  /**
   * A call hung: a new connection is opened, once for all receivers that were on the old one, and the session taken
   * again. The old connection is closed when its last holder lets go (`retire`), not now: see the head of this file.
   */
  private rearm(call: string, generation: number): void {
    const reopen = this.parts.client.reopen?.bind(this.parts.client);
    const reopened = generation === this.generation && reopen !== undefined;
    if (reopened) {
      this.retiring.set(generation, reopen());
      this.generation += 1;
      this.retire(generation);
    }
    this.logger.warn("inbound receiver re-armed", { call, reopened });
    if (reopened || reopen === undefined) this.parts.stats?.rearmed?.();
  }

  private async drain(receiver: SessionReceiver): Promise<void> {
    const taken = this.parts.clock.monotonicMs();
    for (;;) {
      if (this.parts.clock.monotonicMs() - taken >= SESSION_HOLD_MS) return; // (closed, and taken again by the next accept)
      let messages: Received[];
      try {
        messages = await this.within(
          "receive",
          RECEIVE_DEADLINE_MS,
          receiver.receive(1, IDLE_MS, this.stopping.signal),
          true,
        );
      } catch (error) {
        if (this.isStopped()) return; // (an aborted wait took nothing; the session is closed and its lock released)
        throw error;
      }
      if (messages.length === 0) return;
      for (const message of messages) {
        if (this.isStopped()) await this.release(receiver, message);
        else await this.dispatch(receiver, message);
      }
      if (this.isStopped()) return;
    }
  }

  /** A message taken after the stop goes back to the queue at once, for the next worker. */
  private async release(receiver: SessionReceiver, message: Received): Promise<void> {
    this.logLine(message, "released", queueLagMs(message, this.parts.clock.epochMs()), 0);
    await this.within("abandon", SETTLE_DEADLINE_MS, receiver.abandon(message));
  }

  private async dispatch(receiver: SessionReceiver, message: Received): Promise<void> {
    let body: JsonObject;
    try {
      body = decode(message.body);
    } catch (error) {
      const why = error instanceof Error ? error.message : "undecodable";
      this.logLine(message, "dead_lettered", queueLagMs(message, this.parts.clock.epochMs()), 0);
      await this.within(
        "dead-letter",
        SETTLE_DEADLINE_MS,
        receiver.deadLetter(message, "malformed", Array.from(why).slice(0, 200).join("")),
      );
      return;
    }
    const timing = clientTiming(body); // (read before the handler, which may change the activity)
    const started = this.parts.clock.monotonicMs();
    try {
      await this.parts.handle(body);
    } catch (error) {
      this.logger.error("handler failed; abandoning for redelivery", { error: errorName(error) });
      this.record(message, timing, started, false);
      await this.within("abandon", SETTLE_DEADLINE_MS, receiver.abandon(message));
      return;
    }
    this.record(message, timing, started, true);
    await this.within("complete", SETTLE_DEADLINE_MS, receiver.complete(message));
  }

  private record(message: Received, timing: ClientTiming, started: number, ok: boolean): void {
    const handleMs = Math.trunc(this.parts.clock.monotonicMs() - started);
    const lag = queueLagMs(message, this.parts.clock.epochMs(), handleMs);
    this.logLine(message, ok ? "completed" : "abandoned", lag, handleMs, timing);
    this.parts.stats?.processed(lag, handleMs, ok);
  }

  /** The one line for a message taken: ids, outcome and times only. */
  private logLine(
    message: Received,
    outcome: string,
    lagMs: number | undefined,
    handleMs: number,
    timing: ClientTiming = {},
  ): void {
    this.logger.info("inbound message", {
      id: message.messageId,
      delivery: message.deliveryCount,
      outcome,
      lag_ms: lagMs,
      ms: handleMs,
      ...timing,
    });
  }
}
