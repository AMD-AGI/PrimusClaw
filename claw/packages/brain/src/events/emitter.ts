// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { connect, JetStreamClient, NatsConnection, StringCodec, type ConnectionOptions } from "nats";
import { eventSubject } from "@claw/protocol";
import { NATS_USER, NATS_PASSWORD } from "../config.js";
import { isTransientNatsError } from "../infra/nats-transient.js";
import pino from "pino";

const sc = StringCodec();
const logger = pino({ name: "nats-emitter" });

/** Strip unpaired Unicode surrogates that break PG jsonb. */
function sanitizeJson(str: string): string {
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
            .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/**
 * How long to wait before each retry of a publish JetStream did not acknowledge.
 *
 * Sized against what was measured, not against a round number: on 2026-11-06 a
 * storage node rebooted under the R3 event stream, which then had no quorum
 * for about twenty seconds, and every publish in that window timed out after
 * the client's five. The sleeps here add up to a little over twenty-two
 * seconds, and with the publish timeouts between them a single event rides out
 * roughly a minute of stall before the error is allowed to reach the run --
 * where it is retryable (see isTransientNatsError), so even then the run is
 * re-delivered rather than failed.
 *
 * Exported so a test can pin the bound it relies on.
 */
export const EMIT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 3_000, 4_000, 5_000, 5_000];

/** A publish not sent because its sender stood down first (see `emit`'s `stillMine`). */
export class EmitStoodDownError extends Error {
  constructor(type: string) {
    super(`not published: ${type} (the run stood down)`);
    this.name = "EmitStoodDownError";
  }
}

/** Publishes events via JetStream for persistence + real-time SSE delivery. */
export class NatsEmitter {
  private js!: JetStreamClient;
  nc!: NatsConnection;
  /** Replaced by tests, so the retry schedule runs without wall-clock waits. */
  protected sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  async init(natsUrl: string): Promise<void> {
    const opts: ConnectionOptions = { servers: natsUrl };
    if (NATS_USER) {
      opts.user = NATS_USER;
      opts.pass = NATS_PASSWORD;
    }
    this.nc = await connect(opts);
    this.js = this.nc.jetstream();
    logger.info({ natsUrl, account: NATS_USER || "(default)" }, "nats-emitter.connected");
  }

  /**
   * `msgID` is JetStream's de-duplication key: the stream drops a second publish
   * with the same id inside its duplicate window, for the API consumer and for
   * every live subscriber alike.
   *
   * Every publish carries one, minted here when the caller has none, because a
   * publish that timed out may still have been stored: the PubAck is what got
   * lost, not necessarily the message. Retrying under the same id is what makes
   * the retry safe -- the stream keeps one copy whichever attempt landed -- and
   * the retries are what keep a short JetStream stall from failing the run that
   * was emitting. Only reachability errors are retried; anything else (a payload
   * over the limit, a permissions refusal) is thrown at once, as before.
   */
  /**
   * `stillMine`: asked before every attempt. A publish whose sender has since
   * stood down -- a completion for a run another brain may now hold -- is not
   * sent, or re-sent, after the answer turns false.
   */
  async emit(
    sessionId: string, event: Record<string, unknown>, opts: { msgID?: string; stillMine?: () => boolean } = {},
  ): Promise<void> {
    const subject = eventSubject(sessionId);
    const payload = sc.encode(sanitizeJson(JSON.stringify(event)));
    const msgID = opts.msgID ?? randomUUID();
    for (let attempt = 0; ; attempt++) {
      if (opts.stillMine && !opts.stillMine()) throw new EmitStoodDownError(String(event.type ?? ""));
      try {
        await this.js.publish(subject, payload, { msgID });
        break;
      } catch (err) {
        if (!isTransientNatsError(err) || attempt >= EMIT_RETRY_DELAYS_MS.length) throw err;
        logger.warn(
          { sessionId, type: event.type, attempt: attempt + 1, code: (err as { code?: string }).code },
          "emit.retry_transient",
        );
        await this.sleep(EMIT_RETRY_DELAYS_MS[attempt]!);
      }
    }
    logger.info({ sessionId, subject, type: event.type }, "emit.published");
  }
}
