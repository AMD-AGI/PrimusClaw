// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The Stop card's less common paths: a card that cannot be sent or deleted, a pressed card, and the cap on tokens. */

import assert from "node:assert/strict";
import { it } from "node:test";

import { SeededRandom } from "../../../../test-support/random.js";
import type { DeleteUnsupported, MessageId, OutMessage } from "../../src/ports/surface.js";
import { err, ok, type Result } from "../../src/result.js";
import { OFFERS_MAX, StopButtons } from "../../src/turn/stop-buttons.js";
import { Timeline } from "./timeline.js";
import { RecordingLogger } from "./world.js";

const alive = (): Promise<boolean> => Promise.resolve(true);

function chat(behaviour: { post?: "throws"; delete?: "refused" | "throws" } = {}) {
  const deletes: string[] = [];
  let n = 0;
  return {
    deletes,
    post(message: OutMessage): Promise<MessageId | undefined> {
      assert.equal(message.body.type, "view");
      n += 1;
      return behaviour.post === "throws" ? Promise.reject(new Error("down")) : Promise.resolve(`card-${String(n)}`);
    },
    delete(id: string): Promise<Result<void, DeleteUnsupported>> {
      deletes.push(id);
      if (behaviour.delete === "throws") return Promise.reject(new Error("down"));
      if (behaviour.delete === "refused") return Promise.resolve(err({ kind: "delete_unsupported", reason: "queue" }));
      return Promise.resolve(ok(undefined));
    },
  };
}

function buttons(clock: Timeline, log = new RecordingLogger()) {
  return new StopButtons({ clock, random: new SeededRandom(7), log, delaySeconds: 0 });
}

it("a card that cannot be sent is logged and its token still known, and a card that cannot be deleted is only logged", async () => {
  const clock = new Timeline();
  const log = new RecordingLogger();
  const b = buttons(clock, log);
  const offer = b.offer(
    "aad-a",
    "session",
    chat({ post: "throws" }),
    "en",
    alive,
    Promise.resolve().then(() => clock.sleep(10_000)),
  );
  await clock.pump(b.drain());
  assert.equal(b.get(offer.token, "aad-a"), offer);
  assert.equal(offer.cardId, undefined);
  assert.ok(log.lines.some((l) => l.message === "the Stop card of a turn from a phone could not be sent"));
  for (const behaviour of ["refused", "throws"] as const) {
    const c = chat({ delete: behaviour });
    b.offer("aad-a", "session", c, "en", alive, clock.sleep(10_000));
    await clock.pump(b.drain());
    assert.deepEqual(c.deletes, ["card-1"], behaviour);
  }
  assert.equal(log.lines.filter((l) => l.message === "the Stop card of an ended turn could not be deleted").length, 2);
});

it("a pressed card is not deleted again when its turn ends", async () => {
  const clock = new Timeline();
  const b = buttons(clock);
  const c = chat();
  const offer = b.offer("aad-a", "session", c, "en", alive, clock.sleep(10_000));
  await clock.advanceTo(clock.now + 1);
  offer.used = true;
  await clock.pump(b.drain());
  assert.deepEqual(c.deletes, []);
});

it("at most OFFERS_MAX tokens are kept, the oldest going first", async () => {
  const clock = new Timeline();
  const b = buttons(clock);
  const c = chat();
  let end = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const offers = Array.from({ length: OFFERS_MAX }, () => b.offer("aad-a", "assistant", c, "en", alive, ended));
  await clock.advanceTo(clock.now + 1);
  b.offer("aad-a", "assistant", c, "en", alive, ended);
  assert.equal(b.get(offers[0]?.token ?? "", "aad-a"), undefined);
  assert.equal(b.get(offers[1]?.token ?? "", "aad-a"), offers[1]);
  end();
  await clock.pump(b.drain());
});
