// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The approval hooks with nobody at the terminal (approval-skip.ts) and the one-time offer of the approval hooks to a setup that
 * has the session hooks only (approval-offer.ts). The environments and hook inputs are the ones Claude Code 2.1.322 was measured
 * to hand a hook: a terminal session `cli`/`1`, `claude -p` and piped stdin `sdk-cli`/`0`, bypass mode `permission_mode`
 * `bypassPermissions`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { approvalOfferFile } from "../src/approval-offer.js";
import { skipReason } from "../src/approval-skip.js";
import { ApprovalBroker, approvalSocketFile, serveApprovals, type BrokerDeps, type ConnectorReply } from "../src/approvals.js";
import { EXIT, main, type Ctx } from "../src/commands.js";
import { approvalHooksStatus, installApprovalHooks, installHooks, settingsFile } from "../src/hooks.js";
import { resolveDirs } from "../src/paths.js";
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

describe("offering the approval hooks to a setup that has the session hooks only", () => {
  const NODE = process.execPath;
  const stand = (name: string): string => { const f = path.join(tmpdir("cc-hookbin-"), name); fs.writeFileSync(f, "// stand-in\n"); return f; };
  /** A home whose Claude config directory has the session hooks of an older connector, and a context for a command there. */
  function setup(o: { sessionHooks?: boolean; approvalHooks?: boolean } = {}) {
    const home = tmpdir();
    const dir = path.join(home, "claude-config");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsFile(dir), JSON.stringify({ model: "opus" }, null, 2));
    const termScript = stand("terminal-hook.js");
    const apprScript = stand("approval-hook.js");
    if (o.sessionHooks !== false) installHooks(dir, NODE, termScript);
    if (o.approvalHooks) installApprovalHooks(dir, NODE, apprScript, "/s.sock");
    const asked: string[] = [];
    const mk = (answer: boolean | null, env: Record<string, string> = {}) => {
      const out: string[] = [];
      const c: Ctx = {
        dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: { CLAUDE_CONFIG_DIR: dir, ...env },
        out: (l) => out.push(l), err: () => {}, hostname: "box", hookScript: termScript, approvalHookScript: apprScript, node: NODE,
        ...(answer === null ? {} : { ask: async (q: string) => { asked.push(q); return answer; } }),
      };
      return { c, text: () => out.join("\n") };
    };
    return { home, dir, asked, mk, bytes: () => fs.readFileSync(settingsFile(dir), "utf8") };
  }

  test("no: settings untouched, the command is said, the answer kept; the next command does not ask again", async () => {
    const s = setup();
    const before = s.bytes();
    const a = s.mk(false);
    assert.equal(await main(["resume"], a.c), EXIT.ok);
    assert.equal(s.asked.length, 1);
    assert.match(s.asked[0]!, /Add them to .*settings\.json\? \[y\/N\]/);
    assert.match(a.text(), /a question Claude Code asks in a terminal/);
    assert.match(a.text(), /claude -p, bypass mode/);
    assert.match(a.text(), /CLAW_APPROVAL_HOOKS=off/);
    assert.match(a.text(), /to add them later: claw-connector hooks install --approvals/);
    assert.equal(s.bytes(), before);
    const kept = JSON.parse(fs.readFileSync(approvalOfferFile(a.c.dirs), "utf8"));
    assert.equal(kept.answered[s.dir].answer, "no");
    assert.equal(fs.statSync(approvalOfferFile(a.c.dirs)).mode & 0o777, 0o600);
    const b = s.mk(true);
    assert.equal(await main(["resume"], b.c), EXIT.ok);
    assert.equal(s.asked.length, 1, "never asked twice");
    assert.equal(s.bytes(), before);
  });

  test("yes: the approval hooks are added (what hooks install --approvals writes), once", async () => {
    const s = setup();
    const a = s.mk(true);
    assert.equal(await main(["resume"], a.c), EXIT.ok);
    assert.equal(s.asked.length, 1);
    assert.match(a.text(), /installed the approval hooks in .*hooks uninstall --approvals/);
    const st = approvalHooksStatus(s.dir);
    assert.equal(st.installed, true);
    assert.equal(JSON.parse(s.bytes()).model, "opus");
    const cmds = JSON.stringify(JSON.parse(s.bytes()).hooks);
    assert.ok(cmds.includes(approvalSocketFile(a.c.dirs.state)), "the hooks name this connector's socket");
    assert.equal(await main(["resume"], s.mk(true).c), EXIT.ok);
    assert.equal(s.asked.length, 1);
  });

  test("nothing asked, nothing recorded: no terminal, --json, the opt-out, no session hooks, approval hooks already there", async () => {
    const quiet = async (s: ReturnType<typeof setup>, args: string[], answer: boolean | null, env: Record<string, string> = {}) => {
      const before = s.bytes();
      const c = s.mk(answer, env);
      await main(args, c.c);
      assert.equal(s.asked.length, 0, `${args.join(" ")} ${JSON.stringify(env)}`);
      assert.equal(s.bytes(), before);
      assert.doesNotMatch(c.text(), /approval hooks/);
      return c;
    };
    // No terminal: not recorded either, so a later command at a terminal still offers.
    const s1 = setup();
    const c1 = await quiet(s1, ["resume"], null);
    assert.equal(fs.existsSync(approvalOfferFile(c1.c.dirs)), false);
    assert.equal(await main(["resume"], s1.mk(false).c), EXIT.ok);
    assert.equal(s1.asked.length, 1);
    await quiet(setup(), ["status", "--json"], true);
    await quiet(setup(), ["resume"], true, { CLAW_APPROVAL_HOOKS: "off" });
    await quiet(setup({ sessionHooks: false }), ["resume"], true);
    await quiet(setup({ approvalHooks: true }), ["resume"], true);
  });

  test("init, pair and hooks never make this offer (they install hooks themselves)", async () => {
    const s = setup();
    const c = s.mk(false);
    await main(["hooks", "status"], c.c);
    await main(["hooks", "install"], c.c);
    assert.equal(s.asked.length, 0);
  });
});
