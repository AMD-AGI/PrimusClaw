// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The reader's speaker gives up a send that never comes back once the reader is cancelled (`remote/follow/speaker.ts`): Python's
// task cancel cuts the awaited send off; without that, a stop that timed out waited for the reader for ever.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Conversation, OutMessage } from "../../src/ports/surface.js";
import { silentLogger } from "../../src/ports/logger.js";
import { BurstSpeaker } from "../../src/remote/follow/speaker.js";
import { RemoteTurnState } from "../../src/remote-view/turn-state.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { openTestStore } from "../../../../test-support/store.js";
import { TEST_TIMINGS, WORLD_ERRORS } from "../../../../test-support/remote-world.js";

const CHAT = "aad-a";

/** A speaker with text waiting, whose chat's sends never come back; and the sends it tried. */
function speakerThatHangs(cutOff: AbortSignal, reachable = true) {
  const { store } = openTestStore();
  store.references.saveReference(CHAT, { conversation: { id: "conv-a" } });
  store.remoteState.attachRemote(CHAT, {
    sessionId: "s1",
    connectorId: "c1",
    agentId: "codex",
    agentLabel: "⬛ Codex",
    host: "dev-pod",
    cwd: "/repo",
  });
  const sends: OutMessage[] = [];
  const conversation = {
    send: (message: OutMessage) => {
      sends.push(message);
      return new Promise<never>(() => undefined); // (Teams never answers)
    },
  } as unknown as Conversation;
  const held: { text: string; eventId: string }[] = [];
  const turn = new RemoteTurnState(WORLD_ERRORS);
  const chunk = (id: string, text: string) => ({
    id,
    name: "agent_message_chunk",
    data: { data: { update: { content: { text } } } },
  });
  const speaker = new BurstSpeaker(
    CHAT,
    "s1",
    {
      clock: new FakeClock(),
      logger: silentLogger,
      timings: TEST_TIMINGS,
      reach: {
        reachable: () => reachable,
        muted: () => null,
        holdRemote: (_chat, _label, text, eventId) => {
          // (as the assistant holds it: one burst once, by its event)
          if (!held.some((h) => h.eventId === eventId)) held.push({ text, eventId });
        },
      },
      remoteState: store.remoteState,
      references: store.references,
      conversationFor: () => conversation,
      showPermission: () => Promise.resolve(),
      lang: () => "en",
      direct: () => false,
    },
    turn,
    cutOff,
  );
  speaker.feed(chunk("41", "Said on its own."));
  return { speaker, sends, held, chunk };
}

/** Every continuation that is ready runs (no timer, no clock). */
const ready = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a send that never comes back is given up when the reader is cancelled", async () => {
  const cancel = new AbortController();
  const { speaker, sends } = speakerThatHangs(cancel.signal);
  let done: boolean | undefined;
  void speaker.flush({ force: true, holdOnFailure: false }, "1").then((moved) => {
    done = moved;
  });
  await ready();
  assert.equal(sends.length, 1);
  assert.equal(done, undefined); // (the send is in flight)
  cancel.abort();
  await ready();
  assert.equal(done, false); // given up: not delivered, so the safe position did not move
  assert.equal(speaker.waiting, true); // and the text still waits (the follower's stop holds it)
});

test("a reader cancelled before it speaks sends nothing it waits for", async () => {
  const cancel = new AbortController();
  cancel.abort();
  const { speaker } = speakerThatHangs(cancel.signal);
  let done: boolean | undefined;
  void speaker.flush({ force: true, holdOnFailure: false }, "1").then((moved) => {
    done = moved;
  });
  await ready();
  assert.equal(done, false);
});

test("what is held carries the id of the event it came with, and holding it again holds it once", async () => {
  const { speaker, held, chunk } = speakerThatHangs(new AbortController().signal, false); // (the person may not be woken)
  assert.equal(await speaker.flush({ force: false, holdOnFailure: false }, "41"), true);
  assert.deepEqual(held, [{ text: "Said on its own.", eventId: "41" }]);
  speaker.feed(chunk("41", "Said on its own.")); // the same event read again (a reader that started over): the same hold
  await speaker.flush({ force: false, holdOnFailure: false }, "41");
  assert.equal(held.length, 1);
  speaker.feed(chunk("42", "Said later."));
  await speaker.flush({ force: false, holdOnFailure: false }, "42");
  assert.deepEqual(held.at(-1), { text: "Said later.", eventId: "42" });
});
