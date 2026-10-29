// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Taking over an existing session: the twin check against real processes and real files, then the connector end
 * to end (a stand-in Claw, a stand-in adapter and a stand-in `claude` command that are real child processes).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, describe } from "node:test";
import {
  AttachSupport, MAX_REPORTED, SESSION_REF_RE, cleanTitle, fitResumable, localPidDomain, parseAgentsJson, processGroup, readRegistry,
  TwinCheckError, type Resumable,
} from "../src/attach.js";
import { ChildRegistry, processStart } from "../src/children.js";
import { memoryAudit } from "../src/audit.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { silentLogger } from "../src/util.js";
import { Harness, tmpdir, FAKE_CLAUDE, type AttachOptions } from "./support/harness.js";

const REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REF3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Every process a test starts is recorded here and stopped by pid (never by pattern).
const children: ChildProcess[] = [];
after(() => { for (const c of children) { try { if (c.pid && c.exitCode === null) process.kill(c.pid, "SIGKILL"); } catch { /* gone */ } } });
const sleeper = (opts: { detached?: boolean } = {}): ChildProcess => {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: opts.detached ?? false });
  children.push(c);
  return c;
};
const stop = async (c: ChildProcess) => { c.kill("SIGKILL"); await new Promise((r) => c.once("exit", r)); };

// ---- a Claude config directory on disk ------------------------------------------------------------------

function configDir(): string {
  const dir = tmpdir("cc-claudecfg-");
  fs.mkdirSync(path.join(dir, "sessions"));
  return dir;
}
const registryRow = (dir: string, pid: number, extra: Record<string, unknown>) =>
  fs.writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: REF, status: "idle", kind: "interactive", ...extra }));

function support(dir: string, o: { cli?: string; cliEnv?: Record<string, string>; recentWriteMs?: number; attached?: string[] } = {}): AttachSupport {
  const cfg = parseConfig(`
[[agents]]
id = "a"
preset = "claude-attach"
roots = [${JSON.stringify(os.tmpdir())}]
attach_cli = ${JSON.stringify(o.cli ?? "/nonexistent/claude-for-tests")}
[agents.env]
CLAUDE_CONFIG_DIR = ${JSON.stringify(dir)}
${Object.entries(o.cliEnv ?? {}).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n")}
`);
  return new AttachSupport(cfg.agents[0]!, {
    registry: new ChildRegistry(path.join(tmpdir(), "children.json")), audit: memoryAudit(), log: silentLogger, logDir: tmpdir(), version: "test",
    env: process.env, catalogMs: 60_000, cliTimeoutMs: 1500, recentWriteMs: o.recentWriteMs ?? 10_000, attachedRefs: () => new Set(o.attached ?? []),
  });
}

/** A shell wrapper that runs the stand-in `claude` with the given behaviour, so `attach_cli` can name it. */
function fakeCli(mode: string, live: unknown[]): { cli: string; env: Record<string, string> } {
  const dir = tmpdir("cc-fakecli-");
  const liveFile = path.join(dir, "live.json");
  fs.writeFileSync(liveFile, JSON.stringify(live));
  const cli = path.join(dir, "claude");
  fs.writeFileSync(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`, { mode: 0o755 });
  return { cli, env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LIVE: liveFile } };
}

describe("reading who holds a session open", () => {
  test("claude agents --json: the rows that name a process and a session, and nothing else", () => {
    const rows: Array<[string, unknown, number]> = [
      ["a normal row", [{ pid: 10, sessionId: REF, status: "busy", kind: "interactive" }], 1],
      ["rows without a pid or a session id are not comparable and are skipped", [{ sessionId: REF }, { pid: 11 }, { pid: "12", sessionId: REF }, null, "x"], 0],
      ["an empty list", [], 0],
    ];
    for (const [what, doc, n] of rows) assert.equal(parseAgentsJson(JSON.stringify(doc)).length, n, what);
    assert.throws(() => parseAgentsJson("{}"), /not a list/);
    assert.throws(() => parseAgentsJson("not json"));
  });

  test("the registry: a row counts only while the process it names is the same process", async () => {
    const dir = configDir();
    const live = sleeper();
    const gone = sleeper();
    const goneStart = processStart(gone.pid!)!;
    await stop(gone);
    const domain = "linux:test-host:pid:[1]"; // what this process's own rows say the local domain is
    registryRow(dir, live.pid!, { procStart: processStart(live.pid!), pidDomain: domain });
    // a pid that now belongs to another process (same number, other start time) and a pid that is gone
    fs.writeFileSync(path.join(dir, "sessions", "recycled.json"), JSON.stringify({ pid: live.pid, sessionId: REF2, procStart: "1", pidDomain: domain }));
    fs.writeFileSync(path.join(dir, "sessions", "dead.json"), JSON.stringify({ pid: gone.pid, sessionId: REF3, procStart: goneStart, pidDomain: domain }));
    // a row from a pid namespace this machine cannot see cannot be disproved: it counts, and says so
    fs.writeFileSync(path.join(dir, "sessions", "foreign.json"), JSON.stringify({ pid: 999999, sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", pidDomain: "linux:other-host:pid:[7]" }));
    fs.writeFileSync(path.join(dir, "sessions", "readme.txt"), "not a registry row");
    fs.writeFileSync(path.join(dir, "sessions", "no-session.json"), JSON.stringify({ pid: live.pid }));
    const rows = readRegistry(dir, domain);
    if (process.platform === "linux") {
      assert.deepEqual(rows.map((r) => [r.sessionId, r.foreign]).sort(), [[REF, false], ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", true]].sort(), "the live row and the foreign one; not the recycled pid, not the dead one");
    }
  });

  test("an unreadable registry is an unknown answer, not an empty one", () => {
    assert.throws(() => readRegistry(path.join(tmpdir(), "no-such-dir"), null), TwinCheckError);
    const dir = configDir();
    fs.writeFileSync(path.join(dir, "sessions", "1.json"), "{ half a fi");
    assert.throws(() => readRegistry(dir, null), TwinCheckError, "a young broken file may be mid-write");
    const old = Date.now() - 10 * 60_000;
    fs.utimesSync(path.join(dir, "sessions", "1.json"), old / 1000, old / 1000);
    assert.deepEqual(readRegistry(dir, null), [], "an old broken file is junk");
  });

  test("the pid domain is the one Claude Code writes, and a process group can be read", () => {
    if (process.platform === "linux") assert.match(localPidDomain() ?? "", /^linux:[0-9a-f]+:pid:\[\d+\]$/);
    assert.equal(processGroup(process.pid) !== null, true);
    assert.equal(processGroup(2 ** 22 + 12345), null);
  });
});

describe("the twin check", () => {
  type Case = {
    name: string;
    cli?: { mode: string; live: unknown[] };
    registry?: "none" | "empty" | "live-twin" | "live-other";
    transcriptAgeMs?: number;
    transcript?: boolean;
    own?: boolean;
    expect: "ok" | "session_live" | "recently_written" | "twin_check_failed";
  };
  const cases: Case[] = [
    { name: "the command lists the session: a live twin", cli: { mode: "ok", live: [{ pid: 4242, sessionId: REF, status: "idle" }] }, expect: "session_live" },
    { name: "the command lists only other sessions", cli: { mode: "ok", live: [{ pid: 4242, sessionId: REF2, status: "idle" }] }, registry: "empty", expect: "ok" },
    { name: "the command lists nothing and the registry has a live row for it: the registry can add", cli: { mode: "ok", live: [] }, registry: "live-twin", expect: "session_live" },
    { name: "the command fails; the registry has a live row", cli: { mode: "fail", live: [] }, registry: "live-twin", expect: "session_live" },
    { name: "the command answers garbage; the registry is empty: nothing is open", cli: { mode: "garbage", live: [] }, registry: "empty", expect: "ok" },
    { name: "the command answers something that is not a list; the registry is empty", cli: { mode: "notlist", live: [] }, registry: "empty", expect: "ok" },
    { name: "the command hangs: it is given up on after the timeout, and the registry answers", cli: { mode: "hang", live: [] }, registry: "empty", expect: "ok" },
    { name: "the command fails and there is no registry either: unanswerable, so refused", cli: { mode: "fail", live: [] }, registry: "none", expect: "twin_check_failed" },
    { name: "no such command and no registry: refused", registry: "none", expect: "twin_check_failed" },
    { name: "no such command, an empty registry: nothing is open", registry: "empty", expect: "ok" },
    { name: "its own adapter is listed too and is not a twin", cli: { mode: "ok", live: [{ pid: -1, sessionId: REF }] }, own: true, expect: "ok" },
    { name: "a transcript written a moment ago: someone is still writing", registry: "empty", transcript: true, transcriptAgeMs: 2_000, expect: "recently_written" },
    { name: "a transcript left an hour ago", registry: "empty", transcript: true, transcriptAgeMs: 3_600_000, expect: "ok" },
    { name: "that check is skipped while this connector's own adapter is the writer", registry: "empty", transcript: false, transcriptAgeMs: 2_000, expect: "ok" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const dir = configDir();
      if (c.registry === "none") fs.rmSync(path.join(dir, "sessions"), { recursive: true });
      const twin = sleeper();
      const other = sleeper();
      if (c.registry === "live-twin") registryRow(dir, twin.pid!, { procStart: processStart(twin.pid!), pidDomain: localPidDomain() });
      if (c.registry === "live-other") registryRow(dir, other.pid!, { sessionId: REF2, procStart: processStart(other.pid!), pidDomain: localPidDomain() });
      // The "own adapter" case: a process the test leads a group of, listed as holding the session.
      const own = c.own ? sleeper({ detached: true }) : null;
      const live = c.cli?.live.map((r: any) => (r.pid === -1 ? { ...r, pid: own!.pid } : r));
      const fake = c.cli ? fakeCli(c.cli.mode, live ?? []) : null;
      if (c.transcriptAgeMs !== undefined) {
        const file = path.join(dir, "projects", "-some-dir", `${REF}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "{}\n");
        const t = (Date.now() - c.transcriptAgeMs) / 1000;
        fs.utimesSync(file, t, t);
      }
      const s = support(dir, { cli: fake?.cli, cliEnv: fake?.env });
      const v = await s.check(REF, { ownPgid: own ? own.pid! : null, transcript: c.transcript ?? false });
      assert.equal(v.ok ? "ok" : v.reason, c.expect, v.ok ? "" : v.detail);
    });
  }

  test("asked without its own pgid, the same listing is a twin: the exclusion is by process group, not by session id", async () => {
    const own = sleeper({ detached: true });
    const fake = fakeCli("ok", [{ pid: own.pid, sessionId: REF }]);
    const s = support(configDir(), { cli: fake.cli, cliEnv: fake.env });
    assert.equal((await s.check(REF, { transcript: false })).ok, false);
    assert.equal((await s.check(REF, { ownPgid: own.pid!, transcript: false })).ok, true);
    assert.equal((await s.check(REF, { ownPgid: own.pid! + 1, transcript: false })).ok, false, "another group is not ours");
  });

  test("ids are compared as the same id whatever their case: a twin cannot hide behind a capital letter", async () => {
    const fake = fakeCli("ok", [{ pid: 4242, sessionId: REF.toUpperCase() }]);
    const s = support(configDir(), { cli: fake.cli, cliEnv: fake.env });
    for (const ref of [REF, REF.toUpperCase()]) assert.equal((await s.check(ref, { transcript: false })).ok, false, ref);
  });

  test("an exited terminal is not a twin: a real process holds the session, then ends", async () => {
    const dir = configDir();
    const term = sleeper();
    registryRow(dir, term.pid!, { procStart: processStart(term.pid!), pidDomain: localPidDomain() });
    const s = support(dir);
    assert.equal((await s.check(REF, { transcript: false })).ok, false, "alive: refused");
    await stop(term);
    assert.equal((await s.check(REF, { transcript: false })).ok, true, "exited, its file left behind (kill -9): not a twin");
  });

  test("a session id that is not a UUID is refused before any path is built from it", async () => {
    const v = await support(configDir()).check("../../etc/passwd", { transcript: true });
    assert.equal(v.ok, false);
    assert.ok(!SESSION_REF_RE.test("../../etc/passwd") && SESSION_REF_RE.test(REF));
  });
});

describe("what is reported to Claw", () => {
  test("titles are one short line with no credential in it", () => {
    const rows: Array<[string, string]> = [
      ["multi\nline\ttitle", "multi line title"],
      ["token is ghp_abcdefghijklmnopqrstuvwxyz0123456789", "token is [hidden]"],
      ["x".repeat(200), `${"x".repeat(79)}…`],
      ["", ""],
    ];
    for (const [raw, want] of rows) assert.equal(cleanTitle(raw), want);
  });

  test("the list is cut from the oldest end until the capabilities fit the limit Claw puts on them", () => {
    const base = { ask_mode: "default", modes: ["default", "plan"], roots: ["/work"], protocol: 1 };
    const items: Resumable[] = Array.from({ length: 40 }, (_, i) => ({
      ref: REF, title: "t".repeat(80), cwd: `/work/${"d".repeat(120)}`, updated_at: 1_700_000_000 - i, state: "idle",
    }));
    const caps = fitResumable(base, items) as { resumable: Resumable[] };
    assert.ok(new TextEncoder().encode(JSON.stringify(caps)).length <= 4096);
    assert.ok(caps.resumable.length > 0 && caps.resumable.length <= MAX_REPORTED);
    assert.deepEqual(caps.resumable, items.slice(0, caps.resumable.length), "the newest are kept, in order");
    // No room at all: the key is left out. An empty list would be the bytes that make a heartbeat invalid.
    const edge = { ...base, roots: ["/".concat("x".repeat(4010))] };
    assert.ok(new TextEncoder().encode(JSON.stringify(edge)).length <= 4096 && new TextEncoder().encode(JSON.stringify({ ...edge, resumable: [] })).length > 4096, "the case is the one that matters");
    assert.deepEqual(fitResumable(edge, items), edge);
    assert.deepEqual(fitResumable(base, []), { ...base, resumable: [] }, "nothing to offer, room to say so");
  });

  test("the preset: an opaque kind, the ask mode, a default command to list with, and nothing that applies to other agents", () => {
    const cfg = parseConfig(`
[[agents]]
id = "a"
preset = "claude-attach"
roots = ["${os.tmpdir()}"]
[[agents]]
id = "b"
preset = "claude-attach"
attach_cli = "/opt/claude/bin/claude"
roots = ["${os.tmpdir()}"]
[[agents]]
id = "c"
preset = "claude"
roots = ["${os.tmpdir()}"]
`);
    assert.deepEqual(cfg.agents.map((a) => [a.kind, a.askMode, a.attach?.cli ?? null]), [["attach", "default", "claude"], ["attach", "default", "/opt/claude/bin/claude"], ["claude", "default", null]]);
    assert.throws(() => parseConfig(`[[agents]]\nid = "c"\npreset = "claude"\nattach_cli = "claude"\nroots = ["${os.tmpdir()}"]`), ConfigError);
    assert.throws(() => parseConfig(`[[agents]]\nid = "c"\npreset = "claude-attach"\nattach_cli = ""\nroots = ["${os.tmpdir()}"]`), ConfigError);
  });
});

// ---- the connector, end to end ---------------------------------------------------------------------------

const hs: Harness[] = [];
after(async () => { for (const h of hs) await h.close(); });

async function attachHarness(o: { live?: Array<Record<string, unknown>>; cliMode?: string; env?: Record<string, string>; timing?: Record<string, number>; sessions?: AttachOptions["sessions"] } = {}): Promise<Harness> {
  const work = tmpdir("cc-work-");
  const h = await Harness.create({
    work, env: o.env, timing: o.timing,
    attach: {
      live: o.live, cliMode: o.cliMode,
      sessions: o.sessions ?? [
        { sessionId: REF, cwd: work, title: "Fix the flaky test", updatedAt: "2026-10-29T10:00:00.000Z" },
        { sessionId: REF2, cwd: work, title: "Second", updatedAt: "2026-10-29T09:00:00.000Z" },
        { sessionId: REF3, cwd: "/definitely/not/under/the/roots", title: "Elsewhere", updatedAt: "2026-10-29T11:00:00.000Z" },
      ],
    },
  });
  hs.push(h);
  return h;
}

const closedReason = (h: Harness, sid: string) => h.claw.eventsOf(sid, "session_closed")[0]?.data.reason;
const adapterMethods = (h: Harness) => h.adapterLog().map((l) => l.method).filter(Boolean);

describe("attach end to end", () => {
  test("the heartbeat lists what can be taken over, newest first, inside the roots, with its state; the kind is opaque", async () => {
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF2, status: "idle" }] });
    await h.online();
    const hb = await h.claw.until("a heartbeat with the list", () => h.claw.heartbeats.find((b) => b.agents[0].capabilities.resumable?.length));
    const a = hb.agents[0];
    assert.equal(a.kind, "attach");
    assert.deepEqual(a.capabilities.resumable.map((r: any) => [r.ref, r.title, r.state]), [[REF, "Fix the flaky test", "idle"], [REF2, "Second", "live"]], "REF3 is outside the roots and is not offered");
    assert.equal(a.capabilities.resumable[0].updated_at, Date.parse("2026-10-29T10:00:00.000Z") / 1000);
    assert.equal(a.capabilities.resumable[0].cwd, fs.realpathSync(h.work));
    assert.ok(!JSON.stringify(a).includes("claude") && !JSON.stringify(a).includes("Claude"), "Claw is told nothing about the product");
  });

  test("a session is taken over in its own directory, in the ask mode, whatever mode it was left in; a write asks", async () => {
    const h = await attachHarness({ env: { FAKE_RESUME_RESETS: "bypassPermissions", FAKE_RESUME_WARN: "1" } });
    const sid = await h.attach(REF);
    const started = h.claw.eventsOf(sid, "session_started")[0]!.data;
    assert.equal(started.acp_session_id, REF);
    assert.equal(started.attached, true);
    assert.equal(started.title, "Fix the flaky test");
    assert.equal(started.currentMode, "default", "the mode the transcript was left in (bypassPermissions) is replaced before any prompt");
    const log = h.adapterLog();
    const methods = adapterMethods(h);
    assert.ok(!methods.includes("session/new"), "the existing session is resumed, never a new one");
    assert.deepEqual(log.find((l) => l.method === "session/resume").params.sessionId, REF);
    assert.equal(log.find((l) => l.method === "session/resume").params.cwd, fs.realpathSync(h.work));
    assert.ok(methods.indexOf("session/set_mode") > methods.indexOf("session/resume"));
    h.prompt(sid, "write out.txt hi");
    const p = await h.permission(sid);
    assert.ok(p.data.options.length > 0, "the write is asked about, not silently allowed");
    assert.ok(!fs.existsSync(path.join(h.work, "out.txt")));
    assert.ok(h.audit().some((a) => a.kind === "permission_callback_warning_inherited"), "the inherited-mode warning is recorded, not lost");
    assert.ok(h.audit().some((a) => a.kind === "session_attached" && a.acp_session_id === REF));
    assert.ok(!methods.includes("session/delete"), "the conversation is never deleted");
  });

  test("a warning about the permission callback that comes after the mode is locked still closes the session", async () => {
    const h = await attachHarness({ env: { FAKE_RESUME_WARN: "1", FAKE_WARN_AFTER_LOCK: "1" } });
    const sid = await h.attach(REF);
    await h.claw.until("the session to be closed", () => closedReason(h, sid) !== undefined);
    assert.equal(closedReason(h, sid), "mode_not_enforced");
  });

  test("a mode that is not confirmed after the resume closes the session instead of opening it", async () => {
    const h = await attachHarness({ env: { FAKE_RESUME_RESETS: "bypassPermissions", FAKE_IGNORE_SET_MODE: "1" } });
    const sid = await h.attach(REF);
    assert.match(String(closedReason(h, sid)), /^mode_/);
    assert.equal(h.claw.eventsOf(sid, "session_started").length, 0);
  });

  test("a live twin refuses the takeover before an adapter is started", async () => {
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF, status: "busy" }] });
    const sid = await h.attach(REF);
    assert.equal(closedReason(h, sid), "session_live");
    assert.deepEqual(adapterMethods(h).filter((m) => m !== "initialize" && m !== "session/list"), [], "nothing was resumed");
    assert.ok(h.audit().some((a) => a.kind === "attach_refused" && a.reason === "session_live"));
    // The terminal is closed: the same request now goes through.
    h.setLive([]);
    const again = await h.attach(REF);
    assert.equal(h.claw.eventsOf(again, "session_started").length, 1);
  });

  test("the requests that must be refused, each with its own reason and none starting a resume", async () => {
    const rows: Array<{ name: string; ref: string | undefined; cwd?: string; extra?: Record<string, unknown>; cliMode?: string; live?: Array<Record<string, unknown>>; reason: string }> = [
      { name: "no reference", ref: undefined, reason: "resume_ref_required" },
      { name: "a reference that is not a session id", ref: "../../etc/passwd", reason: "invalid_resume_ref" },
      { name: "a well-formed id that is not on this machine", ref: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", reason: "unknown_session" },
      { name: "a session outside the roots is not even listed", ref: REF3, reason: "unknown_session" },
      { name: "a directory inside the roots that is not the session's own", ref: REF, cwd: "SUB", reason: "cwd_mismatch" },
      { name: "a directory outside the roots", ref: REF, cwd: "/etc", reason: "cwd_outside_roots" },
      { name: "the check cannot be made", ref: REF, cliMode: "fail", live: undefined, reason: "twin_check_failed" },
      { name: "a mode that never asks, asked for from the phone", ref: REF, extra: { mode: "bypassPermissions" }, reason: "mode_not_allowed" },
    ];
    for (const r of rows) {
      const h = await attachHarness({ cliMode: r.cliMode });
      let cwd = r.cwd;
      if (cwd === "SUB") { cwd = path.join(h.work, "sub"); fs.mkdirSync(cwd); }
      const sid = await h.attach(r.ref, cwd, r.extra);
      assert.equal(closedReason(h, sid), r.reason, r.name);
      assert.ok(!adapterMethods(h).includes("session/resume"), `${r.name}: no resume`);
      assert.equal(h.claw.eventsOf(sid, "session_started").length, 0, r.name);
    }
  });

  test("a session cannot be taken over twice by the same connector", async () => {
    const h = await attachHarness();
    const first = await h.attach(REF);
    assert.equal(h.claw.eventsOf(first, "session_started").length, 1);
    const second = await h.attach(REF);
    assert.equal(closedReason(h, second), "already_attached");
    assert.equal(adapterMethods(h).filter((m) => m === "session/resume").length, 1);
    const hb = await h.claw.until("a heartbeat that says so", () => [...h.claw.heartbeats].reverse().find((b) => b.agents[0].capabilities.resumable?.find((r: any) => r.ref === REF)?.state === "attached"));
    assert.ok(hb);
  });

  test("two requests for the same conversation, made at once, are not both taken: one session, one resume", async () => {
    // catalogMs 0: each takeover looks the conversation up afresh (a process start), so the two overlap for certain.
    const h = await attachHarness({ timing: { catalogMs: 0 } });
    await h.online();
    const a = h.claw.newSession("fake", h.work, undefined, { resume_ref: REF });
    const b = h.claw.newSession("fake", h.work, undefined, { resume_ref: REF });
    await h.claw.until("both to be answered", () => [a, b].every((s) => h.claw.eventsOf(s).some((e) => e.type === "session_started" || e.type === "session_closed")));
    const outcomes = [a, b].map((s) => (h.claw.eventsOf(s, "session_started").length ? "started" : closedReason(h, s))).sort();
    assert.deepEqual(outcomes, ["already_attached", "started"]);
    assert.equal(adapterMethods(h).filter((m) => m === "session/resume").length, 1, "one writer");
    // The claim does not outlive a refusal: once the first session is closed the conversation can be taken again.
    const first = [a, b].find((s) => h.claw.eventsOf(s, "session_started").length)!;
    h.claw.issue("close", first, {});
    await h.claw.until("the first to close", () => closedReason(h, first) !== undefined);
    const again = await h.attach(REF);
    assert.equal(h.claw.eventsOf(again, "session_started").length, 1);
  });

  test("a twin that appears while it is attached stops the next prompt, and that prompt never reaches the agent", async () => {
    const h = await attachHarness();
    const sid = await h.attach(REF);
    h.prompt(sid, "say first");
    await h.turnEnd(sid, 1);
    // A terminal opens the same conversation.
    h.setLive([{ pid: process.pid, sessionId: REF, status: "idle" }]);
    h.prompt(sid, "say second");
    const rejected = await h.claw.until("the prompt to be rejected", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.equal(rejected.data.reason, "session_live");
    assert.equal((await h.turnEnd(sid, 2)).data.stopReason, "error");
    assert.deepEqual(h.adapterLog().filter((l) => l.prompt).map((l) => l.prompt), ["say first"]);
    // The terminal is closed again: the session was kept and takes the next prompt.
    h.setLive([]);
    h.prompt(sid, "say third");
    await h.turnEnd(sid, 3);
    assert.deepEqual(h.adapterLog().filter((l) => l.prompt).map((l) => l.prompt), ["say first", "say third"]);
    // The adapter that was running while the terminal had the conversation is not reused: what the terminal wrote
    // is not in its memory. The prompt went to a fresh one, started from the transcript, with the mode locked again.
    assert.equal(adapterMethods(h).filter((m) => m === "session/resume").length, 2);
    assert.equal(adapterMethods(h).filter((m) => m === "session/set_mode").length, 2);
    assert.equal(h.connector.registry.list().length, 1, "and only one adapter is left running");
  });

  test("the agent's own process is listed by the command too and is not mistaken for a twin", async () => {
    const h = await attachHarness();
    const sid = await h.attach(REF);
    // The adapter this connector started is what `claude agents --json` would show for the session.
    const adapters = h.connector.registry.list();
    assert.equal(adapters.length, 1);
    h.setLive([{ pid: adapters[0]!.pid, sessionId: REF, status: "idle" }]);
    h.prompt(sid, "say hi");
    await h.turnEnd(sid);
    assert.deepEqual(h.messages(sid), ["hi"]);
    assert.equal(h.claw.eventsOf(sid, "command_rejected").length, 0);
  });

  test("an adapter that was recycled is brought back only if no terminal took the session meanwhile; the session is kept", async () => {
    const h = await attachHarness({ timing: { idleMs: 80 } });
    const sid = await h.attach(REF);
    await h.claw.until("the adapter to be recycled", () => h.audit().some((a) => a.kind === "adapter_recycled"));
    h.setLive([{ pid: process.pid, sessionId: REF, status: "idle" }]);
    h.prompt(sid, "say hi");
    const rejected = await h.claw.until("the prompt to be rejected", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.equal(rejected.data.reason, "session_live");
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0, "the conversation is not closed because a terminal has it");
    assert.deepEqual(h.adapterLog().filter((l) => l.prompt), []);
    h.setLive([]);
    h.prompt(sid, "say hi");
    await h.turnEnd(sid, 2);
    assert.deepEqual(h.messages(sid), ["hi"]);
  });

  test("a terminal that came and went between two prompts is noticed from the transcript: the next prompt starts a fresh adapter", async () => {
    const h = await attachHarness({ timing: { recentWriteMs: 300 } });
    const sid = await h.attach(REF);
    const file = path.join(h.attachDir, "projects", fs.realpathSync(h.work).replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"user"}\n');
    const old = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(file, old, old);
    // The connector marks the transcript when a turn ends; this one ends after the file exists.
    h.prompt(sid, "say one");
    await h.turnEnd(sid, 1);
    const resumes = () => adapterMethods(h).filter((m) => m === "session/resume").length;
    // Nothing wrote to it: the same adapter goes on.
    h.prompt(sid, "say two");
    await h.turnEnd(sid, 2);
    assert.equal(resumes(), 1, "an untouched transcript does not cost a restart");
    // A terminal opened the conversation, said something and closed: nothing holds it open now.
    fs.appendFileSync(file, '{"type":"user","from":"the terminal"}\n');
    h.prompt(sid, "say three");
    const rejected = await h.claw.until("the prompt to be held back while the terminal's last write is fresh", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.equal(rejected.data.reason, "recently_written");
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0);
    assert.ok(h.audit().some((a) => a.kind === "transcript_changed"));
    assert.deepEqual(h.adapterLog().filter((l) => l.prompt).map((l) => l.prompt), ["say one", "say two"], "not sent on to the stale adapter");
    // Once it has settled, the prompt goes to an adapter that reads the transcript afresh.
    fs.utimesSync(file, old, old);
    h.prompt(sid, "say four");
    await h.turnEnd(sid, 4);
    assert.equal(resumes(), 2);
    assert.deepEqual(h.adapterLog().filter((l) => l.prompt).map((l) => l.prompt), ["say one", "say two", "say four"]);
    assert.equal(h.connector.registry.list().length, 1);
  });

  test("an agent that is not an attach agent never turns a resume request into a new conversation", async () => {
    const h = await Harness.create({});
    hs.push(h);
    await h.online();
    const sid = h.claw.newSession("fake", h.work, undefined, { resume_ref: REF });
    await h.claw.until("a refusal", () => h.claw.eventsOf(sid, "session_closed")[0]);
    assert.equal(closedReason(h, sid), "resume_not_supported");
    assert.ok(!adapterMethods(h).includes("session/new"));
  });

  test("the list is read in pages and stays within the heartbeat's limit however many sessions exist", async () => {
    const work = tmpdir("cc-work-");
    const many = Array.from({ length: 60 }, (_, i) => ({
      sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, cwd: work, title: `Session ${i} ${"t".repeat(70)}`,
      updatedAt: new Date(Date.UTC(2026, 9, 29, 10, 0, 60 - i)).toISOString(),
    }));
    const h = await Harness.create({ work, env: { FAKE_PAGE_SIZE: "7" }, attach: { sessions: many } });
    hs.push(h);
    const hb = await h.claw.until("a heartbeat with the list", () => h.claw.heartbeats.find((b) => b.agents[0].capabilities.resumable?.length));
    const list = hb.agents[0].capabilities.resumable;
    assert.ok(list.length > 0 && list.length <= MAX_REPORTED);
    assert.equal(list[0].ref, many[0]!.sessionId, "newest first, though the adapter answered in pages");
    assert.ok(Buffer.byteLength(JSON.stringify(hb.agents[0].capabilities)) <= 4096);
  });

  test("the stand-in command is run with the config directory of the agent", async () => {
    const h = await attachHarness();
    await h.attach(REF);
    const runs = fs.readFileSync(h.cliLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(runs.length > 0 && runs.every((r) => r.args === "agents --json" && r.config === h.attachDir));
  });
});
