// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Typing a message into a conversation open in a terminal: the screen reading and the cleaning on their own, then the
 * connector end to end against a REAL tmux server of the test's own (its own socket in a temporary directory; never the
 * tmux the tests may be run from), with a stand-in for Claude Code's interface in the pane.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { localPidDomain } from "../src/attach.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { processStart } from "../src/children.js";
import { cleanInput, inputBox, findPane, TerminalInput, tmuxRunner } from "../src/terminal-input.js";
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

describe("the owner's switch", () => {
  const agent = (extra: string, preset = "claude-attach") => `[[agents]]\nid = "a"\npreset = "${preset}"\nroots = ["/tmp"]\n${extra}\n`;
  test("on by default with tmux from PATH; off with terminal_input = false; only for an attach agent, only a boolean", () => {
    assert.deepEqual(parseConfig(agent("")).agents[0]!.attach, { cli: "claude", tmux: "tmux" });
    assert.deepEqual(parseConfig(agent('tmux_cli = "/opt/bin/tmux"')).agents[0]!.attach, { cli: "claude", tmux: "/opt/bin/tmux" });
    assert.deepEqual(parseConfig(agent("terminal_input = false")).agents[0]!.attach, { cli: "claude", tmux: null });
    assert.throws(() => parseConfig(agent('terminal_input = "yes"')), (e: unknown) => e instanceof ConfigError && /terminal_input must be true or false/.test(e.message));
    assert.throws(() => parseConfig(agent("terminal_input = true", "claude")), (e: unknown) => e instanceof ConfigError && /only applies to an agent made from the claude-attach preset/.test(e.message));
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
function terminal(work: string, claudeDir: string): { socket: string; pid: number; row: string; transcript: string; tmux: (...a: string[]) => string } {
  const dir = tmpdir("cc-tmux-");
  const socket = path.join(dir, "sock");
  servers.push(socket);
  const transcript = path.join(claudeDir, "projects", work.replace(/[^A-Za-z0-9]/g, "-"), `${REF}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", sessionId: REF, message: { role: "user", content: "earlier" } })}\n`);
  const row = path.join(claudeDir, "sessions", "pending.json");
  fs.mkdirSync(path.dirname(row), { recursive: true });
  const tmux = (...a: string[]) => execFileSync("tmux", ["-S", socket, ...a], { encoding: "utf8" });
  // The pane's own environment is what the connector reads: the test's own TMUX (if any) is not passed on.
  const env = { ...process.env, FAKE_TRANSCRIPT: transcript, FAKE_ROW: row, FAKE_SESSION: REF, FAKE_WORK_MS: "300" } as Record<string, string>;
  delete env.TMUX; delete env.TMUX_PANE;
  execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "30", "-c", work,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_TERMINAL)}`], { env });
  const pid = Number(tmux("display-message", "-p", "-t", "%0", "#{pane_pid}").trim());
  // The registry row Claude Code keeps for its process, named by its pid, which the stand-in updates.
  const named = path.join(claudeDir, "sessions", `${pid}.json`);
  fs.writeFileSync(named, JSON.stringify({ pid, sessionId: REF, status: "idle", kind: "interactive", cwd: work, procStart: processStart(pid), pidDomain: localPidDomain() }));
  fs.symlinkSync(named, row);
  return { socket, pid, row: named, transcript, tmux };
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
    const found = await findPane(t.pid, "tmux");
    assert.ok(found.ok, JSON.stringify(found));
    assert.equal(found.pane.socket, t.socket);
    assert.equal(found.pane.pane, "%0");
    // Not the process of another pane, nor one outside tmux.
    assert.deepEqual(await findPane(process.pid, "tmux").then((r) => r.ok && r.pane.socket === t.socket), false);
    const input = new TerminalInput(found.pane, tmuxRunner("tmux", t.socket));
    await until("an empty box", () => inputBox(t.tmux("capture-pane", "-p", "-e", "-t", "%0")) === "empty");
    assert.deepEqual(await input.readiness(), { ready: true });
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
    // A mode change is the terminal's.
    h.claw.issue("set_mode", sid, { mode_id: "plan" });
    const rejected = await h.claw.until("the mode change refused", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.type === "set_mode"));
    assert.equal(rejected.data.reason, "terminal_session");
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
