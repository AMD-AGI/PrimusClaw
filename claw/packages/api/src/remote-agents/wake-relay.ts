// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Carries a `Waker`'s wake-ups to the other API replicas, through Postgres `LISTEN`/`NOTIFY`.
 *
 * A stream is asleep in its idle poll on whichever replica its client reached; the write that should wake it (a connector's
 * events, a person's prompt) reaches any replica behind the same Service. Without this only a write through the same process
 * woke it, so with four replicas three writes in four waited for the next poll: an agent's answer reached a Teams chat a whole
 * poll (5 s) after the prompt, measured on the live fleet. Every wake is now also sent as one `pg_notify` on `WAKE_CHANNEL`, and
 * every replica listens on it and wakes its own streams on that key.
 *
 * It only shortens the wait, as the waker does. A notification is sent after the write it announces has committed (the waker is
 * rung after the store returns), so a woken stream finds the row; one that is lost, or sent while a replica's listener is
 * reconnecting, costs that replica's streams their next poll and nothing else, and a listener that comes back wakes all of its
 * streams once to cover the gap. Postgres is the one service every replica already shares, so this needs no other.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import pino from "pino";
import type { Waker } from "./waker.js";

const logger = pino({ name: "remote-agents" });

/** The notification channel. Per database, so two deployments on one server never hear each other. */
export const WAKE_CHANNEL = "claw_remote_agents_wake";

/** A payload is `<origin> <key>`; Postgres refuses one of 8000 bytes or more, and a key is a prefix and a UUID. */
const MAX_KEY_LENGTH = 200;

export interface WakeRelayOptions {
  /** A new, unconnected client for the listener (`infra/db.ts` `dedicatedClient`). */
  client: () => pg.Client;
  /** Runs one statement on any connection (`db.query`): how the wakes are sent. */
  query: (text: string, params?: unknown[]) => Promise<unknown>;
  /** First wait before the listener reconnects; doubled up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

export interface WakeRelay {
  /** Resolves when the listener is listening (or, failing that, has failed once and is retrying). */
  ready: Promise<void>;
  stop(): Promise<void>;
}

/** Relay `waker`'s wakes to every other replica, and theirs to it, until `stop`. */
export function startWakeRelay(waker: Waker, opts: WakeRelayOptions): WakeRelay {
  const origin = randomUUID();
  const retryMs = opts.retryMs ?? 1_000;
  const maxRetryMs = opts.maxRetryMs ?? 30_000;
  let stopped = false;
  let client: pg.Client | undefined;
  let timer: NodeJS.Timeout | undefined;
  let backoff = retryMs;
  let listenedOnce = false;

  // Outgoing: the keys woken in one turn of the event loop go out as one statement, each once.
  let pending = new Set<string>();
  let flushing = false;
  const flush = () => {
    flushing = false;
    const keys = [...pending];
    pending = new Set();
    if (!keys.length || stopped) return;
    opts.query("SELECT pg_notify($1, p) FROM unnest($2::text[]) AS p", [WAKE_CHANNEL, keys.map((k) => `${origin} ${k}`)])
      .catch((err) => logger.warn({ err: (err as Error)?.message, keys: keys.length }, "remote_agents.wake_relay_send_failed"));
  };
  waker.setRelay((key) => {
    if (stopped || key.length > MAX_KEY_LENGTH) return;
    pending.add(key);
    if (!flushing) { flushing = true; setImmediate(flush); }
  });

  // Incoming: another replica's wake, rung here. Our own were rung here already.
  const onNotification = (msg: pg.Notification) => {
    if (msg.channel !== WAKE_CHANNEL || !msg.payload) return;
    const space = msg.payload.indexOf(" ");
    if (space < 0 || msg.payload.slice(0, space) === origin) return;
    waker.wakeHere(msg.payload.slice(space + 1));
  };

  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => { markReady = resolve; });

  const retry = (c: pg.Client, err?: unknown) => {
    if (client !== c) return;
    client = undefined;
    c.removeAllListeners("notification");
    c.end().catch(() => {});
    if (stopped) return;
    logger.warn({ err: (err as Error | undefined)?.message, retryMs: backoff }, "remote_agents.wake_relay_lost");
    timer = setTimeout(listen, backoff);
    timer.unref();
    backoff = Math.min(backoff * 2, maxRetryMs);
  };

  async function listen(): Promise<void> {
    if (stopped) return;
    const c = opts.client();
    client = c;
    c.on("error", (err) => retry(c, err));
    c.on("end", () => retry(c));
    c.on("notification", onNotification);
    try {
      await c.connect();
      await c.query(`LISTEN ${WAKE_CHANNEL}`);
    } catch (err) {
      retry(c, err);
      markReady();
      return;
    }
    if (stopped || client !== c) return;
    backoff = retryMs;
    // Whatever was written while nothing listened is read now rather than at each stream's next poll.
    if (listenedOnce) waker.wakeAll();
    listenedOnce = true;
    logger.info({}, "remote_agents.wake_relay_listening");
    markReady();
  }
  void listen();

  return {
    ready,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      waker.setRelay(undefined);
      const c = client;
      client = undefined;
      if (c) {
        c.removeAllListeners("notification");
        await c.end().catch(() => {});
      }
    },
  };
}
