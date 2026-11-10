// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The test entry's stand-ins for what production has behind the Bot Connector: no queue (a send the recording connector
 * did not take is dropped and logged; nothing of the gate reaches Service Bus or Teams) and a made-up bot token that goes
 * only to the recording connector.
 */
import type { Logger } from "@primusclaw/personal-agent";
import { silentLogger } from "@primusclaw/personal-agent";

import type { TokenSource } from "../connector/tokens/cached.js";
import { DeleteUnsupportedError, type Delivered, type Outbox, type TeamsEnvelope } from "../outbound/outbox.js";

export class NoQueue implements Outbox {
  constructor(private readonly logger: Logger = silentLogger) {}

  publish(envelope: TeamsEnvelope): Promise<Delivered | undefined> {
    if (envelope.operation === "delete") {
      return Promise.reject(new DeleteUnsupportedError("the gate's test entry has no queue"));
    }
    this.logger.warn("gate entry: a send the recording connector did not take is dropped (there is no queue)", {
      operation: envelope.operation,
    });
    return Promise.resolve(undefined);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** The bot's token in the test entry: made up, and sent only to the recording connector (its service-URL policy). */
export class GateToken implements TokenSource {
  private readonly token: string;

  constructor(runId: string) {
    this.token = `release-gate-${runId}-not-a-token`;
  }

  get(): Promise<string> {
    return Promise.resolve(this.token);
  }

  invalidate(): void {
    // (a made-up token never expires: there is nothing to forget)
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
