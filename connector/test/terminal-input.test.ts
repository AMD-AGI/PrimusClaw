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
import { CLAUDE_MODE_INDICATORS, MODES_THAT_DO_NOT_ASK, actsAsCommand, cleanInput, dialogOnScreen, enterGuard, inputBox, findPane, terminalMode, TerminalInput, tmuxRunner } from "../src/terminal-input.js";
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

  test("a conversation's name in the rule above the box (/rename) is still the box: empty, typed and the mode read as without it", () => {
    const named = (box: string, footer: string) => `  ready\n${"─".repeat(50)} clean ─\n${box}\n${"─".repeat(60)}\n${footer}`;
    assert.equal(inputBox(named("❯ ", "  ⏵⏵ bypass permissions on (shift+tab to cycle)")), "empty");
    assert.equal(inputBox(named("❯ half typed", "  ⏸ manual mode on")), "typed");
    assert.equal(terminalMode(named("❯ ", "  ⏵⏵ bypass permissions on (shift+tab to cycle)")), "bypassPermissions");
    // A rule is still dashes on both sides of the name: a line of words with dashes in it is not.
    assert.equal(inputBox(`  ready\n─── not a rule, words\n❯ \n${"─".repeat(60)}\n  ⏸ manual mode on`), "unknown");
  });
  test("the modes in which a message typed from the phone runs without asking are the ones Claude Code names so", () => {
    assert.deepEqual([...MODES_THAT_DO_NOT_ASK].sort(), ["acceptEdits", "auto", "bypassPermissions", "dontAsk"]);
    for (const m of MODES_THAT_DO_NOT_ASK) assert.ok(MODES.includes(m), m);
  });
  test("a question or a menu on the screen: under the box, or in its place; the agent's words above the box are not one", () => {
    assert.equal(dialogOnScreen(screenIn("  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt")), false, "a running turn is not a question");
    assert.equal(dialogOnScreen(screenIn("  ⏸ manual mode on\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel", "❯ hello")), true);
    assert.equal(dialogOnScreen(" Bash command\n   touch x\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend"), true, "in place of the box");
    assert.equal(dialogOnScreen(`● Do you want to proceed? Esc to cancel\n${screenIn("  ⏸ manual mode on")}`), false);
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
function terminal(work: string, claudeDir: string, workMs = 300, extraEnv: Record<string, string> = {}, asClaude = false): {
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
  const env = { ...process.env, FAKE_TRANSCRIPT: transcript, FAKE_ROW: row, FAKE_SESSION: REF, FAKE_WORK_MS: String(workMs), FAKE_MODE_FILE: modeFile, ...extraEnv } as Record<string, string>;
  delete env.TMUX; delete env.TMUX_PANE;
  execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "30", "-c", work,
    // (`asClaude`: its arguments name the program `claude`, as a process the connector looks at for an unreadable row must)
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_TERMINAL)}${asClaude ? " claude" : ""}`], { env });
  const pid = Number(tmux("display-message", "-p", "-t", "%0", "#{pane_pid}").trim());
  // The registry row Claude Code keeps for its process, named by its pid, which the stand-in updates.
  const named = path.join(claudeDir, "sessions", `${pid}.json`);
  fs.writeFileSync(named, JSON.stringify({ pid, sessionId: REF, status: extraEnv.FAKE_IDLE_STATUS ?? "idle", kind: "interactive", cwd: work, procStart: processStart(pid), pidDomain: localPidDomain(), version: extraEnv.FAKE_VERSION ?? "2.1.321" }));
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
/** The messages Claude Code queued (submitted while a turn ran), as its transcript says. */
const queuedIn = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((d) => d.type === "queue-operation" && d.operation === "enqueue").map((d) => d.content);
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
    // (its own notice: an earlier message may have had one of its own while the screen was being redrawn, terminal_state_unknown)
    const queued = await h.claw.until("the queue notice", () => h.claw.eventsOf(sid, "terminal_input_queued").find((e) => e.data.cmd_seq === three));
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

  test("withdraw takes back a message waiting for the terminal and leaves the terminal alone: no Escape, nothing typed", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir);
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    await h.online();
    await h.claw.until("a heartbeat that offers typing and taking back", () => [...h.claw.heartbeats].reverse().find((b) =>
      b.agents[0].capabilities.withdraw === true && b.agents[0].capabilities.resumable?.find((r: any) => r.ref === REF)?.input === "terminal"));
    const sid = await h.attach(REF);
    // Someone is typing at the terminal: the phone's message waits for it.
    t.tmux("send-keys", "-t", "%0", "-l", "the person types");
    await until("their text", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "typed");
    const one = h.prompt(sid, "from the phone");
    await h.claw.until("the queue notice", () => h.claw.eventsOf(sid, "terminal_input_queued")[0]);
    h.claw.issue("withdraw", sid, { cmd_id: "w-term" });
    const refused = await h.claw.until("the message taken back", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.cmd_seq === one));
    assert.equal(refused.data.reason, "withdrawn");
    // Their text is still in the box (no Escape, no clearing), and once they send it the phone's message is never typed.
    assert.equal(inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")), "typed");
    t.tmux("send-keys", "-t", "%0", "Enter");
    await h.claw.until("the terminal's prompt", () => h.claw.eventsOf(sid, "user_message_chunk").find((e) => e.data.update.content.text === "the person types"));
    await new Promise((r) => setTimeout(r, 1_000));
    assert.ok(!typed(t.transcript).includes("from the phone"), "the message taken back is not typed");
    assert.equal(h.audit().filter((a) => a.kind === "terminal_input").length, 0);
    assert.equal(h.turnEnds(sid).length, 0, "nothing of the phone's ran, so nothing of it ended");
  });

  test("a row another pid domain left in the shared Claude directory does not stop typing into the local terminal", async () => {
    // (a dev container on a shared disk restarts; the rows of the processes killed with its earlier boot stay, in a domain
    // that is not this one, and nothing can tell them from a process on another machine)
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir);
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    fs.writeFileSync(path.join(h.attachDir, "sessions", "424242.json"), JSON.stringify({
      pid: 424242, sessionId: REF, status: "busy", kind: "interactive", cwd: work, procStart: "1", pidDomain: "linux:an-earlier-boot:pid:[4026531836]" }));
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    await h.online();
    await h.claw.until("a heartbeat that offers typing", () => [...h.claw.heartbeats].reverse().find((b) =>
      b.agents[0].capabilities.resumable?.find((r: any) => r.ref === REF)?.input === "terminal"));
    const sid = await h.attach(REF);
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.input, "terminal");
    const one = h.prompt(sid, "despite the old row");
    const end = await h.turnEnd(sid, 1);
    assert.deepEqual([end.data.stopReason, end.data.cmd_seq, end.data.error], ["end_turn", one, undefined]);
    assert.deepEqual(typed(t.transcript), ["despite the old row"]);
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
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
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

  // The terminal's mode is its owner's choice: whatever the agent's approval, a message is typed in every mode, and in a terminal
  // whose footer names none (Yihan, 2026-11-09).
  for (const approval of ["ask", "never"] as const) {
    test(`approval "${approval}": typed in every mode Claude Code has, and where the footer names none`, async () => {
      const out = await throughModes(approval);
      assert.deepEqual(out, Object.fromEntries([...MODES, "none"].map((m) => [m, { typed: true }])));
    });
  }

  test("session_started names the terminal's mode, so the chat can say a message runs without asking", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir);
    t.setMode("bypassPermissions");
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    await until("the bypass footer", () => terminalMode(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "bypassPermissions");
    const sid = await h.attach(REF);
    const started = h.claw.eventsOf(sid, "session_started")[0]!.data;
    assert.deepEqual([started.live_terminal, started.terminal_mode], [true, "bypassPermissions"]);
  });

  test("a conversation with a name in its rule (/rename) in bypass mode: typed at once, not held as an unreadable screen", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "clean", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir, 300, { FAKE_TITLE: "clean" });
    t.setMode("bypassPermissions");
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    await until("an empty named box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    const sid = await h.attach(REF);
    const seq = h.prompt(sid, "from the phone");
    const end = await h.claw.until("the turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === seq), 15_000);
    assert.equal(end.data.error, undefined);
    assert.ok(typed(t.transcript).includes("from the phone"));
  });

  test("a terminal whose Claude Code says `shell` (idle at its prompt, background shells running) is typed into at once", async () => {
    // (Claude Code 2.1.32x: `shell` is `idle` with background shells; read as busy, the message waited until it was refused)
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "toolbox", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir, 300, { FAKE_IDLE_STATUS: "shell" });
    h.setLive([{ pid: t.pid, sessionId: REF, status: "shell", cwd: work }]);
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    await h.online();
    const hb = await h.claw.until("a heartbeat that offers typing", () => [...h.claw.heartbeats].reverse().find((b) =>
      b.agents[0].capabilities.resumable?.find((r: any) => r.ref === REF)?.input === "terminal"));
    assert.equal(hb.agents[0].capabilities.resumable.find((r: any) => r.ref === REF).activity, "idle", "listed as idle at its prompt");
    const sid = await h.attach(REF);
    const one = h.prompt(sid, "from the phone");
    const end1 = await h.claw.until("the first turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === one), 10_000);
    assert.deepEqual([end1.data.stopReason, end1.data.error], ["end_turn", undefined]);
    // and again after a turn of its own, which leaves the row at `shell`
    const two = h.prompt(sid, "and again");
    const end2 = await h.claw.until("the second turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === two), 10_000);
    assert.deepEqual([end2.data.stopReason, end2.data.error], ["end_turn", undefined]);
    assert.deepEqual(typed(t.transcript), ["from the phone", "and again"]);
    assert.ok(!h.claw.eventsOf(sid, "terminal_input_queued").some((e) => e.data.reason === "terminal_state_unknown"), "never held as a state it cannot read");
  });

  // Yihan, 2026-11-10: "clawy本身不要做这个是否忙的判断了，收到消息就直接发." Whatever Claude Code is doing, the message is typed at once;
  // one submitted while a turn runs is Claude Code's to queue, as one typed by the person at the terminal is.
  for (const c of [
    { name: "taken into the running turn at its next step (queued_command)", queue: "absorb" },
    { name: "taken once the running turn ends (dequeue, a turn of its own)", queue: "next" },
  ]) {
    test(`a terminal whose main turn runs: the message is typed at once, Claude Code queues it, and it is ${c.name}; its turn ends with the reply`, async () => {
      const work = tmpdir("cc-work-");
      const h = await Harness.create({
        work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
        attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "clawy", updatedAt: "2026-11-10T03:00:00.000Z" }] },
      });
      hs.push(h);
      // (busy for hours with background agents, as clawy: its row never says idle; and a main turn of its own runs, `esc to interrupt`)
      const t = terminal(work, h.attachDir, 300, { FAKE_IDLE_STATUS: "busy", FAKE_BUSY_MS: "4000", FAKE_QUEUE: c.queue });
      h.setLive([{ pid: t.pid, sessionId: REF, status: "busy", cwd: work }]);
      await until("its turn running on the screen", () => t.tmux("capture-pane", "-p", "-t", "%0").includes("esc to interrupt"));
      const sid = await h.attach(REF);
      const t0 = Date.now();
      const one = h.prompt(sid, "from the phone");
      await until("the message queued by Claude Code", () => queuedIn(t.transcript).includes("from the phone"), 3_000);
      assert.ok(t.tmux("capture-pane", "-p", "-t", "%0").includes("esc to interrupt"), "typed while that turn still ran");
      assert.ok(Date.now() - t0 < 3_000, `typed in ${Date.now() - t0} ms`);
      const end = await h.claw.until("the turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === one), 15_000);
      assert.deepEqual([end.data.stopReason, end.data.error], ["end_turn", undefined]);
      await h.claw.until("the reply", () => h.claw.eventsOf(sid, "agent_message_chunk").find((e) => e.data.update.content.text === "echo: from the phone"));
      assert.deepEqual(h.claw.eventsOf(sid, "terminal_input_queued").filter((e) => e.data.cmd_seq === one), [], "never held back as busy");
      assert.ok(!h.claw.eventsOf(sid, "user_message_chunk").some((e) => e.data.update.content.text === "from the phone"), "its own echo is not news");
    });
  }

  test("every former busy signal at once (row busy, main turn not ended, a message still queued, a large transcript, esc to interrupt, an unmeasured version): typed at once", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
    work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
    attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "clawy", updatedAt: "2026-11-10T03:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir, 300, { FAKE_IDLE_STATUS: "busy", FAKE_BUSY_MS: "3000", FAKE_QUEUE: "absorb", FAKE_VERSION: "9.9.9" });
    h.setLive([{ pid: t.pid, sessionId: REF, status: "busy", cwd: work }]);
    fs.appendFileSync(t.transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: REF, content: "later" })}\n`);
    fs.appendFileSync(t.transcript, `${JSON.stringify({ type: "assistant", sessionId: REF, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(700_000) }] } })}\n`);
    await until("its turn running on the screen", () => t.tmux("capture-pane", "-p", "-t", "%0").includes("esc to interrupt"));
    const sid = await h.attach(REF);
    const one = h.prompt(sid, "from the phone");
    await until("the message queued by Claude Code", () => queuedIn(t.transcript).includes("from the phone"), 3_000);
    const end = await h.claw.until("the turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === one), 15_000);
    assert.deepEqual([end.data.stopReason, end.data.error], ["end_turn", undefined]);
  });

  test("a terminal whose registry row is torn: proven by the task folder its process holds, listed live, typed into once its screen is free", { skip: process.platform !== "linux" }, async () => {
    // (Claude Code never writes a torn row again: autopilot-devpod 2026-11-09, every conversation of the folder was "unknown" and
    // the one in use had no Connect)
    const work = tmpdir("cc-work-");
    const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
      attach: { tmux: "tmux", sessions: [
        { sessionId: REF, cwd: work, title: "autopilot", updatedAt: "2026-11-09T10:00:00.000Z" },
        { sessionId: OTHER, cwd: work, title: "an old one", updatedAt: "2026-11-06T10:00:00.000Z" },
      ] },
    });
    hs.push(h);
    const uid = process.getuid!();
    const project = fs.realpathSync(work).replace(/[^A-Za-z0-9]/g, "-");
    const tasks = path.join(tmpdir("cc-tmp-"), `claude-${uid}`, project, REF, "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    const t = terminal(fs.realpathSync(work), h.attachDir, 1_500, { FAKE_TORN_ROW: "1", FAKE_TASKS_DIR: tasks, FAKE_TITLE: "autopilot" }, true);
    // The row is torn (empty, not just being written), and nothing lists the process; its conversation was written since it started.
    fs.writeFileSync(t.row, "");
    const old = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(t.row, old, old);
    h.setLive([]);
    // Another interactive conversation of the folder written since it started (a /resume there would look the same): its screen
    // decides, the name in the rule above its box being the held one's.
    fs.writeFileSync(path.join(path.dirname(t.transcript), `${OTHER}.jsonl`),
      `${JSON.stringify({ type: "user", sessionId: OTHER, entrypoint: "cli" })}\n${JSON.stringify({ type: "custom-title", customTitle: "an old one", sessionId: OTHER })}\n`);
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    fs.appendFileSync(t.transcript, `${JSON.stringify({ type: "system", sessionId: REF, entrypoint: "cli" })}\n${JSON.stringify({ type: "custom-title", customTitle: "autopilot", sessionId: REF })}\n`);
    await h.online();
    const hb = await h.claw.until("a heartbeat that lists it live, typed into", () => [...h.claw.heartbeats].reverse().find((b) =>
      b.agents[0].capabilities.resumable?.find((r: any) => r.ref === REF)?.input === "terminal"));
    const listed = hb.agents[0].capabilities.resumable;
    assert.deepEqual(listed.map((r: any) => [r.ref, r.state]), [[REF, "live"], [OTHER, "idle"]], "the old one is free: that process holds REF");
    const sid = await h.attach(REF);
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.input, "terminal");
    const one = h.prompt(sid, "from the phone");
    const end = await h.claw.until("the turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === one), 15_000);
    assert.deepEqual([end.data.stopReason, end.data.error], ["end_turn", undefined]);
    assert.deepEqual(typed(t.transcript), ["from the phone"]);
    await h.claw.until("the reply", () => h.claw.eventsOf(sid, "agent_message_chunk").find((e) => e.data.update.content.text === "echo: from the phone"));
    // A turn of the terminal's own runs (`esc to interrupt` under the box, and no row says so): the phone's next message is typed at
    // once all the same, and Claude Code queues it until that turn ends.
    t.tmux("send-keys", "-t", "%0", "-l", "typed at the terminal");
    t.tmux("send-keys", "-t", "%0", "Enter");
    await until("its turn running on the screen", () => t.tmux("capture-pane", "-p", "-t", "%0").includes("esc to interrupt"));
    const two = h.prompt(sid, "while it works");
    await until("the message queued by Claude Code", () => queuedIn(t.transcript).includes("while it works"), 3_000);
    assert.deepEqual(h.claw.eventsOf(sid, "terminal_input_queued").filter((e) => e.data.cmd_seq === two), [], "never held back as busy");
    const end2 = await h.claw.until("the second turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === two), 15_000);
    assert.deepEqual([end2.data.stopReason, end2.data.error], ["end_turn", undefined]);
    assert.deepEqual(typed(t.transcript), ["from the phone", "typed at the terminal", "while it works"]);
  });

  for (const c of [
    { name: "the box still holding the text: Enter then", clears: false },
    { name: "the question having emptied the box: typed again, then Enter", clears: true },
  ]) {
    test(`a question shows after the text is typed, before Enter: no key reaches it, the phone is told, and once it is answered at the terminal, ${c.name}`, async () => {
      // (the hard rule: a phone's message never becomes a key of a confirmation; an Enter there would approve a tool call)
      const work = tmpdir("cc-work-");
      const h = await Harness.create({
        work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
        attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
      });
      hs.push(h);
      const dir = tmpdir("cc-dialog-");
      const approved = path.join(dir, "approved");
      const dismiss = path.join(dir, "dismiss");
      const t = terminal(work, h.attachDir, 300, { FAKE_DIALOG_FILE: approved, FAKE_DIALOG_DISMISS: dismiss, ...(c.clears ? { FAKE_DIALOG_CLEARS: "1" } : {}) });
      h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
      await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
      const sid = await h.attach(REF);
      const seq = h.prompt(sid, "1 yes please go ahead");
      const told = await h.claw.until("the notice that a question holds it", () => h.claw.eventsOf(sid, "terminal_input_queued").find((e) => e.data.cmd_seq === seq));
      assert.equal(told.data.reason, "terminal_dialog");
      // Held for longer than any echo wait: still nothing approved, nothing submitted, the turn not ended.
      await new Promise((r) => setTimeout(r, 2_500));
      assert.equal(fs.existsSync(approved), false, "no Enter reached the question");
      assert.deepEqual(typed(t.transcript), [], "nothing was submitted");
      assert.equal(h.turnEnds(sid).find((e) => e.data.cmd_seq === seq), undefined, "still waiting");
      fs.writeFileSync(dismiss, "");
      const end = await h.claw.until("the turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === seq), 15_000);
      assert.deepEqual([end.data.stopReason, end.data.error], ["end_turn", undefined]);
      assert.equal(fs.existsSync(approved), false, "no Enter reached the question");
      assert.deepEqual(typed(t.transcript), ["1 yes please go ahead"], "submitted once");
    });
  }

  test("a question that shows in the very moment the message goes in does not take it as its choice (a lone 1): it goes in as a paste, then once the question is answered", async () => {
    // (Claude Code 2.1.285, measured 2026-11-10: a typed `1` while a permission question shows approves it; a pasted one does not)
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const dir = tmpdir("cc-dialog-");
    const approved = path.join(dir, "approved");
    const dismiss = path.join(dir, "dismiss");
    const t = terminal(work, h.attachDir, 300, { FAKE_DIALOG_FILE: approved, FAKE_DIALOG_DISMISS: dismiss, FAKE_DIALOG_ON_KEY: "1" });
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    const sid = await h.attach(REF);
    const seq = h.prompt(sid, "1");
    const told = await h.claw.until("the notice that a question holds it", () => h.claw.eventsOf(sid, "terminal_input_queued").find((e) => e.data.cmd_seq === seq));
    assert.equal(told.data.reason, "terminal_dialog");
    assert.equal(fs.existsSync(approved), false, "the question did not take the message as its choice");
    fs.writeFileSync(dismiss, "");
    const end = await h.claw.until("the turn's end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === seq), 15_000);
    assert.deepEqual([end.data.stopReason, end.data.error], ["end_turn", undefined]);
    assert.equal(fs.existsSync(approved), false);
    assert.deepEqual(typed(t.transcript), ["1"], "submitted once, after the question");
  });

  test("a question shows after the text is typed, and the person at the terminal types into the box meanwhile: their text is left, the message refused", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalIdleMs: 2_000 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const dir = tmpdir("cc-dialog-");
    const approved = path.join(dir, "approved");
    const dismiss = path.join(dir, "dismiss");
    const t = terminal(work, h.attachDir, 300, { FAKE_DIALOG_FILE: approved, FAKE_DIALOG_DISMISS: dismiss });
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    const sid = await h.attach(REF);
    const seq = h.prompt(sid, "from the phone");
    await h.claw.until("the notice that a question holds it", () => h.claw.eventsOf(sid, "terminal_input_queued").find((e) => e.data.cmd_seq === seq));
    t.tmux("send-keys", "-t", "%0", "-l", " and mine");
    fs.writeFileSync(dismiss, "");
    const end = await h.claw.until("the refusal", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === seq), 15_000);
    assert.equal(end.data.error, "terminal_input_failed");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.existsSync(approved), false);
    assert.deepEqual(typed(t.transcript), [], "nothing was submitted");
    assert.match(String(h.audit().find((a) => a.kind === "terminal_input_refused")?.detail), /the box does not hold exactly what was typed/);
  });

  test("Enter's guard reads the one screen: the box there, exactly the text, no question; a long text the box wraps is still exact", () => {
    const box = (held: string[], below = "  ⏸ manual mode on") => `  ready\n${RULE}\n❯ ${held[0]}\n${held.slice(1).map((l) => `  ${l}`).join("\n")}${held.length > 1 ? "\n" : ""}${RULE}\n${below}`;
    assert.equal(enterGuard(box(["hello from the phone"]), "hello from the phone"), null);
    // (RULE is 40 columns: a row holds 39 at most, its prompt or indent included; a wide character takes two)
    assert.equal(enterGuard(box(["这是一段很长的手机消息，用来测试输入框", "如何显示。"]), "这是一段很长的手机消息，用来测试输入框如何显示。"), null, "wrapped, wide characters");
    assert.equal(enterGuard(box(["这是一段很长的手机消息", "用来测试输入框如何显示。"]), "这是一段很长的手机消息用来测试输入框如何显示。"), "the box does not hold exactly what was typed", "a row ending short is a line break, not a wrap");
    assert.equal(enterGuard(box(["line one", "line two"]), "line one\nline two"), null);
    assert.equal(enterGuard(box(["[Pasted text #1 +2 lines]"]), "a\nb\nc"), null, "a long paste, its line breaks counted");
    assert.equal(enterGuard(box(["[Pasted text #1 +40 lines]"]), "a\nb\nc"), "the box does not hold exactly what was typed", "another paste");
    assert.equal(enterGuard(box(["[Pasted text #3]"]), "x".repeat(1500)), null, "one long line, collapsed");
    assert.equal(enterGuard(box(["[Pasted text #3]"]), "short"), "the box does not hold exactly what was typed", "a short line is never collapsed");
    assert.equal(enterGuard(box(["[Pasted text #3]", "more"]), "x".repeat(1500)), "the box does not hold exactly what was typed");
    // Exactly the text: a wrap may drop the space it broke at, nothing else may differ.
    assert.equal(enterGuard(box(["aaaaaaaa bbbbbbbb cccccccc dddddd", "eeeeee"]), "aaaaaaaa bbbbbbbb cccccccc dddddd eeeeee"), null, "wrapped at a space: the next word did not fit");
    assert.equal(enterGuard(box(["x".repeat(37), "xxx"]), "x".repeat(40)), null, "wrapped inside a word: the row full");
    assert.equal(enterGuard(box(["x".repeat(36), "x"]), "x".repeat(37)), "the box does not hold exactly what was typed", "one more column was free (codex r3)");
    assert.equal(enterGuard(box([`${"x".repeat(36)}`, "你好"]), `${"x".repeat(36)}你好`), null, "a wide character does not fit the last free column");
    // (codex r2 on #648) a line break of the box's own is not a wrapped space
    assert.equal(enterGuard(box(["hello", "world"]), "hello world"), "the box does not hold exactly what was typed", "a line break is not a space");
    assert.equal(enterGuard(box(["aaaaaaaa bbbbbbbb cccc", "dd"]), "aaaaaaaa bbbbbbbb cccc dd"), "the box does not hold exactly what was typed", "the next word would have fit");
    assert.equal(enterGuard(box(["hello", "world"]), "hello\nworld"), null, "the text's own line break");
    assert.equal(enterGuard(box(["hellofrom the phone"]), "hello from the phone"), "the box does not hold exactly what was typed", "a space taken out");
    assert.equal(enterGuard(box(["hello from th e phone"]), "hello from the phone"), "the box does not hold exactly what was typed", "a space put in");
    assert.equal(enterGuard(box(["hello from the"]), "hello from the phone"), "the box does not hold exactly what was typed", "cut short");
    assert.equal(enterGuard(box(["line one", "", "line three"]), "line one\n\nline three"), null, "an empty line");
    assert.equal(enterGuard(box(["line one", "line three"]), "line one\n\nline three"), "the box does not hold exactly what was typed");
    assert.equal(enterGuard(box(["hello from the phone and more"]), "hello from the phone"), "the box does not hold exactly what was typed");
    assert.equal(enterGuard(box(["hello"], "  ⏸ manual mode on\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel"), "hello"), "a question or a menu is on the screen");
    assert.equal(enterGuard(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend", "hello"), "no input box on the screen");
    // A turn running under the box does not hold Enter back: Claude Code queues what is submitted meanwhile.
    assert.equal(enterGuard(box(["hello"], "  ⏵⏵ bypass permissions on · esc to interrupt"), "hello"), null);
    // The agent's own words above the box that look like a question do not hold Enter back.
    assert.equal(enterGuard(`● Do you want to proceed? Esc to cancel\n${box(["hello"])}`, "hello"), null);
  });

  test("a screen that cannot be read is refused by name after terminalScreenWaitMs, not held for terminalWaitMs", async () => {
    const work = tmpdir("cc-work-");
    const h = await Harness.create({
      work, timing: { spectateMs: 20, spectateCheckMs: 60_000, terminalScreenWaitMs: 500 } as never,
      attach: { tmux: "tmux", sessions: [{ sessionId: REF, cwd: work, title: "In the terminal", updatedAt: "2026-11-07T10:00:00.000Z" }] },
    });
    hs.push(h);
    const t = terminal(work, h.attachDir);
    h.setLive([{ pid: t.pid, sessionId: REF, status: "idle", cwd: work }]);
    const sid = await h.attach(REF);
    t.setMode("nobox");
    await until("no box on the screen", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "unknown");
    const t0 = Date.now();
    const seq = h.prompt(sid, "not typed");
    const end = await h.claw.until("the refusal", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === seq), 10_000);
    assert.equal(end.data.error, "terminal_screen_unknown");
    assert.ok(Date.now() - t0 < 8_000, `refused in ${Date.now() - t0} ms`);
    const queued = h.claw.eventsOf(sid, "terminal_input_queued").find((e) => e.data.cmd_seq === seq);
    assert.equal(queued?.data.reason, "terminal_screen", "the phone was told it waits, before the refusal");
    assert.deepEqual(typed(t.transcript).filter((x) => x === "not typed"), []);
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
