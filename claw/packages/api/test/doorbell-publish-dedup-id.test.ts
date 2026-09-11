// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The dedup id the doorbell publish is made under.
 *
 * A doorbell is published at least once: the drain retries, and so does every
 * caller that could not tell whether its publish landed. What makes that safe
 * is the JetStream duplicate window, and the only thing that puts a message in
 * one is the `msgID` on the publish. Dropped, a retried publish is a second
 * message on the stream, two pods claim one chat turn, and the user watches
 * their turn answered twice.
 *
 * `js` is a module binding `initNats` assigns, so there is no seam to write to
 * and no NATS to publish at. The resolve hook swaps `../infra/nats.js` for this
 * file, and only for the import in `sessions/dispatch.ts`.
 */

import { registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

import { StringCodec } from "nats";
import { doorbellDedupId, taskSubject } from "@claw/protocol";

const DISPATCH_MODULE = new URL("../src/sessions/dispatch.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === DISPATCH_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const sc = StringCodec();

interface Published { subject: string; payload: string; msgID?: string }
const published: Published[] = [];

export const js = {
  async publish(
    subject: string, payload: Uint8Array, opts?: { msgID?: string },
  ): Promise<{ seq: number }> {
    published.push({
      subject, payload: new TextDecoder().decode(payload), msgID: opts?.msgID,
    });
    return { seq: published.length };
  },
};

export const nc = {
  publish(): void { /* the SSE fan-out is not what this case is about */ },
};

export function publishCertainlyFailed(): boolean {
  return false;
}

test("a doorbell is published inside the duplicate window that makes a retry one turn", async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  const dedupId = doorbellDedupId("s1", "claw-1700000000000");

  const seq = await sessionDispatchPorts.publishTask(taskSubject(), "{}", dedupId);

  assert.equal(seq, 1, "the sequence the row records its delivery against comes back");
  assert.deepEqual(
    published.map((m) => m.msgID), [dedupId],
    "a publish made outside the window turns a redelivered doorbell into a second run",
  );
});
