// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A command frame held back in the network is confirmed with Claw before it runs (connector.ts `lateness`: `delayed`, `network`).
 *
 * The case (FS-Q2, found by an independent verifier on 2026-11-07): the connector process keeps running, but the frames from Claw
 * to it are held in the network (Wi-Fi drops, roaming, a VPN reconnecting) for less than the stream's watchdog. Meanwhile the person
 * removes the machine, or closes the session, and is told so. TCP then delivers the held frames. Without the check the prompt ran
 * at once: the stall clock saw nothing, because the process never stopped. Here the connector is the real CLI in its own process,
 * behind a TCP proxy that holds every byte from Claw to the connector for {@link HOLD_MS} and then lets them all through.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { processStart } from "../src/children.js";
import { sleep } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, onCleanup, tmpdir } from "./support/harness.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
/** How long the network holds what Claw sends: as the verifier's probe, well inside the 75 s watchdog and the 90 s online window. */
const HOLD_MS = Number(process.env.HOLD_MS ?? 20_000);
/** A hold well inside a heartbeat (30 s) and the watchdog: the verifier's ~10 s, nothing but missed pings to see it by. */
const HOLD_SHORT_MS = 9_500;
/** How long the running turn goes on into the hold: past the stand-in Claw's ping (200 ms) plus `transitMs` (3 s). */
const QUIET_TURN_MS = 5_000;

/** A TCP proxy; while held, the bytes from Claw to the connector are queued and then delivered in order (TCP retransmission). */
async function proxy(target: number) {
  const st = { held: false, queue: [] as Array<() => void> };
  const srv = net.createServer((c) => {
    const s = net.connect(target, "127.0.0.1");
    c.on("data", (d) => s.write(d));
    s.on("data", (d) => { if (st.held) st.queue.push(() => c.write(d)); else c.write(d); });
    c.on("error", () => s.destroy());
    s.on("error", () => c.destroy());
    c.on("close", () => s.destroy());
    s.on("close", () => { if (st.held) st.queue.push(() => c.end()); else c.end(); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  onCleanup(() => new Promise<void>((r) => srv.close(() => r())));
  return {
    port: (srv.address() as net.AddressInfo).port,
    hold() { st.held = true; },
    release() { st.held = false; const q = st.queue; st.queue = []; for (const f of q) f(); },
  };
}

interface Machine { claw: FakeClaw; px: Awaited<ReturnType<typeof proxy>>; home: string; work: string; log: string; exited: Promise<number | null> }

/** The real `claw-connector run` in its own process, reaching the stand-in Claw only through the proxy. */
async function machine(): Promise<Machine> {
  const claw = await FakeClaw.start({ pingMs: 200 });
  onCleanup(() => claw.close()); // (after the connector: cleanups run newest first)
  const realPort = Number(new URL(claw.url).port);
  const px = await proxy(realPort);
  const url = claw.url.replace(`:${realPort}`, `:${px.port}`);
  const home = tmpdir("cc-netdelay-");
  const work = tmpdir("cc-netdelay-work-");
  const log = path.join(home, "agent-received.jsonl");
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  fs.writeFileSync(path.join(home, "config", "agents.toml"), `server = ${JSON.stringify(url)}
name = "nd-box"

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
  const login = spawnSync(process.execPath, ["--import", "tsx", cli, "login", "--server", url, "--key", "good-token"], { env, encoding: "utf8" });
  assert.equal(login.status, 0, login.stderr);
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", cli, "run"], { env, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  onCleanup(async () => {
    if (processStart(child.pid!) !== null) {
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
      if (processStart(child.pid!) !== null) child.kill("SIGKILL");
    }
  });
  await claw.until("the connector online", () => claw.online && claw.heartbeats.length > 0, 30_000);
  return { claw, px, home, work, log, exited };
}

const audit = (m: Machine): any[] => {
  try { return fs.readFileSync(path.join(m.home, "state", "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const received = (m: Machine): string[] => {
  try { return fs.readFileSync(m.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => typeof r.prompt === "string").map((r) => r.prompt); } catch { return []; }
};

async function openSession(m: Machine): Promise<string> {
  const sid = m.claw.newSession("fake", m.work);
  await m.claw.until("session_started", () => m.claw.eventsOf(sid, "session_started")[0], 30_000);
  return sid;
}

describe("a command frame held in the network while the connector keeps running", { timeout: 180_000 }, () => {
  test("the machine is removed meanwhile: the late prompt is not run, and the connector stops as revoked", async () => {
    const m = await machine();
    const sid = await openSession(m);
    m.px.hold();
    m.claw.issue("prompt", sid, { text: "ls" });
    await sleep(300); // written into the stream, where the network holds it
    m.claw.revoke(); // the person removed the machine: Claw closed the session and said so
    const revokedAt = Date.now();
    await sleep(HOLD_MS);
    m.px.release();
    const code = await Promise.race([m.exited, sleep(15_000).then(() => "still running" as const)]);
    assert.notEqual(code, "still running", "a revoked connector ends its run");
    const a = audit(m);
    assert.deepEqual(a.filter((r) => r.kind === "turn_started" && Date.parse(r.ts) > revokedAt), [], "no turn started after the machine was removed");
    assert.deepEqual(received(m), [], "the agent received nothing after the machine was removed");
    assert.ok(a.some((r) => (r.kind === "command_dropped" && r.reason === "not_live" && r.status === "connector_revoked" && r.type === "prompt")
      || (r.kind === "command_deferred" && r.type === "prompt")), JSON.stringify(a.filter((r) => String(r.kind).startsWith("command") || r.kind === "network_trouble")));
  });

  test("the session is closed meanwhile (the machine stays): the late prompt is refused by name in the session, not run", async () => {
    const m = await machine();
    const sid = await openSession(m);
    m.px.hold();
    const seq = m.claw.issue("prompt", sid, { text: "ls" });
    const cmd = String(m.claw.commands.find((c) => c.seq === seq)!.payload.cmd_id);
    await sleep(300);
    m.claw.closedSessions.add(sid); // /agent close: Claw closed it and told the person
    await sleep(HOLD_MS);
    m.px.release();
    const rejected = await m.claw.until("the prompt refused in the session", () => m.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === cmd), 20_000);
    assert.equal(rejected.data.reason, "command_not_live");
    assert.equal(rejected.data.status, "session_closed");
    assert.deepEqual(m.claw.confirmations, [{ cmd_id: cmd, status: "session_closed" }]);
    const why = m.claw.confirmBodies.find((c) => c.cmd_id === cmd)?.body?.why;
    assert.ok(why === "delayed" || why === "network", `asked because the frame came late, not for a stall: ${why}`);
    await sleep(500);
    assert.deepEqual(received(m), []);
    assert.deepEqual(audit(m).filter((r) => r.kind === "turn_started"), []);
  });

  test("a prompt that came on time and waits behind a turn, while the stream is held and its session closed: refused, not run", async () => {
    // The bypass found after #469 (2026-11-07): P2 came on time and queued behind a long turn; then the network held every byte
    // from Claw for ~10 s, the process running all along, and the person closed the session. No stall, no late heartbeat (one
    // every 30 s), no late frame, no reconnect: the turn ended and P2 ran without asking. Now a stream that misses its pings (Claw
    // pings every `ping_ms`, 200 ms here) for longer than that plus `transitMs` (3 s) is network trouble, and P2 is asked about.
    const m = await machine();
    const sid = await openSession(m);
    const flag = path.join(m.work, "turn-done");
    m.claw.issue("prompt", sid, { text: `wait ${flag}` });
    await m.claw.until("the long turn running", () => received(m).includes(`wait ${flag}`), 15_000);
    const seq = m.claw.issue("prompt", sid, { text: "ls" });
    const cmd = String(m.claw.commands.find((c) => c.seq === seq)!.payload.cmd_id);
    await m.claw.until("P2 read, queued behind the turn", () => audit(m).some((r) => r.kind === "command" && r.cmd_id === cmd), 10_000);
    m.px.hold();
    const heldAt = Date.now();
    m.claw.closedSessions.add(sid); // /agent close: Claw closed it and told the person; the frames saying so are held
    await sleep(QUIET_TURN_MS);
    fs.writeFileSync(flag, ""); // the turn ends: P2 is about to reach the agent
    await sleep(Math.max(0, HOLD_SHORT_MS - (Date.now() - heldAt)));
    assert.deepEqual(received(m).filter((p) => p === "ls"), [], "P2 did not run while the stream was held");
    m.px.release();
    const rejected = await m.claw.until("P2 refused in the session", () => m.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_id === cmd), 20_000);
    assert.deepEqual([rejected.data.reason, rejected.data.status], ["command_not_live", "session_closed"]);
    assert.deepEqual(m.claw.confirmations, [{ cmd_id: cmd, status: "session_closed" }]);
    assert.deepEqual(m.claw.confirmBodies.map((c) => [c.cmd_id, c.body.why, c.body.received_late, c.body.session_id]), [[cmd, "network", false, sid]]);
    assert.ok(audit(m).some((r) => r.kind === "network_trouble" && r.reason === "stream_quiet"));
    await sleep(500);
    assert.deepEqual(received(m).filter((p) => p === "ls"), []);
  });

  test("a prompt that came on time and waits behind a turn while pings keep coming runs when the turn ends, with no question to Claw", async () => {
    const m = await machine();
    const sid = await openSession(m);
    const flag = path.join(m.work, "turn-done");
    m.claw.issue("prompt", sid, { text: `wait ${flag}` });
    await m.claw.until("the long turn running", () => received(m).includes(`wait ${flag}`), 15_000);
    m.claw.issue("prompt", sid, { text: "queued on time" });
    await sleep(QUIET_TURN_MS); // as long as the held case waits, the stream moving
    fs.writeFileSync(flag, "");
    await m.claw.until("the queued prompt run", () => received(m).includes("queued on time"), 15_000);
    assert.deepEqual(m.claw.confirmAsked, [], "nothing late, nothing asked");
    assert.deepEqual(audit(m).filter((r) => r.kind === "network_trouble"), []);
  });

  test("a prompt that comes promptly runs at once, with no question to Claw", async () => {
    const m = await machine();
    const sid = await openSession(m);
    m.claw.issue("prompt", sid, { text: "on time" });
    await m.claw.until("the prompt run", () => received(m).includes("on time"), 15_000);
    assert.deepEqual(m.claw.confirmAsked, [], "nothing late, nothing asked");
  });
});
