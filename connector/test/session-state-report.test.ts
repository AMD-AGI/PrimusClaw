// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the phone is shown of a conversation on this machine follows the conversation within seconds: one that just ended (a
 * `claude -p` that returned, a terminal that exited) is offered to be taken over at once, not up to a sessions look (10 s) and a
 * heartbeat later; one resumed and ended again between two looks is refreshed too; and nothing is sent when nothing changed.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe } from "node:test";
import { AttachSupport, localPidDomain } from "../src/attach.js";
import { approvalSocketFile, ApprovalBroker, type BrokerDeps } from "../src/approvals.js";
import { memoryAudit } from "../src/audit.js";
import { ChildRegistry, processStart } from "../src/children.js";
import { parseConfig } from "../src/config.js";
import { terminalsDir } from "../src/terminals.js";
import { silentLogger } from "../src/util.js";
import { ADAPTER, Harness, tmpdir } from "./support/harness.js";

const REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "approval-hook.ts");
/** What Claude Code's environment says of a session with a person at its terminal (approval-skip.ts). */
const TERMINAL_ENV = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAW_APPROVAL_HOOKS: "" };

// Every process a test starts is recorded here and stopped by pid (never by pattern).
const children: ChildProcess[] = [];
after(() => { for (const c of children) { try { if (c.pid && c.exitCode === null) process.kill(c.pid, "SIGKILL"); } catch { /* gone */ } } });
const sleeper = (): ChildProcess => {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(c);
  return c;
};
const stop = async (c: ChildProcess) => { c.kill("SIGKILL"); await new Promise((r) => c.once("exit", r)); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for `cond` (a positive answer is waited for as long as a slow runner needs; only the absence of one is a fixed wait). */
async function eventually(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
}

/** A process that has the conversation open, and the registry row Claude Code writes for it (removed with it, as when it exits). */
function open(dir: string, ref: string, status = "busy"): { pid: number; row: string; rewrite(status: string): void; end(): Promise<void> } {
  const proc = sleeper();
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const row = path.join(dir, "sessions", `${proc.pid}.json`);
  const write = (st: string) => fs.writeFileSync(row, JSON.stringify({ pid: proc.pid, sessionId: ref, status: st, kind: "interactive", procStart: processStart(proc.pid!), pidDomain: localPidDomain() }));
  write(status);
  return { pid: proc.pid!, row, rewrite: write, end: async () => { await stop(proc); fs.rmSync(row, { force: true }); } };
}

const hs: Harness[] = [];
after(async () => { for (const h of hs) await h.close(); });

/** A connector whose heartbeat and sessions look are a minute away, so that only what this change brings can report in time. */
async function connector(o: { timing?: Record<string, number>; rows?: (dir: string) => void } = {}): Promise<Harness> {
  const work = tmpdir("cc-work-");
  const h = await Harness.create({
    work, start: false, attach: { sessions: [{ sessionId: REF, cwd: work, title: "The conversation", updatedAt: "2026-10-29T10:00:00.000Z" }] },
    timing: { heartbeatMs: 60_000, watchdogMs: 60_000, sessionsWatchMs: 60_000, catalogMs: 600_000, ...(o.timing ?? {}) },
  });
  hs.push(h);
  o.rows?.(h.attachDir);
  h.start();
  return h;
}

const stateOf = (hb: any, ref = REF): string | undefined => hb.agents[0].capabilities.resumable?.find((r: any) => r.ref === ref)?.state;
const lastState = (h: Harness, ref = REF): string | undefined => stateOf(h.claw.heartbeats[h.claw.heartbeats.length - 1], ref);

/** Online and quiet: the heartbeats the start-up brings (the first, and the one the command stream's `ready` frame wakes) are in. */
async function settled(h: Harness): Promise<void> {
  await h.online();
  let n = -1;
  while (n !== h.claw.heartbeats.length) { n = h.claw.heartbeats.length; await sleep(500); }
}

/** The hook program as Claude Code runs it for a terminal session's event; resolves once the connector has been told. */
function hookSays(h: Harness, event: Record<string, unknown>, dir = h.attachDir): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", HOOK, "settled", "--dir", dir, "--socket", approvalSocketFile(h.dirs.state), "--managed-by", "claw-connector"], {
    env: { ...process.env, ...TERMINAL_ENV }, stdio: ["pipe", "ignore", "ignore"],
  });
  children.push(child);
  child.stdin.end(JSON.stringify({ cwd: h.work, ...event }));
  return new Promise((resolve) => child.on("exit", () => resolve()));
}
const sessionEnd = { session_id: REF, hook_event_name: "SessionEnd", reason: "prompt_input_exit" };

describe("a conversation that just ended is reported within seconds", () => {
  test("a `claude -p` that returned (no hook is run for it): its registry row is gone, and the phone is told within seconds, not at the next look", { skip: process.platform !== "linux" }, async () => {
    let conv!: ReturnType<typeof open>;
    const h = await connector({ rows: (dir) => { conv = open(dir, REF); } });
    await settled(h);
    assert.equal(lastState(h), "live", "while it runs, the card offers only to watch");
    const before = h.claw.heartbeats.length;
    const t0 = Date.now();
    await conv.end();
    const hb = await h.claw.until("a heartbeat that says it is free", () => h.claw.heartbeats.slice(before).find((b) => stateOf(b) === "idle"), 5_000);
    assert.ok(hb);
    assert.ok(Date.now() - t0 < 3_000, `reported ${Date.now() - t0} ms after it ended (a second for the look, and the heartbeat)`);
    assert.equal(h.claw.heartbeats.length, before + 1, "one heartbeat for it");
  });

  test("the first conversation ever run on a machine (Claude Code makes the registry directory itself): reported live, then free, within seconds each", { skip: process.platform !== "linux" }, async () => {
    const h = await connector();
    await settled(h);
    assert.equal(lastState(h), "idle");
    assert.ok(!fs.existsSync(path.join(h.attachDir, "sessions")), "no registry directory yet");
    const before = h.claw.heartbeats.length;
    const t0 = Date.now();
    const conv = open(h.attachDir, REF);
    await h.claw.until("a heartbeat that says it is in use", () => h.claw.heartbeats.slice(before).find((b) => stateOf(b) === "live"), 5_000);
    assert.ok(Date.now() - t0 < 3_000, `reported ${Date.now() - t0} ms after it started`);
    const mid = h.claw.heartbeats.length;
    const t1 = Date.now();
    await conv.end();
    await h.claw.until("a heartbeat that says it is free", () => h.claw.heartbeats.slice(mid).find((b) => stateOf(b) === "idle"), 5_000);
    assert.ok(Date.now() - t1 < 3_000, `reported ${Date.now() - t1} ms after it ended`);
    assert.equal(h.claw.heartbeats.length, mid + 1);
  });

  test("a terminal that exited and ran its SessionEnd hook: told within seconds of the hook, with nothing but the hook to see it", { skip: process.platform !== "linux" }, async () => {
    let conv!: ReturnType<typeof open>;
    const h = await connector({ rows: (dir) => { conv = open(dir, REF); } });
    await settled(h);
    assert.equal(lastState(h), "live");
    const before = h.claw.heartbeats.length;
    // The registry directory is swapped for an empty one, which a watch on the old one does not report: only the hook says it ended.
    const sessions = path.join(h.attachDir, "sessions");
    fs.renameSync(sessions, `${sessions}.old`);
    fs.mkdirSync(sessions);
    await conv.end();
    await sleep(300);
    assert.equal(h.claw.heartbeats.length, before, "nothing says it yet");
    await hookSays(h, sessionEnd);
    const t0 = Date.now();
    const hb = await h.claw.until("a heartbeat that says it is free", () => h.claw.heartbeats.slice(before).find((b) => stateOf(b) === "idle"), 5_000);
    assert.ok(hb);
    assert.ok(Date.now() - t0 < 3_000, `reported ${Date.now() - t0} ms after the hook (a second for the look, and the heartbeat)`);
    assert.equal(h.claw.heartbeats.length, before + 1);
  });

  test("the end of a turn in a terminal (Stop) is reported too: working becomes idle", { skip: process.platform !== "linux" }, async () => {
    let conv!: ReturnType<typeof open>;
    const h = await connector({ rows: (dir) => { conv = open(dir, REF, "busy"); } });
    await settled(h);
    assert.equal(h.claw.heartbeats[h.claw.heartbeats.length - 1].agents[0].capabilities.resumable[0].activity, "working");
    const before = h.claw.heartbeats.length;
    // Claude Code rewrites the row as the turn ends and runs the Stop hook: both ask for the one look.
    conv.rewrite("idle");
    await hookSays(h, { session_id: REF, hook_event_name: "Stop", last_assistant_message: "done" });
    const hb = await h.claw.until("a heartbeat that says it is at its prompt", () => h.claw.heartbeats.slice(before).find((b) => b.agents[0].capabilities.resumable[0].activity === "idle"), 5_000);
    assert.equal(stateOf(hb), "live");
    assert.equal(h.claw.heartbeats.length, before + 1);
  });

  test("a change that comes while a heartbeat is on its way is sent right after it, not at the next timer", { skip: process.platform !== "linux" }, async () => {
    let conv!: ReturnType<typeof open>;
    const h = await connector({ timing: { heartbeatMs: 2_500 }, rows: (dir) => { conv = open(dir, REF); } });
    await settled(h);
    // A heartbeat is sent (the timer) and its answer held: it read the conversation as live. It ends meanwhile.
    h.claw.holdHeartbeats = true;
    const before = h.claw.heartbeats.length;
    await h.claw.until("the timer's heartbeat", () => h.claw.heartbeats.length > before, 5_000);
    await sleep(50);
    await conv.end();
    await sleep(1_600);   // (the look it brings has been made, and found the change: the heartbeat on its way is older)
    assert.equal(h.claw.heartbeats.length, before + 1, "none while the answer is held");
    const released = Date.now();
    h.claw.holdHeartbeats = false;
    h.claw.releaseHeartbeats();
    const hb = await h.claw.until("the heartbeat that follows", () => h.claw.heartbeats.slice(before + 1).find((b) => stateOf(b) === "idle"), 5_000);
    assert.ok(hb);
    assert.ok(Date.now() - released < 1_500, `sent ${Date.now() - released} ms after the answer came (the timer is 2.5 s)`);
  });
});

describe("nothing is sent when nothing changed", () => {
  test("hooks that say a turn or a conversation ended, and a row rewritten as it was, change nothing the phone is shown", { skip: process.platform !== "linux" }, async () => {
    let conv!: ReturnType<typeof open>;
    const h = await connector({ rows: (dir) => { conv = open(dir, REF, "idle"); } });
    await settled(h);
    const before = h.claw.heartbeats.length;
    for (const event of ["Stop", "StopFailure", "SessionEnd"]) await hookSays(h, { session_id: REF2, hook_event_name: event });
    conv.rewrite("idle");
    await sleep(2_500);   // (past the look they ask for)
    assert.equal(h.claw.heartbeats.length, before);
  });


  test("a hook of another Claude config directory asks for no look: what it would find waits for the next one", { skip: process.platform !== "linux" }, async () => {
    let conv!: ReturnType<typeof open>;
    const h = await connector({ rows: (dir) => { conv = open(dir, REF); } });
    await settled(h);
    const before = h.claw.heartbeats.length;
    const sessions = path.join(h.attachDir, "sessions");
    fs.renameSync(sessions, `${sessions}.old`);
    fs.mkdirSync(sessions);
    await conv.end();
    await hookSays(h, sessionEnd, path.join(tmpdir(), "somebody-elses-claude"));
    await sleep(2_500);
    assert.equal(h.claw.heartbeats.length, before);
  });

  test("a burst of hooks and registry changes brings one look and one heartbeat", { skip: process.platform !== "linux" }, async () => {
    let conv!: ReturnType<typeof open>;
    const h = await connector({ rows: (dir) => { conv = open(dir, REF); } });
    await settled(h);
    const before = h.claw.heartbeats.length;
    const hooks = [1, 2, 3, 4].map(() => hookSays(h, sessionEnd));
    await conv.end();
    await Promise.all(hooks);
    await h.claw.until("the heartbeat", () => h.claw.heartbeats.length > before, 5_000);
    await sleep(2_500);
    assert.equal(h.claw.heartbeats.length, before + 1);
    assert.equal(lastState(h), "idle");
  });
});

describe("the broker says when a terminal's turn or conversation ended", () => {
  const rig = () => {
    const ended: Array<Record<string, unknown>> = [];
    const deps: BrokerDeps = {
      openSession: async () => ({ refused: "test" }), emit() {}, audit() {}, ttlMs: 60_000,
      terminalEnded: (e) => { ended.push({ ...e }); },
    };
    return { broker: new ApprovalBroker(deps), ended };
  };

  test("Stop, StopFailure and SessionEnd, with the agent and the config directory the hook was installed for; nothing else", () => {
    const { broker, ended } = rig();
    const from = { agent: "claude" as const, configDir: "/home/u/.claude" };
    for (const e of ["Stop", "StopFailure", "SessionEnd", "UserPromptSubmit", "PostToolUse"]) broker.settled({ session_id: REF, hook_event_name: e, cwd: "/w" }, from);
    broker.settled({ session_id: REF, hook_event_name: "Stop", cwd: "/w" }, { agent: "codex", configDir: "/home/u/.codex" });
    assert.deepEqual(ended, [
      { agent: "claude", configDir: "/home/u/.claude", ref: REF, event: "Stop" },
      { agent: "claude", configDir: "/home/u/.claude", ref: REF, event: "StopFailure" },
      { agent: "claude", configDir: "/home/u/.claude", ref: REF, event: "SessionEnd" },
      { agent: "codex", configDir: "/home/u/.codex", ref: REF, event: "Stop" },
    ]);
  });

  test("a callback that throws never costs the hook its answer", () => {
    const broker = new ApprovalBroker({ openSession: async () => ({ refused: "test" }), emit() {}, audit() {}, ttlMs: 1000, terminalEnded: () => { throw new Error("boom"); } });
    assert.doesNotThrow(() => broker.settled({ session_id: REF, hook_event_name: "SessionEnd", cwd: "/w" }, { agent: "claude", configDir: "/c" }));
  });
});

describe("what the phone was last told, not what the previous look saw", () => {
  /** An attach agent on `dir` that lists REF, with the stand-in adapter; nothing is started to look. */
  function support(dir: string, onRegistryChange?: () => void, registry = new ChildRegistry(path.join(tmpdir(), "children.json"))): AttachSupport {
    const cfg = parseConfig(`
[[agents]]
id = "a"
preset = "claude-attach"
roots = [${JSON.stringify(os.tmpdir())}]
attach_cli = "/nonexistent/claude-for-tests"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
[agents.env]
CLAUDE_CONFIG_DIR = ${JSON.stringify(dir)}
`);
    const s = new AttachSupport(cfg.agents[0]!, {
      registry, audit: memoryAudit(), log: silentLogger, logDir: tmpdir(), version: "test", env: process.env,
      catalogMs: 60_000, cliTimeoutMs: 1500, recentWriteMs: 10_000, attachedRefs: () => new Set(), ...(onRegistryChange ? { onRegistryChange } : {}),
    });
    const any = s as unknown as { listed: unknown[]; waitedOnce: boolean; listedAt: number };
    any.listed = [{ ref: REF, title: "The conversation", cwd: os.tmpdir(), updatedAt: Date.now() }];
    any.waitedOnce = true;
    any.listedAt = Date.now();
    return s;
  }
  const dirWithRegistry = (): string => { const dir = tmpdir("cc-claudecfg-"); fs.mkdirSync(path.join(dir, "sessions")); return dir; };

  test("a conversation resumed and ended again between two looks: the look after finds what a heartbeat in between reported", { skip: process.platform !== "linux" }, async () => {
    const dir = dirWithRegistry();
    const s = support(dir);
    assert.deepEqual((await s.resumable(1_000)).map((r) => r.state), ["idle"], "the first heartbeat");
    assert.equal(await s.poll(), false, "the first look learns what is there");
    assert.equal(await s.poll(), false, "and nothing changed");
    // A terminal resumes it; the periodic heartbeat falls in that window and reports it live; it exits before the next look.
    const term = open(dir, REF);
    assert.deepEqual((await s.resumable(1_000)).map((r) => r.state), ["live"], "a heartbeat reports it");
    await term.end();
    // The registry reads as it did at the previous look (no row), so a comparison with that look finds nothing.
    assert.equal(await s.poll(), true, "the phone was told live; it is free");
    assert.deepEqual((await s.resumable(1_000)).map((r) => r.state), ["idle"]);
    assert.equal(await s.poll(), false, "told, and the same again changes nothing");
  });

  test("a row rewritten with what it said, or a heartbeat that already said it, is no change", { skip: process.platform !== "linux" }, async () => {
    const dir = dirWithRegistry();
    const s = support(dir);
    const term = open(dir, REF, "busy");
    await s.resumable(1_000);
    assert.equal(await s.poll(), false);
    term.rewrite("busy");
    assert.equal(await s.poll(), false, "the same status");
    term.rewrite("idle");
    assert.equal(await s.poll(), true, "another status");
    assert.equal(await s.poll(), true, "not told yet: asked again at the next look, not forgotten");
    await s.resumable(1_000);
    assert.equal(await s.poll(), false, "told");
    await term.end();
  });

  test("a look that is asked for now skips the shortcut of files that read as they did", { skip: process.platform !== "linux" }, async () => {
    const dir = dirWithRegistry();
    const s = support(dir);
    const term = open(dir, REF);
    await s.resumable(1_000);
    await s.poll();
    await term.end();
    assert.equal(await s.poll(true), true);
    assert.equal(await s.poll(true), true, "still not told");
    await s.resumable(1_000);
    assert.equal(await s.poll(true), false);
  });

  test("what the process of this connector's own adapter does is not what the phone is shown: it says attached, so its status changes are no change", { skip: process.platform !== "linux" }, async () => {
    const dir = dirWithRegistry();
    const adapter = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });   // (it leads its own group, as an adapter does)
    children.push(adapter);
    const registry = new ChildRegistry(path.join(tmpdir(), "children.json"));
    registry.add({ pid: adapter.pid!, pgid: adapter.pid!, agent_id: "claude", session_id: "s-phone" });
    const row = path.join(dir, "sessions", `${adapter.pid}.json`);
    const write = (status: string) => fs.writeFileSync(row, JSON.stringify({ pid: adapter.pid, sessionId: REF, status, kind: "interactive", procStart: processStart(adapter.pid!), pidDomain: localPidDomain() }));
    write("busy");
    const s = support(dir, undefined, registry);
    assert.deepEqual((await s.resumable(1_000)).map((r) => [r.state, r.activity ?? null]), [["attached", null]]);
    assert.equal(await s.poll(), false);
    write("waiting");
    assert.equal(await s.poll(), false, "a turn that waits on the phone is not shown as a terminal that waits");
    write("idle");
    assert.equal(await s.poll(true), false);
    await stop(adapter);
  });

  test("a conversation only a terminal's hook row says is open: the end of that terminal is a change", { skip: process.platform !== "linux" }, async () => {
    const dir = dirWithRegistry();
    const s = support(dir);
    const proc = sleeper();
    const rows = terminalsDir(dir);
    fs.mkdirSync(rows, { recursive: true });
    const file = path.join(rows, `${proc.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ v: 1, pid: proc.pid, procStart: processStart(proc.pid!), sessionId: REF, cwd: os.tmpdir(), at: Date.now(), pidDomain: localPidDomain() }));
    assert.deepEqual((await s.resumable(1_000)).map((r) => r.state), ["live"], "the hook row says it is open, the registry says nothing");
    assert.equal(await s.poll(), false);
    fs.rmSync(file);   // (the SessionEnd hook takes the row away)
    assert.equal(await s.poll(true), true);
    await s.resumable(1_000);
    assert.equal(await s.poll(true), false);
    await stop(proc);
  });

  test("the registry is watched: a row written or removed says so at once; other files and a closed support do not", { skip: process.platform !== "linux" }, async () => {
    const dir = dirWithRegistry();
    let n = 0;
    const s = support(dir, () => { n++; });
    await s.poll();   // (the first look starts the watch)
    const term = open(dir, REF);
    await eventually(() => n > 0, "a row written");
    n = 0;
    fs.writeFileSync(path.join(dir, "sessions", `${term.pid}.key`), "x");
    await sleep(300);
    assert.equal(n, 0, "a file that is no row says nothing");
    await term.end();
    await eventually(() => n > 0, "a row removed");
    s.close();
    n = 0;
    const again = open(dir, REF);
    await sleep(300);
    assert.equal(n, 0, "closed");
    await again.end();
  });

  test("a registry directory that was not there yet is watched the moment it is made; one replaced is watched again", { skip: process.platform !== "linux" }, async () => {
    const dir = tmpdir("cc-claudecfg-");
    let n = 0;
    const s = support(dir, () => { n++; });
    await s.poll();
    assert.equal(n, 0);
    // Claude Code runs for the first time on this machine: it makes the directory and writes its row, with no look in between.
    const a = open(dir, REF);
    await eventually(() => n > 0, "the directory made, and a look asked for");
    await sleep(100);
    n = 0;
    await a.end();
    await eventually(() => n > 0, "the row removed, in the directory now watched");
    fs.renameSync(path.join(dir, "sessions"), path.join(dir, "sessions.old"));
    fs.mkdirSync(path.join(dir, "sessions"));
    await s.poll();
    n = 0;
    const b = open(dir, REF);
    await eventually(() => n > 0, "a row in the new directory");
    await b.end();
    s.close();
  });
});
