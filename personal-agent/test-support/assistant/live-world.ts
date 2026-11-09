// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A 1:1 message to the assistant and its reply in one world (the Python `live_turn`): the assistant's chat opens the receipt and
 * follows the turn's live stream into it; what Claw posts back is delivered by the real `Proactive`, on the same store, clock,
 * receipts and conversation, so the reply closes that receipt.
 */
import type { JsonObject } from "@primusclaw/personal-agent";

import { world as proactiveWorld } from "./proactive-world.js";
import type { Recorded } from "../surface.js";
import { flushMicrotasks } from "../clock.js";
import { ALICE, AssistantWorld, type AssistantWorldOptions } from "./assistant-world.js";

export async function liveWorld(options: AssistantWorldOptions = {}) {
  const w = await AssistantWorld.start(options);
  const p = proactiveWorld({
    on: { store: w.store, clock: w.clock },
    receipts: w.receipts,
    conversationFor: () => w.conversation(ALICE),
  });
  return {
    w,
    p,
    /** What Claw posts for Alice, as the endpoint hands it over. */
    push: (event: JsonObject) => p.proactive.handle(ALICE, w.reference(ALICE), event),
    /** A live event of the turn answering `messageId`, let run through. */
    live: async (name: string, data: JsonObject, messageId = "msg-1") => {
      w.feed.push(name, { message_id: messageId, ...data });
      await flushMicrotasks();
    },
  };
}

/** The texts of one kind of the receipt's stream: "open" (its first status), "inform" (status) or "emit" (streamed words). */
export function streamed(outbox: readonly Recorded[], kind: "open" | "inform" | "emit"): string[] {
  return outbox.flatMap((r) => (r.op === `stream.${kind}` && "text" in r ? [r.text] : []));
}

/** The receipt's final messages. */
export function finals(outbox: readonly Recorded[]) {
  return outbox.flatMap((r) => (r.op === "stream.finish" ? [r.message] : []));
}

/** The messages sent or posted on their own (not through the receipt). */
export function sent(outbox: readonly Recorded[]) {
  return outbox.flatMap((r) => (r.op === "send" || r.op === "post" ? [r.message] : []));
}
