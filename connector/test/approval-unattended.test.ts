// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The approval hooks with nobody at the terminal (approval-skip.ts). The environments and hook inputs are the ones Claude Code 2.1.322 was measured
 * to hand a hook: a terminal session `cli`/`1`, `claude -p` and piped stdin `sdk-cli`/`0`, bypass mode `permission_mode`
 * `bypassPermissions`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { skipReason } from "../src/approval-skip.js";
import { ApprovalBroker, approvalSocketFile, serveApprovals, type BrokerDeps, type ConnectorReply } from "../src/approvals.js";
import { tmpdir } from "./support/tmp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "..", "src", "approval-hook.ts");
const REF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const TERMINAL = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" };
const PRINT = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" };
const req = (tool: string, input: Record<string, unknown>, mode = "default"): Record<string, unknown> => ({
  session_id: REF, transcript_path: "/x/y.jsonl", cwd: "/work/proj", permission_mode: mode, hook_event_name: "PermissionRequest", tool_name: tool, tool_input: input,
});
const QUESTION = { questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }], multiSelect: false }] };

describe("which sessions the approval hooks leave alone", () => {
  const cases: Array<[string, Record<string, string>, Record<string, unknown> | null, "ask" | "settled", string | null]> = [
    ["a terminal session in the mode that asks", TERMINAL, req("Bash", { command: "ls" }), "ask", null],
    ["a terminal session in auto, plan or accept-edits mode", TERMINAL, req("Bash", { command: "ls" }, "auto"), "ask", null],
    ["claude -p (and piped stdin)", PRINT, req("Bash", { command: "ls" }), "ask", "not_a_terminal"],
    ["an unattended session that says cli", { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }, null, "ask", "unattended"],
    ["no entrypoint at all", {}, null, "ask", "not_a_terminal"],
    ["an IDE's entrypoint", { CLAUDE_CODE_ENTRYPOINT: "claude-vscode", CLAUDE_CODE_SESSION_ATTENDED: "1" }, null, "ask", "not_a_terminal"],
    ["a question asked in bypass mode", TERMINAL, req("AskUserQuestion", QUESTION, "bypassPermissions"), "ask", "unattended_mode"],
    ["dontAsk mode", TERMINAL, req("Bash", { command: "ls" }, "dontAsk"), "ask", "unattended_mode"],
    ["an answer reported in bypass mode is still passed on (it withdraws a card)", TERMINAL, { session_id: REF, hook_event_name: "PostToolUse", permission_mode: "bypassPermissions" }, "settled", null],
    ["CLAW_APPROVAL_HOOKS=off", { ...TERMINAL, CLAW_APPROVAL_HOOKS: "off" }, req("Bash", { command: "ls" }), "ask", "opted_out"],
    ["CLAW_APPROVAL_HOOKS=0, any case and spacing", { ...TERMINAL, CLAW_APPROVAL_HOOKS: " FALSE " }, null, "settled", "opted_out"],
    ["CLAW_APPROVAL_HOOKS=on is not an opt-out", { ...TERMINAL, CLAW_APPROVAL_HOOKS: "on" }, req("Bash", { command: "ls" }), "ask", null],
  ];
  for (const [name, env, event, mode, want] of cases) test(name, () => assert.equal(skipReason(env, event, mode), want));
});

/** Run the hook program as Claude Code does, with only `env` of the Claude Code variables (none inherited from whoever runs the tests). */
function runHook(mode: "ask" | "settled", socket: string, stdin: Record<string, unknown>, env: Record<string, string>) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_CODE_") && k !== "CLAW_APPROVAL_HOOKS"));
  const child = spawn(process.execPath, ["--import", "tsx", HOOK, mode, "--dir", "/cfg", "--socket", socket, "--managed-by", "claw-connector"], {
    env: { ...base, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stdin.end(JSON.stringify(stdin));
  return new Promise<{ code: number | null; out: string }>((res) => child.on("exit", (code) => res({ code, out })));
}

function rig() {
  const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const deps: BrokerDeps = {
    openSession: async () => ({ sessionId: "22222222-2222-4222-8222-222222222222" }),
    emit: (_sid, type, data) => { emitted.push({ type, data }); },
    audit: (event, detail) => { audits.push({ event, detail }); },
    ttlMs: 60_000,
  };
  const broker = new ApprovalBroker(deps);
  return { broker, emitted, audits, cards: () => emitted.filter((e) => e.type === "permissionRequest") };
}

describe("the hook program with nobody at the terminal", () => {
  test("claude -p, an unattended session, bypass mode and the opt-out put no card out; a terminal session still does", async () => {
    const state = tmpdir("cc-unatt-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, () => "/cfg", () => {});
    const sock = approvalSocketFile(state);
    try {
      for (const [env, event] of [
        [PRINT, req("Bash", { command: "ls" })],
        [{ CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }, req("Bash", { command: "ls" })],
        [TERMINAL, req("AskUserQuestion", QUESTION, "bypassPermissions")],
        [TERMINAL, req("Bash", { command: "ls" }, "dontAsk")],
        [{ ...TERMINAL, CLAW_APPROVAL_HOOKS: "off" }, req("Bash", { command: "ls" })],
      ] as Array<[Record<string, string>, Record<string, unknown>]>) {
        const t0 = Date.now();
        assert.deepEqual(await runHook("ask", sock, event, env), { code: 0, out: "" }, JSON.stringify(env));
        assert.ok(Date.now() - t0 < 8_000);
      }
      assert.equal(r.cards().length, 0, "nothing reached the connector as a card");
      assert.equal(r.audits.length, 0, "and nothing reached it at all");
      // The control: the same request from a person's terminal is put on a card.
      const waiting = runHook("ask", sock, req("Bash", { command: "ls" }), TERMINAL);
      const end = Date.now() + 10_000;
      while (r.cards().length === 0 && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
      assert.equal(r.cards().length, 1);
      // Answered at the terminal after the person switched to bypass mode: the report still withdraws the card.
      assert.deepEqual(await runHook("settled", sock, { session_id: REF, hook_event_name: "PostToolUse", permission_mode: "bypassPermissions", tool_name: "Bash", tool_input: { command: "ls" } }, TERMINAL), { code: 0, out: "" });
      assert.deepEqual(await waiting, { code: 0, out: "" });
      assert.equal(r.emitted.at(-1)!.data.by, "terminal");
    } finally { await close(); }
  });

  test("the connector itself refuses a request made in bypass mode (a hook of another version)", async () => {
    const r = rig();
    const replies: ConnectorReply[] = [];
    await r.broker.ask(req("AskUserQuestion", QUESTION, "bypassPermissions"), "/cfg", (x) => replies.push(x));
    assert.deepEqual(replies, [{ v: 1, decision: null, why: "unattended_mode" }]);
    assert.equal(r.cards().length, 0);
    assert.deepEqual(r.audits.map((a) => [a.event, a.detail.reason]), [["approval_skipped", "unattended_mode"]]);
  });
});
