// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A command that reaches the connector late is confirmed with Claw before it runs (connector.ts `confirmLive`).
 *
 * The case it exists for (FS-Q2, 2026-11-07): a laptop lid closes, so the connector process is stopped. A chat message is pushed
 * into its command stream and sits in the socket's buffer. The person removes the machine, Claw closes the session and tells them
 * it ended. When the process runs again it reads the buffered frame first, and without this check the agent ran the message. Here
 * the connector is the real CLI in its own process, stopped with SIGSTOP and continued with SIGCONT, against a stand-in Claw.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { REMOTE_AGENT_TIMING } from "../src/protocol.js";
import { processStart } from "../src/children.js";
import { sleep } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, Harness, onCleanup, tmpdir } from "./support/harness.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
/** Longer than the connector's `stallMs` (5 s by default), as a closed lid is. */
const STOPPED_MS = 6_500;

interface Machine { claw: FakeClaw; child: ChildProcess; home: string; work: string; log: string; exited: Promise<number | null> }
/** The connector process ended (continued first if it is still stopped), before its home goes. */
async function stopConnector(m: Machine): Promise<void> {
  if (processStart(m.child.pid!) !== null) {
    try { process.kill(m.child.pid!, "SIGCONT"); } catch { /* gone */ }
    m.child.kill("SIGTERM");
    if (await Promise.race([m.exited.then(() => true), sleep(10_000).then(() => false)]) === false) m.child.kill("SIGKILL");
  }
  await Promise.race([m.exited, sleep(5_000)]);
}

/** The real `claw-connector run` in its own process, signed in with a key, its agent the stand-in adapter that logs each prompt. */
async function machine(): Promise<Machine> {
  const claw = await FakeClaw.start({ pingMs: 200 });
  onCleanup(() => claw.close()); // (after the connector: cleanups run newest first)
  const home = tmpdir("cc-stall-");
  const work = tmpdir("cc-stall-work-");
  const log = path.join(home, "agent-received.jsonl");
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  fs.writeFileSync(path.join(home, "config", "agents.toml"), `server = ${JSON.stringify(claw.url)}
name = "stall-box"

[[agents]]
id = "fake"
kind = "example"
name = "Fake agent"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
ask_mode = "default"
roots = [${JSON.stringify(work)}]
[agents.env]
FAKE_LOG = ${JSON.stringify(log)}
`);
  const env = { ...process.env, CLAW_CONNECTOR_HOME: home };
  const login = spawnSync(process.execPath, ["--import", "tsx", cli, "login", "--server", claw.url, "--key", "good-token"], { env, encoding: "utf8" });
  assert.equal(login.status, 0, login.stderr);
  const child = spawn(process.execPath, ["--import", "tsx", cli, "run"], { env, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const m = { claw, child, home, work, log, exited };
  onCleanup(() => stopConnector(m));
  await claw.until("the connector online", () => claw.online && claw.heartbeats.length > 0, 30_000);
  return m;
}

const received = (m: Machine): string[] => {
  try { return fs.readFileSync(m.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => typeof r.prompt === "string").map((r) => r.prompt); } catch { return []; }
};
const audit = (m: Machine): any[] => {
  try { return fs.readFileSync(path.join(m.home, "state", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

async function openSession(m: Machine): Promise<string> {
  const sid = m.claw.newSession("fake", m.work);
  await m.claw.until("session_started", () => m.claw.eventsOf(sid, "session_started")[0], 30_000);
  return sid;
}

/** Stop the process (a closed lid), let `during` happen while it is stopped, then continue it after {@link STOPPED_MS}. */
async function lidClosed(m: Machine, during: () => Promise<void> | void): Promise<void> {
  const t0 = Date.now();
  process.kill(m.child.pid!, "SIGSTOP");
  try {
    await sleep(300);
    await during();
    await sleep(Math.max(0, STOPPED_MS - (Date.now() - t0)));
  } finally {
    process.kill(m.child.pid!, "SIGCONT");
  }
}

describe("a command held in the socket while the connector was stopped", { timeout: 120_000 }, () => {
  test("the machine is removed meanwhile: on SIGCONT the buffered prompt is not run, and the connector stops as revoked", async () => {
    const m = await machine();
    const sid = await openSession(m);
    await lidClosed(m, async () => {
      m.claw.issue("prompt", sid, { text: "ls" });
      await sleep(300); // written into the stream, where it waits in the socket's buffer
      m.claw.revoke(); // the person removed the machine (DELETE, as /agent off does): Claw closed the session and said so
    });
    const code = await Promise.race([m.exited, sleep(15_000).then(() => "still running" as const)]);
    assert.notEqual(code, "still running", "a revoked connector ends its run");
    const a = audit(m);
    // Not handed to the agent at all: a turn started on the old code (the adapter was then killed by the revocation that came
    // after it in the buffer, sometimes before it logged the prompt, sometimes after: on 2026-11-07 it ran `ls`).
    assert.deepEqual(a.filter((r) => r.kind === "turn_started"), [], "no turn started after the machine was removed");
    assert.deepEqual(received(m), [], "the agent received nothing after the machine was removed");
    assert.ok(a.some((r) => r.kind === "stall_detected" && r.gap_ms >= 5_000), JSON.stringify(a.map((r) => r.kind)));
    assert.ok(a.some((r) => r.kind === "command_dropped" && r.reason === "not_live" && r.status === "connector_revoked" && r.type === "prompt"),
      JSON.stringify(a.filter((r) => r.kind.startsWith("command"))));
  });

  test("the session is closed meanwhile (the machine stays): the prompt is refused by name in the session, not run", async () => {
    const m = await machine();
    const sid = await openSession(m);
    let cmd = "";
    await lidClosed(m, async () => {
      const seq = m.claw.issue("prompt", sid, { text: "ls" });
      cmd = String(m.claw.commands.find((c) => c.seq === seq)!.payload.cmd_id);
      await sleep(300);
      m.claw.closedSessions.add(sid); // /agent close: Claw closed it and told the person
    });
    const rejected = await m.claw.until("the prompt refused in the session", () => m.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === cmd), 15_000);
    assert.equal(rejected.data.reason, "command_not_live");
    assert.equal(rejected.data.status, "session_closed");
    assert.deepEqual(m.claw.confirmations, [{ cmd_id: cmd, status: "session_closed" }]);
    await sleep(500);
    assert.deepEqual(received(m), []);
    assert.deepEqual(audit(m).filter((r) => r.kind === "turn_started"), []);
  });

  test("a prompt read before the stall and queued behind a running turn is confirmed when it reaches the agent, and dropped once its session closed", async () => {
    const m = await machine();
    const sid = await openSession(m);
    const gate = path.join(m.work, "the-turn-may-end");
    m.claw.issue("prompt", sid, { text: `wait ${gate}` });
    await m.claw.until("the long turn running", () => received(m).includes(`wait ${gate}`), 15_000);
    const seq = m.claw.issue("prompt", sid, { text: "ls" });
    const cmd = String(m.claw.commands.find((c) => c.seq === seq)!.payload.cmd_id);
    await sleep(500); // read, and queued on the machine behind the running turn, before the lid closes
    assert.deepEqual(m.claw.confirmations, []);
    await lidClosed(m, () => {
      m.claw.closedSessions.add(sid); // the person closed the session while the lid was closed
      fs.writeFileSync(gate, ""); // and the running turn ends meanwhile (its adapter was not stopped)
    });
    const rejected = await m.claw.until("the queued prompt refused", () => m.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === cmd), 15_000);
    assert.equal(rejected.data.status, "session_closed");
    assert.deepEqual(m.claw.confirmations, [{ cmd_id: cmd, status: "session_closed" }]);
    // Read in time, so Claw is told it did not come late: however long it then waited behind the turn, it is never `expired`.
    assert.deepEqual(m.claw.confirmBodies.map((c) => [c.cmd_id, c.body.why, c.body.received_late]), [[cmd, "stall", false]]);
    await sleep(500);
    assert.equal(received(m).includes("ls"), false, "the queued prompt never reached the agent");
  });

  test("a prompt still live after the stall is confirmed and runs; one that arrives without a stall runs without asking", async () => {
    const m = await machine();
    const sid = await openSession(m);
    m.claw.issue("prompt", sid, { text: "before" });
    await m.claw.until("the first prompt run", () => received(m).includes("before"), 15_000);
    assert.deepEqual(m.claw.confirmations, [], "nothing late, nothing asked");
    let cmd = "";
    await lidClosed(m, async () => {
      const seq = m.claw.issue("prompt", sid, { text: "after the lid opened" });
      cmd = String(m.claw.commands.find((c) => c.seq === seq)!.payload.cmd_id);
    });
    await m.claw.until("the late prompt run", () => received(m).includes("after the lid opened"), 15_000);
    assert.deepEqual(m.claw.confirmations, [{ cmd_id: cmd, status: "live" }]);
  });
});

describe("a command older than the live TTL", () => {
  test("is confirmed first, whatever the stall clock says: expired is dropped, live runs", async () => {
    const h = await Harness.create();
    const sid = await h.newSession();
    const old = Date.now() - REMOTE_AGENT_TIMING.liveCommandTtlMs - 60_000;
    const stale = h.prompt(sid, "stale", { issued_at: old, cmd_id: "c-stale" });
    h.claw.commandStatus.set("c-stale", "expired");
    const rejected = await h.claw.until("the stale prompt refused", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === "c-stale"));
    assert.equal(rejected.data.status, "expired");
    assert.equal(rejected.data.cmd_seq, stale);
    h.prompt(sid, "old but live", { issued_at: old, cmd_id: "c-live" });
    await h.turnEnd(sid, 1);
    assert.deepEqual(h.adapterLog().filter((r) => r.prompt).map((r) => r.prompt), ["old but live"]);
    assert.deepEqual(h.claw.confirmations.map((c) => [c.cmd_id, c.status]), [["c-stale", "expired"], ["c-live", "live"]]);
    assert.deepEqual(h.claw.confirmBodies.map((c) => [c.cmd_id, c.body.why, c.body.received_late]), [["c-stale", "old", true], ["c-live", "old", true]]);
    // A fresh one is not asked about.
    h.prompt(sid, "fresh");
    await h.turnEnd(sid, 2);
    assert.equal(h.claw.confirmations.length, 2);
  });
  for (const later of ["live", "cancelled"] as const) {
    test(`a restart while Claw is being asked keeps the command for the next run, which asks again: ${later === "live" ? "still live, it runs there" : "cancelled meanwhile, it never runs"}`, async () => {
      const h = await Harness.create();
      const sid = await h.newSession();
      h.claw.holdConfirms = true;
      const old = Date.now() - REMOTE_AGENT_TIMING.liveCommandTtlMs - 60_000;
      const seq = h.prompt(sid, "say asked-across-a-restart", { issued_at: old, cmd_id: "c-restart" });
      await h.claw.until("the confirmation asked", () => h.claw.confirmAsked.includes("c-restart"));
      await h.stop();
      h.claw.releaseConfirms(); // the answer (live) comes after that run stopped
      await sleep(300);
      assert.equal(h.messages(sid).includes("asked-across-a-restart"), false, "not run by the run that stopped");
      assert.ok(h.claw.cursor < seq, "not acknowledged: Claw still holds it");
      assert.ok(h.audit().some((a) => a.kind === "command_deferred" && a.cmd_id === "c-restart"));
      assert.equal(h.claw.eventsOf(sid, "command_rejected").length, 0, "nor reported refused");
      // Delivered again as a young command (no stall in the next run, inside the TTL): the note left by the run that stopped is
      // what makes the next one ask.
      h.claw.commands.find((c) => c.seq === seq)!.payload.issued_at = Date.now();
      h.claw.holdConfirms = false;
      if (later === "cancelled") h.claw.commandStatus.set("c-restart", "cancelled");
      h.connect();
      h.start();
      if (later === "live") {
        await h.claw.until("the prompt run by the next run", () => h.messages(sid).includes("asked-across-a-restart"));
        const ends = await h.claw.until("its turn_end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === seq));
        assert.equal(ends.data.stopReason, "end_turn");
      } else {
        const rejected = await h.claw.until("refused by the next run", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === "c-restart"));
        assert.equal(rejected.data.status, "cancelled");
        await sleep(300);
        assert.equal(h.messages(sid).includes("asked-across-a-restart"), false, "never run");
      }
      assert.deepEqual(h.claw.confirmAsked.filter((c) => c === "c-restart").length, 2, "asked again by the next run");
    });
  }
  test("a close or a cancel is never held up by a question", async () => {
    const h = await Harness.create();
    const sid = await h.newSession();
    h.claw.issue("close", sid, { issued_at: 1 });
    await h.claw.until("closed", () => h.claw.eventsOf(sid, "session_closed")[0]);
    assert.equal(h.claw.confirmations.length, 0);
  });
});

describe("a command whose frame was held in the network", () => {
  test("one that took longer than transitMs to come is confirmed first (`delayed`); one that came at once is not", async () => {
    const h = await Harness.create();
    const sid = await h.newSession();
    h.prompt(sid, "came late", { sent_at: Date.now() - 10_000, cmd_id: "c-delayed" });
    await h.turnEnd(sid, 1);
    assert.deepEqual(h.claw.confirmBodies.map((c) => [c.cmd_id, c.body.why, c.body.received_late]), [["c-delayed", "delayed", false]]);
    h.prompt(sid, "came at once");
    await h.turnEnd(sid, 2);
    assert.equal(h.claw.confirmAsked.length, 1, "a frame that came at once is not asked about");
    assert.deepEqual(h.adapterLog().filter((r) => r.prompt).map((r) => r.prompt), ["came late", "came at once"]);
  });

  test("with no answer yet (no network after a wake), it waits in its session and is asked again until Claw answers; it is not dropped", async () => {
    const h = await Harness.create();
    const sid = await h.newSession();
    h.claw.failConfirms = 8; // more than the four tries the connector used to give up after
    h.prompt(sid, "asked until answered", { sent_at: Date.now() - 10_000, cmd_id: "c-wait" });
    await h.turnEnd(sid, 1);
    assert.equal(h.claw.confirmAsked.filter((c) => c === "c-wait").length, 9);
    assert.deepEqual(h.claw.confirmations, [{ cmd_id: "c-wait", status: "live" }]);
    assert.equal(h.claw.eventsOf(sid, "command_rejected").length, 0);
  });

  test("past the retry budget with no answer it is dropped, and the session is told why (command_rejected unconfirmed)", async () => {
    const h = await Harness.create({ timing: { confirmRetryMs: 400 } });
    const sid = await h.newSession();
    h.claw.failConfirms = 1_000;
    const seq = h.prompt(sid, "never answered", { sent_at: Date.now() - 10_000, cmd_id: "c-never" });
    const rejected = await h.claw.until("the prompt refused", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === "c-never"));
    assert.equal(rejected.data.reason, "command_not_live");
    assert.equal(rejected.data.status, "unconfirmed");
    assert.equal(rejected.data.cmd_seq, seq);
    await sleep(200);
    assert.deepEqual(h.adapterLog().filter((r) => r.prompt), [], "never reached the agent");
  });

  test("a Claw with no confirm route (404 from its router): the command runs as before, so the API and the connector ship in either order", async () => {
    const h = await Harness.create();
    const sid = await h.newSession();
    h.claw.confirmRoute = false;
    h.prompt(sid, "say old-claw", { sent_at: Date.now() - 10_000, cmd_id: "c-old-claw" });
    await h.turnEnd(sid, 1);
    assert.ok(h.messages(sid).includes("old-claw"));
    assert.ok(h.audit().some((a) => a.kind === "command_unconfirmable" && a.cmd_id === "c-old-claw"));
    assert.equal(h.claw.eventsOf(sid, "command_rejected").length, 0);
  });

  test("after the command stream reconnects, a command read in the window is confirmed first (`network`)", async () => {
    const h = await Harness.create({ timing: { stallMs: 2_000 } });
    const sid = await h.newSession();
    h.claw.dropStreams();
    await h.claw.until("the stream back", () => h.claw.online && h.claw.streamHeaders.length >= 2);
    h.prompt(sid, "right after", { cmd_id: "c-after-reconnect" });
    await h.turnEnd(sid, 1);
    assert.deepEqual(h.claw.confirmBodies.map((c) => [c.cmd_id, c.body.why]), [["c-after-reconnect", "network"]]);
    assert.ok(h.audit().some((a) => a.kind === "network_trouble" && a.reason === "reconnect"));
  });

  test("a first command stream whose `ready` the network held: what came behind it is confirmed (`network`, ready_late)", async () => {
    // (A watchdog longer than the hold: the stream is not dropped and opened afresh, which would make its frames fresh.)
    const timing = { transitMs: 1_000, watchdogMs: 10_000 };
    const h = await Harness.create({ timing });
    await h.stop();
    h.claw.streamDelayMs = 1_800; // the ready and the session.new behind it are stamped now and arrive 1.8 s later
    const sid = h.claw.newSession("fake", h.work);
    h.connect({ timing });
    h.start();
    await h.claw.until("session_started", () => h.claw.eventsOf(sid, "session_started")[0]);
    assert.deepEqual(h.claw.confirmBodies.map((c) => c.body.why), ["network"]);
    assert.ok(h.audit().some((a) => a.kind === "network_trouble" && a.reason === "ready_late"));
  });

  for (const ending of ["close", "cancel"] as const) {
    test(`a ${ending} of the session is not held up by a confirmation Claw does not answer: it runs at once, and the prompt is dropped and said so`, async () => {
      const h = await Harness.create();
      const sid = await h.newSession();
      const flag = path.join(h.work, `never-${ending}`);
      h.prompt(sid, `wait ${flag}`); // a running turn the cancel must interrupt
      await h.claw.until("the turn running", () => h.adapterLog().some((l) => l.prompt === `wait ${flag}`));
      h.claw.failConfirms = 1_000; // no answer, for the 10 minutes the connector would keep asking
      h.prompt(sid, "late one", { sent_at: Date.now() - 10_000, cmd_id: `c-${ending}` });
      await h.claw.until("the confirmation being asked", () => h.claw.confirmAsked.includes(`c-${ending}`));
      const t0 = Date.now();
      h.claw.issue(ending, sid);
      const rejected = await h.claw.until("the prompt refused", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === `c-${ending}`));
      assert.equal(rejected.data.status, ending === "close" ? "session_closed" : "cancelled");
      if (ending === "close") await h.claw.until("the session closed", () => h.claw.eventsOf(sid, "session_closed")[0]);
      else await h.claw.until("the running turn cancelled", () => h.turnEnds(sid).find((e) => e.data.stopReason === "cancelled"));
      assert.ok(Date.now() - t0 < 5_000, `at once, not after the retries: ${Date.now() - t0} ms`);
      assert.equal(h.adapterLog().some((l) => l.prompt === "late one"), false);
    });
  }

  test("a cancel that runs ahead of a session.new still being confirmed still cancels the prompt sent before it", async () => {
    const h = await Harness.create();
    h.claw.holdConfirms = true; // Claw answers about the session.new only later
    const sid = h.claw.newSession("fake", h.work, undefined, { issued_at: Date.now() - REMOTE_AGENT_TIMING.liveCommandTtlMs - 60_000 });
    const newId = String(h.claw.commands.find((c) => c.payload.session_id === sid)!.payload.cmd_id);
    await h.claw.until("the session.new being confirmed", () => h.claw.confirmAsked.includes(newId));
    const seq = h.prompt(sid, "sent before the cancel", { cmd_id: "c-before-cancel" });
    h.claw.issue("cancel", sid); // runs at once (it must not wait behind the confirmation), ahead of the prompt in the chain
    await h.claw.until("the cancel handled", () => h.audit().some((a) => a.kind === "command" && a.type === "cancel"));
    h.claw.holdConfirms = false;
    h.claw.releaseConfirms(); // live: the session starts after all
    await h.claw.until("the session started", () => h.claw.eventsOf(sid, "session_started")[0]);
    const rejected = await h.claw.until("the prompt refused", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === "c-before-cancel"));
    assert.deepEqual([rejected.data.status, rejected.data.cmd_seq], ["cancelled", seq]);
    await sleep(300);
    assert.equal(h.adapterLog().some((l) => l.prompt === "sent before the cancel"), false, "the cancel came after it: it never runs");
  });

  test("a `ready` held for less than transitMs still bounds Claw's clock from above: a frame held longer behind it is confirmed (`delayed`)", async () => {
    // (Round 8: the ready's own delay made Claw's clock look that much earlier, so a frame held 1.3 s + 0.4 s looked 0.4 s old.)
    const timing = { transitMs: 1_500, watchdogMs: 10_000 };
    const h = await Harness.create({ timing });
    await h.stop();
    h.claw.streamDelayMs = 1_300; // below transitMs: not `ready_late`
    const sid = h.claw.newSession("fake", h.work, undefined, { sent_at: Date.now() - 400 });
    h.connect({ timing });
    h.start();
    await h.claw.until("session_started", () => h.claw.eventsOf(sid, "session_started")[0]);
    assert.equal(h.claw.confirmBodies.length, 1, "the session.new held 1.7 s was asked about");
    assert.ok(["delayed", "network"].includes(h.claw.confirmBodies[0]!.body.why), h.claw.confirmBodies[0]!.body.why);
  });
});

