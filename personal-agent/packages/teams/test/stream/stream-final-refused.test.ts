// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stream whose final Teams refuses, through the Teams surface, the direct outbox and the Bot Connector's HTTP answers:
 * refused with 403 ContentStreamNotAllowed (Teams' own body), the stream is over on Teams' side and the next turn in the
 * conversation streams again at once; refused any other way (no answer, a 5xx), the conversation keeps the guard until
 * Teams' ten-minute limit, because the stream may still be open there.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { err, textMessage, type Conversation } from "@primusclaw/personal-agent";

import { FakeClock } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import type { JsonObject } from "../../src/cards/json.js";
import { DEFAULT_STYLE } from "../../src/config/style.js";
import { AckRegistry } from "../../src/messenger/acks.js";
import { noMasking } from "../../src/messenger/masker.js";
import { STREAM_LIMIT_MS } from "../../src/stream/busy.js";
import { TeamsSurface } from "../../src/surface.js";
import { RENDERERS } from "../../src/views/index.js";
import { type Answer, build, type Call, empty, FakeTeams, json, reference, settle } from "../connector/fakes.js";

/** What Teams answers a final of a stream it has already ended (the person stopped it in the chat). */
const STREAM_OVER = json(403, {
  error: {
    code: "ContentStreamNotAllowed",
    message: "Content stream is not allowed on an already completed streamed message",
  },
});

function streamInfo(call: Call): JsonObject {
  const body = JSON.parse(call.body) as JsonObject;
  return ((body["entities"] as JsonObject[] | undefined) ?? [])[0] ?? {};
}

/** A chat whose Teams answers the first stream's final with `finalAnswer`, and takes everything else. */
function chat(finalAnswer: Answer): { teams: FakeTeams; clock: FakeClock; conversation: Conversation } {
  const teams = new FakeTeams(new FakeClock());
  let streams = 0;
  let finals = 0;
  teams.answers = [
    (call, n) => {
      const info = streamInfo(call);
      if (info["streamType"] === "final" && finals++ === 0) {
        if (typeof finalAnswer === "function") return finalAnswer(call, n);
        if (finalAnswer instanceof Error) throw finalAnswer;
        return finalAnswer.clone();
      }
      if (info["streamSequence"] === 1) return json(201, { id: `stream-${String(++streams)}` });
      return json(info["streamType"] === "final" ? 201 : 202, info["streamType"] === "final" ? { id: "final" } : {});
    },
  ];
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
  const conversation = surface.conversation({ id: "a:1on1", kind: "personal", tenantId: "t", wire });
  return { teams, clock, conversation };
}

/** One turn's stream: opened, then closed with its answer; whether the final was taken. */
async function turn(c: ReturnType<typeof chat>, replyTo: string): Promise<boolean | "not opened"> {
  const opened = await settle(c.clock, c.conversation.openStream(replyTo, "Thinking…"));
  if (!opened.ok) return "not opened";
  const finished = await settle(c.clock, opened.value.finish(textMessage("the answer")));
  return finished.ok;
}

function kinds(teams: FakeTeams): unknown[] {
  return teams.calls.filter((c) => c.url.includes("/activities")).map((c) => streamInfo(c)["streamType"]);
}

test("a final Teams refuses with 403 ContentStreamNotAllowed lets the next turn in the conversation stream at once", async () => {
  const c = chat(STREAM_OVER);
  assert.equal(await turn(c, "m-1"), false);
  const second = await settle(c.clock, c.conversation.openStream("m-2", "Thinking…"));
  assert.ok(second.ok, "the next turn did not get a stream");
  assert.equal(second.value.id, "stream-2");
  assert.deepEqual(kinds(c.teams), ["informative", "final", "informative"]);
});

test("a final that got no answer or a 5xx keeps the conversation off streams until Teams' limit", async () => {
  for (const answer of [empty(503), new TypeError("fetch failed")]) {
    const c = chat(answer);
    assert.equal(await turn(c, "m-1"), false);
    const calls = c.teams.calls.length;
    assert.equal(await turn(c, "m-2"), "not opened");
    assert.equal(c.teams.calls.length, calls, "a second stream was opened while the first may be open");
    await c.clock.advance(STREAM_LIMIT_MS);
    assert.equal(await turn(c, "m-3"), true);
  }
});
