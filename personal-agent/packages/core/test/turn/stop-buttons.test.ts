// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Stop card of a turn from a phone (test_stop_button.py, the card on its own; internal #458): a quick turn gets no
 * card, one that runs on gets it and loses it at its end; a token is forgotten after its time.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { RecordingLogger } from "./world.js";
import { Timeline } from "./timeline.js";
import { OFFER_KEEP_SECONDS, StopButtons } from "../../src/turn/stop-buttons.js";
import type { OutMessage } from "../../src/ports/surface.js";
import { ok } from "../../src/result.js";
import { SeededRandom } from "../../../../test-support/random.js";

/** What the conversation was asked to do: posts (with the token their card carries) and deletes. */
function conversation(): {
  posts: Array<{ id: string; token: string }>;
  deletes: string[];
  post(m: OutMessage): Promise<string>;
  delete(id: string): Promise<ReturnType<typeof ok<undefined>>>;
} {
  const posts: Array<{ id: string; token: string }> = [];
  const deletes: string[] = [];
  return {
    posts,
    deletes,
    post(m) {
      const body = m.body;
      const token = body.type === "view" && body.view.name === "turnStop" ? body.view.model.token : "";
      const id = `card-${String(posts.length + 1)}`;
      posts.push({ id, token });
      return Promise.resolve(id);
    },
    delete(id) {
      deletes.push(id);
      return Promise.resolve(ok(undefined));
    },
  };
}

const alive = (): Promise<boolean> => Promise.resolve(true);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("test_a_turn_that_ends_before_the_delay_gets_no_card_and_one_that_runs_on_gets_it_and_loses_it_at_its_end", async () => {
  const clock = new Timeline();
  const buttons = new StopButtons({ clock, random: new SeededRandom(1), log: new RecordingLogger() });
  const chat = conversation();
  const quick = deferred();
  buttons.offer("aad-a", "session", chat, "zh", alive, quick.promise);
  quick.resolve();
  await clock.advanceTo(clock.start + 5);
  assert.equal(chat.posts.length, 0);
  const slow = deferred();
  const offer = buttons.offer("aad-a", "session", chat, "zh", alive, slow.promise);
  await clock.advanceTo(clock.now + 5);
  assert.deepEqual(
    chat.posts.map((p) => p.token),
    [offer.token],
  );
  assert.equal(buttons.get(offer.token, "aad-a"), offer);
  assert.equal(buttons.get(offer.token, "aad-b"), undefined);
  assert.equal(buttons.get("forged", "aad-a"), undefined);
  slow.resolve();
  await clock.pump(buttons.drain());
  assert.deepEqual(chat.deletes, [chat.posts[0]?.id]);
});

it("test_a_token_is_forgotten_after_its_time", async () => {
  const clock = new Timeline();
  const buttons = new StopButtons({ clock, random: new SeededRandom(2), log: new RecordingLogger(), delaySeconds: 0 });
  const chat = conversation();
  const running = deferred();
  const offer = buttons.offer("aad-a", "remote", chat, "en", alive, running.promise);
  await clock.advanceTo(clock.now + 1);
  assert.equal(buttons.get(offer.token, "aad-a"), offer);
  clock.now += OFFER_KEEP_SECONDS + 1;
  assert.equal(buttons.get(offer.token, "aad-a"), undefined);
  running.resolve();
  await clock.pump(buttons.drain());
});

it("a token is 16 characters of base64url, as Python's token_urlsafe(12)", () => {
  const buttons = new StopButtons({ clock: new Timeline(), random: new SeededRandom(3), log: new RecordingLogger() });
  const offer = buttons.offer("aad-a", "assistant", conversation(), "en", alive, Promise.resolve());
  assert.match(offer.token, /^[A-Za-z0-9_-]{16}$/);
});
