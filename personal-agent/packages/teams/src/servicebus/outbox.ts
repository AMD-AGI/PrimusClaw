// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The outbound queue: envelopes handed to Service Bus, which the relay Function posts to Teams (send, reply and update;
 * it has no delete). A sender that has sat idle for minutes is dropped by the broker without the client noticing (the
 * first send on it fails and the person waits for the SDK to reconnect), so past IDLE_REOPEN_MS it is replaced first.
 */
import type { Clock, Logger } from "@primusclaw/personal-agent";
import { errorName, pyJsonDumps, silentLogger } from "@primusclaw/personal-agent";

import {
  DeleteUnsupportedError,
  type Delivered,
  type Outbox,
  type PublishOptions,
  type TeamsEnvelope,
} from "../outbound/outbox.js";
import { Mutex } from "../stream/mutex.js";
import type { BusClient, BusSender } from "./client.js";

export const IDLE_REOPEN_MS = 240_000;

export class ServiceBusOutbox implements Outbox {
  private sender: BusSender;
  private usedAt: number;
  private readonly lock = new Mutex(); // (a sender is never replaced while another send is using it)
  private readonly logger: Logger;

  constructor(
    private readonly client: BusClient,
    private readonly queue: string,
    private readonly clock: Clock,
    logger?: Logger,
  ) {
    this.sender = client.sender(queue);
    this.usedAt = clock.monotonicMs();
    this.logger = logger ?? silentLogger;
  }

  publish(envelope: TeamsEnvelope, options: PublishOptions = {}): Promise<Delivered | undefined> {
    if (envelope.operation === "delete") {
      return Promise.reject(new DeleteUnsupportedError("the outbound queue cannot delete a message"));
    }
    // (the queue's body is the envelope as the Python worker wrote it: json.dumps, ", " and ": " separators)
    const body = Buffer.from(pyJsonDumps(envelope), "utf8");
    return this.lock.run(async () => {
      options.signal?.throwIfAborted();
      const idle = this.clock.monotonicMs() - this.usedAt;
      if (idle > IDLE_REOPEN_MS) {
        this.logger.info("outbound sender idle; replacing it before the send", { idleMs: idle });
        await this.replaceSender();
      }
      await this.sender.send({ body, contentType: "application/json" });
      this.usedAt = this.clock.monotonicMs();
      return undefined;
    });
  }

  private async replaceSender(): Promise<void> {
    const stale = this.sender;
    this.sender = this.client.sender(this.queue);
    try {
      await stale.close();
    } catch (error) {
      // (the connection is already gone, which is why it is being replaced)
      this.logger.info("closing the idle outbound sender failed", { error: errorName(error) });
    }
  }

  async close(): Promise<void> {
    await this.sender.close();
    await this.client.close();
  }
}
