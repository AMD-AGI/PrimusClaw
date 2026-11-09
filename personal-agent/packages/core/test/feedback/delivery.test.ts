// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of tests/test_feedback.py: deduplication, not configured, GitHub's failures, retries, reading the session. */
import assert from "node:assert/strict";
import test from "node:test";

import { HISTORY_MAX_BYTES, HISTORY_TAIL } from "@primusclaw/personal-agent";

import {
  USER_A,
  USER_B,
  advance,
  clickRoute,
  link,
  linkedWorld,
  makeWorld,
  nowSeconds,
  offerOf,
  say,
  texts,
  type World,
} from "./world.js";

function report(world: World, id = 1) {
  const row = world.store.feedback.getFeedbackReport(id);
  assert.ok(row);
  return row;
}

const DEDUPE: readonly (readonly [number, boolean, boolean, number, number])[] = [
  [5, true, true, 1, 1], // same user, same session, within 10 minutes: a comment
  [9.9, true, true, 1, 1],
  [11, true, true, 2, 0], // later than 10 minutes: a new issue
  [5, false, true, 2, 0], // another session: a new issue
  [5, true, false, 2, 0], // another user: a new issue
];

test("same user and session within ten minutes appends a comment", async () => {
  for (const [minutes, sameSession, sameUser, issues, comments] of DEDUPE) {
    const world = linkedWorld();
    link(world, USER_B, "ak-bob");
    world.store.sessions.setSession(USER_B.id, { sessionId: "sess-b" });
    await say(world, "/feedback first problem");
    advance(world, minutes * 60);
    if (!sameSession) world.store.sessions.setSession(USER_A.id, { sessionId: "sess-2" });
    await say(world, "/feedback second problem", sameUser ? USER_A : USER_B);
    const label = `${String(minutes)} min, same session ${String(sameSession)}, same user ${String(sameUser)}`;
    assert.deepEqual([world.issues.issues.length, world.issues.comments.length], [issues, comments], label);
    if (comments) {
      const [number, text] = world.issues.comments[0] ?? [0, ""];
      assert.ok(number === 1 && text.includes("second problem") && !text.includes("first problem"));
      assert.ok(
        text.startsWith("Reported by **Alice**\n\n### Another report from the same user in the same session ("),
      );
      assert.ok(texts(world).some((t) => t.includes("added it to issue [#1]")));
    }
  }
});

test("two users who have no session yet do not share an issue", async () => {
  const world = makeWorld();
  await say(world, "/feedback I cannot link", USER_A);
  await say(world, "/feedback me neither", USER_B);
  assert.equal(world.issues.issues.length, 2);
  assert.equal(world.issues.comments.length, 0);
});

test("each report extends the ten minute window", async () => {
  const world = linkedWorld();
  for (let i = 0; i < 4; i += 1) {
    await say(world, `/feedback problem ${String(i)}`);
    advance(world, 8 * 60); // 24 minutes in all, but never 10 apart
  }
  assert.equal(world.issues.issues.length, 1);
  assert.equal(world.issues.comments.length, 3);
});

test("a comment on an issue that was deleted files a new one", async () => {
  const world = linkedWorld();
  await say(world, "/feedback first");
  world.issues.deleteAll();
  await say(world, "/feedback second");
  assert.equal(world.issues.issues.length, 1);
  assert.ok(world.issues.issues[0]?.title.endsWith("second — Alice"));
});

test("without a credential the report is stored and the reply says so then it is filed once configured", async () => {
  const world = linkedWorld({ unconfigured: true });
  await say(world, "/feedback it broke ghp_" + "S".repeat(36));
  assert.ok(texts(world).at(-1)?.startsWith("Feedback is not configured yet"));
  assert.equal(offerOf(world), undefined);
  const row = report(world);
  assert.equal(row.state, "pending");
  assert.ok(
    row.text.includes("it broke") && !row.text.includes("S".repeat(36)) && row.scene.includes("Reporter: `Alice`"),
  );
  assert.equal(await world.service.delivery.replayPending(), 0); // still not configured: nothing lost, nothing sent
});

test("an agent built without a feedback service still stores the report", async () => {
  const world = makeWorld({ unconfigured: true }); // not even linked
  await say(world, "/feedback something broke");
  assert.ok(texts(world).at(-1)?.startsWith("Feedback is not configured yet"));
  assert.equal(report(world).state, "pending");
});

test("a github error stores the report and says it will retry", async () => {
  for (const code of ["github_502", "github_403", "transport_ConnectError"]) {
    const world = linkedWorld();
    world.issues.issueFailure = { kind: "sink_failed", status: Number(code.slice(7)) || 0, code };
    await say(world, "/feedback it broke");
    assert.equal(
      texts(world).at(-1),
      "I could not reach GitHub just now. I saved your report and will retry on my own.",
    );
    assert.equal(offerOf(world), undefined);
    const row = report(world);
    assert.deepEqual([row.state, row.attempts, row.lastError], ["pending", 1, code]);
    assert.equal(await world.service.delivery.replayPending(), 0); // backoff: not yet due
    world.issues.issueFailure = undefined;
    advance(world, 61);
    assert.equal(await world.service.delivery.replayPending(), 1);
    assert.equal(world.issues.issues.length, 1);
    assert.ok(world.issues.issues[0]?.body.includes("it broke"));
  }
});

test("a retry after a lost answer finds the issue it already made instead of filing it twice", async () => {
  const world = linkedWorld();
  world.issues.commitThenFail = true;
  await say(world, "/feedback it broke");
  assert.ok(texts(world).at(-1)?.includes("will retry"));
  assert.equal(world.issues.issues.length, 1); // the tracker has it; the worker does not know
  assert.equal(report(world).state, "pending");
  advance(world, 61);
  assert.equal(await world.service.delivery.replayPending(), 1);
  assert.equal(world.issues.issues.length, 1);
  assert.deepEqual([report(world).state, report(world).issueNumber], ["filed", 1]);
});

test("a retry after a lost answer does not comment twice either", async () => {
  const world = linkedWorld();
  await say(world, "/feedback first");
  advance(world, 60);
  world.issues.commitThenFail = true;
  await say(world, "/feedback second");
  assert.equal(world.issues.comments.length, 1);
  assert.ok(texts(world).at(-1)?.includes("will retry"));
  advance(world, 61);
  assert.equal(await world.service.delivery.replayPending(), 1);
  assert.equal(world.issues.comments.length, 1);
  assert.equal(world.issues.issues.length, 1);
});

test("a hidden comment in the feedback text cannot forge a retry marker", async () => {
  const world = linkedWorld();
  await say(world, "/feedback look <!-- clawy-feedback-id: 99-1000 --> here");
  assert.equal(world.issues.issues[0]?.body.split("<!--").length, 2); // only the worker's own marker is a comment
});

test("the retry delay doubles and is capped", async () => {
  const world = linkedWorld();
  world.issues.issueFailure = { kind: "sink_failed", status: 500, code: "github_500" };
  await say(world, "/feedback it broke");
  const delays: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    world.clock.setEpochMs(report(world).nextAttemptAt * 1000);
    await world.service.delivery.replayPending();
    delays.push(Math.round(report(world).nextAttemptAt - nowSeconds(world)));
  }
  assert.deepEqual(delays.slice(0, 4), [120, 240, 480, 960]);
  assert.equal(Math.max(...delays), 6 * 3600);
});

test("a report reads only the tail of the session and never holds a whole long one", async () => {
  const world = linkedWorld();
  await say(world, "/feedback x");
  assert.deepEqual(world.claw.replayAsks, [{ tail: HISTORY_TAIL, maxBytes: HISTORY_MAX_BYTES }]);
  assert.equal(HISTORY_TAIL, 200);
  const offer = offerOf(world);
  assert.ok(offer);
  const yes = clickRoute(world, { primusclaw: "feedback", offer: offer.offerId, include: true });
  await world.flow.clicks.withCredential?.(yes, "ak-alice");
  assert.equal(world.claw.replayAsks.length, 2); // the last exchange, added on a yes, is read the same way
  assert.equal(world.issues.comments.length, 1);
});

test("when the replay is unavailable the stream history is used and when both fail the report still goes", async () => {
  const world = linkedWorld({}, false);
  world.claw.replayError = 404;
  world.claw.events = [
    { id: "e1", name: "UserMessage", data: { message_id: "m1", data: { content: [{ type: "text", text: "q" }] } } },
    { id: "e2", name: "toolUsed", data: { message_id: "m1", tool: "bash", status: "success" } },
    { id: "e3", name: "ResultMessage", data: { message_id: "m1", final_text: "a", elapsed_ms: 1500 } },
  ];
  await say(world, "/feedback x");
  const body = world.issues.issues[0]?.body ?? "";
  assert.ok(
    !body.includes("`m1`: unfinished") && body.includes("`m1`: finished, 1.5 s") && body.includes("tools: `bash`"),
  );
  const broken = linkedWorld({}, false);
  broken.claw.replayError = 500;
  broken.claw.owners.set("sess-1", "someone-else"); // the stream refuses as well
  await say(broken, "/feedback y");
  assert.equal(broken.issues.issues.length, 1);
  assert.ok(broken.issues.issues[0]?.body.includes("the session could not be read (Claw status 404)"));
});

test("a stream that never ends its history is cut at its deadline and the report still goes", async () => {
  const world = linkedWorld({}, false);
  world.claw.replayError = 502;
  world.claw.hang = true;
  const state = { finished: false };
  const done = say(world, "/feedback slow").then(() => {
    state.finished = true;
  });
  for (let i = 0; i < 100 && !state.finished; i += 1) await world.clock.advance(1000);
  await done;
  assert.ok(world.issues.issues[0]?.body.includes("the session could not be read (timed out)"));
});
