// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Typing a message into a conversation open in a terminal: the screen reading and the cleaning on their own, then the
 * connector end to end against a REAL tmux server of the test's own (its own socket in a temporary directory; never the
 * tmux the tests may be run from), with a stand-in for Claude Code's interface in the pane.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { localPidDomain } from "../src/attach.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { processStart } from "../src/children.js";
import { CLAUDE_MODE_INDICATORS, actsAsCommand, cleanInput, inputBox, findPane, modeVerdict, terminalMode, TerminalInput, tmuxRunner } from "../src/terminal-input.js";
import { Harness, tmpdir } from "./support/harness.js";

const REF = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FAKE_TERMINAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "support", "fake-terminal.mjs");
const RULE = "─".repeat(40);

describe("reading Claude Code's input box", () => {
  test("empty, with or without its dimmed suggestion; typed; several lines; and no box at all", () => {
    assert.equal(inputBox(`  ready\n${RULE}\n\x1b[39m❯ \x1b[2mTry "fix lint errors"\x1b[0m\n${RULE}\n  ⏵⏵ auto mode on`), "empty");
    assert.equal(inputBox(`${RULE}\n\x1b[38;5;246m❯ \x1b[39m\n${RULE}`), "empty");
    assert.equal(inputBox(`${RULE}\n\x1b[39m❯ hello\n${RULE}`), "typed");
    assert.equal(inputBox(`${RULE}\n\x1b[39m❯ \x1b[2mTry\x1b[0m and more\n${RULE}`), "typed", "text after the suggestion is text");
    assert.equal(inputBox(`${RULE}\n❯ line one\n  line two\n${RULE}`), "typed");
    // A permission question: its options start with ❯ too, but no rule above and below a single line holds them.
    assert.equal(inputBox(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel"), "unknown");
    assert.equal(inputBox("$ ls\nfile\n$ "), "unknown");
    assert.equal(inputBox(`${RULE}\n❯ half a box`), "unknown");
  });

  test("the message loses every control character: nothing in it can act as a key or end the paste", () => {
    assert.equal(cleanInput("run it\r\nand then\rthis"), "run it\nand then\nthis");
    assert.equal(cleanInput("a\x1b[201~b\x07c\x00d\u0085e f"), "a[201~bcde\nf");
    assert.equal(cleanInput("\x1b[A\x03\x04"), "[A");
    assert.equal(cleanInput("tab\there\n\n\n"), "tab  here");
    assert.equal(cleanInput("中文 消息"), "中文 消息");
  });
});

/** Every permission mode Claude Code has (its own table), and the footer it draws for each. */
const MODES = Object.values(CLAUDE_MODE_INDICATORS);
const INDICATOR_OF = Object.fromEntries(Object.entries(CLAUDE_MODE_INDICATORS).map(([label, id]) => [id, label]));
const screenIn = (footer: string, box = "\x1b[39m❯ \x1b[2mTry \"fix lint errors\"\x1b[0m") => `  ready\n${RULE}\n${box}\n${RULE}\n${footer}`;

describe("the terminal's permission mode, and whether the agent's policy lets the phone type in it", () => {
  test("Claude Code's six modes are the ones it names (2.1.285 to 2.1.319)", () => {
    assert.deepEqual([...MODES].sort(), ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
  });

  test("read from the footer below the box, as Claude Code draws it for each mode; anything else is unknown", () => {
    // As 2.1.319 drew them in a real tmux pane.
    assert.equal(terminalMode(screenIn("\x1b[39m  \x1b[38;5;246m⏸ manual mode on · ? for shortcuts\x1b[39m")), "default");
    assert.equal(terminalMode(screenIn("\x1b[39m  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle) · ← for agents          ◐ medium · /effort")), "auto");
    for (const mode of MODES) {
      const sym = mode === "default" || mode === "plan" ? "⏸" : "⏵⏵";
      assert.equal(terminalMode(screenIn(`  \x1b[38;5;147m${sym} ${INDICATOR_OF[mode]} on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m`)), mode, mode);
    }
    // No mode named (an older Claude Code, a notice in its place), two named, or no box at all: unknown.
    assert.equal(terminalMode(screenIn("  ? for shortcuts")), null);
    assert.equal(terminalMode(screenIn("  Press Ctrl-C again to exit")), null);
    assert.equal(terminalMode(screenIn("  ⏵⏵ accept edits on · ⏸ plan mode on")), null);
    assert.equal(terminalMode(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n  ⏸ manual mode on"), null);
    // Words in the box are not the footer.
    assert.equal(terminalMode(screenIn("  ? for shortcuts", "❯ please turn bypass permissions on")), null);
  });

  const agentOf = (extra: string) => parseConfig(`[[agents]]\nid = "a"\npreset = "claude-attach"\nroots = ["/tmp"]\n${extra}\n`).agents[0]!;
  test("approval \"ask\": only a mode in safeModes; every other mode Claude Code has is refused", () => {
    const a = agentOf("");
    const allowed = MODES.filter((m) => modeVerdict(a, m).ok);
    assert.deepEqual(allowed.sort(), ["default", "plan"]);
    for (const m of MODES.filter((x) => !allowed.includes(x))) assert.deepEqual(modeVerdict(a, m), { ok: false, reason: "terminal_mode_not_allowed" }, m);
    assert.deepEqual(modeVerdict(agentOf('approval = "ask"'), "bypassPermissions"), { ok: false, reason: "terminal_mode_not_allowed" });
  });
  test("approval \"never\" (or allow_unsafe_modes): every mode, the unsafe ones too", () => {
    for (const m of MODES) assert.deepEqual(modeVerdict(agentOf('approval = "never"'), m), { ok: true }, m);
    const file = parseConfig(`allow_unsafe_modes = true\n[[agents]]\nid = "a"\npreset = "claude-attach"\nroots = ["/tmp"]\n`).agents[0]!;
    for (const m of MODES) assert.deepEqual(modeVerdict(file, m), { ok: true }, m);
  });
  test("a read-only agent (its ask mode cannot write): only a read-only mode", () => {
    const a = agentOf('ask_mode = "plan"');
    assert.deepEqual(MODES.filter((m) => modeVerdict(a, m).ok), ["plan"]);
  });
  test("a mode that cannot be read is refused, whatever the approval", () => {
    for (const extra of ["", 'approval = "never"']) assert.deepEqual(modeVerdict(agentOf(extra), null), { ok: false, reason: "terminal_mode_unknown" });
  });
  test("a message that would run a shell command (!) or a slash command (/) there is not a prompt", () => {
    for (const t of ["!rm -rf ~", "  !ls", "/permissions", " /add-dir /", "/clear\nmore"]) assert.equal(actsAsCommand(t), true, t);
    for (const t of ["hello", "what does ! do", "a/b", "# heading"]) assert.equal(actsAsCommand(t), false, t);
  });
});

describe("the owner's switch", () => {
  const agent = (extra: string, preset = "claude-attach") => `[[agents]]\nid = "a"\npreset = "${preset}"\nroots = ["/tmp"]\n${extra}\n`;
  test("on by default with tmux from PATH; off with terminal_input = false; only for an attach agent, only a boolean", () => {
    assert.deepEqual(parseConfig(agent("")).agents[0]!.attach, { cli: "claude", tmux: "tmux" });
    assert.deepEqual(parseConfig(agent('tmux_cli = "/opt/bin/tmux"')).agents[0]!.attach, { cli: "claude", tmux: "/opt/bin/tmux" });
    assert.deepEqual(parseConfig(agent("terminal_input = false")).agents[0]!.attach, { cli: "claude", tmux: null });
    assert.throws(() => parseConfig(agent('terminal_input = "yes"')), (e: unknown) => e instanceof ConfigError && /terminal_input must be true or false/.test(e.message));
    assert.throws(() => parseConfig(agent("terminal_input = true", "codex")), (e: unknown) => e instanceof ConfigError && /terminal_input only applies to an agent made from the claude or claude-attach preset/.test(e.message));
    assert.throws(() => parseConfig(agent('tmux_cli = "tmux"', "codex")), (e: unknown) => e instanceof ConfigError && /tmux_cli only applies/.test(e.message));
  });

  test("on a plain claude agent it is the setting of the agent derived from it for the conversations already there", () => {
    const derived = (extra: string) => parseConfig(agent(extra, "claude")).agents.find((a) => a.id === "a-sessions")!;
    assert.deepEqual(derived("").attach, { cli: "claude", tmux: "tmux" });
    // Honoured, not a config problem: the derived agent only watches a conversation open in a terminal.
    assert.deepEqual(derived("terminal_input = false").attach, { cli: "claude", tmux: null });
    assert.deepEqual(derived('tmux_cli = "/opt/bin/tmux"').attach, { cli: "claude", tmux: "/opt/bin/tmux" });
    assert.equal(parseConfig(agent("terminal_input = false", "claude")).agents.find((a) => a.id === "a")!.attach, null, "the claude agent itself attaches nothing");
    assert.throws(() => parseConfig(agent('terminal_input = "no"', "claude")), (e: unknown) => e instanceof ConfigError && /terminal_input must be true or false/.test(e.message));
  });
});

// ---- a real tmux server of the test's own -------------------------------------------------------------------

let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* not installed */ }
// In CI a missing tmux is a failure, not a skip: these are the only tests that type into a real terminal.
const needTmux = process.env.CI === "true";

const servers: string[] = [];
const hs: Harness[] = [];
after(async () => {
  for (const h of hs) await h.close();
  // Only the servers this file started, by their own sockets.
  for (const s of servers) { try { execFileSync("tmux", ["-S", s, "kill-server"], { stdio: "ignore" }); } catch { /* gone */ } }
});

/** A tmux server on a socket of its own, with the stand-in interface in its one pane, working in `work`. */
function terminal(work: string, claudeDir: string, workMs = 300): {
  socket: string; pid: number; row: string; transcript: string; tmux: (...a: string[]) => string; setMode: (m: string) => void;
} {
  const dir = tmpdir("cc-tmux-");
  const socket = path.join(dir, "sock");
  const modeFile = path.join(dir, "mode");
  fs.writeFileSync(modeFile, "default");
  servers.push(socket);
  const transcript = path.join(claudeDir, "projects", work.replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", sessionId: REF, message: { role: "user", content: "earlier" } })}\n`);
  const row = path.join(claudeDir, "sessions", "pending.json");
  fs.mkdirSync(path.dirname(row), { recursive: true });
  const tmux = (...a: string[]) => execFileSync("tmux", ["-S", socket, ...a], { encoding: "utf8" });
  // The pane's own environment is what the connector reads: the test's own TMUX (if any) is not passed on.
  const env = { ...process.env, FAKE_TRANSCRIPT: transcript, FAKE_ROW: row, FAKE_SESSION: REF, FAKE_WORK_MS: String(workMs), FAKE_MODE_FILE: modeFile } as Record<string, string>;
  delete env.TMUX; delete env.TMUX_PANE;
  execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "30", "-c", work,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_TERMINAL)}`], { env });
  const pid = Number(tmux("display-message", "-p", "-t", "%0", "#{pane_pid}").trim());
  // The registry row Claude Code keeps for its process, named by its pid, which the stand-in updates.
  const named = path.join(claudeDir, "sessions", `${pid}.json`);
  fs.writeFileSync(named, JSON.stringify({ pid, sessionId: REF, status: "idle", kind: "interactive", cwd: work, procStart: processStart(pid), pidDomain: localPidDomain() }));
  fs.symlinkSync(named, row);
  return { socket, pid, row: named, transcript, tmux, setMode: (m) => fs.writeFileSync(modeFile, m) };
}

const until = async <T>(what: string, f: () => T | undefined | false, ms = 15_000): Promise<T> => {
  const by = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > by) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const typed = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((d) => d.type === "user" && d.promptSource === "typed").map((d) => d.message.content);

describe("typing into a terminal, through a real tmux", { skip: !hasTmux && !needTmux ? "tmux is not installed" : false }, () => {
  test("the pane is found and proven from the process, and typing waits for an empty box", async () => {
    const work = tmpdir("cc-work-");
    const claudeDir = tmpdir("cc-claude-");
    const t = terminal(work, claudeDir);
    // (Once the stand-in draws its box: until the pane's process has started, it still has the tmux server's environment.)
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    const found = await findPane(t.pid, "tmux");
    assert.ok(found.ok, JSON.stringify(found));
    assert.equal(found.pane.socket, t.socket);
    assert.equal(found.pane.pane, "%0");
    // Not a process outside tmux, nor one that only claims this pane in its environment (it does not run in it).
    const outside = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
    const forged = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", TMUX: `${t.socket},1,0`, TMUX_PANE: "%0" } });
    try {
      await until("both to start", () => fs.existsSync(`/proc/${outside.pid}/environ`) && fs.existsSync(`/proc/${forged.pid}/environ`));
      assert.deepEqual(await findPane(outside.pid!, "tmux"), { ok: false, why: "the terminal is not a tmux pane" });
      assert.deepEqual(await findPane(forged.pid!, "tmux"), { ok: false, why: "the tmux pane it names does not run that process" });
    } finally {
      outside.kill("SIGKILL");
      forged.kill("SIGKILL");
    }
    const input = new TerminalInput(found.pane, tmuxRunner("tmux", t.socket));
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    assert.deepEqual(await input.readiness(), { ready: true, mode: "default" });
    t.setMode("bypassPermissions");
    await until("the footer names the new mode", () => terminalMode(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "bypassPermissions");
    assert.deepEqual(await input.readiness(), { ready: true, mode: "bypassPermissions" });
    t.setMode("default");
    t.tmux("send-keys", "-t", "%0", "-l", "half-typed");
    await until("the half-typed text", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "typed");
    assert.deepEqual(await input.readiness(), { ready: false, why: "typing" });
    t.tmux("send-keys", "-t", "%0", "C-u");
    await until("an empty box again", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    await input.type("hello from the phone");
    await until("the prompt in the transcript", () => typed(t.transcript).includes("hello from the phone"));
  });

  test("two messages from Claw are typed into the terminal as the person's own prompts, and the replies come back", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir);
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    // The heartbeat says it can be typed into.
    await h.online();
    await h.claw.until("a heartbeat that offers typing", () => [...h.claw.heartbeats].reverse().find((b) =>
      b.agents[0].capabilities.terminal_input === true && b.agents[0].capabilities.resumable?.find((r: any) => r.ref === REF)?.input === "terminal"));

    const sid = await h.attach(REF);
    const started = h.claw.eventsOf(sid, "session_started")[0]!.data;
    assert.deepEqual([started.read_only, started.live_terminal, started.input, started.attached], [undefined, true, "terminal", true]);
    assert.ok(!h.adapterLog().some((l) => l.method === "session/resume" || l.method === "session/prompt"), "no second agent on the conversation");

    const one = h.prompt(sid, "first message");
    const end1 = await h.turnEnd(sid, 1);
    assert.deepEqual([end1.data.stopReason, end1.data.cmd_seq, end1.data.error], ["end_turn", one, undefined]);
    await h.claw.until("the reply", () => h.claw.eventsOf(sid, "agent_message_chunk").find((e) => e.data.update.content.text === "echo: first message"));

    // Several lines, and characters that would be keys: one prompt, typed as text.
    const two = h.prompt(sid, "second\nmessage\x1b[201~\x07 end\r\n");
    const end2 = await h.turnEnd(sid, 2);
    assert.deepEqual([end2.data.stopReason, end2.data.cmd_seq], ["end_turn", two]);
    assert.deepEqual(typed(t.transcript), ["first message", "second\nmessage[201~ end"]);
    await h.claw.until("the second reply", () => h.claw.eventsOf(sid, "agent_message_chunk").find((e) => e.data.update.content.text === "echo: second\nmessage[201~ end"));
    // Its own prompts are not sent back as news; what was typed at the terminal is, and nothing is marked read-only.
    assert.ok(!h.claw.eventsOf(sid, "user_message_chunk").some((e) => !e.data.replay && /first message|second/.test(e.data.update.content.text)));
    assert.ok(!h.claw.eventsOf(sid).some((e) => e.data.read_only === true));

    // Someone is typing at the terminal: the message waits, and the phone is told why; once the box is empty it goes.
    t.tmux("send-keys", "-t", "%0", "-l", "the person types");
    await until("their text", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "typed");
    const three = h.prompt(sid, "third");
    const queued = await h.claw.until("the queue notice", () => h.claw.eventsOf(sid, "terminal_input_queued")[0]);
    assert.deepEqual([queued.data.reason, queued.data.cmd_seq], ["terminal_typing", three]);
    assert.ok(!typed(t.transcript).includes("third"), "not typed over their text");
    t.tmux("send-keys", "-t", "%0", "C-u");
    const end3 = await h.turnEnd(sid, 3);
    assert.deepEqual([end3.data.stopReason, end3.data.cmd_seq], ["end_turn", three]);
    assert.deepEqual(typed(t.transcript), ["first message", "second\nmessage[201~ end", "third"]);

    // The terminal's own prompt reaches the phone as the person's words.
    t.tmux("send-keys", "-t", "%0", "-l", "typed at the terminal");
    t.tmux("send-keys", "-t", "%0", "Enter");
    await h.claw.until("the terminal's prompt", () => h.claw.eventsOf(sid, "user_message_chunk").find((e) => e.data.update.content.text === "typed at the terminal"));

    // The trail: one record per message typed, its size and a digest, never its words.
    const trail = h.audit().filter((a) => a.kind === "terminal_input");
    assert.equal(trail.length, 3);
    assert.deepEqual(trail.map((a) => a.length), [13, 23, 5]);
    assert.ok(trail.every((a) => a.pid === t.pid && a.pane === "%0" && typeof a.sha256 === "string"));
    assert.ok(!JSON.stringify(h.audit()).includes("first message"), "the words are not in the trail");
    // The terminal switches to another conversation (`/resume` there): a message for this one is not typed into it.
    const row = JSON.parse(fs.readFileSync(t.row, "utf8"));
    fs.writeFileSync(t.row, JSON.stringify({ ...row, sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", status: "idle" }));
    const four = h.prompt(sid, "fourth");
    const refused = await h.claw.until("the refusal", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_seq === four));
    assert.equal(refused.data.reason, "terminal_switched");
    assert.ok(!typed(t.transcript).includes("fourth"), "not typed into the other conversation");
    fs.writeFileSync(t.row, JSON.stringify(row));
    // A mode change is the terminal's.
    h.claw.issue("set_mode", sid, { mode_id: "plan" });
    const rejected = await h.claw.until("the mode change refused", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.type === "set_mode"));
    assert.equal(rejected.data.reason, "terminal_session");
  });

  test("a restart during a typed message's turn ends that turn by name and never types the message again", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 60_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir, 4_000);
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    const sid = await h.attach(REF);
    const seq = h.prompt(sid, "a long one");
    await until("it is typed", () => typed(t.transcript).includes("a long one"));
    await h.stop();
    h.connect({ timing: { spectateMs: 20, spectateCheckMs: 60_000 } as never });
    h.start();
    const end = await h.claw.until("the turn ended by the restart", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === seq));
    assert.equal(end.data.error, "connector_restarted");
    await new Promise((r) => setTimeout(r, 1_500));
    assert.deepEqual(typed(t.transcript).filter((x) => x === "a long one").length, 1, "typed once, not again after the restart");
  });

  /** A typed session on an agent with `approval`, and one prompt per mode Claude Code has: typed, or refused by name. */
  const throughModes = async (approval: "ask" | "never") => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000, terminalModeWaitMs: 300 } as never,
      ...(approval === "never" ? { approval, askMode: "bypassPermissions" } : { approval }),
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir);
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    const sid = await h.attach(REF);
    const out: Record<string, { typed: boolean; error?: string; reason?: string; mode?: unknown }> = {};
    for (const mode of [...MODES, "none"]) {
      t.setMode(mode);
      await until(`the footer for ${mode}`, () => terminalMode(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === (mode === "none" ? null : mode)
        && inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
      const words = `in ${mode}`;
      const seq = h.prompt(sid, words);
      const end = await h.claw.until(`the end of the prompt in ${mode}`, () => h.turnEnds(sid).find((e) => e.data.cmd_seq === seq), 15_000);
      const rejected = h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_seq === seq);
      out[mode] = { typed: typed(t.transcript).includes(words), ...(end.data.error ? { error: end.data.error, reason: rejected?.data.reason, mode: rejected?.data.terminal_mode } : {}) };
    }
    t.setMode("default");
    // A shell command or a slash command is never typed, in any mode.
    const bang = h.prompt(sid, "!touch pwned");
    const r = await h.claw.until("the refusal", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_seq === bang));
    assert.equal(r.data.reason, "terminal_command_refused");
    assert.match(String(r.data.hint), /starts with ! or \//);
    assert.ok(!typed(t.transcript).includes("!touch pwned"));
    return out;
  };

  test("approval \"ask\": typed only in a mode in safeModes; an unsafe mode is refused with the mode named; an unread mode is refused", async () => {
    const out = await throughModes("ask");
    const want: typeof out = {};
    for (const m of MODES) {
      want[m] = ["default", "plan"].includes(m) ? { typed: true } : { typed: false, error: "terminal_mode_not_allowed", reason: "terminal_mode_not_allowed", mode: m };
    }
    want.none = { typed: false, error: "terminal_mode_unknown", reason: "terminal_mode_unknown", mode: null };
    assert.deepEqual(out, want);
  });

  test("approval \"never\": typed in every mode, the unsafe ones too; an unread mode is still refused", async () => {
    const out = await throughModes("never");
    const want: typeof out = Object.fromEntries(MODES.map((m) => [m, { typed: true }]));
    want.none = { typed: false, error: "terminal_mode_unknown", reason: "terminal_mode_unknown", mode: null };
    assert.deepEqual(out, want);
  });

  test("the owner can turn it off: then the same conversation is only watched", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000 } as never, agentToml: "terminal_input = false",
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir);
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    const sid = await h.attach(REF);
    const started = h.claw.eventsOf(sid, "session_started")[0]!.data;
    assert.deepEqual([started.read_only, started.live_terminal], [true, undefined]);
    assert.match(String(started.read_only_why), /turned off/);
    h.prompt(sid, "not typed");
    const rejected = await h.claw.until("the refusal", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.equal(rejected.data.reason, "read_only_live_session");
    assert.deepEqual(typed(t.transcript), []);
  });
});
