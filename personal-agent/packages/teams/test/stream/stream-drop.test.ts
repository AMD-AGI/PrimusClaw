// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stream update its sender gives up (core's receipt is dropped as the worker stops and aborts its updates' signal),
 * through the Teams surface and the direct outbox: it ends at once as a refusal, whether Teams has not answered the request
 * yet or the token the request needs is still being fetched, and the stream takes nothing more. The fake clock is not moved
 * after the update is given up: nothing waits for a request timeout or the send's deadline.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { err, type LiveStream, type Result, type StreamRefused } from "@primusclaw/personal-agent";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { DEFAULT_STYLE } from "../../src/config/style.js";
import { AckRegistry } from "../../src/messenger/acks.js";
import { noMasking } from "../../src/messenger/masker.js";
import { TeamsSurface } from "../../src/surface.js";
import { RENDERERS } from "../../src/views/index.js";
import { build, FakeTeams, json, reference } from "../connector/fakes.js";

async function opened(teams: FakeTeams): Promise<LiveStream> {
  const { outbox, clock } = build({ teams });
  const surface = new TeamsSurface({
    mode: "direct",
    outbox,
    acks: new AckRegistry(clock),
    clock,
    random: new SeededRandom(3),
    style: DEFAULT_STYLE,
    renderers: RENDERERS,
    masker: noMasking,
    files: { fetchFile: () => Promise.resolve(err({ kind: "file_refused", reason: "none" })) },
  });
  const wire = { ...reference("a:1on1"), conversation: { id: "a:1on1", conversationType: "personal" } };
  const stream = await surface
    .conversation({ id: "a:1on1", kind: "personal", tenantId: "t", wire })
    .openStream("m-1", "…");
  assert.ok(stream.ok);
  await teams.clock.advance(2_000); // (past Teams' second between a stream's requests)
  return stream.value;
}

/** The update's outcome if it settled once the microtasks ran out, the clock left where it is; undefined if still waiting. */
async function atOnce(work: Promise<Result<void, StreamRefused>>): Promise<Result<void, StreamRefused> | undefined> {
  let outcome: Result<void, StreamRefused> | undefined;
  void work.then((value) => {
    outcome = value;
  });
  for (let i = 0; i < 50 && outcome === undefined; i++) await flushMicrotasks();
  return outcome;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) await flushMicrotasks();
  assert.ok(done());
}

test("an update given up while Teams has not answered it ends at once, refused, and the stream takes no more", async () => {
  const teams = new FakeTeams(new FakeClock());
  teams.answers = [json(201, { id: "stream-1" })];
  const stream = await opened(teams);
  teams.delayMs = () => 60_000;
  const updates = new AbortController();
  const update = stream.inform("Searching…", { signal: updates.signal });
  await until(() => teams.calls.length === 2);
  updates.abort(new Error("the receipt was dropped"));
  const outcome = await atOnce(update);
  assert.ok(outcome !== undefined, "still waiting for Teams after the update was given up");
  assert.equal(outcome.ok, false);
  assert.equal((await stream.emit("more")).ok, false);
  assert.equal(teams.calls.length, 2);
});

test("an update given up while its token is still being fetched ends at once, refused, and reaches no one", async () => {
  const teams = new FakeTeams(new FakeClock());
  teams.answers = [json(201, { id: "stream-1" })];
  teams.expiresIn = 2; // (kept one second: a new token is fetched for the next request)
  const stream = await opened(teams);
  teams.imdsDelayMs = 60_000;
  const updates = new AbortController();
  const update = stream.emit("The answer so far", { signal: updates.signal });
  await until(() => teams.imds.length === 2);
  updates.abort(new Error("the receipt was dropped"));
  const outcome = await atOnce(update);
  assert.ok(outcome !== undefined, "still waiting for the token after the update was given up");
  assert.equal(outcome.ok, false);
  assert.equal(teams.calls.length, 1);
});
