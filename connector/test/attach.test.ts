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
  AttachSupport, MAX_REPORTED, SESSION_REF_RE, blindHolders, classifyAppended, isClaudeArgv, cleanTitle, ownTurnOf, fitResumable, liveActivity, localPidDomain, parseAgentsJson, processGroup, readRegistry,
  TranscriptTail, TwinCheckError, transcriptUpdates, type Resumable,
} from "../src/attach.js";
import { ChildRegistry, processStart } from "../src/children.js";
import { memoryAudit } from "../src/audit.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { terminalsDir, runHook } from "../src/terminals.js";
import { silentLogger } from "../src/util.js";
import { Harness, tmpdir, FAKE_CLAUDE, type AttachOptions } from "./support/harness.js";

const REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REF3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Every process a test starts is recorded here and stopped by pid (never by pattern).
const children: ChildProcess[] = [];
after(() => { for (const c of children) { try { if (c.pid && c.exitCode === null) process.kill(c.pid, "SIGKILL"); } catch { /* gone */ } } });
const sleeper = (opts: { detached?: boolean; cwd?: string } = {}): ChildProcess => {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: opts.detached ?? false, cwd: opts.cwd });
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

/** A terminal that has the conversation open: a real process and the registry row Claude Code writes for it. `leave()` is `/exit`. */
function openTerminal(dir: string, ref = REF, cwd?: string): { pid: number; leave(): Promise<void> } {
  const proc = sleeper({ cwd });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const row = path.join(dir, "sessions", `${proc.pid}.json`);
  fs.writeFileSync(row, JSON.stringify({ pid: proc.pid, sessionId: ref, status: "busy", kind: "interactive", procStart: processStart(proc.pid!), pidDomain: localPidDomain() }));
  return { pid: proc.pid!, leave: async () => { await stop(proc); fs.rmSync(row, { force: true }); } };
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

  test("a row from another host or container counts as open when the command answers too: the command cannot see it", async () => {
    if (localPidDomain() === null) return; // only Linux names a pid namespace
    const own = sleeper({ detached: true });
    const cases: Array<{ name: string; live: unknown[]; pid: number; ownPgid: number | null }> = [
      { name: "the command lists nothing", live: [], pid: 999999, ownPgid: null },
      { name: "its pid is a number the command lists for another session", live: [{ pid: 4242, sessionId: REF2 }], pid: 4242, ownPgid: null },
      { name: "its pid is that of this connector's own agent: a number from another namespace is not our agent", live: [{ pid: own.pid, sessionId: REF }], pid: own.pid!, ownPgid: own.pid! },
    ];
    for (const c of cases) {
      const dir = configDir();
      registryRow(dir, c.pid, { pidDomain: "linux:other-host:pid:[7]" });
      const fake = fakeCli("ok", c.live);
      const v = await support(dir, { cli: fake.cli, cliEnv: fake.env }).check(REF, { ownPgid: c.ownPgid, transcript: false });
      assert.equal(v.ok ? "ok" : v.reason, "session_live", c.name);
      assert.match(v.ok ? "" : v.detail, /cannot see/, c.name);
    }
    // The same row written by a process of this machine, and that process is our own agent: not a twin.
    const dir = configDir();
    registryRow(dir, own.pid!, { procStart: processStart(own.pid!), pidDomain: localPidDomain() });
    const fake = fakeCli("ok", [{ pid: own.pid, sessionId: REF }]);
    assert.equal((await support(dir, { cli: fake.cli, cliEnv: fake.env }).check(REF, { ownPgid: own.pid!, transcript: false })).ok, true);
  });

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

/** The row a terminal session's hook keeps (terminals.ts): `procStart` and `pidDomain` default to the real process's. */
function hookRow(dir: string, pid: number, extra: Record<string, unknown> = {}, name = `${pid}.json`): void {
  fs.mkdirSync(terminalsDir(dir), { recursive: true });
  fs.writeFileSync(path.join(terminalsDir(dir), name), JSON.stringify({ v: 1, pid, procStart: processStart(pid), sessionId: REF, cwd: "/w", at: Date.now(), pidDomain: localPidDomain(), ...extra }));
}

// A Claude Code process whose registry row is unreadable (an empty sessions/<pid>.json, measured on a dev pod 2026-11-09: a
// terminal session open for days was offered to be taken over, as "idle").
const claudeNamed = (cwd: string, detached = false): ChildProcess => {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", cwd, argv0: "claude", detached });
  children.push(c);
  return c;
};
// (older than the grace an unreadable row gets while it may be being written: one written moments ago already refuses everything)
const emptyRow = (dir: string, pid: number) => {
  const file = path.join(dir, "sessions", `${pid}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const t = (Date.now() - 3_600_000) / 1000;
  fs.utimesSync(file, t, t);
};

describe("a Claude Code process whose registry row cannot be read", () => {
  test("is found by its pid, its program and its folder; a readable row, or a process that is not Claude Code, is not", { skip: process.platform !== "linux" }, async () => {
    const dir = configDir();
    const work = fs.realpathSync(tmpdir("cc-blind-"));
    const blind = claudeNamed(work);
    const other = sleeper();
    await new Promise((r) => setTimeout(r, 100));
    emptyRow(dir, blind.pid!);
    emptyRow(dir, other.pid!);   // (an unreadable row of a process that is not Claude Code says nothing about a conversation)
    registryRow(dir, 4242, { procStart: "1" });
    assert.deepEqual(await blindHolders(dir), [{ pid: blind.pid, pgid: processGroup(blind.pid!), cwd: work }]);
    assert.equal(isClaudeArgv(["claude"]), true);
    assert.equal(isClaudeArgv(["/usr/bin/node", "/opt/x/node_modules/@anthropic-ai/claude-code/cli.js"]), true);
    assert.equal(isClaudeArgv(["node", "/opt/claude-agent-acp/dist/index.js"]), false);
  });

  test("the twin check refuses: it cannot tell that the conversation is free, and a second writer is never started", { skip: process.platform !== "linux" }, async () => {
    const dir = configDir();
    const blind = claudeNamed(os.tmpdir());
    await new Promise((r) => setTimeout(r, 100));
    emptyRow(dir, blind.pid!);
    const v = await support(dir).check(REF, { ownPgid: null, transcript: false });
    assert.equal(v.ok ? "ok" : v.reason, "twin_check_failed");
    assert.match(v.ok ? "" : v.detail, new RegExp(`process ${blind.pid} .*sessions/${blind.pid}\\.json cannot be read`));
    await stop(blind);
    assert.equal((await support(dir).check(REF, { ownPgid: null, transcript: false })).ok, true, "once that process is gone, the row says nothing");
  });

  test("this connector's own adapter (the process group it leads) is never taken for such a holder", { skip: process.platform !== "linux" }, async () => {
    const dir = configDir();
    const mine = claudeNamed(os.tmpdir(), true);   // (detached: it leads its own group, as an adapter the connector starts does)
    await new Promise((r) => setTimeout(r, 100));
    emptyRow(dir, mine.pid!);
    assert.equal((await support(dir).check(REF, { ownPgid: mine.pid!, transcript: false })).ok, true);
    assert.equal((await support(dir).check(REF, { ownPgid: null, transcript: false })).ok, false, "anyone else's: refused");
  });

  test("a session this connector holds with its own adapter is not stopped by another process's unreadable row (each prompt checks)", { skip: process.platform !== "linux" }, async () => {
    const dir = configDir();
    const unrelated = claudeNamed(os.tmpdir());   // (an unrelated terminal in the same folder, its row empty)
    const mine = sleeper({ detached: true });     // (this connector's adapter, leading its own group)
    await new Promise((r) => setTimeout(r, 100));
    emptyRow(dir, unrelated.pid!);
    assert.equal((await support(dir).check(REF, { ownPgid: mine.pid!, transcript: false })).ok, true, "the held session goes on");
    assert.equal((await support(dir).check(REF, { ownPgid: null, transcript: false })).ok, false, "a new writer is still refused");
  });
});

describe("the terminal hooks' rows in the twin check", () => {
  type Case = {
    name: string;
    hook: "live" | "other-session" | "killed" | "recycled" | "foreign" | "own-group" | "broken-young" | "none";
    cli?: { mode: string; live: unknown[] };
    claudeRegistry?: "none" | "empty" | "live-twin";
    ref?: string;
    expect: "ok" | "session_live" | "twin_check_failed";
    detail?: RegExp;
    /** Answered without waiting for the command (which here would run into its timeout). */
    fast?: boolean;
  };
  const cases: Case[] = [
    { name: "a terminal's row names the session: refused, and the detail says it is in a terminal", hook: "live", cli: { mode: "ok", live: [] }, claudeRegistry: "empty", expect: "session_live", detail: /open in a terminal \(pid \d+/ },
    { name: "the rows are asked first: a command that hangs is never waited for", hook: "live", cli: { mode: "hang", live: [] }, claudeRegistry: "empty", expect: "session_live", fast: true },
    { name: "the rows alone answer when nothing else can (no command, no registry would be unanswerable)", hook: "live", claudeRegistry: "none", expect: "session_live", detail: /terminal/ },
    { name: "the id is compared whatever its case", hook: "live", ref: REF.toUpperCase(), cli: { mode: "ok", live: [] }, claudeRegistry: "empty", expect: "session_live" },
    { name: "a row for another session is not this one", hook: "other-session", cli: { mode: "ok", live: [] }, claudeRegistry: "empty", expect: "ok" },
    { name: "a row whose process was killed (kill -9 ran no SessionEnd) is not open", hook: "killed", cli: { mode: "ok", live: [] }, claudeRegistry: "empty", expect: "ok" },
    { name: "a row whose pid now belongs to another process is not open", hook: "recycled", cli: { mode: "ok", live: [] }, claudeRegistry: "empty", expect: "ok" },
    { name: "a row from another host or container cannot be checked and counts", hook: "foreign", cli: { mode: "ok", live: [] }, claudeRegistry: "empty", expect: "session_live", detail: /cannot see/ },
    { name: "this connector's own agent is not a twin, whoever registered it", hook: "own-group", cli: { mode: "ok", live: [] }, claudeRegistry: "empty", expect: "ok" },
    { name: "no rows at all: Claude Code's own registry still refuses (the fallback)", hook: "none", cli: { mode: "ok", live: [] }, claudeRegistry: "live-twin", expect: "session_live", detail: /process \d+ has it open/ },
    { name: "no rows and the command lists it: still refused", hook: "none", cli: { mode: "ok", live: [{ pid: 4242, sessionId: REF, status: "idle" }] }, claudeRegistry: "empty", expect: "session_live", detail: /process 4242/ },
    { name: "rows that cannot be read add nothing: the registry still refuses", hook: "broken-young", cli: { mode: "ok", live: [] }, claudeRegistry: "live-twin", expect: "session_live", detail: /process \d+ has it open/ },
    { name: "rows that cannot be read never turn a yes into a no: nothing else is open", hook: "broken-young", cli: { mode: "ok", live: [] }, claudeRegistry: "empty", expect: "ok" },
    { name: "rows that say nothing do not make an unanswerable check answerable", hook: "none", cli: { mode: "fail", live: [] }, claudeRegistry: "none", expect: "twin_check_failed" },
    { name: "a row for another session does not make an unanswerable check answerable either", hook: "other-session", cli: { mode: "fail", live: [] }, claudeRegistry: "none", expect: "twin_check_failed" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const dir = configDir();
      if (c.claudeRegistry === "none") fs.rmSync(path.join(dir, "sessions"), { recursive: true });
      const term = sleeper();
      const own = sleeper({ detached: true });
      const gone = sleeper();
      if (c.hook === "live") hookRow(dir, term.pid!);
      if (c.hook === "other-session") hookRow(dir, term.pid!, { sessionId: REF2 });
      if (c.hook === "killed") { hookRow(dir, gone.pid!); await stop(gone); }
      if (c.hook === "recycled") hookRow(dir, term.pid!, { procStart: "1" });
      if (c.hook === "foreign") hookRow(dir, 999999, { procStart: null, pidDomain: "linux:other-host:pid:[7]" });
      if (c.hook === "own-group") hookRow(dir, own.pid!);
      if (c.hook === "broken-young") { fs.mkdirSync(terminalsDir(dir), { recursive: true }); fs.writeFileSync(path.join(terminalsDir(dir), "1.json"), "{ half a fi"); }
      if (c.claudeRegistry === "live-twin") registryRow(dir, term.pid!, { procStart: processStart(term.pid!), pidDomain: localPidDomain() });
      const fake = c.cli ? fakeCli(c.cli.mode, c.cli.live) : null;
      if (c.hook === "foreign" && localPidDomain() === null) return; // only Linux names a pid namespace
      const t0 = Date.now();
      const v = await support(dir, { cli: fake?.cli, cliEnv: fake?.env }).check(c.ref ?? REF, { ownPgid: c.hook === "own-group" ? own.pid! : null, transcript: false });
      assert.equal(v.ok ? "ok" : v.reason, c.expect, v.ok ? "" : v.detail);
      if (c.detail) assert.match(v.ok ? "" : v.detail, c.detail);
      if (c.fast) assert.ok(Date.now() - t0 < 1000, `answered in ${Date.now() - t0} ms: the command (timeout 1500 ms) was waited for`);
    });
  }

  test("a terminal opens the session, then exits: refused, then allowed; with kill -9 it is allowed too, because the process is gone", async () => {
    const dir = configDir();
    const s = support(dir);
    const env = (pid: number) => ({ CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_PID: String(pid) });
    const hook = (event: "start" | "end", pid: number) =>
      runHook({ event, configDir: dir, stdin: JSON.stringify({ session_id: REF, cwd: "/w" }), env: env(pid), ppid: 1 }, { ancestors: () => [pid] });
    assert.equal((await s.check(REF, { transcript: false })).ok, true, "before: nothing open");
    const a = sleeper();
    assert.equal(hook("start", a.pid!).done, "registered");
    assert.equal((await s.check(REF, { transcript: false })).ok, false, "open in a terminal: refused");
    assert.equal(hook("end", a.pid!).done, "unregistered");
    assert.equal((await s.check(REF, { transcript: false })).ok, true, "/exit: allowed");
    const b = sleeper();
    hook("start", b.pid!);
    assert.equal((await s.check(REF, { transcript: false })).ok, false);
    await stop(b);
    assert.equal((await s.check(REF, { transcript: false })).ok, true, "kill -9: no SessionEnd, but the process is gone");
  });

  test("the rows add to the live list and to the look the connector takes while its own agent works", async () => {
    const dir = configDir();
    const term = sleeper();
    const own = sleeper({ detached: true });
    hookRow(dir, term.pid!);
    hookRow(dir, own.pid!, { sessionId: REF2 });
    const fake = fakeCli("ok", []);
    const s = support(dir, { cli: fake.cli, cliEnv: fake.env });
    const live = await s.liveEntries();
    assert.deepEqual(live.filter((e) => e.via === "hook").map((e) => [e.pid, e.sessionId]).sort(), [[term.pid, REF], [own.pid, REF2]].sort());
    assert.equal(s.peek(REF, null)?.twin?.pid, term.pid, "peek sees the terminal");
    assert.equal(s.peek(REF, own.pid!)?.twin?.pid, term.pid, "another process group is not this connector's own");
    assert.equal(s.peek(REF2, own.pid!)?.twin, null, "the process group that is its own is not a twin");
    assert.equal(s.peek(REF3, null)?.twin, null);
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
    // The flag that says a conversation in a terminal can be watched never makes a valid heartbeat invalid.
    const bare = new TextEncoder().encode(JSON.stringify({ ...base, roots: ["/"] })).length;
    const near = { ...base, roots: ["/".concat("x".repeat(4090 - bare))] };
    const flagged = { ...near, watch_live: true };
    assert.ok(new TextEncoder().encode(JSON.stringify(near)).length <= 4096 && new TextEncoder().encode(JSON.stringify(flagged)).length > 4096, "the case is the one that matters");
    assert.deepEqual(fitResumable(flagged, items), near);
    assert.deepEqual(fitResumable({ ...base, watch_live: true }, []), { ...base, watch_live: true, resumable: [] }, "with room, it is said");
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

describe("reading a transcript another process writes", () => {
  test("each line becomes what an adapter would have sent; what a phone has no use for is nothing", () => {
    const j = (d: unknown) => JSON.stringify(d);
    const rows: Array<[string, string, Array<[string, unknown]>]> = [
      ["the user's words", j({ type: "user", message: { role: "user", content: "hi" } }), [["user_message_chunk", "hi"]]],
      ["the agent's words", j({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }), [["agent_message_chunk", "ok"]]],
      ["a step it starts", j({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/b.ts" } }] } }), [["tool_call", "Read: /a/b.ts"]]],
      ["how a step ended", j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "boom" }] }] } }), [["tool_call_update", "failed"]]],
      ["thinking", j({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }] } }), []],
      ["a sub-agent", j({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "x" }] } }), []],
      ["Claude Code's own lines", j({ type: "user", isMeta: true, message: { content: "x" } }), []],
      ["a summary", j({ type: "summary", summary: "x" }), []],
      ["not JSON", "{ half", []],
      ["empty text", j({ type: "assistant", message: { content: [{ type: "text", text: "  " }] } }), []],
    ];
    for (const [what, line, want] of rows) {
      const got = transcriptUpdates(line).map((u) => [u.type, u.type === "tool_call" ? u.update.title : u.type === "tool_call_update" ? u.update.status : (u.update.content as { text: string }).text]);
      assert.deepEqual(got, want, what);
    }
  });

  test("the tail reads only what is new, waits for a line to be whole, survives a character split across reads and a rewrite", () => {
    const file = path.join(tmpdir("cc-tail-"), "t.jsonl");
    let where: string | null = null;
    const tail = new TranscriptTail(() => where);
    assert.deepEqual(tail.backlog(), [], "no file yet");
    where = file;
    const say = (t: string) => `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t } ] } })}\n`;
    fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => say(`old ${i}`)).join(""));
    const texts = (us: ReturnType<TranscriptTail["poll"]>) => us.map((u) => (u.update.content as { text: string }).text);
    assert.deepEqual(texts(new TranscriptTail(() => file).backlog()).length, 20, "the backlog is the last twenty");
    // A backlog read that ends inside a character keeps its first bytes: the line completes on the next poll, whole.
    const cutFile = path.join(path.dirname(file), "cut.jsonl");
    const whole = Buffer.from(say("下一步"));
    const mid = whole.indexOf(Buffer.from("下")) + 2;
    fs.writeFileSync(cutFile, Buffer.concat([Buffer.from(say("before")), whole.subarray(0, mid)]));
    const cutTail = new TranscriptTail(() => cutFile);
    assert.deepEqual(texts(cutTail.backlog()), ["before"]);
    fs.appendFileSync(cutFile, whole.subarray(mid));
    assert.deepEqual(texts(cutTail.poll()), ["下一步"]);
    tail.fromEnd();
    assert.deepEqual(tail.poll(), []);
    const line = Buffer.from(say("完成了"));
    const cut = line.indexOf(Buffer.from("完")) + 1;   // inside the character
    fs.appendFileSync(file, line.subarray(0, cut));
    assert.deepEqual(tail.poll(), [], "half a line is held");
    fs.appendFileSync(file, line.subarray(cut));
    assert.deepEqual(texts(tail.poll()), ["完成了"]);
    fs.writeFileSync(file, say("rewritten"));
    assert.deepEqual(tail.poll(), [], "a rewritten file is followed from its new end");
    fs.appendFileSync(file, say("after"));
    assert.deepEqual(texts(tail.poll()), ["after"]);
  });
});

// ---- the connector, end to end ---------------------------------------------------------------------------

const hs: Harness[] = [];
after(async () => { for (const h of hs) await h.close(); });

async function attachHarness(o: { live?: Array<Record<string, unknown>>; cliMode?: string; env?: Record<string, string>; timing?: Record<string, number>; sessions?: AttachOptions["sessions"]; approval?: "ask" | "never"; askMode?: string } = {}): Promise<Harness> {
  const work = tmpdir("cc-work-");
  const h = await Harness.create({
    work, env: o.env, timing: o.timing, approval: o.approval, askMode: o.askMode,
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

/** What Claw sends with a takeover the person has just confirmed: the flag and until when the confirmation holds. */
const fresh = () => ({ takeover: true, takeover_until: Date.now() + 5 * 60_000 });
const closedReason = (h: Harness, sid: string) => h.claw.eventsOf(sid, "session_closed")[0]?.data.reason;
const adapterMethods = (h: Harness) => h.adapterLog().map((l) => l.method).filter(Boolean);

// The shapes Claude Code writes, as measured on 2.1.312 (claude-agent-acp 0.99.0) and 2.1.319 (a terminal), contents cut.
const jl = (...entries: Array<Record<string, unknown>>) => entries.map((e) => JSON.stringify(e) + "\n").join("");
const SDK = { entrypoint: "sdk-cli", userType: "external", isSidechain: false, sessionId: REF };
const CLI = { ...SDK, entrypoint: "cli" };
const agentTurn = (text: string) => [
  { type: "queue-operation", operation: "enqueue", sessionId: REF },
  { type: "queue-operation", operation: "dequeue", sessionId: REF },
  { ...SDK, type: "user", message: { role: "user", content: text }, promptSource: "sdk", origin: { kind: "human" } },
  { type: "api-request", sessionId: REF },
  { ...SDK, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
];
/** The agent's own turn that started a background task (`run_in_background`), which records the task's id. */
const startedTask = (id: string) => [
  ...agentTurn("run the tests in the background"),
  { ...SDK, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: {} }] } },
  { ...SDK, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: "running" }] }, toolUseResult: { stdout: "", backgroundTaskId: id } },
];
/** A background task has finished: Claude Code writes the notification as its own prompt and answers it. */
const notified = (id: string) => ({ ...SDK, type: "user", message: { role: "user", content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` }, promptSource: "system", origin: { kind: "task-notification", producer: "session-task", runId: "r1" } });
const selfTurn = [
  { type: "queue-operation", operation: "enqueue", sessionId: REF },
  { type: "queue-operation", operation: "dequeue", sessionId: REF },
  notified("bktod8m08"),
  { type: "api-request-blob", message: { role: "user", content: [{ type: "text", text: "…" }] } },
  { type: "api-request", sessionId: REF },
  { ...SDK, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
  { ...SDK, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }, toolUseResult: {} },
  { ...SDK, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } },
  { ...SDK, type: "system", subtype: "turn_duration", isMeta: false },
  { type: "last-prompt", sessionId: REF }, { type: "ai-title", sessionId: REF }, { type: "mode", sessionId: REF },
];
/** A person typed a prompt in a terminal: the same session, another program. */
const typedTurn = [
  { type: "file-history-snapshot", sessionId: REF },
  { ...CLI, type: "user", message: { role: "user", content: "fix it" }, promptSource: "typed", origin: { kind: "human" } },
  { ...CLI, type: "attachment" },
  { ...CLI, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fixed" }] } },
  { ...CLI, type: "system", subtype: "turn_duration", isMeta: false },
];

describe("who wrote what a transcript gained between two prompts", () => {
  const OWN = { entrypoint: "sdk-cli", tasks: new Set(["bktod8m08"]) };
  const classify = (text: string, own: { entrypoint: string | null; tasks: ReadonlySet<string> } = OWN) => classifyAppended(text, own, Buffer.byteLength(text));

  test("the agent's own turn on a finished background task, and its own interruption note, are its own", () => {
    assert.deepEqual(classify(jl(...selfTurn)), { by: "self", size: Buffer.byteLength(jl(...selfTurn)), tasks: [] });
    const interrupted = jl({ ...SDK, type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
    assert.equal(classify(interrupted).by, "self");
    assert.equal(classify("").by, "self", "nothing written");
  });

  test("a person's prompt typed in a terminal is not, nor anything another program wrote", () => {
    assert.equal(classify(jl(...typedTurn)).by, "other");
    // Even one entry of a terminal among the agent's own.
    assert.equal(classify(jl(...selfTurn, { ...CLI, type: "attachment" })).by, "other");
    // A terminal's entries with no prompt in them (opened, a slash command, closed) are still a terminal's.
    assert.equal(classify(jl({ ...CLI, type: "system", subtype: "local_command" })).by, "other");
  });

  test("a notification of a task this agent did not start is another process's turn, though it is the same program", () => {
    // Another SDK process (a second adapter, a `claude -p`) that resumed the conversation, started a task and left.
    assert.deepEqual(classify(jl(notified("bzzzzzzzz"))), { by: "other", why: "a notification of a task this agent did not start" });
    assert.equal(classify(jl({ ...notified("bktod8m08"), message: { role: "user", content: "<task-notification>no id</task-notification>" } })).by, "other");
    // A task the agent's own turn on a notification started is its own too, and so is that task's notification later.
    const chained = jl(...selfTurn.slice(0, 6), { ...SDK, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "" }] }, toolUseResult: { backgroundTaskId: "b2" } });
    assert.deepEqual(classify(chained), { by: "self", size: Buffer.byteLength(chained), tasks: ["b2"] });
    assert.equal(classify(jl(notified("b2"))).by, "other", "not before it is known");
    assert.equal(classify(jl(notified("b2")), { entrypoint: "sdk-cli", tasks: new Set(["b2"]) }).by, "self");
  });

  test("a prompt the connector did not send is someone else's turn, even from the same kind of program (`claude -p`)", () => {
    assert.equal(classify(jl(...agentTurn("hello"))).by, "other");
    assert.equal(classify(jl({ ...SDK, type: "user", message: { role: "user", content: [{ type: "image" }] } })).by, "other", "an image is a prompt too");
    assert.equal(classify(jl({ ...SDK, type: "user" })).by, "other", "a user entry that says nothing about what it is: not the agent's for certain");
    assert.equal(classify(jl({ ...SDK, type: "user", message: { role: "user", content: "x" }, origin: { kind: "something-new" } })).by, "other", "an origin not known to be the agent's own");
  });

  test("while the agent's own program is not known, any entry that names one is not its own; what cannot be read is not either", () => {
    assert.equal(classify(jl(...selfTurn), { entrypoint: null, tasks: OWN.tasks }).by, "other");
    assert.equal(classify(jl({ type: "last-prompt" }), { entrypoint: null, tasks: new Set() }).by, "self", "an entry that names no program and is no prompt");
    assert.equal(classify("{not json}\n").by, "other");
    assert.equal(classify("[1]\n").by, "other");
    assert.deepEqual(classify(jl(...selfTurn).slice(0, -5)), { by: "partial" }, "an entry still being written");
  });

  test("the program that wrote a turn, and the tasks it started, are read from the turn: one program, or none when two did", () => {
    assert.deepEqual(ownTurnOf(jl(...agentTurn("hi"))), { entrypoint: "sdk-cli", tasks: [] });
    assert.deepEqual(ownTurnOf(jl(...startedTask("bktod8m08"))), { entrypoint: "sdk-cli", tasks: ["bktod8m08"] });
    assert.equal(ownTurnOf(jl(...agentTurn("hi"), ...typedTurn)).entrypoint, null);
    assert.equal(ownTurnOf(jl({ type: "mode" })).entrypoint, null);
  });
});

describe("attach end to end", () => {
  test("the heartbeat lists what can be taken over, newest first, inside the roots, with its state; the kind is opaque", async () => {
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF2, status: "idle" }] });
    await h.online();
    const hb = await h.claw.until("a heartbeat with the list", () => h.claw.heartbeats.find((b) => b.agents[0].capabilities.resumable?.length));
    const a = hb.agents[0];
    assert.equal(a.kind, "attach");
    assert.equal(a.capabilities.watch_live, true, "it says a conversation open in a terminal can be watched");
    assert.deepEqual(a.capabilities.resumable.map((r: any) => [r.ref, r.title, r.state]), [[REF, "Fix the flaky test", "idle"], [REF2, "Second", "live"]], "REF3 is outside the roots and is not offered");
    assert.equal(a.capabilities.resumable[0].updated_at, Date.parse("2026-10-29T10:00:00.000Z") / 1000);
    assert.equal(a.capabilities.resumable[0].cwd, fs.realpathSync(h.work));
    assert.ok(!JSON.stringify(a).includes("claude") && !JSON.stringify(a).includes("Claude"), "Claw is told nothing about the product");
  });

  test("a conversation in the folder of a Claude Code whose registry row cannot be read is reported unknown, not idle", { skip: process.platform !== "linux" }, async () => {
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF2, status: "idle" }] });
    const blind = claudeNamed(fs.realpathSync(h.work));
    await new Promise((r) => setTimeout(r, 100));
    emptyRow(h.attachDir, blind.pid!);
    await h.online();
    // (the connector may have reported once before the row was written: the report after it is the one that counts)
    const hb = await h.claw.until("a heartbeat that says REF is unknown", () => h.claw.heartbeats.find((b) =>
      b.agents[0].capabilities.resumable?.some((r: any) => r.ref === REF && r.state === "unknown")));
    // REF was "idle" (offered to take over); REF2 is still the live one its own row names
    assert.deepEqual(hb.agents[0].capabilities.resumable.map((r: any) => [r.ref, r.state]), [[REF, "unknown"], [REF2, "live"]]);
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

  test("a taken-over session says whether it asks: it does by default, and with approval = never it is unattended, in the agent's own mode", async () => {
    const asks = await attachHarness({ env: { FAKE_RESUME_RESETS: "bypassPermissions" } });
    const sid1 = await asks.attach(REF);
    const a = asks.claw.eventsOf(sid1, "session_started")[0]!.data;
    assert.deepEqual([a.currentMode, a.unattended], ["default", false]);
    assert.equal(asks.audit().find((x) => x.kind === "session_attached")?.unattended, false);
    await asks.online();
    const hb1 = await asks.claw.until("a heartbeat", () => asks.claw.heartbeats.at(-1));
    assert.deepEqual([hb1.agents[0].capabilities.unattended, hb1.agents[0].capabilities.unattended_allowed], [false, false]);

    const never = await attachHarness({ approval: "never", askMode: "bypassPermissions", env: { FAKE_RESUME_RESETS: "default" } });
    const sid2 = await never.attach(REF);
    const n = never.claw.eventsOf(sid2, "session_started")[0]!.data;
    assert.deepEqual([n.currentMode, n.unattended, n.attached], ["bypassPermissions", true, true], "the mode the transcript was left in is replaced by the agent's own, and the phone is told it does not ask");
    assert.equal(never.audit().find((x) => x.kind === "session_attached")?.unattended, true);
    assert.ok(n.modes.every((m: { unattended: boolean }) => typeof m.unattended === "boolean"), "every mode offered says whether it asks");
    await never.online();
    const hb2 = await never.claw.until("a heartbeat", () => never.claw.heartbeats.at(-1));
    assert.deepEqual([hb2.agents[0].capabilities.unattended, hb2.agents[0].capabilities.unattended_allowed], [true, true]);
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

  test("a conversation open in a terminal is watched read-only: its output arrives, nothing typed reaches it, and the watch ends with the terminal", async () => {
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF, status: "busy" }], timing: { spectateMs: 20, spectateCheckMs: 100 } });
    const file = path.join(h.attachDir, "projects", fs.realpathSync(h.work).replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (doc: Record<string, unknown>) => fs.appendFileSync(file, `${JSON.stringify({ sessionId: REF, isSidechain: false, ...doc })}\n`);
    line({ type: "user", message: { role: "user", content: "run the tests" } });
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Running them now." }] } });
    const sid = await h.attach(REF);
    const started = h.claw.eventsOf(sid, "session_started")[0]!.data;
    assert.deepEqual([started.read_only, started.read_only_reason, started.attached, started.acp_session_id], [true, "session_live", true, REF]);
    assert.equal(closedReason(h, sid), undefined, "not refused: watched");
    assert.deepEqual(adapterMethods(h).filter((m) => m !== "initialize" && m !== "session/list"), [], "nothing was resumed or started");
    assert.ok(h.audit().some((a) => a.kind === "session_spectating"));
    // What was there before: sent once, marked as history, right after session_started. The connector posts events in
    // batches as their lines reach its outbox on disk, so session_started can be posted (and `attach` return) one batch
    // ahead of the history: it is waited for, not assumed to have come in the same request.
    const history = () => h.claw.eventsOf(sid).filter((e) => e.data.replay === true)
      .map((e) => [e.type, e.data.update.content.text, e.data.read_only]);
    const shown: unknown[][] = [["user_message_chunk", "run the tests", true], ["agent_message_chunk", "Running them now.", true]];
    await h.claw.until("the history", () => history().length >= shown.length);
    assert.deepEqual(history(), shown);
    assert.deepEqual(h.claw.eventsOf(sid).slice(0, 3).map((e) => e.type), ["session_started", "user_message_chunk", "agent_message_chunk"], "the history follows session_started, before anything new");
    // The terminal goes on: each new line arrives, scrubbed, as the update an adapter would have sent.
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "a private musing" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] } });
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12 passed, token ghp_abcdefghijklmnopqrstuvwxyz0123 seen" }] } });
    line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "a sub-agent's aside" }] } });
    fs.appendFileSync(file, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "全部通过。" }] } }).slice(0, 40));
    const call = await h.claw.until("the tool call", () => h.claw.eventsOf(sid, "tool_call")[0]);
    assert.deepEqual([call.data.update.toolCallId, call.data.update.title, call.data.read_only, call.data.replay], ["toolu_1", "Bash: npm test", true, undefined]);
    const result = await h.claw.until("its result", () => h.claw.eventsOf(sid, "tool_call_update")[0]);
    assert.equal(result.data.update.status, "completed");
    assert.ok(!JSON.stringify(result.data).includes("ghp_abcdef"), "a credential in the output is masked before it leaves");
    assert.match(JSON.stringify(result.data), /12 passed/);
    // A line written in two pieces is read once it is whole.
    fs.appendFileSync(file, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "全部通过。" }] } }).slice(40)}\n`);
    await h.claw.until("the last line", () => h.claw.eventsOf(sid, "agent_message_chunk").find((e) => e.data.update.content.text === "全部通过。"));
    assert.ok(!h.claw.eventsOf(sid).some((e) => JSON.stringify(e.data).includes("private musing") || JSON.stringify(e.data).includes("sub-agent")), "thinking and sub-agents are not shown");
    assert.deepEqual(history(), shown, "the history was sent once, and nothing new is marked as history");

    // Typing into it is refused, by name, and not one byte reaches the transcript.
    const bytes = fs.readFileSync(file);
    const seq = h.prompt(sid, "say do something else");
    const rejected = await h.claw.until("the prompt to be refused", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.deepEqual([rejected.data.type, rejected.data.reason, rejected.data.cmd_seq], ["prompt", "read_only_live_session", seq]);
    const end = await h.turnEnd(sid);
    assert.deepEqual([end.data.stopReason, end.data.error, end.data.cmd_seq], ["error", "read_only_live_session", seq]);
    h.claw.issue("set_mode", sid, { mode_id: "plan" });
    await h.claw.until("the mode change to be refused", () => h.claw.eventsOf(sid, "command_rejected")[1]);
    assert.equal(h.claw.eventsOf(sid, "command_rejected")[1]!.data.reason, "read_only_live_session");
    h.claw.issue("resume", sid, {});
    const resumed = await h.claw.until("the resume to answer", () => h.claw.eventsOf(sid, "session_resumed")[0]);
    assert.equal(resumed.data.read_only, true);
    assert.deepEqual(h.adapterLog().filter((l) => l.prompt), [], "no prompt reached any agent");
    assert.ok(!adapterMethods(h).some((m) => m === "session/resume" || m === "session/prompt" || m === "session/set_mode"), "no agent was started");
    assert.ok(fs.readFileSync(file).equals(bytes), "the transcript is exactly as the terminal left it");
    // The list still says the terminal has it: watching is not holding.
    await h.claw.until("a heartbeat that says live", () => [...h.claw.heartbeats].reverse().find((b) => b.agents[0].capabilities.resumable?.find((r: any) => r.ref === REF)?.state === "live"));

    // The terminal is closed: the watch ends, and the conversation can now be taken over through the full check.
    h.setLive([]);
    await h.claw.until("the watch to end", () => closedReason(h, sid) !== undefined);
    assert.equal(closedReason(h, sid), "terminal_closed");
    const old = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(file, old, old);
    const again = await h.attach(REF);
    const taken = h.claw.eventsOf(again, "session_started")[0]!.data;
    assert.equal(taken.read_only, undefined);
    assert.equal(adapterMethods(h).filter((m) => m === "session/resume").length, 1);
  });

  test("a takeover the person confirmed ends the terminal that has the conversation open, then resumes it; without it, the same request is only watched", async () => {
    const h = await attachHarness({ timing: { spectateMs: 20, spectateCheckMs: 60_000, recentWriteMs: 300, takeoverWaitMs: 8_000 } });
    const file = path.join(h.attachDir, "projects", fs.realpathSync(h.work).replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: "user", sessionId: REF, message: { role: "user", content: "hello" } })}\n`);
    // The terminal: a real process that, like Claude Code on SIGTERM, writes the end of its transcript, drops its row and exits.
    const liveFile = (h as unknown as { liveFile: string }).liveFile;
    // (the paths reach it through its environment, never through the code it runs)
    const script = 'process.on("SIGTERM", () => { const fs = require("fs"); fs.appendFileSync(process.env.T_FILE, JSON.stringify({ type: "system", subtype: "end" }) + "\\n"); fs.writeFileSync(process.env.T_LIVE, "[]"); process.exit(0); }); setInterval(() => {}, 1000);';
    const term = spawn(process.execPath, ["-e", script], { stdio: "ignore", cwd: h.work, env: { ...process.env, T_FILE: file, T_LIVE: liveFile } });
    children.push(term);
    await new Promise((r) => setTimeout(r, 300));   // (its handler is in place)
    h.setLive([{ pid: term.pid, sessionId: REF, status: "busy" }]);

    const watched = await h.attach(REF);
    assert.equal(h.claw.eventsOf(watched, "session_started")[0]!.data.read_only, true, "no takeover asked for: watched");
    assert.equal(term.exitCode, null, "the terminal is untouched by a request that did not ask to take it over");
    h.claw.issue("close", watched, {});
    await h.claw.until("the watch to close", () => closedReason(h, watched) !== undefined);

    const exited = new Promise<number | null>((r) => term.once("exit", (code) => r(code)));
    const sid = await h.attach(REF, h.work, fresh());
    assert.equal(closedReason(h, sid), undefined, `taken over, not refused (${closedReason(h, sid)})`);
    const started = h.claw.eventsOf(sid, "session_started")[0]!.data;
    assert.deepEqual([started.read_only, started.took_over, started.acp_session_id], [undefined, true, REF]);
    assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 5_000))]), 0, "the terminal was asked to end and ended by itself");
    assert.equal(adapterMethods(h).filter((m) => m === "session/resume").length, 1, "resumed once, after the terminal was gone");
    assert.match(fs.readFileSync(file, "utf8"), /"subtype":"end"/, "what the terminal wrote on its way out is kept");
    const ended = h.audit().find((a) => a.kind === "terminal_ended");
    assert.deepEqual(ended?.pids, [term.pid]);
    await h.online();
    const hb = await h.claw.until("a heartbeat", () => h.claw.heartbeats.at(-1));
    assert.equal(hb.agents[0].capabilities.takeover, true, "the phone is told a takeover can be asked for");
  });

  test("a holder proven by its registry row (this machine's pid domain, the same process start) is ended too, without the command's word", async () => {
    const h = await attachHarness({ live: [], cliMode: "fail", timing: { recentWriteMs: 100, takeoverWaitMs: 5_000, spectateMs: 20, spectateCheckMs: 60_000 } });
    const term = openTerminal(h.attachDir, REF, h.work);
    const sid = await h.attach(REF, h.work, fresh());
    assert.equal(closedReason(h, sid), undefined, `taken over (${closedReason(h, sid)})`);
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.took_over, true);
    assert.ok(!(await import("../src/children.js")).isAlive(term.pid), "the terminal's process was ended");
  });

  test("a takeover that reaches the machine after its confirmation lapsed, or names no deadline, ends nothing and resumes nothing", async () => {
    for (const [label, extra] of [["late", { takeover: true, takeover_until: Date.now() - 1 }], ["no deadline", { takeover: true }]] as const) {
      const h = await attachHarness({ timing: { recentWriteMs: 100, takeoverWaitMs: 2_000 } });
      const term = sleeper({ cwd: h.work });
      await new Promise((r) => setTimeout(r, 200));
      h.setLive([{ pid: term.pid, sessionId: REF, status: "busy" }]);
      const sid = await h.attach(REF, h.work, extra);
      await h.claw.until("refused", () => closedReason(h, sid) !== undefined);
      assert.equal(closedReason(h, sid), "takeover_expired", label);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual([term.exitCode, term.signalCode], [null, null], `${label}: the terminal is untouched`);
      assert.ok(!adapterMethods(h).includes("session/resume"), label);
      assert.equal(h.claw.eventsOf(sid, "session_started").length, 0, `${label}: not even watched`);
    }
  });

  test("a takeover is refused, and nothing is resumed, when the terminal cannot be ended", async () => {
    // Another host shares the config directory: its process cannot be ended from here.
    const far = await attachHarness({ live: [], timing: { recentWriteMs: 100, takeoverWaitMs: 2_000 } });
    fs.mkdirSync(path.join(far.attachDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(far.attachDir, "sessions", "424242.json"), JSON.stringify({ pid: 424242, sessionId: REF, status: "busy", kind: "interactive", pidDomain: "another-host:0" }));
    const sid1 = await far.attach(REF, far.work, fresh());
    await far.claw.until("refused", () => closedReason(far, sid1) !== undefined);
    assert.equal(closedReason(far, sid1), "session_live_elsewhere");
    assert.ok(!adapterMethods(far).includes("session/resume"));

    // A row that names a live local pid but not this machine's pid domain proves nothing: that pid is not signalled.
    const unproven = await attachHarness({ live: [], timing: { recentWriteMs: 100, takeoverWaitMs: 2_000 } });
    const bystander = sleeper();
    fs.mkdirSync(path.join(unproven.attachDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(unproven.attachDir, "sessions", `${bystander.pid}.json`), JSON.stringify({ pid: bystander.pid, sessionId: REF, status: "busy", kind: "interactive" }));
    const sid0 = await unproven.attach(REF, unproven.work, fresh());
    await unproven.claw.until("refused", () => closedReason(unproven, sid0) !== undefined);
    assert.equal(closedReason(unproven, sid0), "takeover_failed");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(bystander.exitCode, null, "a process that is not proven to hold it is never signalled");
    assert.equal(bystander.signalCode, null);
    assert.ok(!adapterMethods(unproven).includes("session/resume"));

    // A proven holder whose working directory is outside the agent's roots is not this agent's to end.
    const outside = await attachHarness({ live: [], cliMode: "fail", timing: { recentWriteMs: 100, takeoverWaitMs: 2_000 } });
    const far2 = openTerminal(outside.attachDir, REF, os.tmpdir());
    const sid3 = await outside.attach(REF, outside.work, fresh());
    await outside.claw.until("refused", () => closedReason(outside, sid3) !== undefined);
    assert.equal(closedReason(outside, sid3), "takeover_failed");
    assert.ok((await import("../src/children.js")).isAlive(far2.pid), "a process outside the roots is never signalled");
    assert.ok(!adapterMethods(outside).includes("session/resume"));

    // A terminal that does not exit when asked: refused once the wait is over; it is not killed harder.
    const stubborn = await attachHarness({ timing: { recentWriteMs: 100, takeoverWaitMs: 1_000 } });
    const term = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: "ignore", cwd: stubborn.work });
    children.push(term);
    await new Promise((r) => setTimeout(r, 300));
    stubborn.setLive([{ pid: term.pid, sessionId: REF, status: "busy" }]);
    const sid2 = await stubborn.attach(REF, stubborn.work, fresh());
    await stubborn.claw.until("refused", () => closedReason(stubborn, sid2) !== undefined);
    assert.equal(closedReason(stubborn, sid2), "terminal_did_not_exit");
    assert.equal(term.exitCode, null, "still running: only asked, never killed");
    assert.ok(!adapterMethods(stubborn).includes("session/resume"));
    assert.ok(stubborn.audit().some((a) => a.kind === "takeover_refused" && a.reason === "terminal_did_not_exit"));
  });

  test("a read-only session stays read-only after the connector restarts", async () => {
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF, status: "busy" }], timing: { spectateMs: 20, spectateCheckMs: 60_000 } });
    const sid = await h.attach(REF);
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.read_only, true);
    await h.stop();
    h.connect({ timing: { spectateMs: 20, spectateCheckMs: 60_000 } });
    h.start();
    await h.online();
    h.setLive([]);   // even with the terminal gone, a prompt after the restart is not a takeover by surprise
    h.prompt(sid, "say hi");
    const rejected = await h.claw.until("the prompt to be refused", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.equal(rejected.data.reason, "read_only_live_session");
    assert.ok(!adapterMethods(h).includes("session/resume"));
  });

  test("a read-only session stays read-only after a restart even when its agent can no longer attach", async () => {
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF, status: "busy" }], timing: { spectateMs: 20, spectateCheckMs: 60_000 } });
    const sid = await h.attach(REF);
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.read_only, true);
    await h.stop();
    // The machine's config dropped the agent's attach support before the restart.
    (h.config.agents.find((a) => a.id === "fake") as { attach: unknown }).attach = null;
    h.connect({ timing: { spectateMs: 20, spectateCheckMs: 60_000 } });
    h.start();
    await h.online();
    h.prompt(sid, "say hi");
    const rejected = await h.claw.until("the prompt to be refused", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.equal(rejected.data.reason, "read_only_live_session");
    assert.ok(!adapterMethods(h).includes("session/resume"), "no adapter was launched on the terminal's conversation");
  });

  test("after a restart a watch goes on by itself, a replayed request to open it stays read-only, and it ends with the terminal", async () => {
    const timing = { spectateMs: 20, spectateCheckMs: 100 };
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF, status: "busy" }], timing });
    const file = path.join(h.attachDir, "projects", fs.realpathSync(h.work).replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    const sid = await h.attach(REF);
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.read_only, true);
    await h.stop();
    h.connect({ timing });
    h.start();
    await h.claw.until("the restarted connector to be up", () => h.audit().filter((a) => a.kind === "connector_online").length === 2);
    // Followed again without any command: what the terminal writes now arrives.
    fs.appendFileSync(file, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "after the restart" }] } })}\n`);
    await h.claw.until("output after the restart", () => h.claw.eventsOf(sid, "agent_message_chunk").find((e) => e.data.update.content.text === "after the restart"));
    // The terminal closes and the transcript is old: a replay of the very request that opened the watch is still not a takeover.
    h.setLive([]);
    const old = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(file, old, old);
    h.claw.issue("session.new", sid, { agent_id: "fake", cwd: h.work, mode: null, resume_ref: REF });
    await h.claw.until("the watch to end", () => closedReason(h, sid) !== undefined);
    assert.equal(closedReason(h, sid), "terminal_closed");
    assert.ok(h.claw.eventsOf(sid, "session_started").every((e) => e.data.read_only === true), "never opened as a takeover");
    assert.ok(!adapterMethods(h).includes("session/resume"));
  });

  test("a transcript reached through a link that leaves the config directory is not read", () => {
    const dir = configDir();
    const outside = path.join(tmpdir("cc-outside-"), "secret.jsonl");
    fs.writeFileSync(outside, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "not yours" }] } })}\n`);
    fs.mkdirSync(path.join(dir, "projects", "-x"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "projects", "-x", `${REF}.jsonl`));
    const s = support(dir);
    assert.equal(s.transcriptPath(REF), null);
    fs.writeFileSync(path.join(dir, "projects", "-x", `${REF2}.jsonl`), "");
    assert.equal(s.transcriptPath(REF2), fs.realpathSync(path.join(dir, "projects", "-x", `${REF2}.jsonl`)));
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
    // The window must outlast the time the check itself takes on a loaded machine (it starts a process): a 300 ms one was
    // only a test that depended on a fast runner. The write is made old again by hand below instead of waiting for it.
    const h = await attachHarness({ timing: { recentWriteMs: 5_000 } });
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

  test("what the agent writes on its own between turns (a background task it started finishing) neither refuses the next prompt nor discards the agent", async () => {
    // A window far longer than the test: a check of the transcript's age would refuse every prompt below.
    const h = await attachHarness({ env: { FAKE_TRANSCRIPT: "1" }, timing: { recentWriteMs: 600_000 } });
    const file = path.join(h.attachDir, "projects", fs.realpathSync(h.work).replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jl(...typedTurn));
    const old = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(file, old, old);
    const sid = await h.attach(REF);
    const resumes = () => adapterMethods(h).filter((m) => m === "session/resume").length;
    h.prompt(sid, "background 100");
    assert.equal((await h.turnEnd(sid, 1)).data.stopReason, "end_turn");
    await h.claw.until("the agent to answer the finished task by itself", () => fs.readFileSync(file, "utf8").includes("task-notification"));
    assert.ok(Date.now() - fs.statSync(file).mtimeMs < 600_000, "the transcript was written a moment ago");
    h.prompt(sid, "say two");
    assert.equal((await h.turnEnd(sid, 2)).data.stopReason, "end_turn");
    assert.equal(h.claw.eventsOf(sid, "command_rejected").length, 0, "not refused as recently_written");
    assert.deepEqual(h.messages(sid), ["started", "two"]);
    assert.equal(resumes(), 1, "the same agent goes on: it wrote what was added, so it is in its memory");
    assert.ok(h.audit().some((a) => a.kind === "transcript_grew_by_agent"));
    assert.ok(!h.audit().some((a) => a.kind === "transcript_changed"));
    // And again, once more on its own: the agent's program is known from each of its turns.
    h.prompt(sid, "background 50");
    assert.equal((await h.turnEnd(sid, 3)).data.stopReason, "end_turn");
    await h.claw.until("the second notification", () => fs.readFileSync(file, "utf8").split('"kind":"task-notification"').length === 3);
    h.prompt(sid, "say four");
    assert.equal((await h.turnEnd(sid, 4)).data.stopReason, "end_turn");
    assert.equal(h.claw.eventsOf(sid, "command_rejected").length, 0);
    assert.equal(resumes(), 1);
  });

  test("a person who typed in a terminal between two prompts still holds the next one back, though the agent wrote on its own too", async () => {
    const h = await attachHarness({ env: { FAKE_TRANSCRIPT: "1" }, timing: { recentWriteMs: 5_000 } });
    const file = path.join(h.attachDir, "projects", fs.realpathSync(h.work).replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jl(...typedTurn));
    const old = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(file, old, old);
    const sid = await h.attach(REF);
    h.prompt(sid, "background 50");
    assert.equal((await h.turnEnd(sid, 1)).data.stopReason, "end_turn");
    await h.claw.until("the agent's own turn", () => fs.readFileSync(file, "utf8").includes("task-notification"));
    // A terminal opened the conversation, the person typed a prompt, it was answered, and the terminal closed.
    fs.appendFileSync(file, jl(...typedTurn));
    h.prompt(sid, "say two");
    const rejected = await h.claw.until("the prompt to be held back", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.equal(rejected.data.reason, "recently_written");
    const changed = h.audit().find((a) => a.kind === "transcript_changed");
    assert.equal(changed?.why, "entries written by another program");
    assert.ok(!h.audit().some((a) => a.kind === "transcript_grew_by_agent"));
    assert.deepEqual(h.adapterLog().filter((l) => l.prompt).map((l) => l.prompt), ["background 50"], "not sent to the agent that has not read the terminal's turn");
    // Once it has settled, a fresh agent that reads the transcript takes it.
    fs.utimesSync(file, old, old);
    h.prompt(sid, "say three");
    await h.turnEnd(sid, 3);
    assert.equal(adapterMethods(h).filter((m) => m === "session/resume").length, 2);
  });

  test("a terminal that opens the conversation during a turn, takes a turn of its own and exits is noticed: the next prompt does not go to the agent that was running", async () => {
    const h = await attachHarness({ timing: { twinWatchMs: 20 } });
    const sid = await h.attach(REF);
    const file = path.join(h.attachDir, "projects", fs.realpathSync(h.work).replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"user"}\n');
    const old = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(file, old, old);
    h.prompt(sid, "say one");
    await h.turnEnd(sid, 1);
    const resumes = () => adapterMethods(h).filter((m) => m === "session/resume").length;
    // A long turn. While it runs, a terminal resumes the conversation, takes its turn (the transcript grows) and exits.
    const release = path.join(h.attachDir, "release");
    h.prompt(sid, `wait ${release}`);
    await h.claw.until("the turn to be running", () => h.adapterLog().some((l) => String(l.prompt).startsWith("wait ")));
    const terminal = openTerminal(h.attachDir);
    await h.claw.until("the connector to see the terminal", () => h.audit().some((a) => a.kind === "twin_seen" && a.pid === terminal.pid));
    fs.appendFileSync(file, '{"type":"user","from":"the terminal"}\n');
    await terminal.leave();
    fs.utimesSync(file, old, old); // it left a while ago: the transcript is no longer being written
    fs.writeFileSync(release, "");
    await h.turnEnd(sid, 2);
    // Nothing holds the conversation open now, and the transcript's size is what it was when the turn ended. The agent
    // that ran the turn has not read what the terminal wrote, so it must not be the one to take the next prompt.
    h.prompt(sid, "say three");
    await h.turnEnd(sid, 3);
    assert.equal(h.claw.eventsOf(sid, "command_rejected").length, 0);
    assert.equal(resumes(), 2, "the next prompt went to an agent that was started afresh, from the transcript");
    assert.equal(adapterMethods(h).filter((m) => m === "session/set_mode").length, 2, "and its mode was locked again");
    assert.ok(h.audit().some((a) => a.kind === "adapter_discarded"));
    assert.equal(h.connector.registry.list().length, 1, "only one agent is left running");
    // That fresh agent has seen it all: the next prompt goes on to it without another restart.
    h.prompt(sid, "say four");
    await h.turnEnd(sid, 4);
    assert.equal(resumes(), 2);
  });

  test("a terminal still open when a turn ends is noticed by the check made then, even if it is gone by the next prompt", async () => {
    const h = await attachHarness();
    const sid = await h.attach(REF);
    const resumes = () => adapterMethods(h).filter((m) => m === "session/resume").length;
    const release = path.join(h.attachDir, "release");
    h.prompt(sid, `wait ${release}`);
    await h.claw.until("the turn to be running", () => h.adapterLog().some((l) => String(l.prompt).startsWith("wait ")));
    // Only the command shows it (the registry has no row), and only at the end of the turn.
    h.setLive([{ pid: process.pid, sessionId: REF, status: "busy" }]);
    fs.writeFileSync(release, "");
    await h.turnEnd(sid, 1);
    await h.claw.until("the check at the end of the turn", () => h.audit().some((a) => a.kind === "twin_seen" && a.reason === "session_live"));
    h.setLive([]);
    h.prompt(sid, "say two");
    await h.turnEnd(sid, 2);
    assert.equal(resumes(), 2, "the agent that ran that turn is not reused");
    assert.equal(h.claw.eventsOf(sid, "command_rejected").length, 0);
  });

  test("a terminal that opens the conversation while the agent is being started is not missed: still there, or already gone", async () => {
    const variants: Array<{ name: string; during: (h: Harness) => Promise<void>; refused: boolean }> = [
      { name: "nobody", during: async () => {}, refused: false },
      { name: "the command lists it when the start ends", during: async (h) => h.setLive([{ pid: process.pid, sessionId: REF, status: "idle" }]), refused: true },
      {
        name: "the registry showed it for a moment, and it is gone when the start ends",
        during: async (h) => {
          const terminal = openTerminal(h.attachDir);
          await h.claw.until("the connector to see the terminal", () => h.audit().some((a) => a.kind === "twin_seen" && a.pid === terminal.pid));
          assert.ok(!adapterMethods(h).includes("session/set_mode"), "it was seen while the agent was still starting, not when the start was over");
          await terminal.leave();
        },
        refused: true,
      },
    ];
    for (const v of variants) {
      // The agent takes a while to read the transcript: the terminal appears after the check that let the takeover begin.
      const h = await attachHarness({ env: { FAKE_RESUME_DELAY_MS: "800" }, timing: { twinWatchMs: 20 } });
      await h.online();
      const sid = h.claw.newSession("fake", h.work, undefined, { resume_ref: REF });
      await h.claw.until("the agent to be resuming", () => adapterMethods(h).includes("session/resume"));
      await v.during(h);
      await h.claw.until("an answer", () => h.claw.eventsOf(sid).some((e) => e.type === "session_started" || e.type === "session_closed"), 15_000);
      assert.equal(closedReason(h, sid), v.refused ? "session_live" : undefined, v.name);
      assert.equal(h.claw.eventsOf(sid, "session_started").length, v.refused ? 0 : 1, v.name);
      assert.equal(h.connector.registry.list().length, v.refused ? 0 : 1, `${v.name}: the agent that was started is not left running`);
    }
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

describe("the conversations already on the machine show up by themselves", () => {
  const root = os.tmpdir();
  const ids = (toml: string) => parseConfig(toml).agents.map((a) => [a.id, a.kind, a.attach?.cli ?? null]);

  test("a claude agent brings one that lists its existing conversations, unless told not to or one already does", () => {
    const claude = (extra = "", id = "cc") => `[[agents]]\nid = "${id}"\npreset = "claude"\nroots = ["${root}"]\n${extra}`;
    assert.deepEqual(ids(claude()), [["cc", "claude", null], ["cc-sessions", "attach", "claude"]]);
    const got = parseConfig(claude(`approval = "never"\nname = "Claude on my box"\n[agents.env]\nCLAUDE_CONFIG_DIR = "/x/cfg"\n`)).agents;
    const [src, derived] = [got[0]!, got[1]!];
    assert.deepEqual([derived.roots, derived.env, derived.askMode, derived.unattended, derived.allowUnsafeModes, derived.command, derived.args],
      [src.roots, src.env, src.askMode, src.unattended, src.allowUnsafeModes, src.command, src.args], "the same roots, environment, adapter and approval");
    assert.equal(derived.name, "Claude on my box (existing sessions)");
    assert.notEqual(derived.env, src.env, "not the same object: editing one does not change the other");
    assert.deepEqual(ids(claude(`existing_sessions = false\n`)), [["cc", "claude", null]], "the owner can turn it off");
    assert.deepEqual(ids(`${claude()}\n[[agents]]\nid = "mine"\npreset = "claude-attach"\nroots = ["${root}"]\n`), [["cc", "claude", null], ["mine", "attach", "claude"]],
      "a claude-attach agent on the same config directory already lists them");
    assert.deepEqual(ids(`${claude(`[agents.env]\nCLAUDE_CONFIG_DIR = "/other"\n`)}\n[[agents]]\nid = "mine"\npreset = "claude-attach"\nroots = ["${root}"]\n`).map((r) => r[0]),
      ["cc", "mine", "cc-sessions"], "one on another config directory does not");
    assert.deepEqual(ids(`${claude()}\n[[agents]]\nid = "cc-sessions"\npreset = "codex"\nroots = ["${root}"]\n`).map((r) => r[0]), ["cc", "cc-sessions"],
      "an agent of the owner's with that id wins");
    assert.deepEqual(ids(`[[agents]]\nid = "x"\npreset = "codex"\nroots = ["${root}"]\n`), [["x", "codex", null]], "only Claude");
    assert.throws(() => parseConfig(`[[agents]]\nid = "x"\npreset = "codex"\nexisting_sessions = true\nroots = ["${root}"]\n`), /existing_sessions only applies/);
    assert.throws(() => parseConfig(claude(`existing_sessions = "no"\n`)), /existing_sessions must be true or false/);
    const same = path.join(os.homedir(), ".claude-same-test");
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = same;
    try {
      assert.deepEqual(ids(`${claude()}\n[[agents]]\nid = "mine"\npreset = "claude-attach"\nroots = ["${root}"]\n[agents.env]\nCLAUDE_CONFIG_DIR = "${same}/"\n`).map((r) => r[0]),
        ["cc", "mine"], "the same directory spelled differently (the connector's default here, written out there) is the same directory");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    }
    assert.ok(parseConfig(claude("", "a".repeat(64))).agents[1]!.id.length <= 64);
  });

  test("what a terminal says it is doing: waiting for its person wins, then working, then idle", () => {
    const rows = parseAgentsJson(JSON.stringify([
      { pid: 1, sessionId: REF, status: "waiting", waitingFor: "input needed", cwd: "/w" }, { pid: 2, sessionId: REF, status: "busy" },
    ]));
    assert.deepEqual([rows[0]!.waitingFor, rows[0]!.cwd, rows[1]!.waitingFor], ["input needed", "/w", null]);
    assert.deepEqual(liveActivity(rows), { activity: "waiting", waiting_for: "input needed" });
    assert.deepEqual(liveActivity([rows[1]!]), { activity: "working" });
    assert.deepEqual(liveActivity(parseAgentsJson(JSON.stringify([{ pid: 3, sessionId: REF, status: "idle" }]))), { activity: "idle" });
    assert.deepEqual(liveActivity(parseAgentsJson(JSON.stringify([{ pid: 3, sessionId: REF, status: "shell" }]))), {}, "a status it does not know says nothing");
    assert.deepEqual(liveActivity([{ pid: 4, sessionId: REF, status: "waiting", waitingFor: `token sk-ant-api03-${"x".repeat(40)}\nnext`, foreign: false }]).waiting_for?.includes("sk-ant"), false, "scrubbed");
  });

  test("the heartbeat says a conversation open in a terminal is waiting for its person, and what for", async () => {
    const h = await attachHarness({ live: [{ pid: process.pid, sessionId: REF2, status: "waiting", waitingFor: "input needed" }, { pid: process.pid, sessionId: REF, status: "busy" }] });
    await h.online();
    const hb = await h.claw.until("a heartbeat with the list", () => h.claw.heartbeats.find((b) => b.agents[0].capabilities.resumable?.length));
    assert.deepEqual(hb.agents[0].capabilities.resumable.map((r: any) => [r.ref, r.state, r.activity ?? null, r.waiting_for ?? null]),
      [[REF, "live", "working", null], [REF2, "live", "waiting", "input needed"]]);
  });

  test("a conversation a terminal has just opened is reported within seconds, not at the next heartbeat", async () => {
    const work = tmpdir("cc-work-");
    const real = fs.realpathSync(work);
    const listFile = path.join(tmpdir("cc-list-"), "sessions.json");
    fs.writeFileSync(listFile, JSON.stringify([{ sessionId: REF, cwd: work, title: "Old one", updatedAt: "2026-10-29T10:00:00.000Z" }]));
    const h = await Harness.create({
      work, env: { FAKE_SESSIONS_FILE: listFile }, attach: { sessions: [] },
      // The heartbeat is a minute away: only the watcher can bring the new conversation in time.
      timing: { heartbeatMs: 60_000, sessionsWatchMs: 100, catalogMs: 600_000 },
    });
    hs.push(h);
    await h.claw.until("the first heartbeat", () => h.claw.heartbeats.find((b) => b.agents[0].capabilities.resumable?.length));
    const before = h.claw.heartbeats.length;
    await new Promise((r) => setTimeout(r, 400));   // (the watcher has taken its first look)
    // A terminal opens a new conversation in the roots: Claude Code writes its transcript and its registry row.
    const project = path.join(h.attachDir, "projects", real.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${REF2}.jsonl`), "{}\n");
    fs.writeFileSync(listFile, JSON.stringify([
      { sessionId: REF2, cwd: work, title: "Just opened", updatedAt: "2026-10-29T11:00:00.000Z" },
      { sessionId: REF, cwd: work, title: "Old one", updatedAt: "2026-10-29T10:00:00.000Z" },
    ]));
    const term = sleeper();
    fs.mkdirSync(path.join(h.attachDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(h.attachDir, "sessions", `${term.pid}.json`), JSON.stringify({
      pid: term.pid, sessionId: REF2, cwd: real, status: "waiting", waitingFor: "input needed", kind: "interactive",
      procStart: processStart(term.pid!), pidDomain: localPidDomain(),
    }));
    const hb = await h.claw.until("a heartbeat with the new conversation", () => h.claw.heartbeats.slice(before)
      .find((b) => b.agents[0].capabilities.resumable?.some((r: any) => r.ref === REF2)), 5_000);
    const row = hb.agents[0].capabilities.resumable.find((r: any) => r.ref === REF2);
    assert.deepEqual([row.title, row.state, row.activity, row.waiting_for], ["Just opened", "live", "waiting", "input needed"]);
    await stop(term);
  });

  test("so is one a terminal ran and already ended (claude -p): a new transcript in a project folder inside the roots", async () => {
    const work = tmpdir("cc-work-");
    const real = fs.realpathSync(work);
    const listFile = path.join(tmpdir("cc-list-"), "sessions.json");
    const old = { sessionId: REF, cwd: work, title: "Old one", updatedAt: "2026-10-29T10:00:00.000Z" };
    fs.writeFileSync(listFile, JSON.stringify([old]));
    const h = await Harness.create({
      work, env: { FAKE_SESSIONS_FILE: listFile }, attach: { sessions: [] }, start: false,
      // Only the watcher may wake a heartbeat here: the timer is a minute away, and so is the stream's watchdog. With the
      // tests' 700 ms watchdog a stalled event loop (a busy runner; this process is the stand-in Claw too) reopened the
      // stream, and its `ready` frame woke a heartbeat the watcher was blamed for (CI 2026-11-07: 3 where 2 were taken).
      timing: { heartbeatMs: 60_000, watchdogMs: 60_000, sessionsWatchMs: 100, catalogMs: 600_000 },
    });
    hs.push(h);
    const project = path.join(h.attachDir, "projects", real.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${REF}.jsonl`), "{}\n");
    h.start();
    await h.claw.until("the first heartbeat", () => h.claw.heartbeats.find((b) => b.agents[0].capabilities.resumable?.length));
    // The command stream's `ready` frame wakes one more heartbeat; on a slow runner the stream opens after any fixed wait, so
    // the count is taken once that heartbeat is in (CI 2026-11-07: counted 2 where 1 was taken as the baseline).
    await h.online();
    await h.claw.until("the heartbeat the stream's ready frame wakes", () => h.claw.heartbeats.length >= 2);
    await new Promise((r) => setTimeout(r, 400));
    const before = h.claw.heartbeats.length;
    // Appending to a transcript is no new conversation and lists nothing again.
    fs.appendFileSync(path.join(project, `${REF}.jsonl`), "{}\n");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(h.claw.streamHeaders.length, 1, "the stream was never reopened (its ready frame wakes a heartbeat too)");
    assert.equal(h.claw.heartbeats.length, before, "nothing changed that the phone is shown");
    fs.writeFileSync(listFile, JSON.stringify([{ sessionId: REF2, cwd: work, title: "Ran and ended", updatedAt: "2026-10-29T11:00:00.000Z" }, old]));
    fs.writeFileSync(path.join(project, `${REF2}.jsonl`), "{}\n");
    const hb = await h.claw.until("a heartbeat with the ended conversation", () => h.claw.heartbeats.slice(before)
      .find((b) => b.agents[0].capabilities.resumable?.some((r: any) => r.ref === REF2)), 5_000);
    assert.deepEqual(hb.agents[0].capabilities.resumable.map((r: any) => [r.title, r.state]), [["Ran and ended", "idle"], ["Old one", "idle"]]);
  });
});
