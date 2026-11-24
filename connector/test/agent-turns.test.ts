// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn the agent takes by itself (session.ts `agentTurn`): Claude Code answers a command it put in the background once that command
 * finishes, and claude-agent-acp streams that turn with no prompt whose response would end it.
 *
 *   T1 it ends with a `turn_end` that names no prompt (`agent_initiated`), at the usage the agent reports at the end of its model turn,
 *      after its answer; the next prompt's turn is its own
 *   T2 an agent that says nothing at the end: the turn ends once it has been quiet for `agentTurnQuietMs`
 *   T3 a prompt that starts while it is open ends it first, so what follows is the prompt's
 *   T4 a cancel stops it (the agent is told) and says one end, naming no prompt, as a cancel with nothing running does
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { Harness } from "./support/harness.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a turn the agent takes by itself", () => {
  test("T1 ends at the usage of its model turn, after its answer, with an end that names no prompt", async () => {
    const h = await Harness.create({ env: { FAKE_AUTONOMOUS: "1" }, timing: { agentTurnQuietMs: 600_000 } });
    const sid = await h.newSession();
    const done = path.join(h.work, "bg-done");
    const seq = h.prompt(sid, `background ${done}`);
    const first = await h.turnEnd(sid, 1);
    assert.equal(first.data.cmd_seq, seq);
    assert.equal(first.data.agent_initiated, undefined);
    fs.writeFileSync(done, "");
    const own = await h.turnEnd(sid, 2);
    assert.deepEqual({ stop: own.data.stopReason, seq: own.data.cmd_seq, id: own.data.cmd_id, by: own.data.agent_initiated, how: own.data.ended_by },
      { stop: "end_turn", seq: null, id: null, by: true, how: "result" });
    const events = h.claw.eventsOf(sid);
    const answer = events.findIndex((e) => e.type === "agent_message_chunk" && e.data.update.content.text === "finished bg-done");
    assert.ok(answer >= 0 && answer < events.indexOf(own), "its answer comes before its end");
    assert.ok(events.findIndex((e) => e.type === "usage_update") < events.indexOf(own), "its usage too");
    const next = h.prompt(sid, "say two");
    const third = await h.turnEnd(sid, 3);
    assert.equal(third.data.cmd_seq, next);
    await wait(200);
    assert.equal(h.turnEnds(sid).length, 3, "one end each");
    assert.ok(h.audit().some((a) => a.kind === "agent_turn_ended" && a.by === "result"));
  });

  test("T2 an agent that says nothing at its end: the turn ends once it is quiet", async () => {
    const h = await Harness.create({ env: { FAKE_AUTONOMOUS: "quiet" }, timing: { agentTurnQuietMs: 300 } });
    const sid = await h.newSession();
    const done = path.join(h.work, "bg-done");
    h.prompt(sid, `background ${done}`);
    await h.turnEnd(sid, 1);
    fs.writeFileSync(done, "");
    const own = await h.turnEnd(sid, 2);
    assert.equal(own.data.agent_initiated, true);
    assert.equal(own.data.ended_by, "quiet");
    assert.equal(own.data.cmd_seq, null);
    assert.deepEqual(h.messages(sid), ["started", "finished bg-done"]);
  });

  test("T3 a prompt that starts while it is open ends it first", async () => {
    const h = await Harness.create({ env: { FAKE_AUTONOMOUS: "quiet" }, timing: { agentTurnQuietMs: 600_000 } });
    const sid = await h.newSession();
    const done = path.join(h.work, "bg-done");
    h.prompt(sid, `background ${done}`);
    await h.turnEnd(sid, 1);
    fs.writeFileSync(done, "");
    await h.claw.until("its answer", () => h.messages(sid).includes("finished bg-done"));
    await wait(100);
    assert.equal(h.turnEnds(sid).length, 1, "still open: nothing ended it yet");
    const seq = h.prompt(sid, "say two");
    const own = await h.turnEnd(sid, 2);
    assert.deepEqual({ by: own.data.agent_initiated, how: own.data.ended_by, seq: own.data.cmd_seq }, { by: true, how: "prompt", seq: null });
    const prompt = await h.turnEnd(sid, 3);
    assert.equal(prompt.data.cmd_seq, seq);
    const events = h.claw.eventsOf(sid);
    assert.ok(events.indexOf(own) < events.findIndex((e) => e.type === "agent_message_chunk" && e.data.update.content.text === "two"));
  });

  test("T4 a cancel stops it: the agent is told, and one end that names no prompt is said", async () => {
    const h = await Harness.create({ env: { FAKE_AUTONOMOUS: "quiet" }, timing: { agentTurnQuietMs: 600_000 } });
    const sid = await h.newSession();
    const done = path.join(h.work, "bg-done");
    h.prompt(sid, `background ${done}`);
    await h.turnEnd(sid, 1);
    fs.writeFileSync(done, "");
    await h.claw.until("its answer", () => h.messages(sid).includes("finished bg-done"));
    h.claw.issue("cancel", sid);
    const end = await h.turnEnd(sid, 2);
    assert.deepEqual({ stop: end.data.stopReason, seq: end.data.cmd_seq, by: end.data.agent_initiated }, { stop: "cancelled", seq: null, by: undefined });
    await h.claw.until("the agent to be told", () => h.adapterLog().some((l) => l.method === "session/cancel"));
    await wait(200);
    assert.equal(h.turnEnds(sid).length, 2);
    assert.ok(h.audit().some((a) => a.kind === "cancelled" && a.agent_turn === true));
  });
});
