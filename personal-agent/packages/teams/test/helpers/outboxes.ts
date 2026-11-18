// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Fake outboxes for the messenger's tests: a queue that records envelopes (and can ack them), and a direct one. */
import {
  DeleteUnsupportedError,
  type Delivered,
  type DirectOutbox,
  type Outbox,
  type PublishOptions,
  type TeamsEnvelope,
} from "../../src/outbound/outbox.js";
import type { AckRegistry } from "../../src/messenger/acks.js";

export class RecordingQueue implements Outbox {
  readonly sent: TeamsEnvelope[] = [];
  /** Ack each envelope that asks for one with this id (undefined: never). */
  ackWith: string | undefined;
  /** Every publish first waits for this. */
  delay: () => Promise<void> = () => Promise.resolve();

  constructor(private readonly acks?: AckRegistry) {}

  async publish(envelope: TeamsEnvelope, options: PublishOptions = {}): Promise<Delivered | undefined> {
    if (envelope.operation === "delete") throw new DeleteUnsupportedError("the outbound queue cannot delete a message");
    await this.delay();
    options.signal?.throwIfAborted();
    this.sent.push(envelope);
    const ack = envelope.ack;
    if (ack && this.acks && this.ackWith !== undefined) {
      const id = this.ackWith;
      queueMicrotask(() => {
        this.acks?.resolve(ack, id);
      });
    }
    return undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class RecordingDirect extends RecordingQueue implements DirectOutbox {
  readonly streamed: TeamsEnvelope[] = [];
  private n = 0;
  /** What each stream request is answered with (an error to throw, or the id); default: a new id for the first. */
  answerStream: (envelope: TeamsEnvelope, n: number) => string | undefined | Error = (_e, n) =>
    n === 1 ? "stream-1" : undefined;

  override async publish(envelope: TeamsEnvelope, options: PublishOptions = {}): Promise<Delivered | undefined> {
    if (envelope.operation === "delete") {
      this.sent.push(envelope);
      return { activityId: envelope.activity_id };
    }
    await super.publish(envelope, options);
    this.n += 1;
    return { activityId: `teams-${String(this.n)}` };
  }

  publishStream(envelope: TeamsEnvelope): Promise<Delivered> {
    this.streamed.push(envelope);
    const answer = this.answerStream(envelope, this.streamed.length);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ activityId: answer });
  }

  openPersonal(): Promise<string> {
    return Promise.resolve("a:personal");
  }

  listMembers(): Promise<never[]> {
    return Promise.resolve([]);
  }
}
