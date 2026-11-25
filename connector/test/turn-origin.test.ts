// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who started a turn that ended in a terminal (turn-origin.ts), and what the connector does with it (approvals.ts `turnEnded`):
 *
 *   O1 the turn's prompt, as Claude Code writes it (2.1.285-2.1.328, shapes measured on real transcripts): typed, queued, an
 *      accepted suggestion and a typed slash command are a person's; another session's message and a scheduled prompt are not;
 *      a background task's notification continues the turn before it; lines Claude Code inserts into a turn are skipped
 *   O2 a Claude Code older than `origin`/`promptSource`: judged by how the words begin
 *   O3 only `<configDir>/projects/.../<ref>.jsonl` is read (no link out of it is followed); anything else, or a transcript without a prompt in its tail, says nothing
 *   O4 the end of a turn nobody typed is told with `origin: "automation"`; one a person typed with `origin: "person"`; an end
 *      whose transcript says nothing is told as before (no `origin`)
 *   O5 ends of turns nobody typed that follow one another (a new prompt came before the wait was over) are told once, as the
 *      newest, carrying how many turns and the earlier ones' last words
 *   O6 a turn a person typed after such an end drops it (they are at the terminal) and is told alone
 *   O7 a run that began with a person's turn is told as theirs
 *   O8 a run of ends that never pauses is still told once its first end is old enough
 *   O9 a failed end folded into a later one that finished is counted (`failed_earlier`), never hidden, and its words are marked
 *      as a failure's (`earlier_failed`)
 *   O10 a question in a folded turn is counted (`asked_earlier`) even once its words are no longer carried
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { ApprovalBroker, type BrokerDeps } from "../src/approvals.js";
import { entryOrigin, originOfTail, turnOrigin } from "../src/turn-origin.js";
import { tmpdir } from "./support/tmp.js";

const REF = "7b0619b8-d414-4782-b72a-fcc03a83a5b1";
const SID = "11111111-1111-4111-8111-111111111111";
const TTY = "/dev/pts/4";

const typed = (text: string) => ({ type: "user", promptSource: "typed", origin: { kind: "human" }, message: { role: "user", content: text } });
const queued = (text: string) => ({ type: "user", promptSource: "queued", origin: { kind: "human" }, message: { role: "user", content: text } });
const suggestion = (text: string) => ({ type: "user", promptSource: "suggestion_accepted", origin: { kind: "human" }, message: { role: "user", content: text } });
const peer = (text: string) => ({
  type: "user", isMeta: true, promptSource: "system", origin: { kind: "peer", from: "uds:/tmp/cc-socks/1.sock" },
  message: { role: "user", content: `Another Claude session sent a message: <cross-session-message from="x">${text}</cross-session-message>` },
});
const cron = (text: string) => ({ type: "user", isMeta: true, promptSource: "system", message: { role: "user", content: text } });
const notification = () => ({
  type: "user", promptSource: "system", origin: { kind: "task-notification", producer: "session-task" },
  message: { role: "user", content: "<task-notification> <task-id>b1</task-id> done </task-notification>" },
});
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolResult = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, toolUseResult: {} });
const reminder = () => ({ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>x</system-reminder>" } });
const lines = (...docs: unknown[]) => docs.map((d) => JSON.stringify(d)).join("\n") + "\n";

describe("who started the turn", () => {
  test("O1 Claude Code's own record of a prompt decides", () => {
    assert.equal(originOfTail(lines(typed("fix it"), assistant("done"))), "person");
    assert.equal(originOfTail(lines(queued("also this"), assistant("done"))), "person");
    assert.equal(originOfTail(lines(suggestion("yes"), assistant("done"))), "person");
    assert.equal(originOfTail(lines({ type: "user", message: { role: "user", content: "<command-name>/goal</command-name>" } }, assistant("ok"))), "person");
    assert.equal(originOfTail(lines(typed("fix it"), assistant("ok"), peer("status?"), assistant("all green"))), "automation");
    assert.equal(originOfTail(lines(typed("fix it"), assistant("ok"), cron("hourly report"), assistant("report"))), "automation");
    // a background task's notice continues the turn that started the task
    assert.equal(originOfTail(lines(typed("run the suite"), assistant("started"), notification(), assistant("suite passed"))), "person");
    assert.equal(originOfTail(lines(peer("run it"), assistant("started"), notification(), assistant("passed"))), "automation");
    // tool results, sub-agent lines and reminders inside a turn are not its prompt
    assert.equal(originOfTail(lines(typed("go"), assistant("x"), toolResult(), reminder(), { ...peer("side"), isSidechain: true }, assistant("y"))), "person");
    assert.equal(entryOrigin(assistant("x")), "skip");
  });

  test("O2 an older Claude Code: by how the words begin", () => {
    assert.equal(originOfTail(lines({ type: "user", message: { role: "user", content: "please fix the test" } })), "person");
    assert.equal(originOfTail(lines({ type: "user", message: { role: "user", content: "<cross-session-message from=\"a\">hi</cross-session-message>" } })), "automation");
    assert.equal(originOfTail(lines({ type: "user", message: { role: "user", content: "Another Claude session sent a message: hi" } })), "automation");
    assert.equal(originOfTail(lines(typed("go"), { type: "user", message: { role: "user", content: "<bash-input>ls</bash-input>" } })), "person");
  });

  test("O3 only the conversation's own transcript under the config folder; nothing to say is null", () => {
    const dir = tmpdir("turn-origin-");
    const config = path.join(dir, ".claude");
    const file = path.join(config, "projects", "-work", `${REF}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines(peer("x"), assistant("y")));
    assert.equal(turnOrigin(file, config, REF), "automation");
    assert.equal(turnOrigin(file, path.join(dir, "other"), REF), null, "outside the config folder");
    assert.equal(turnOrigin(file, config, "8b0619b8-d414-4782-b72a-fcc03a83a5b1"), null, "another conversation's name");
    assert.equal(turnOrigin("work/x.jsonl", config, REF), null, "not absolute");
    assert.equal(turnOrigin(path.join(config, "projects", "..", "..", `${REF}.jsonl`), config, REF), null, "out by ..");
    assert.equal(turnOrigin(path.join(config, "projects", "-none", `${REF}.jsonl`), config, REF), null, "no file");
    // a folder under projects that links out of it is not followed, nor is a transcript that is a link
    const outside = path.join(dir, "elsewhere");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, `${REF}.jsonl`), lines(typed("secret")));
    fs.symlinkSync(outside, path.join(config, "projects", "-linked"));
    assert.equal(turnOrigin(path.join(config, "projects", "-linked", `${REF}.jsonl`), config, REF), null, "linked folder");
    fs.mkdirSync(path.join(config, "projects", "-file-link"));
    fs.symlinkSync(path.join(outside, `${REF}.jsonl`), path.join(config, "projects", "-file-link", `${REF}.jsonl`));
    assert.equal(turnOrigin(path.join(config, "projects", "-file-link", `${REF}.jsonl`), config, REF), null, "linked file");
    // a config folder that is itself a link (a home on another disk) is still read
    const linkedConfig = path.join(dir, ".claude-link");
    fs.symlinkSync(config, linkedConfig);
    assert.equal(turnOrigin(path.join(linkedConfig, "projects", "-work", `${REF}.jsonl`), linkedConfig, REF), "automation");
    // only the tail is read: a first line cut in half is ignored, and a tail with no prompt says nothing
    fs.writeFileSync(file, lines(typed("x".repeat(5000)), assistant("y".repeat(5000))));
    assert.equal(turnOrigin(file, config, REF, 2000), null);
    assert.equal(turnOrigin(file, config, REF), "person");
  });
});

/** A broker whose conversation's transcript is a file the test writes. */
function rig(o: { awayMs?: number; runMaxMs?: number } = {}) {
  const dir = tmpdir("turn-origin-rig-");
  const configDir = path.join(dir, ".claude");
  const transcript = path.join(configDir, "projects", "-home-u-work-claw", `${REF}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
  const audited: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const t0 = Date.now() - 600_000;
  const deps: BrokerDeps = {
    async openSession() { return { sessionId: SID }; },
    emit: (_sid, type, data) => emitted.push({ type, data }),
    audit: (event, detail) => audited.push({ event, detail }),
    ttlMs: 60_000, attached: () => false, awayMs: o.awayMs ?? 150, lastInputMs: () => t0,
    ...(o.runMaxMs !== undefined ? { runMaxMs: o.runMaxMs } : {}),
  };
  const broker = new ApprovalBroker(deps);
  const from = { agent: "claude" as const, configDir, tty: TTY };
  const write = (...docs: unknown[]) => fs.appendFileSync(transcript, lines(...docs));
  const stop = (said: string, failed = false) => broker.settled({
    session_id: REF, transcript_path: transcript, cwd: "/home/u/work/claw", hook_event_name: failed ? "StopFailure" : "Stop",
    last_assistant_message: said, ...(failed ? { error: "rate_limit" } : { background_tasks: [] }),
  }, from);
  const prompt = () => broker.settled({ session_id: REF, transcript_path: transcript, cwd: "/home/u/work/claw", hook_event_name: "UserPromptSubmit", prompt: "…" }, from);
  const ends = () => emitted.filter((e) => e.type === "terminal_turn_end").map((e) => e.data);
  const skipped = () => audited.filter((a) => a.event === "turn_end_not_sent").map((a) => a.detail.reason);
  return { broker, write, stop, prompt, ends, skipped, transcript };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await wait(20); }
};

describe("the end says who started the turn", () => {
  test("O4 automation, person, and a transcript that says nothing", async () => {
    const a = rig();
    a.write(peer("status?"), assistant("all green"));
    a.stop("all green");
    await until(() => a.ends().length === 1);
    assert.equal(a.ends()[0]!.origin, "automation");
    assert.equal(a.ends()[0]!.turns, undefined, "one turn: no run");

    const p = rig();
    p.write(typed("fix the test"), assistant("fixed"));
    p.stop("fixed");
    await until(() => p.ends().length === 1);
    assert.equal(p.ends()[0]!.origin, "person");

    const n = rig();
    fs.rmSync(n.transcript);
    n.stop("done");
    await until(() => n.ends().length === 1);
    assert.equal("origin" in n.ends()[0]!, false, "an older connector's end, as before");
  });

  test("O5 ends of turns nobody typed, one after another: told once, the newest, with the earlier ones", async () => {
    const r = rig({ awayMs: 250 });
    r.write(peer("one"), assistant("first result"));
    r.stop("first result");
    r.prompt();
    r.write(cron("two"), assistant("second result"));
    r.stop("second result");
    r.prompt();
    r.write(peer("three"), assistant("third result"));
    r.stop("third result");
    await until(() => r.ends().length === 1);
    await wait(400);
    assert.equal(r.ends().length, 1);
    const e = r.ends()[0]!;
    assert.equal(e.message, "third result");
    assert.equal(e.origin, "automation");
    assert.equal(e.turns, 3);
    assert.deepEqual(e.earlier, ["first result", "second result"]);
    assert.equal(typeof e.since, "string");
    assert.deepEqual(r.skipped(), ["folded", "folded"]);
  });

  test("O6 a person's turn after such an end drops it and is told alone", async () => {
    const r = rig({ awayMs: 250 });
    r.write(peer("one"), assistant("automated"));
    r.stop("automated");
    r.prompt();
    r.write(typed("what now?"), assistant("answer for you"));
    r.stop("answer for you");
    await until(() => r.ends().length === 1);
    await wait(400);
    assert.deepEqual(r.ends().map((e) => [e.message, e.origin, e.turns]), [["answer for you", "person", undefined]]);
    assert.deepEqual(r.skipped(), ["terminal_active"]);
  });

  test("O7 a run that began with a person's turn is told as theirs", async () => {
    const r = rig({ awayMs: 250 });
    r.write(typed("deploy it"), assistant("deploying"));
    r.stop("deploying");
    r.prompt();
    r.write(peer("deploy finished"), assistant("deployed and verified"));
    r.stop("deployed and verified");
    await until(() => r.ends().length === 1);
    assert.deepEqual([r.ends()[0]!.origin, r.ends()[0]!.turns, r.ends()[0]!.earlier], ["person", 2, ["deploying"]]);
  });

  test("O8 a run that never pauses is told once its first end is old enough", async () => {
    const r = rig({ awayMs: 60_000, runMaxMs: 100 });
    r.write(peer("one"), assistant("a"));
    r.stop("a");
    r.prompt();
    await wait(150);
    r.write(peer("two"), assistant("b"));
    r.stop("b");
    await until(() => r.ends().length === 1, 2000);
    assert.deepEqual([r.ends()[0]!.turns, r.ends()[0]!.earlier], [2, ["a"]]);
    r.broker.stopAll();
  });

  test("O9 a failed end folded into a later one is counted, not hidden", async () => {
    const r = rig({ awayMs: 250 });
    r.write(peer("one"), assistant("API Error: 429"));
    r.stop("API Error: 429", true);
    r.prompt();
    r.write(peer("two"), assistant("retried, done"));
    r.stop("retried, done");
    await until(() => r.ends().length === 1);
    const e = r.ends()[0]!;
    assert.deepEqual([e.outcome, e.turns, e.failed_earlier, e.earlier], ["done", 2, 1, ["API Error: 429"]]);
    assert.deepEqual(e.earlier_failed, [0], "which of the earlier words are a failure's");
  });

  test("O10 a folded question is counted even once its words are dropped", async () => {
    const r = rig({ awayMs: 300 });
    r.write(peer("first"), assistant("Ready. Should I publish?"));
    r.stop("Ready. Should I publish?");
    for (let i = 1; i <= 6; i++) {
      r.prompt();
      r.write(peer(`n${i}`), assistant(`report ${i}`));
      r.stop(`report ${i}`);
    }
    await until(() => r.ends().length === 1);
    const e = r.ends()[0]!;
    assert.equal(e.turns, 7);
    assert.deepEqual(e.earlier, ["report 1", "report 2", "report 3", "report 4", "report 5"], "the question's words are no longer carried");
    assert.equal(e.asked_earlier, 1);
  });
});
