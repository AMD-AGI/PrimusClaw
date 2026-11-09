// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A chat turn that died with its worker does not hold its run's notification, and what the person asked comes back as the answer
// itself (teams/tests/test_lost_turn.py). Reading the finished answer is the turns' (`RunFollowUps.lostAnswer`, W4b): here it is a
// fake that gives the answer or nothing, and records what it was asked with.
import assert from "node:assert/strict";
import { it } from "node:test";

import type { JsonObject } from "../../src/json.js";
import { pythonIsoUtc } from "../../src/proactive/proactive.js";
import { sentMessages, sentTexts, sentViews } from "../../../../test-support/assistant/proactive-chat.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { advanceSeconds, openFileTestStore } from "../../../../test-support/store.js";
import { ALICE, at, link, world } from "../../../../test-support/assistant/proactive-world.js";

const ASKED = "现在哪个model 跑agentX效果最好";
const SESSION = "sess-ak-alice";

/** What Claw sends: its title names the session, and a session is named by its first message ("hi", days earlier). */
function completed(finished: number, kind = "run.completed"): JsonObject {
  return {
    event_id: `ev-${String(finished)}`,
    type: kind,
    occurred_at: pythonIsoUtc(finished),
    user_id: "u",
    session_id: SESSION,
    task_id: "t1",
    trigger_id: null,
    title: "Run completed: hi",
    summary: "",
    link: "/x",
  };
}

/** The title of the run card a view shows. */
function titleOf(model: Readonly<Record<string, unknown>>): string {
  const title = (model["event"] as JsonObject | undefined)?.["title"];
  return typeof title === "string" ? title : "";
}

/** The turn was recorded by one worker process; the notification reaches the next one (same database, new process). */
function restarted(t: { after: (fn: () => void) => void }, prompt = ASKED) {
  const clock = new FakeClock(at(12) * 1000);
  const file = openFileTestStore({ clock });
  t.after(() => {
    file.close();
  });
  link(file.store, "ak-alice");
  file.store.turns.turnStarted(SESSION, { prompt });
  advanceSeconds(clock, 60); // the worker is rolled a minute into the turn
  const w = world({ on: { store: file.reopen({ random: new SeededRandom(99) }), clock } });
  const asked: [string, string][] = [];
  const read = w.runs.lostAnswer.bind(w.runs);
  w.runs.lostAnswer = (key, sessionId, lead) => {
    asked.push([key, sessionId]);
    return read(key, sessionId, lead);
  };
  const deliver = (event: JsonObject) => w.proactive.handle(ALICE, w.reference, event);
  const titles = () =>
    sentViews(w.surface.outbox)
      .filter((v) => v.name === "runEvent")
      .map((v) => titleOf(v.model));
  return { ...w, asked, deliver, titles };
}

it("a turn of the previous worker does not hold the notification", async (t) => {
  const w = restarted(t);
  advanceSeconds(w.clock, 120); // the run finishes two minutes after the restart, far inside the 32 minutes a turn is waited for
  const finishedAt = w.store.now();
  assert.equal(w.store.turns.answeredInChat(SESSION, { finishedAt, runningMax: 1920, slack: 60 }), "lost");
  assert.equal(await w.deliver(completed(finishedAt)), "delivered"); // the first try, not a retry every 5 minutes
});

it("the answer of a lost turn is sent in the chat after one line that says why", async (t) => {
  const w = restarted(t);
  w.runs.answers.set(SESSION, ["For agentX, model M is the best right now."]);
  advanceSeconds(w.clock, 120);
  const event = completed(w.store.now());
  assert.equal(await w.deliver(event), "delivered");
  const said = sentTexts(w.surface.outbox).join("\n");
  assert.ok(said.includes(`Clawy 重启打断了上一轮，这是你问的「${ASKED}」的回答`), said);
  assert.ok(said.includes("model M is the best"), said);
  const answer = sentMessages(w.surface.outbox).find(
    (m) => m.body.type === "rich" && m.body.markdown.includes("model M is the best"),
  );
  assert.equal(answer?.aiGenerated, true); // the agent's answer carries the AI label as a turn's does
  assert.ok(!w.titles().some((title) => title.includes("Run completed")), "the answer, not a card");
  assert.deepEqual(w.asked, [["ak-alice", SESSION]]); // the session's answer, read with the owner's key
  const before = w.surface.outbox.length; // answered: the sender's retry of the same notification sends nothing more
  assert.equal(await w.deliver(event), "dropped");
  assert.equal(w.surface.outbox.length, before);
});

it("the lead line is english for an english question", async (t) => {
  const w = restarted(t, "which model runs agentX best now");
  w.runs.answers.set(SESSION, ["Model M."]);
  advanceSeconds(w.clock, 120);
  await w.deliver(completed(w.store.now()));
  assert.ok(
    sentTexts(w.surface.outbox).some(
      (text) => text.includes("interrupted the last turn") && text.includes("which model runs agentX best now"),
    ),
  );
});

it("the card of a run is named by what was asked not by the session", async (t) => {
  const w = restarted(t); // no finished answer can be read: the card is shown, and it says which question it is about
  advanceSeconds(w.clock, 120);
  assert.equal(await w.deliver(completed(w.store.now())), "delivered");
  assert.ok(w.titles().includes(`Run completed: ${ASKED}`), w.titles().join(" | "));
  assert.ok(!w.titles().includes("Run completed: hi"));
});

it("a turn that gave up still names its run by the question", async () => {
  const w = world();
  link(w.store, "ak-alice");
  w.store.turns.turnStarted(SESSION, { prompt: ASKED });
  w.store.turns.turnNotDelivered(SESSION); // "still running in PrimusClaw; I will message you here when it finishes"
  advanceSeconds(w.clock, 600);
  assert.equal(await w.proactive.handle(ALICE, w.reference, completed(w.store.now())), "delivered");
  const titles = sentViews(w.surface.outbox).map((v) => titleOf(v.model));
  assert.ok(titles.includes(`Run completed: ${ASKED}`), titles.join(" | "));
  assert.ok(!sentTexts(w.surface.outbox).some((text) => text.includes("interrupted"))); // same worker: nothing was lost
});

it("a run not started from the chat keeps claws title", async () => {
  const w = world();
  link(w.store, "ak-alice");
  assert.equal(await w.proactive.handle(ALICE, w.reference, completed(w.store.now())), "delivered");
  const titles = sentViews(w.surface.outbox).map((v) => titleOf(v.model));
  assert.ok(titles.includes("Run completed: hi"), titles.join(" | "));
});
