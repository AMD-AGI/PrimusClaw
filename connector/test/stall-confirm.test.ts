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
    // A fresh one is not asked about.
    h.prompt(sid, "fresh");
    await h.turnEnd(sid, 2);
    assert.equal(h.claw.confirmations.length, 2);
  });
  test("a close or a cancel is never held up by a question", async () => {
    const h = await Harness.create();
    const sid = await h.newSession();
    h.claw.issue("close", sid, { issued_at: 1 });
    await h.claw.until("closed", () => h.claw.eventsOf(sid, "session_closed")[0]);
    assert.equal(h.claw.confirmations.length, 0);
  });
});
