// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn tells Claw the short name of the chat app its message came through (`SurfaceCaps.shortName`), on the session it
 * makes and on every message it sends, so the headings the runtime appends name that app ("## Teams reply style ...").
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { OTHER_CHANNEL } from "../../../../test-support/surface.js";
import { runTurn } from "../../src/turn/engine/run-turn.js";
import { sendOptions } from "../../src/turn/engine/submit.js";
import { Timeline } from "./timeline.js";
import { Bus, result, ScriptedClaw, world } from "./world.js";

async function turn(caps?: typeof OTHER_CHANNEL, sessionId?: string) {
  const clock = new Timeline();
  const bus = new Bus(clock);
  if (caps) Object.assign(bus, { caps: { ...bus.caps, ...caps } });
  const claw = new ScriptedClaw(clock, [[0, result("done", sessionId ? "m2" : "m1")]]);
  const w = world(clock, bus, claw, sessionId ? { sessionId } : {});
  await clock.pump(runTurn(w.ctx, { onSession: () => undefined, stopRequested: () => false }));
  await clock.drain();
  return { claw, ctx: w.ctx };
}

it("a new session and a message to an old one carry the chat app's short name", async () => {
  const made = await turn();
  assert.equal(made.claw.created[0]?.channel, "Teams");
  const sent = await turn(undefined, "sess-old");
  const send = sent.claw.calls.find((c) => c[0] === "send");
  assert.deepEqual((send?.[4] as { channel?: string } | undefined)?.channel, "Teams");
  assert.equal(sendOptions(sent.ctx).channel, "Teams");
});

it("on another chat app they carry that app's name", async () => {
  const made = await turn(OTHER_CHANNEL);
  assert.equal(made.claw.created[0]?.channel, "ChatApp");
  const sent = await turn(OTHER_CHANNEL, "sess-old");
  assert.equal(sendOptions(sent.ctx).channel, "ChatApp");
});
