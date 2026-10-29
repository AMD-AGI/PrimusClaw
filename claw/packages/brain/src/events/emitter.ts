// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { connect, JetStreamClient, NatsConnection, StringCodec, type ConnectionOptions } from "nats";
import { eventSubject } from "@claw/protocol";
import { NATS_USER, NATS_PASSWORD } from "../config.js";
import pino from "pino";

const sc = StringCodec();
const logger = pino({ name: "nats-emitter" });

/** Strip unpaired Unicode surrogates that break PG jsonb. */
function sanitizeJson(str: string): string {
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
            .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** Publishes events via JetStream for persistence + real-time SSE delivery. */
export class NatsEmitter {
  private js!: JetStreamClient;
  nc!: NatsConnection;

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
   */
  async emit(sessionId: string, event: Record<string, unknown>, opts: { msgID?: string } = {}): Promise<void> {
    const subject = eventSubject(sessionId);
    const payload = sc.encode(sanitizeJson(JSON.stringify(event)));
    await this.js.publish(subject, payload, opts.msgID ? { msgID: opts.msgID } : undefined);
    logger.info({ sessionId, subject, type: event.type }, "emit.published");
  }
}
