// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One inbound queue message (or a body the gate's test entry posted), as the Python worker's `Agent.handle` took it: a
 * `primusclaw.delivered` ack from the relay settles the post that waits for it; a message or an invoke becomes core's
 * event and goes to the router; anything else is not for the worker. An activity that cannot be read is logged by its kind
 * of failure and dropped (a redelivery cannot make it readable).
 */
import type { InboundEvent, Logger } from "@primusclaw/personal-agent";
import { silentLogger } from "@primusclaw/personal-agent";

import { toInboundEvent } from "../activity/inbound/index.js";
import type { JsonObject } from "../cards/json.js";
import type { AckRegistry } from "../messenger/acks.js";

export const DELIVERED = "primusclaw.delivered";

export interface InboundParts {
  readonly acks: AckRegistry;
  readonly route: (event: InboundEvent) => Promise<void>;
  readonly botName: string;
  readonly logger?: Logger;
}

/** Python's `str(body.get(key) or "")` of an ack's field. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" && value !== 0 ? String(value) : "";
}

/** The handler of one inbound body. */
export function inboundHandler(parts: InboundParts): (body: JsonObject) => Promise<void> {
  const logger = parts.logger ?? silentLogger;
  return async (body) => {
    if (body["type"] === DELIVERED) {
      const activityId = text(body["activity_id"]);
      parts.acks.resolve(text(body["ack"]), activityId || undefined);
      return;
    }
    if (body["type"] !== "message" && body["type"] !== "invoke") return;
    const event = toInboundEvent(body, { botName: parts.botName, logger });
    if (!event.ok) {
      logger.warn("an inbound activity was not read", { why: event.error.kind });
      return;
    }
    if (event.value !== undefined) await parts.route(event.value);
  };
}
