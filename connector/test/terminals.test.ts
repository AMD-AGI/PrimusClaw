// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The terminal hooks: what the hook does with what Claude Code hands it, how the rows are read back, and how the two hooks
 * are merged into (and taken out of) a user's settings file. The hook is also run as the real program it is.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { processStart } from "../src/children.js";
import { HOOKED, HooksError, hookCommand, hooksStatus, installHooks, settingsFile, uninstallHooks } from "../src/hooks.js";
import { TERMINALS_DIR, localPidDomain, readTerminals, runHook, terminalsDir, type HookDeps } from "../src/terminals.js";
import { tmpdir } from "./support/harness.js";

const REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOMAIN = localPidDomain();

const children: ChildProcess[] = [];
after(() => { for (const c of children) { try { if (c.pid && c.exitCode === null) process.kill(c.pid, "SIGKILL"); } catch { /* gone */ } } });
const sleeper = (): ChildProcess => {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(c);
  return c;
};
const stop = async (c: ChildProcess) => { c.kill("SIGKILL"); await new Promise((r) => c.once("exit", r)); };

const TERMINAL = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" };
const ADAPTER = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" };
/** What Claude Code writes on a hook's stdin (measured on 2.1.314). */
const stdinOf = (session: string, event = "SessionStart") => JSON.stringify({ session_id: session, transcript_path: "/x/y.jsonl", cwd: "/work", hook_event_name: event });

const ids = (dir: string): string[] => readTerminals(dir, DOMAIN).map((e) => e.sessionId).sort();

describe("the hook: what it registers", () => {
  type Case = {
    name: string;
    env: Record<string, string>;
    stdin?: string;
    /** The ancestors the hook sees above itself, nearest first; `claude` is the process the test started. */
    chain?: (claude: number) => number[];
    commOf?: (pid: number, claude: number) => string | null;
    claudePidEnv?: "claude" | "stale" | "none";
    expect: "registered" | "ignored";
    why?: RegExp;
  };
  const cases: Case[] = [
    { name: "a terminal session is registered", env: TERMINAL, expect: "registered" },
    { name: "a session started by an ACP adapter or claude -p (sdk-cli, unattended) is not a terminal", env: ADAPTER, expect: "ignored", why: /not a terminal/ },
    { name: "an unknown entrypoint is not a terminal", env: { CLAUDE_CODE_ENTRYPOINT: "claude-vscode", CLAUDE_CODE_SESSION_ATTENDED: "1" }, expect: "ignored", why: /not a terminal/ },
    { name: "a version that does not export the entrypoint, but says a person is at it, is given the benefit of the doubt", env: { CLAUDE_CODE_SESSION_ATTENDED: "1" }, expect: "registered" },
    { name: "nothing exported at all: not registered", env: {}, expect: "ignored", why: /not a terminal/ },
    { name: "a terminal entrypoint that says it is unattended is not registered", env: { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }, expect: "ignored", why: /unattended/ },
    { name: "stdin that is not JSON", env: TERMINAL, stdin: "not json", expect: "ignored", why: /not JSON/ },
    { name: "empty stdin", env: TERMINAL, stdin: "", expect: "ignored", why: /not JSON/ },
    { name: "stdin is JSON but not an object", env: TERMINAL, stdin: "null", expect: "ignored", why: /no session id/ },
    { name: "no session id", env: TERMINAL, stdin: JSON.stringify({ cwd: "/x" }), expect: "ignored", why: /no session id/ },
    { name: "a session id that is not a UUID never becomes a file name", env: TERMINAL, stdin: stdinOf("../../etc/passwd"), expect: "ignored", why: /no session id/ },
    { name: "a UUID in capitals is the same session", env: TERMINAL, stdin: stdinOf(REF.toUpperCase()), expect: "registered" },
    { name: "CLAUDE_PID that is not one of the hook's ancestors is not believed (a value inherited through a nested launch)", env: TERMINAL, claudePidEnv: "stale", commOf: () => "node", expect: "ignored", why: /cannot tell which process is claude/ },
    { name: "no CLAUDE_PID and no ancestor called claude", env: TERMINAL, claudePidEnv: "none", commOf: () => "node", expect: "ignored", why: /cannot tell which process is claude/ },
    { name: "no CLAUDE_PID: the nearest ancestor called claude is the process", env: TERMINAL, claudePidEnv: "none", chain: (c) => [999999, c, 1234], commOf: (p, c) => (p === c ? "claude" : "sh"), expect: "registered" },
    { name: "a stale CLAUDE_PID is replaced by the ancestor called claude", env: TERMINAL, claudePidEnv: "stale", chain: (c) => [c], commOf: () => "claude", expect: "registered" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const dir = tmpdir("cc-claudecfg-");
      const claude = sleeper();
      const other = sleeper();
      const env: Record<string, string> = { ...c.env };
      if ((c.claudePidEnv ?? "claude") === "claude") env.CLAUDE_PID = String(claude.pid);
      if (c.claudePidEnv === "stale") env.CLAUDE_PID = String(other.pid);
      const deps: HookDeps = { ancestors: c.chain ? () => c.chain!(claude.pid!) : () => [claude.pid!], commOf: c.commOf ? (p) => c.commOf!(p, claude.pid!) : undefined };
      const r = runHook({ event: "start", configDir: dir, stdin: c.stdin ?? stdinOf(REF), env, ppid: 1 }, deps);
      assert.equal(r.done, c.expect, JSON.stringify(r));
      if (c.why) assert.match(r.why ?? "", c.why);
      const rows = readTerminals(dir, DOMAIN);
      if (c.expect === "registered") {
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.pid, claude.pid, "the row names the claude process");
        assert.equal(rows[0]!.via, "hook");
        const file = path.join(terminalsDir(dir), `${claude.pid}.json`);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).procStart, processStart(claude.pid!), "with the start time that tells it from a recycled pid");
      } else {
        assert.deepEqual(rows, [], "nothing written");
        assert.equal(fs.existsSync(terminalsDir(dir)), false);
      }
    });
  }
});

describe("the hook: a session's life in one terminal", () => {
  type Step = { event: "start" | "end"; session: string; by?: 0 | 1; killBefore?: 0 | 1; expect: string[]; done?: string };
  const sequences: Array<{ name: string; steps: Step[]; rowsLeft?: number }> = [
    { name: "start then end leaves nothing", steps: [{ event: "start", session: REF, expect: [REF] }, { event: "end", session: REF, expect: [], done: "unregistered" }] },
    { name: "starting the same session twice is one row", steps: [{ event: "start", session: REF, expect: [REF] }, { event: "start", session: REF, expect: [REF] }] },
    { name: "an end for another session leaves the row", steps: [{ event: "start", session: REF, expect: [REF] }, { event: "end", session: REF2, expect: [REF], done: "ignored" }] },
    { name: "an end with no start is nothing to do", steps: [{ event: "end", session: REF, expect: [], done: "ignored" }] },
    {
      name: "/clear: the old id ends, then a new id starts in the same process",
      steps: [{ event: "start", session: REF, expect: [REF] }, { event: "end", session: REF, expect: [] }, { event: "start", session: REF2, expect: [REF2] }],
    },
    {
      name: "/clear when the new start comes first: the old end does not take the new row away",
      steps: [{ event: "start", session: REF, expect: [REF] }, { event: "start", session: REF2, expect: [REF2] }, { event: "end", session: REF, expect: [REF2], done: "ignored" }],
    },
    {
      name: "two terminals hold the same session: one ending takes away only its own row",
      steps: [{ event: "start", session: REF, by: 0, expect: [REF] }, { event: "start", session: REF, by: 1, expect: [REF, REF] }, { event: "end", session: REF, by: 0, expect: [REF] }],
    },
    {
      name: "kill -9 runs no SessionEnd: its row is not read as open, and the next hook sweeps it away",
      steps: [
        { event: "start", session: REF, by: 0, expect: [REF] },
        { event: "start", session: REF2, by: 1, killBefore: 0, expect: [REF2] },
      ],
      rowsLeft: 1,
    },
  ];
  for (const seq of sequences) {
    test(seq.name, async () => {
      const dir = tmpdir("cc-claudecfg-");
      const procs = [sleeper(), sleeper()];
      for (const [i, s] of seq.steps.entries()) {
        const p = procs[s.by ?? 0]!;
        if (s.killBefore !== undefined) await stop(procs[s.killBefore]!);
        const r = runHook({ event: s.event, configDir: dir, stdin: stdinOf(s.session, s.event === "start" ? "SessionStart" : "SessionEnd"), env: { ...TERMINAL, CLAUDE_PID: String(p.pid) }, ppid: 1 }, { ancestors: () => [p.pid!] });
        if (s.done) assert.equal(r.done, s.done, `step ${i}: ${JSON.stringify(r)}`);
        assert.deepEqual(ids(dir), s.expect.sort(), `after step ${i} (${s.event} ${s.session})`);
      }
      if (seq.rowsLeft !== undefined) {
        const left = fs.readdirSync(terminalsDir(dir)).filter((n) => n.endsWith(".json"));
        assert.equal(left.length, seq.rowsLeft, "the dead process's row was swept by the next hook");
      }
    });
  }

  test("a row whose process has been killed is not open, with no hook to say so", async () => {
    const dir = tmpdir("cc-claudecfg-");
    const p = sleeper();
    runHook({ event: "start", configDir: dir, stdin: stdinOf(REF), env: { ...TERMINAL, CLAUDE_PID: String(p.pid) }, ppid: 1 }, { ancestors: () => [p.pid!] });
    assert.deepEqual(ids(dir), [REF]);
    await stop(p);
    assert.deepEqual(ids(dir), [], "kill -9: the file is still there, the process is not");
    assert.equal(fs.readdirSync(terminalsDir(dir)).length, 1);
  });
});

describe("reading the rows", () => {
  const rowFile = (dir: string, pid: number) => path.join(terminalsDir(dir), `${pid}.json`);
  const write = (dir: string, name: string, body: unknown) => {
    fs.mkdirSync(terminalsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(terminalsDir(dir), name), typeof body === "string" ? body : JSON.stringify(body));
  };

  test("what counts: the same process, a foreign one that cannot be checked; what does not: gone, recycled, malformed", async () => {
    const dir = tmpdir("cc-claudecfg-");
    const live = sleeper();
    const gone = sleeper();
    const goneStart = processStart(gone.pid!)!;
    await stop(gone);
    const base = { v: 1, sessionId: REF, cwd: "/w", at: 1, pidDomain: DOMAIN };
    write(dir, `${live.pid}.json`, { ...base, pid: live.pid, procStart: processStart(live.pid!) });
    write(dir, "recycled.json", { ...base, sessionId: REF2, pid: live.pid, procStart: "1" });
    write(dir, "dead.json", { ...base, pid: gone.pid, procStart: goneStart });
    write(dir, "foreign.json", { ...base, sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", pid: 999999, procStart: "7", pidDomain: "linux:other-host:pid:[7]" });
    write(dir, "version.json", { ...base, v: 2, pid: live.pid, procStart: processStart(live.pid!) });
    write(dir, "badid.json", { ...base, sessionId: "../x", pid: live.pid, procStart: processStart(live.pid!) });
    write(dir, "pid1.json", { ...base, pid: 1 });
    write(dir, "string-pid.json", { ...base, pid: String(live.pid) });
    write(dir, "readme.txt", "not a row");
    write(dir, "left.123.tmp", "{ half");
    const rows = readTerminals(dir, DOMAIN).map((r) => [r.sessionId, r.foreign]);
    const want: unknown[] = [[REF, false]];
    if (DOMAIN !== null) want.push(["dddddddd-dddd-4ddd-8ddd-dddddddddddd", true]);
    assert.deepEqual(rows.sort(), want.sort());
  });

  test("no directory is an empty answer (the hooks were never installed)", () => {
    assert.deepEqual(readTerminals(path.join(tmpdir(), "nothing-here"), DOMAIN), []);
  });

  test("a young row that does not parse is an unknown answer, an old one is junk", () => {
    const dir = tmpdir("cc-claudecfg-");
    write(dir, "1.json", "{ half a fi");
    assert.throws(() => readTerminals(dir, DOMAIN), /unreadable/);
    const old = Date.now() - 10 * 60_000;
    fs.utimesSync(rowFile(dir, 1), old / 1000, old / 1000);
    assert.deepEqual(readTerminals(dir, DOMAIN), []);
  });

  test("the directory is named under the Claude config directory, not in it", () => {
    assert.equal(terminalsDir("/c"), path.join("/c", TERMINALS_DIR));
  });
});

// --- the settings file ------------------------------------------------------------------------------

const NODE = "/usr/local/bin/node";
const SCRIPT = "/opt/claw/dist/terminal-hook.js";
const CLAUDE_DIR = "/home/u/.claude";
const ours = (arg: "start" | "end", dir: string, script = SCRIPT) => ({ type: "command", command: hookCommand(NODE, script, arg, dir), timeout: arg === "start" ? 2 : 1 });
const oursGroups = (dir: string, script = SCRIPT) => ({ SessionStart: [{ hooks: [ours("start", dir, script)] }], SessionEnd: [{ hooks: [ours("end", dir, script)] }] });

function settingsDir(initial: string | unknown | undefined, indent: string | number = 2): string {
  const dir = tmpdir("cc-claudecfg-");
  if (initial !== undefined) fs.writeFileSync(settingsFile(dir), typeof initial === "string" ? initial : JSON.stringify(initial, null, indent) + "\n");
  return dir;
}
const readSettings = (dir: string) => JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"));

describe("merging the hooks into settings.json", () => {
  const userStart = { matcher: "startup", hooks: [{ type: "command", command: "echo hello", timeout: 5 }] };
  const userEnd = { hooks: [{ type: "command", command: "/usr/local/bin/mine end" }] };
  const other = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }], Stop: [] };
  const originals: Array<{ name: string; initial: unknown | undefined }> = [
    { name: "no settings file", initial: undefined },
    { name: "an empty object", initial: {} },
    { name: "settings with no hooks", initial: { env: { A: "1" }, permissions: { allow: ["Bash(ls)"], defaultMode: "default" }, model: "opus", theme: "dark" } },
    { name: "other events hooked by the user", initial: { model: "x", hooks: { ...other } } },
    { name: "the same events hooked by the user", initial: { hooks: { SessionStart: [userStart], SessionEnd: [userEnd], ...other } } },
  ];

  for (const o of originals) {
    test(`install into ${o.name}: ours added, everything else as it was; a second install changes nothing; uninstall restores it`, () => {
      const dir = settingsDir(o.initial);
      const first = installHooks(dir, NODE, SCRIPT);
      assert.equal(first.changed, true);
      const after1 = readSettings(dir);
      const before = (o.initial ?? {}) as Record<string, any>;
      // Every key the user had is still there, with the value it had, except `hooks` which only gains our entries.
      for (const k of Object.keys(before)) if (k !== "hooks") assert.deepEqual(after1[k], before[k], k);
      for (const ev of Object.keys(before.hooks ?? {})) {
        const theirs = before.hooks[ev] as unknown[];
        assert.deepEqual((after1.hooks[ev] as unknown[]).slice(0, theirs.length), theirs, `${ev}: their groups come first, untouched`);
      }
      for (const h of HOOKED) {
        const mine = (after1.hooks[h.event] as any[]).flatMap((g) => g.hooks).filter((x: any) => /terminal-hook\.js/.test(x.command));
        assert.equal(mine.length, 1, `${h.event}: exactly one of ours`);
        assert.deepEqual(mine[0], ours(h.arg, dir));
      }
      if (o.initial === undefined) assert.equal(fs.statSync(settingsFile(dir)).mode & 0o777, 0o600, "a file we create is private");
      const bytes = fs.readFileSync(settingsFile(dir), "utf8");
      assert.equal(installHooks(dir, NODE, SCRIPT).changed, false, "idempotent");
      assert.equal(fs.readFileSync(settingsFile(dir), "utf8"), bytes, "and does not touch the file");
      const un = uninstallHooks(dir);
      assert.equal(un.changed, true);
      assert.deepEqual(readSettings(dir), o.initial ?? {}, "uninstall gives back what was there");
      assert.equal(uninstallHooks(dir).changed, false);
    });
  }

  test("an install that moved (another node or script) updates our entries in place", () => {
    const dir = settingsDir(undefined);
    installHooks(dir, NODE, "/old/terminal-hook.js");
    // the user has since put their own entries around ours
    const doc = readSettings(dir);
    doc.hooks.SessionStart.unshift(userStart);
    doc.hooks.SessionEnd[0].hooks.unshift(userEnd.hooks[0]);
    fs.writeFileSync(settingsFile(dir), JSON.stringify(doc));
    assert.equal(installHooks(dir, "/new/node", SCRIPT).changed, true);
    const after = readSettings(dir);
    const moved = (arg: "start" | "end") => ({ type: "command", command: hookCommand("/new/node", SCRIPT, arg, dir), timeout: arg === "start" ? 2 : 1 });
    assert.deepEqual(after.hooks.SessionStart, [userStart, { hooks: [moved("start")] }], "same place, new command");
    assert.deepEqual(after.hooks.SessionEnd, [{ hooks: [userEnd.hooks[0], moved("end")] }], "in the user's own group, beside theirs");
  });

  test("a hand-made second copy of our entry is collapsed, and a group that held only it is dropped", () => {
    const dir = settingsDir(undefined);
    installHooks(dir, NODE, SCRIPT);
    const doc = readSettings(dir);
    doc.hooks.SessionStart.push({ hooks: [ours("start", dir, "/elsewhere/terminal-hook.js")] });
    doc.hooks.SessionStart.push({ matcher: "resume", hooks: [ours("start", dir, "/elsewhere/terminal-hook.js")] });
    fs.writeFileSync(settingsFile(dir), JSON.stringify(doc));
    assert.equal(installHooks(dir, NODE, SCRIPT).changed, true);
    assert.deepEqual(readSettings(dir).hooks.SessionStart, [{ hooks: [ours("start", dir)] }, { matcher: "resume", hooks: [] }], "one of ours; the group with its own matcher stays, empty");
  });

  test("the file's own indentation is kept", () => {
    for (const indent of ["\t", 4, 1] as const) {
      const dir = settingsDir({ model: "x" }, indent);
      installHooks(dir, NODE, SCRIPT);
      const text = fs.readFileSync(settingsFile(dir), "utf8");
      const unit = typeof indent === "number" ? " ".repeat(indent) : indent;
      assert.ok(text.includes(`\n${unit}"model"`) && !text.includes(`\n${unit}${unit}"model"`), JSON.stringify(indent));
      assert.ok(text.endsWith("}\n"));
    }
  });

  test("the file's mode is kept, and a symlinked settings.json stays a symlink to the same target", () => {
    const dir = settingsDir({ model: "x" });
    fs.chmodSync(settingsFile(dir), 0o640);
    installHooks(dir, NODE, SCRIPT);
    assert.equal(fs.statSync(settingsFile(dir)).mode & 0o777, 0o640);
    const linked = tmpdir("cc-claudecfg-");
    const target = path.join(tmpdir("cc-dotfiles-"), "claude-settings.json");
    fs.writeFileSync(target, JSON.stringify({ theme: "dark" }));
    fs.symlinkSync(target, settingsFile(linked));
    installHooks(linked, NODE, SCRIPT);
    assert.ok(fs.lstatSync(settingsFile(linked)).isSymbolicLink(), "still a link");
    assert.equal(fs.realpathSync(settingsFile(linked)), target);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).theme, "dark");
    assert.ok(JSON.parse(fs.readFileSync(target, "utf8")).hooks.SessionStart);
  });

  test("a settings file that cannot be understood is left exactly as it was", () => {
    const bad: Array<[string, string, RegExp]> = [
      ["not JSON", "{ \"model\": ", /not valid JSON/],
      ["a JSON array", "[1, 2]", /not a JSON object/],
      ["hooks that is not an object", JSON.stringify({ hooks: "yes" }), /"hooks" is not an object/],
      ["an event that is not a list", JSON.stringify({ hooks: { SessionStart: {} } }), /SessionStart is not a list/],
    ];
    for (const [what, text, msg] of bad) {
      const dir = settingsDir(text);
      assert.throws(() => installHooks(dir, NODE, SCRIPT), (e) => e instanceof HooksError && msg.test(e.message), what);
      assert.throws(() => uninstallHooks(dir), HooksError, what);
      assert.equal(fs.readFileSync(settingsFile(dir), "utf8"), text, `${what}: untouched`);
      assert.deepEqual(fs.readdirSync(dir), ["settings.json"], `${what}: no temp file left`);
    }
  });

  test("uninstall takes out only ours, keeping a user's empty containers and a group that has other keys", () => {
    const initial = { hooks: { SessionStart: [{ matcher: "startup", hooks: [] }], Stop: [] } };
    const dir = settingsDir(initial);
    assert.equal(uninstallHooks(dir).changed, false, "nothing of ours: nothing changed");
    assert.deepEqual(readSettings(dir), initial);
    installHooks(dir, NODE, SCRIPT);
    uninstallHooks(dir);
    assert.deepEqual(readSettings(dir), initial, "their empty list and their empty group survive");
    const none = settingsDir(undefined);
    assert.equal(uninstallHooks(none).changed, false);
    assert.equal(fs.existsSync(settingsFile(none)), false, "uninstall never creates the file");
  });

  test("uninstall also removes the rows", () => {
    const dir = settingsDir({});
    installHooks(dir, NODE, SCRIPT);
    fs.mkdirSync(terminalsDir(dir), { recursive: true });
    fs.writeFileSync(path.join(terminalsDir(dir), "1.json"), "{}");
    uninstallHooks(dir);
    assert.equal(fs.existsSync(terminalsDir(dir)), false);
  });

  test("the entries carry timeouts: SessionStart holds up the first turn, so it is short", () => {
    assert.deepEqual(HOOKED.map((h) => [h.event, h.timeout]), [["SessionStart", 2], ["SessionEnd", 1]]);
    assert.deepEqual(oursGroups(CLAUDE_DIR).SessionStart[0]!.hooks[0]!.timeout, 2);
  });

  test("paths with spaces and quotes survive the shell command", () => {
    const dir = path.join(tmpdir("cc-it's a dir "), "my claude");
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "terminal-hook.js");
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const r = spawnSync("/bin/sh", ["-c", hookCommand(process.execPath, script, "start", dir)], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(r.stdout), ["start", "--dir", dir]);
  });

  test("status: not installed, installed and healthy, half installed, broken, unreadable", () => {
    const script = path.join(tmpdir("cc-hookbin-"), "terminal-hook.js");
    fs.writeFileSync(script, "// stand-in\n");
    const dir = settingsDir({ model: "x" });
    assert.deepEqual(hooksStatus(dir), { installed: false, events: [], healthy: true, problem: null });
    installHooks(dir, process.execPath, script);
    assert.deepEqual(hooksStatus(dir), { installed: true, events: ["SessionStart", "SessionEnd"], healthy: true, problem: null });
    const doc = readSettings(dir);
    delete doc.hooks.SessionEnd;
    fs.writeFileSync(settingsFile(dir), JSON.stringify(doc));
    const half = hooksStatus(dir);
    assert.equal(half.installed, false);
    assert.deepEqual(half.events, ["SessionStart"]);
    fs.rmSync(script);
    const broken = hooksStatus(dir);
    assert.equal(broken.healthy, false);
    assert.match(broken.problem ?? "", /does not exist/);
    const bad = hooksStatus(settingsDir("{ nope"));
    assert.equal(bad.installed, false);
    assert.match(bad.problem ?? "", /not valid JSON/);
  });
});

// --- the real program -------------------------------------------------------------------------------

describe("terminal-hook as the program Claude Code runs", () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "terminal-hook.ts");
  const run = (args: string[], stdin: string, env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", entry, ...args], { input: stdin, env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 });

  test("start registers, end removes; stdout stays empty and the exit code is 0 (a SessionStart hook's stdout would reach the model)", () => {
    const dir = tmpdir("cc-claudecfg-");
    // The hook's parent is this test process, so naming it as claude (CLAUDE_PID, one of the hook's ancestors) registers the test process.
    const env = { ...TERMINAL, CLAUDE_PID: String(process.pid) };
    const s = run(["start", "--dir", dir], stdinOf(REF), env);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stdout, "");
    assert.deepEqual(ids(dir), [REF]);
    const e = run(["end", "--dir", dir], stdinOf(REF, "SessionEnd"), env);
    assert.equal(e.status, 0, e.stderr);
    assert.equal(e.stdout, "");
    assert.deepEqual(ids(dir), []);
  });

  test("a session of an ACP adapter registers nothing", () => {
    const dir = tmpdir("cc-claudecfg-");
    const r = run(["start", "--dir", dir], stdinOf(REF), { ...ADAPTER, CLAUDE_PID: String(process.pid) });
    assert.equal(r.status, 0);
    assert.deepEqual(ids(dir), []);
  });

  test("whatever goes wrong, it exits 0 and prints nothing to stdout: bad arguments, bad stdin, a directory it cannot write", () => {
    const blocked = path.join(tmpdir("cc-blocked-"), "file");
    fs.writeFileSync(blocked, "a file where a directory is needed");
    const cases: Array<[string, string[], string]> = [
      ["no arguments", [], stdinOf(REF)],
      ["an unknown event", ["middle", "--dir", "/x"], stdinOf(REF)],
      ["no directory", ["start"], stdinOf(REF)],
      ["garbage on stdin", ["start", "--dir", tmpdir("cc-claudecfg-")], "\u0000\u0001 not json"],
      ["a directory that cannot be created", ["start", "--dir", path.join(blocked, "inside")], stdinOf(REF)],
    ];
    for (const [what, args, stdin] of cases) {
      const r = run(args, stdin, { ...TERMINAL, CLAUDE_PID: String(process.pid) });
      assert.equal(r.status, 0, `${what}: ${r.stderr}`);
      assert.equal(r.stdout, "", what);
    }
  });

  test("it does not wait for a stdin that never ends", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, "start", "--dir", tmpdir("cc-claudecfg-")], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...TERMINAL } });
    children.push(child);
    const t0 = Date.now();
    const code = await new Promise<number | null>((resolve) => { child.once("exit", resolve); setTimeout(() => resolve(-1), 15_000).unref(); });
    assert.equal(code, 0, "stdin was left open and it still ended");
    assert.ok(Date.now() - t0 < 14_000);
  });
});
