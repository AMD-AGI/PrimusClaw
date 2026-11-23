// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The end of a turn in a terminal, told to its owner when nobody is at that terminal (approvals.ts `turnEnded`, approval-hook.ts):
 *
 *   E1 a Claude Code `Stop` (the payload 2.1.328 hands the hook, measured) in a terminal nobody typed in for the wait: one
 *      `terminal_turn_end` (done, the agent's last words) on the conversation's terminal-hook session, said started once
 *   E2 someone typed in that terminal after the end, or a new prompt or the end of the conversation came first: nothing
 *   E3 `StopFailure` (measured: an unknown model, `error: "unknown"`): told as an error, with its reason
 *   E4 not told: no terminal named, a chat follows the conversation, background work still running, the terminal gone, Claw refused
 *   E5 a newer end replaces an older one of the same conversation: one end told, the newer
 *   E6 a Codex `Stop` (the payload 0.153.4 hands the hook, measured) is told as Codex's
 *   E7 the hook program itself, run in a real pseudo-terminal: it names that terminal, and the connector tells the end
 *   E8 while Claw opens the session: a new prompt, typing at the terminal, a chat attaching, a newer end or a stop takes the end back
 *   E9 a session Claw opened for an end that is then not told is not left open: the end of the conversation closes it (once)
 *   E10 a chat still attaching to the conversation counts as following it (manager.ts `followsRef`), so its end is not told twice
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { ApprovalBroker, approvalSocketFile, serveApprovals, type BrokerDeps } from "../src/approvals.js";
import type { AttachSupport } from "../src/attach.js";
import { SessionManager } from "../src/manager.js";
import type { SessionEnv } from "../src/session.js";
import { tmpdir } from "./support/tmp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "..", "src", "approval-hook.ts");
const SID = "11111111-1111-4111-8111-111111111111";

/** Claude Code 2.1.328's `Stop` payload, measured in a terminal (paths made generic). */
const CLAUDE_STOP = {
  session_id: "7b0619b8-d414-4782-b72a-fcc03a83a5b1",
  transcript_path: "/home/u/.claude/projects/-home-u-work-claw/7b0619b8-d414-4782-b72a-fcc03a83a5b1.jsonl",
  cwd: "/home/u/work/claw", prompt_id: "042f19e4-4ff6-4775-b2d4-fefe2823ef45", permission_mode: "auto", effort: { level: "medium" },
  hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "probe done.", background_tasks: [], session_crons: [],
};
/** Its `StopFailure`, measured with a model the API does not know. */
const CLAUDE_STOP_FAILURE = {
  session_id: "7260e61c-f234-441e-8cc8-66ee39b35195",
  transcript_path: "/home/u/.claude/projects/-home-u-work-claw/7260e61c-f234-441e-8cc8-66ee39b35195.jsonl",
  cwd: "/home/u/work/claw", prompt_id: "0370f833-d62a-4e24-a0a3-2ae76af96f08", effort: { level: "high" }, hook_event_name: "StopFailure",
  error: "unknown",
  last_assistant_message: "API Error: 400 400: {'error': 'anthropic_messages: Invalid model name passed in model=claude-nonexistent-xyz-1. Call `/v1/models` to view available models for your key.'}",
};
/** Codex 0.153.4's `Stop` payload, measured in the TUI. */
const CODEX_STOP = {
  session_id: "01a207e4-9e92-76f3-a734-09b243374f33", turn_id: "01a207e4-b9dd-74a2-b46e-95da58cf64ca",
  transcript_path: "/home/u/.codex/sessions/2026/11/23/rollout-2026-11-23T10-12-33-01a207e4-9e92-76f3-a734-09b243374f33.jsonl",
  cwd: "/home/u/work/claw", hook_event_name: "Stop", model: "gpt-5.1-codex", permission_mode: "bypassPermissions", stop_hook_active: false,
  last_assistant_message: "codex probe done.",
};
const TTY = "/dev/pts/4";

function rig(o: { refuse?: string; attached?: boolean | (() => boolean); input?: () => number | null; awayMs?: number; opening?: () => Promise<void> } = {}) {
  const emitted: Array<{ sid: string; type: string; data: Record<string, unknown> }> = [];
  const audited: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const opened: Array<Record<string, unknown>> = [];
  const t0 = Date.now() - 600_000;
  const deps: BrokerDeps = {
    async openSession(p) { opened.push(p); await o.opening?.(); return o.refuse ? { refused: o.refuse } : { sessionId: SID }; },
    emit: (sid, type, data) => emitted.push({ sid, type, data }),
    audit: (event, detail) => audited.push({ event, detail }),
    ttlMs: 60_000,
    attached: () => (typeof o.attached === "function" ? o.attached() : o.attached === true),
    awayMs: o.awayMs ?? 60,
    lastInputMs: o.input ?? (() => t0),
  };
  const broker = new ApprovalBroker(deps);
  const ends = () => emitted.filter((e) => e.type === "terminal_turn_end");
  const skipped = () => audited.filter((a) => a.event === "turn_end_not_sent").map((a) => a.detail.reason);
  return { broker, emitted, audited, opened, ends, skipped };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await wait(20); }
};
const claude = { agent: "claude" as const, configDir: "/home/u/.claude", tty: TTY };

describe("a turn's end in a terminal nobody is at", () => {
  test("E1 Claude Code's Stop, nobody typing for the wait: one terminal_turn_end with its last words, the session said started once", async () => {
    const r = rig();
    r.broker.settled(CLAUDE_STOP, claude);
    assert.equal(r.ends().length, 0, "not before the wait");
    await until(() => r.ends().length === 1);
    const e = r.ends()[0]!;
    assert.equal(e.sid, SID);
    assert.deepEqual({ ...e.data, ended_at: "x", away_ms: 0 }, {
      ref: CLAUDE_STOP.session_id, outcome: "done", message: "probe done.", agent: "claude", cwd: "/home/u/work/claw", ended_at: "x", away_ms: 0,
    });
    assert.ok(Number(e.data.away_ms) >= 60_000, "counted from the terminal's last input");
    assert.deepEqual(r.emitted.filter((x) => x.type === "session_started").map((x) => x.data),
      [{ origin: "terminal_hook", ref: CLAUDE_STOP.session_id, title: "claw", agent: "claude", cwd: "/home/u/work/claw" }]);
    assert.deepEqual(r.opened, [{ agent: "claude", configDir: "/home/u/.claude", ref: CLAUDE_STOP.session_id, cwd: "/home/u/work/claw", title: "claw" }]);
    // a second turn of the same conversation: the session is not said started again
    r.broker.settled(CLAUDE_STOP, claude);
    await until(() => r.ends().length === 2);
    assert.equal(r.emitted.filter((x) => x.type === "session_started").length, 1);
  });

  test("E2 typed in after the end, or a new prompt or the session's end first: nothing is told", async () => {
    const typed = rig({ input: () => Date.now() });
    typed.broker.settled(CLAUDE_STOP, claude);
    await until(() => typed.skipped().includes("terminal_input"));
    assert.equal(typed.ends().length, 0);
    assert.equal(typed.opened.length, 0);

    for (const next of ["UserPromptSubmit", "SessionEnd"]) {
      const r = rig({ awayMs: 150 });
      r.broker.settled(CLAUDE_STOP, claude);
      r.broker.settled({ session_id: CLAUDE_STOP.session_id, hook_event_name: next, cwd: "/home/u/work/claw", prompt: "go on" }, claude);
      await wait(300);
      assert.equal(r.ends().length, 0, next);
      assert.ok(r.skipped().includes("terminal_active"), next);
    }
  });

  test("E3 StopFailure is told as an error with its reason", async () => {
    const r = rig();
    r.broker.settled(CLAUDE_STOP_FAILURE, claude);
    await until(() => r.ends().length === 1);
    assert.equal(r.ends()[0]!.data.outcome, "error");
    assert.equal(r.ends()[0]!.data.error, "unknown");
    assert.match(String(r.ends()[0]!.data.message), /Invalid model name/);
    // a reason that is not a plain word is not passed on as one
    const odd = rig();
    odd.broker.settled({ ...CLAUDE_STOP_FAILURE, error: "rate limit; rm -rf" }, claude);
    await until(() => odd.ends().length === 1);
    assert.equal(odd.ends()[0]!.data.error, "unknown");
  });

  test("E4 not told: no terminal, a chat follows it, background work running, the terminal gone, Claw refuses", async () => {
    const cases: Array<[string, ReturnType<typeof rig>, Record<string, unknown>, Record<string, unknown>]> = [
      ["no_terminal", rig(), CLAUDE_STOP, { ...claude, tty: undefined }],
      ["no_terminal", rig(), CLAUDE_STOP, { ...claude, tty: "/etc/passwd" }],
      ["attached", rig({ attached: true }), CLAUDE_STOP, claude],
      ["background_tasks", rig(), { ...CLAUDE_STOP, background_tasks: [{ id: "b1" }] }, claude],
      ["terminal_gone", rig({ input: () => null }), CLAUDE_STOP, claude],
      ["session_muted", rig({ refuse: "session_muted" }), CLAUDE_STOP, claude],
      ["approvals_off", rig({ refuse: "approvals_off" }), CLAUDE_STOP, claude],
    ];
    for (const [why, r, raw, from] of cases) {
      r.broker.settled(raw, from);
      await until(() => r.skipped().includes(why));
      assert.equal(r.ends().length, 0, why);
    }
  });

  test("E5 a newer end of the same conversation replaces the older: one told, the newer", async () => {
    const r = rig({ awayMs: 150 });
    r.broker.settled({ ...CLAUDE_STOP, last_assistant_message: "first" }, claude);
    await wait(50);
    r.broker.settled({ ...CLAUDE_STOP, last_assistant_message: "second" }, claude);
    await wait(400);
    assert.deepEqual(r.ends().map((e) => e.data.message), ["second"]);
    assert.ok(r.skipped().includes("superseded"));
  });

  test("E5b a question asked after the end (a background task woke it) takes the end back; stopping forgets every end", async () => {
    const r = rig({ awayMs: 150 });
    r.broker.settled(CLAUDE_STOP, claude);
    await r.broker.ask({ session_id: CLAUDE_STOP.session_id, cwd: "/home/u/work/claw", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }, "/home/u/.claude", () => {});
    r.broker.settled({ ...CLAUDE_STOP, session_id: "22222222-2222-4222-8222-222222222222" }, claude);
    r.broker.stopAll();
    await wait(400);
    assert.equal(r.ends().length, 0);
    assert.ok(r.skipped().includes("asked"));
  });

  test("E6 a Codex Stop is told as Codex's", async () => {
    const r = rig();
    r.broker.settled(CODEX_STOP, { agent: "codex", configDir: "/home/u/.codex", tty: TTY });
    await until(() => r.ends().length === 1);
    assert.equal(r.ends()[0]!.data.agent, "codex");
    assert.equal(r.ends()[0]!.data.message, "codex probe done.");
    assert.equal(r.opened[0]!.agent, "codex");
  });

  test("E7 the hook program in a real pseudo-terminal names it, and the end is told", { skip: process.platform !== "linux" ? "needs Linux's script(1) and /proc" : false }, async () => {
    const state = tmpdir("cc-end-");
    const stdin = path.join(state, "stop.json");
    fs.writeFileSync(stdin, JSON.stringify(CLAUDE_STOP));
    const seen: Array<string | null> = [];
    const r = rig({ input: () => 0 });
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    // (what the connector was handed: the hook named the terminal it runs in)
    const real = r.broker.settled.bind(r.broker);
    r.broker.settled = (raw, from) => { seen.push(typeof from?.tty === "string" ? from.tty : null); real(raw, from); };
    try {
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cmd = [process.execPath, "--import", "tsx", HOOK, "settled", "--dir", "/home/u/.claude", "--socket", approvalSocketFile(state), "--managed-by", "claw-connector"].map(q).join(" ");
      const child = spawn("script", ["-qec", `${cmd} < ${q(stdin)}`, "/dev/null"], {
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAW_APPROVAL_HOOKS: "" }, stdio: ["ignore", "pipe", "pipe"],
      });
      const code = await new Promise<number | null>((res) => child.on("exit", res));
      assert.equal(code, 0);
      await until(() => r.ends().length === 1);
      assert.equal(seen.length, 1);
      assert.match(String(seen[0]), /^\/dev\/pts\/\d+$/);
      assert.equal(r.ends()[0]!.data.message, "probe done.");
    } finally { await close(); }
  });

  test("E8 what happens while Claw opens the session still takes the end back; nothing is told then", async () => {
    /** A rig whose session opening waits until `go` is called; `during` runs once the opening has started. */
    const held = (o: { attached?: () => boolean; input?: () => number | null } = {}) => {
      let go = () => {};
      const gate = new Promise<void>((res) => { go = res; });
      const r = rig({ ...o, opening: () => gate });
      return { r, go: () => go() };
    };
    const t0 = Date.now() - 600_000;

    for (const next of ["UserPromptSubmit", "SessionEnd"]) {
      const { r, go } = held();
      r.broker.settled(CLAUDE_STOP, claude);
      await until(() => r.opened.length === 1);
      r.broker.settled({ session_id: CLAUDE_STOP.session_id, hook_event_name: next, cwd: "/home/u/work/claw", prompt: "go on" }, claude);
      go();
      await wait(100);
      assert.equal(r.ends().length, 0, next);
      assert.deepEqual(r.skipped(), ["terminal_active"], next);
    }

    let typedAt = t0;
    const typed = held({ input: () => typedAt });
    typed.r.broker.settled(CLAUDE_STOP, claude);
    await until(() => typed.r.opened.length === 1);
    typedAt = Date.now();
    typed.go();
    await until(() => typed.r.skipped().includes("terminal_input"));
    assert.equal(typed.r.ends().length, 0);

    let chat = false;
    const attaching = held({ attached: () => chat });
    attaching.r.broker.settled(CLAUDE_STOP, claude);
    await until(() => attaching.r.opened.length === 1);
    chat = true;
    attaching.go();
    await until(() => attaching.r.skipped().includes("attached"));
    assert.equal(attaching.r.ends().length, 0);

    const newer = held();
    newer.r.broker.settled({ ...CLAUDE_STOP, last_assistant_message: "first" }, claude);
    await until(() => newer.r.opened.length === 1);
    newer.r.broker.settled({ ...CLAUDE_STOP, last_assistant_message: "second" }, claude);
    newer.go();
    await until(() => newer.r.ends().length === 1);
    await wait(100);
    assert.deepEqual(newer.r.ends().map((e) => e.data.message), ["second"]);

    const stopped = held();
    stopped.r.broker.settled(CLAUDE_STOP, claude);
    await until(() => stopped.r.opened.length === 1);
    stopped.r.broker.stopAll();
    stopped.go();
    await wait(100);
    assert.equal(stopped.r.ends().length, 0);
    assert.equal(stopped.r.emitted.length, 0, "not even the session's start");
  });

  test("E9 a session opened for an end that is then not told is closed when the conversation ends, once", async () => {
    const held = () => {
      let go = () => {};
      let gate = Promise.resolve();
      const r = rig({ opening: () => gate });
      return { r, hold: () => { gate = new Promise<void>((res) => { go = res; }); }, go: () => go() };
    };
    const end = (r: ReturnType<typeof rig>) => r.broker.settled({ session_id: CLAUDE_STOP.session_id, hook_event_name: "SessionEnd", cwd: "/home/u/work/claw", reason: "prompt_input_exit" }, claude);
    const lifecycle = (r: ReturnType<typeof rig>) => r.emitted.filter((e) => e.type === "session_started" || e.type === "session_closed").map((e) => `${e.type}:${e.sid}`);

    // A new prompt takes it back: the session is the conversation's from now on, and the conversation's end closes it.
    const prompt = held();
    prompt.hold();
    prompt.r.broker.settled(CLAUDE_STOP, claude);
    await until(() => prompt.r.opened.length === 1);
    prompt.r.broker.settled({ session_id: CLAUDE_STOP.session_id, hook_event_name: "UserPromptSubmit", cwd: "/home/u/work/claw", prompt: "go on" }, claude);
    prompt.go();
    await until(() => lifecycle(prompt.r).length === 1);
    end(prompt.r);
    assert.deepEqual(lifecycle(prompt.r), [`session_started:${SID}`, `session_closed:${SID}`]);
    assert.equal(prompt.r.ends().length, 0);

    // Typing at the terminal once it is open: the same.
    let typedAt = Date.now() - 600_000;
    let typedGo = () => {};
    const typedGate = new Promise<void>((res) => { typedGo = res; });
    const tr = rig({ opening: () => typedGate, input: () => typedAt });
    tr.broker.settled(CLAUDE_STOP, claude);
    await until(() => tr.opened.length === 1);
    typedAt = Date.now();
    typedGo();
    await until(() => tr.skipped().includes("terminal_input"));
    end(tr);
    assert.deepEqual(lifecycle(tr), [`session_started:${SID}`, `session_closed:${SID}`]);

    // The conversation ends while it opens: closed at once, never said started.
    const ended = held();
    ended.hold();
    ended.r.broker.settled(CLAUDE_STOP, claude);
    await until(() => ended.r.opened.length === 1);
    end(ended.r);
    ended.go();
    await until(() => lifecycle(ended.r).length === 1);
    await wait(100);
    assert.deepEqual(lifecycle(ended.r), [`session_closed:${SID}`]);
    assert.equal(ended.r.emitted.find((e) => e.type === "session_closed")?.data.reason, "terminal_ended");

    // ...and when the conversation already had that session, the end of the conversation closed it: not closed twice.
    const known = held();
    known.r.broker.settled({ ...CLAUDE_STOP, last_assistant_message: "first" }, claude);
    await until(() => known.r.ends().length === 1);
    known.hold();
    known.r.broker.settled({ ...CLAUDE_STOP, last_assistant_message: "second" }, claude);
    await until(() => known.r.opened.length === 2);
    end(known.r);
    known.go();
    await wait(150);
    assert.deepEqual(lifecycle(known.r), [`session_started:${SID}`, `session_closed:${SID}`]);
    assert.equal(known.r.ends().length, 1);
  });

  test("E10 a chat still attaching to the conversation follows it already", async () => {
    const REF = CLAUDE_STOP.session_id;
    let found: (v: { ok: false; reason: string }) => void = () => {};
    const lookup = new Promise<{ ok: false; reason: string }>((res) => { found = res; });
    const closed: Array<Record<string, unknown>> = [];
    const env = {
      config: { agents: [{ id: "claude", attach: { cli: "claude" }, roots: ["/home/u"], env: {} }] },
      audit: { record: () => {} },
      emit: (_sid: string, type: string, data: Record<string, unknown>) => { if (type === "session_closed") closed.push(data); },
      store: { get: () => undefined },
      attach: new Map([["claude", { resolve: () => lookup } as unknown as AttachSupport]]),
      timing: {},
      log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    } as unknown as SessionEnv;
    const manager = new SessionManager(env);
    assert.equal(manager.followsRef(REF), false);
    const handled = manager.handle({ type: "session.new", session_id: SID, agent_id: "claude", resume_ref: REF.toUpperCase(), cwd: "/home/u/work/claw" } as never);
    await until(() => manager.followsRef(REF));
    assert.equal(manager.followsRef("01a207e4-9e92-76f3-a734-09b243374f33"), false, "another conversation is not followed");
    found({ ok: false, reason: "not_found" });
    await handled;
    assert.equal(manager.followsRef(REF), false, "a refused attach follows nothing");
    assert.equal(closed[0]?.reason, "not_found");
  });
});
