// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One session delete, three Brain replicas: who does what.
 *
 * Every replica used to run the whole teardown off one plain `cleanup.*`
 * subscription, so production logged each `session.cleanup_incomplete_parked`
 * three times (once per replica, same session, same millisecond) and SaFE was
 * listed three times per delete. The local half -- aborting the session's runs,
 * dropping this process's tokens and keepalive registration -- still has to
 * reach every replica; the platform teardown has to happen once.
 *
 * The broker below delivers the way NATS core does: every plain subscription
 * gets every message, and each queue group gets it once, on one member.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  installSessionCleanupSubscribers,
  SESSION_CLEANUP_QUEUE,
  type CleanupMessage,
} from "../src/sandbox/session-cleanup-subscriber.js";

class Inbox implements AsyncIterable<CleanupMessage> {
  private items: CleanupMessage[] = [];
  private waiting: ((r: IteratorResult<CleanupMessage>) => void) | null = null;
  push(msg: CleanupMessage): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }
  [Symbol.asyncIterator](): AsyncIterator<CleanupMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

class Broker {
  private subs: Array<{ subject: string; queue?: string; inbox: Inbox }> = [];
  private turn = new Map<string, number>();
  subscribe(subject: string, opts?: { queue?: string }): Inbox {
    const inbox = new Inbox();
    this.subs.push({ subject, queue: opts?.queue, inbox });
    return inbox;
  }
  publish(subject: string, data: Uint8Array): void {
    const matches = this.subs.filter((s) => s.subject === "cleanup.*" && subject.startsWith("cleanup."));
    const groups = new Map<string, typeof matches>();
    for (const s of matches) {
      if (!s.queue) {
        s.inbox.push({ subject, data });
        continue;
      }
      groups.set(s.queue, [...(groups.get(s.queue) ?? []), s]);
    }
    for (const [queue, members] of groups) {
      const n = this.turn.get(queue) ?? 0;
      this.turn.set(queue, n + 1);
      members[n % members.length].inbox.push({ subject, data });
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function replicas(broker: Broker, count: number, opts: { forgetThrowsFor?: string } = {}) {
  const forgot: Array<{ replica: number; sid: string }> = [];
  const tornDown: Array<{ replica: number; sid: string; payload: string }> = [];
  const errors: Array<{ replica: number; sid: string; half: string }> = [];
  for (let replica = 0; replica < count; replica++) {
    installSessionCleanupSubscribers({
      subscribe: (subject, o) => broker.subscribe(subject, o),
      forget: async (sid) => {
        if (sid === opts.forgetThrowsFor) throw new Error("abort failed");
        forgot.push({ replica, sid });
      },
      teardown: async (sid, payload) => { tornDown.push({ replica, sid, payload: new TextDecoder().decode(payload) }); },
      onError: (_err, sid, half) => { errors.push({ replica, sid, half }); },
    });
  }
  return { forgot, tornDown, errors };
}

test("every replica forgets a deleted session, and exactly one tears it down", async () => {
  const broker = new Broker();
  const r = replicas(broker, 3);

  broker.publish("cleanup.s1", new TextEncoder().encode('{"platformKey":"k"}'));
  broker.publish("cleanup.s2", new TextEncoder().encode(""));
  await settle();

  assert.deepEqual(r.forgot.filter((f) => f.sid === "s1").map((f) => f.replica).sort(), [0, 1, 2]);
  assert.deepEqual(r.forgot.filter((f) => f.sid === "s2").map((f) => f.replica).sort(), [0, 1, 2]);
  assert.deepEqual(r.tornDown.map((d) => d.sid).sort(), ["s1", "s2"], "one teardown per session, not one per replica");
  assert.equal(r.tornDown.find((d) => d.sid === "s1")?.payload, '{"platformKey":"k"}', "the payload reaches the teardown");
});

test("the teardown subscription is a queue group and the forget subscription is not", () => {
  const seen: Array<{ subject: string; queue?: string }> = [];
  installSessionCleanupSubscribers({
    subscribe: (subject, o) => { seen.push({ subject, queue: o?.queue }); return new Inbox(); },
    forget: async () => {},
    teardown: async () => {},
    onError: () => {},
  });
  assert.deepEqual(seen, [
    { subject: "cleanup.*", queue: undefined },
    { subject: "cleanup.*", queue: SESSION_CLEANUP_QUEUE },
  ]);
});

test("a failure on one session neither ends the loop nor skips the teardown", async () => {
  const broker = new Broker();
  const r = replicas(broker, 2, { forgetThrowsFor: "bad" });

  broker.publish("cleanup.bad", new Uint8Array());
  broker.publish("cleanup.good", new Uint8Array());
  await settle();

  assert.equal(r.errors.filter((e) => e.sid === "bad" && e.half === "forget").length, 2);
  assert.deepEqual(r.forgot.filter((f) => f.sid === "good").map((f) => f.replica).sort(), [0, 1]);
  assert.deepEqual(r.tornDown.map((d) => d.sid).sort(), ["bad", "good"]);
});
