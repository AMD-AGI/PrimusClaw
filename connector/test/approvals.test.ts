// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Approvals asked in a terminal and answered from the phone (approvals.ts, approval-hook.ts): how each kind of question becomes a
 * card and the owner's choice a hook decision, how every request is settled exactly once (phone, terminal, hook gone, timeout),
 * the hook program itself run over the real socket, and the merge of the approval hooks into a settings file.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ApprovalBroker, approvalSocketFile, mapRequest, parsePermissionEvent, serveApprovals, type BrokerDeps, type ConnectorReply, type PermissionEvent,
} from "../src/approvals.js";
import {
  APPROVAL_HOOKED, approvalHooksStatus, HOOKED, hooksStatus, installApprovalHooks, installHooks, settingsFile, uninstallApprovalHooks, uninstallHooks,
} from "../src/hooks.js";
import { tmpdir } from "./support/tmp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "..", "src", "approval-hook.ts");
const REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** What Claude Code 2.1.322 hands a PermissionRequest hook (measured), for `tool` with `input`. */
const req = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: REF, transcript_path: "/x/y.jsonl", cwd: "/work/proj", permission_mode: "default", hook_event_name: "PermissionRequest",
  tool_name: tool, tool_input: input, ...extra,
});
const ev = (raw: Record<string, unknown>): PermissionEvent => parsePermissionEvent(raw)!;

const BASH_SUGGESTIONS = [
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" },
  { type: "setMode", mode: "acceptEdits", destination: "session" },
];
const QUESTION = { question: "Which color?", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false };
const PLAN = { plan: "## Refactor auth\n1. Extract the token check\n2. Test it", planFilePath: "/cfg/plans/p.md" };

describe("what a card offers, and what the choice tells Claude Code", () => {
  test("a command: once, for this session only (never saved to a file, never a mode change), no, and no-and-stop", () => {
    const m = mapRequest(ev(req("Bash", { command: "npm test", description: "Run tests" }, { permission_suggestions: BASH_SUGGESTIONS })))!;
    assert.equal(m.cards.length, 1);
    assert.equal(m.cards[0]!.kind, "execute");
    assert.equal(m.cards[0]!.tool, "Run: npm test");
    assert.deepEqual(m.cards[0]!.options.map((o) => [o.optionId, o.kind]), [["allow", "allow_once"], ["allow-session", "allow_always"], ["deny", "reject_once"], ["deny-stop", "reject_once"]]);
    assert.equal(m.cards[0]!.options[1]!.name, "Always allow this session: Bash(npm test)");
    // The input on the card is the request's own, untouched.
    assert.deepEqual(m.cards[0]!.input, { command: "npm test", description: "Run tests" });
    assert.deepEqual(m.decide(["allow"]), { behavior: "allow" });
    assert.deepEqual(m.decide(["allow-session"]), { behavior: "allow", updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" }] });
    assert.equal(m.decide(["deny"])!.behavior, "deny");
    assert.equal((m.decide(["deny-stop"]) as { interrupt?: boolean }).interrupt, true);
    assert.equal(m.decide(["something-else"]), null);
  });

  test("a tool's own argument named like card metadata is shown as it is (nothing is merged into the input)", () => {
    const sugg = [{ type: "addRules", rules: [{ toolName: "mcp__store__delete" }], behavior: "allow", destination: "localSettings" }];
    const m = mapRequest(ev(req("mcp__store__delete", { always_allows: "confirm=false", id: "42" }, { permission_suggestions: sugg })))!;
    assert.deepEqual(m.cards[0]!.input, { always_allows: "confirm=false", id: "42" });
    assert.equal(m.cards[0]!.options[1]!.name, "Always allow this session: mcp__store__delete");
  });

  test("an allow rule too long to name on its option is not offered", () => {
    const sugg = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "x".repeat(300) }], behavior: "allow", destination: "localSettings" }];
    const m = mapRequest(ev(req("Bash", { command: "ls" }, { permission_suggestions: sugg })))!;
    assert.deepEqual(m.cards[0]!.options.map((o) => o.optionId), ["allow", "deny", "deny-stop"]);
  });

  test("no 'always' option when Claude Code suggested no allow rule (only a mode change)", () => {
    const m = mapRequest(ev(req("Write", { file_path: "/work/proj/a.txt", content: "hi\n" }, { permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] })))!;
    assert.deepEqual(m.cards[0]!.options.map((o) => o.optionId), ["allow", "deny", "deny-stop"]);
    assert.equal(m.cards[0]!.kind, "edit");
    assert.equal(m.cards[0]!.tool, "Write /work/proj/a.txt");
  });

  test("a credential in the command is masked on the card", () => {
    const m = mapRequest(ev(req("Bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' https://x" })))!;
    assert.doesNotMatch(JSON.stringify(m.cards[0]!.input), /abcdefghijklmnopqrstuvwxyz0123456789/);
  });

  test("a subagent's request says so", () => {
    const m = mapRequest(ev(req("Bash", { command: "ls" }, { agent_id: "agent-1", agent_type: "Explore" })))!;
    assert.equal(m.cards[0]!.tool, "Subagent Explore: Run: ls");
  });

  test("AskUserQuestion: the answers are the question's own labels, given back the way Claude Code reads them", () => {
    const m = mapRequest(ev(req("AskUserQuestion", { questions: [QUESTION] })))!;
    assert.equal(m.cards.length, 1);
    assert.equal(m.cards[0]!.kind, "question");
    // The buttons are the labels (at most four: the chat shows four buttons); what each means is in the card's body.
    assert.deepEqual(m.cards[0]!.options.map((o) => [o.optionId, o.name]), [["a0", "Red"], ["a1", "Blue"]]);
    assert.match(JSON.stringify(m.cards[0]!.input), /cool/);
    assert.deepEqual(m.decide(["a1"]), { behavior: "allow", updatedInput: { questions: [QUESTION], answers: { "Which color?": "Blue" } } });
    assert.equal(m.decide(["a7"]), null);
  });

  test("AskUserQuestion with several questions: a card each, answered together", () => {
    const q2 = { question: "Which size?", header: "Size", options: [{ label: "S" }, { label: "L" }] };
    const m = mapRequest(ev(req("AskUserQuestion", { questions: [QUESTION, q2] })))!;
    assert.deepEqual(m.cards.map((c) => [c.questionIndex, c.questionCount]), [[0, 2], [1, 2]]);
    assert.deepEqual((m.decide(["a0", "a1"]) as unknown as { updatedInput: { answers: unknown } }).updatedInput.answers, { "Which color?": "Red", "Which size?": "L" });
  });

  test("a question no card can carry is left to the terminal: multi-select, more than four answers, duplicate labels", () => {
    assert.equal(mapRequest(ev(req("AskUserQuestion", { questions: [{ ...QUESTION, multiSelect: true }] }))), null);
    assert.equal(mapRequest(ev(req("AskUserQuestion", { questions: [{ ...QUESTION, options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` })) }] }))), null);
    assert.equal(mapRequest(ev(req("AskUserQuestion", { questions: [{ ...QUESTION, options: [{ label: "A" }, { label: "A" }] }] }))), null);
    assert.equal(mapRequest(ev(req("AskUserQuestion", { questions: [] }))), null);
  });

  test("a plan: approving it sets the mode back to the one that asks (never accept-edits or bypass); 'keep planning' denies", () => {
    const m = mapRequest(ev(req("ExitPlanMode", PLAN, { permission_mode: "plan" })))!;
    assert.equal(m.cards[0]!.kind, "switch_mode");
    assert.equal(m.cards[0]!.tool, "Plan: Refactor auth");
    assert.deepEqual(m.decide(["plan-approve"]), { behavior: "allow", updatedInput: PLAN, updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] });
    assert.equal(m.decide(["plan-keep"])!.behavior, "deny");
  });

  test("a request too long to show in full can only be turned down from the phone (nothing is approved unseen)", () => {
    const long = "x".repeat(30 * 1024);
    const cmd = mapRequest(ev(req("Bash", { command: `echo ok; ${long}; rm -rf ~` }, { permission_suggestions: BASH_SUGGESTIONS })))!;
    assert.deepEqual(cmd.cards[0]!.options.map((o) => o.optionId), ["deny", "deny-stop"]);
    assert.equal((cmd.cards[0]!.input as Record<string, unknown>).truncated, true);
    assert.equal(cmd.decide(["allow"]), null);
    assert.equal(cmd.decide(["allow-session"]), null);
    assert.equal(cmd.decide(["deny"])!.behavior, "deny");
    assert.ok(Buffer.byteLength(JSON.stringify(cmd.cards[0]!.input)) < 16 * 1024);

    const plan = mapRequest(ev(req("ExitPlanMode", { plan: `## Big\n${long}` })))!;
    assert.deepEqual(plan.cards[0]!.options.map((o) => o.optionId), ["plan-keep"]);
    assert.equal(plan.decide(["plan-approve"]), null);

    // A plan or command that fits is carried whole, its last line included.
    const fits = mapRequest(ev(req("ExitPlanMode", { plan: `## Ok\n${"y".repeat(8_000)}\nLAST STEP` })))!;
    assert.match(JSON.stringify(fits.cards[0]!.input), /LAST STEP/);
    assert.deepEqual(fits.cards[0]!.options.map((o) => o.optionId), ["plan-approve", "plan-keep"]);
  });

  test("only a PermissionRequest with a usable session id, folder, tool and input is taken", () => {
    assert.equal(parsePermissionEvent({ ...req("Bash", { command: "ls" }), hook_event_name: "PreToolUse" }), null);
    assert.equal(parsePermissionEvent({ ...req("Bash", { command: "ls" }), session_id: "../../etc" }), null);
    assert.equal(parsePermissionEvent({ ...req("Bash", { command: "ls" }), cwd: "relative" }), null);
    assert.equal(parsePermissionEvent({ ...req("Bash", { command: "ls" }), tool_input: "ls" }), null);
  });
});

/** A broker over fake deps that records what it emits and audits. */
function rig(o: { refuse?: string; ttlMs?: number } = {}) {
  const emitted: Array<{ sid: string; type: string; data: Record<string, unknown> }> = [];
  const audited: Array<{ event: string; detail: Record<string, unknown> }> = [];
  let opens = 0;
  const deps: BrokerDeps = {
    async openSession() { opens++; return o.refuse ? { refused: o.refuse } : { sessionId: "11111111-1111-4111-8111-111111111111" }; },
    emit: (sid, type, data) => emitted.push({ sid, type, data }),
    audit: (event, detail) => audited.push({ event, detail }),
    ttlMs: o.ttlMs ?? 60_000,
  };
  const broker = new ApprovalBroker(deps);
  const replies: ConnectorReply[] = [];
  const ask = (raw: Record<string, unknown>) => broker.ask(raw, "/cfg", (r) => replies.push(r));
  const cards = () => emitted.filter((e) => e.type === "permissionRequest");
  return { broker, emitted, audited, replies, ask, cards, opens: () => opens };
}

describe("the broker: each request settled exactly once", () => {
  test("the owner's choice is the hook's decision; the session is opened once per conversation and said once", async () => {
    const r = rig();
    await r.ask(req("Bash", { command: "npm test" }));
    await r.ask(req("Bash", { command: "npm run lint" }));
    assert.equal(r.emitted.filter((e) => e.type === "session_started").length, 1);
    assert.equal(r.cards().length, 2);
    const card = r.cards()[0]!.data;
    assert.equal(card.origin, "terminal_hook");
    assert.equal(card.toolCallId, null);
    assert.ok(r.broker.owns("11111111-1111-4111-8111-111111111111"));
    assert.equal(r.broker.decide(String(card.actionId), "not-offered", null), false);
    assert.equal(r.replies.length, 0);
    assert.equal(r.broker.decide(String(card.actionId), "allow", null), true);
    assert.deepEqual(r.replies, [{ v: 1, decision: { behavior: "allow" } }]);
    assert.deepEqual(r.emitted.filter((e) => e.type === "permission_resolved").map((e) => e.data), [{ actionId: card.actionId, optionId: "allow", by: "phone" }]);
    // Answered once: a second answer (another device, a replay) changes nothing.
    assert.equal(r.broker.decide(String(card.actionId), "deny", null), false);
    assert.equal(r.replies.length, 1);
    assert.equal(r.broker.size, 1);
  });

  test("answered at the terminal first: the call's result settles it, the card is withdrawn, the hook is let go without a decision", async () => {
    const r = rig();
    await r.ask(req("Bash", { command: "npm test", description: "x" }));
    const card = r.cards()[0]!.data;
    // Another call's result (a command that needed no approval) settles nothing.
    r.broker.settled({ session_id: REF, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    assert.equal(r.replies.length, 0);
    // Same call, keys in another order.
    r.broker.settled({ session_id: REF, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { description: "x", command: "npm test" } });
    assert.deepEqual(r.replies, [{ v: 1, decision: null, why: "terminal" }]);
    assert.deepEqual(r.emitted.at(-1)!.data, { actionId: card.actionId, optionId: null, outcome: "cancelled", by: "terminal" });
    // The phone's answer after that is refused.
    assert.equal(r.broker.decide(String(card.actionId), "allow", null), false);
    assert.equal(r.replies.length, 1);
  });

  test("a question or a plan is matched by tool name (Claude Code changes their input between asking and the result)", async () => {
    const r = rig();
    await r.ask(req("AskUserQuestion", { questions: [QUESTION] }));
    r.broker.settled({ session_id: REF, hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [QUESTION], answers: { "Which color?": "Red" } } });
    assert.equal(r.replies[0]!.decision, null);
  });

  test("a new prompt, the turn's end or the session's end settle every request of that conversation (and only of that one)", async () => {
    const r = rig();
    await r.ask(req("Bash", { command: "a" }));
    await r.ask({ ...req("Bash", { command: "b" }), session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    r.broker.settled({ session_id: REF, hook_event_name: "Stop" });
    assert.equal(r.replies.length, 1);
    r.broker.settled({ session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", hook_event_name: "SessionEnd" });
    assert.equal(r.replies.length, 2);
    assert.equal(r.emitted.filter((e) => e.type === "session_closed").length, 1);
  });

  test("the hook went away (the terminal's 'No' interrupted the turn): withdrawn as answered there", async () => {
    const r = rig();
    const gone = await r.ask(req("Bash", { command: "rm -rf build" }));
    gone();
    assert.equal(r.replies[0]!.why, "terminal");
    assert.equal(r.emitted.at(-1)!.data.by, "terminal");
  });

  test("a card nobody answers is withdrawn after its time; the terminal still asks", async () => {
    const r = rig({ ttlMs: 30 });
    await r.ask(req("Bash", { command: "sleep 1" }));
    await new Promise((res) => setTimeout(res, 80));
    assert.deepEqual(r.replies, [{ v: 1, decision: null, why: "timeout" }]);
  });

  test("several questions: the decision waits for every card", async () => {
    const r = rig();
    const q2 = { question: "Which size?", header: "Size", options: [{ label: "S" }, { label: "L" }] };
    await r.ask(req("AskUserQuestion", { questions: [QUESTION, q2] }));
    const [c1, c2] = r.cards().map((c) => String(c.data.actionId));
    r.broker.decide(c1!, "a1", null);
    assert.equal(r.replies.length, 0);
    r.broker.decide(c2!, "a0", null);
    assert.deepEqual((r.replies[0]!.decision as unknown as { updatedInput: { answers: unknown } }).updatedInput.answers, { "Which color?": "Blue", "Which size?": "S" });

  });

  test("Claw will not take it (approvals off, not connected): the hook is answered at once and nothing is shown", async () => {
    const r = rig({ refuse: "approvals_off" });
    await r.ask(req("Bash", { command: "ls" }));
    assert.deepEqual(r.replies, [{ v: 1, decision: null, why: "approvals_off" }]);
    assert.equal(r.emitted.length, 0);
  });

  test("a request no card can carry never reaches Claw", async () => {
    const r = rig();
    await r.ask(req("AskUserQuestion", { questions: [{ ...QUESTION, multiSelect: true }] }));
    assert.equal(r.opens(), 0);
    assert.equal(r.replies[0]!.why, "no_card_shape");
  });

  test("a close from Claw lets the waiting hooks go and forgets the session", async () => {
    const r = rig();
    await r.ask(req("Bash", { command: "ls" }));
    r.broker.close("11111111-1111-4111-8111-111111111111");
    assert.equal(r.replies[0]!.why, "session_end");
    assert.equal(r.broker.owns("11111111-1111-4111-8111-111111111111"), false);
  });
});

/** Run the hook program as Claude Code does: JSON on stdin, decision (if any) on stdout. */
function runHook(mode: "ask" | "settled", socket: string, stdin: Record<string, unknown>, env: Record<string, string> = { CLAUDE_CODE_ENTRYPOINT: "cli" }) {
  const child = spawn(process.execPath, ["--import", "tsx", HOOK, mode, "--dir", "/cfg", "--socket", socket, "--managed-by", "claw-connector"], {
    env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stdin.end(JSON.stringify(stdin));
  const exited = new Promise<{ code: number | null; out: string }>((res) => child.on("exit", (code) => res({ code, out })));
  return { child, exited };
}

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};

describe("the hook program over the real socket", () => {
  test("the owner's answer comes out as Claude Code's PermissionRequest decision", async () => {
    const state = tmpdir("cc-appr-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      assert.equal(fs.statSync(approvalSocketFile(state)).mode & 0o777, 0o600);
      const h = runHook("ask", approvalSocketFile(state), req("AskUserQuestion", { questions: [QUESTION] }));
      await until(() => r.cards().length === 1);
      r.broker.decide(String(r.cards()[0]!.data.actionId), "a1", null);
      const { code, out } = await h.exited;
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { questions: [QUESTION], answers: { "Which color?": "Blue" } } } } });
    } finally { await close(); }
  });

  test("answered at the terminal: the background hook settles it, the waiting hook exits printing nothing", async () => {
    const state = tmpdir("cc-appr-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      const h = runHook("ask", approvalSocketFile(state), req("Bash", { command: "npm test" }));
      await until(() => r.cards().length === 1);
      const s = runHook("settled", approvalSocketFile(state), { session_id: REF, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
      assert.equal((await s.exited).code, 0);
      const { code, out } = await h.exited;
      assert.equal(code, 0);
      assert.equal(out, "");
      assert.equal(r.emitted.at(-1)!.data.by, "terminal");
    } finally { await close(); }
  });

  test("SIGTERM (the terminal interrupted the turn): the card is withdrawn", async () => {
    const state = tmpdir("cc-appr-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      const h = runHook("ask", approvalSocketFile(state), req("Bash", { command: "npm test" }));
      await until(() => r.cards().length === 1);
      // The child is `node --import tsx`: signal it once the hook is waiting.
      h.child.kill("SIGTERM");
      await h.exited;
      await until(() => r.emitted.some((e) => e.type === "permission_resolved"));
      assert.equal(r.emitted.at(-1)!.data.by, "terminal");
      assert.equal(r.broker.size, 0);
    } finally { await close(); }
  });

  test("no connector, or not a terminal session: nothing printed, exit 0, at once", async () => {
    const state = tmpdir("cc-appr-");
    const t0 = Date.now();
    const a = await runHook("ask", approvalSocketFile(state), req("Bash", { command: "ls" })).exited;
    assert.deepEqual(a, { code: 0, out: "" });
    assert.ok(Date.now() - t0 < 8_000);
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      const b = await runHook("ask", approvalSocketFile(state), req("Bash", { command: "ls" }), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).exited;
      assert.deepEqual(b, { code: 0, out: "" });
      assert.equal(r.cards().length, 0);
    } finally { await close(); }
  });
});

describe("installing the approval hooks", () => {
  const NODE = "/usr/bin/node";
  const SCRIPT = "/opt/claw/dist/approval-hook.js";
  const SOCK = "/home/u/.local/state/claw-connector/approvals.sock";
  const read = (dir: string) => JSON.parse(fs.readFileSync(settingsFile(dir), "utf8"));

  test("added next to the user's own hooks and the session hooks, once; status sees them; uninstall takes out only them", () => {
    const dir = tmpdir("cc-claude-");
    const mine = { type: "command", command: "/usr/local/bin/my-policy.sh" };
    fs.writeFileSync(settingsFile(dir), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" }, hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [mine] }] } }, null, 2));
    installHooks(dir, NODE, "/opt/claw/dist/terminal-hook.js");
    assert.equal(installApprovalHooks(dir, NODE, SCRIPT, SOCK).changed, true);
    assert.equal(installApprovalHooks(dir, NODE, SCRIPT, SOCK).changed, false);
    const doc = read(dir);
    assert.deepEqual(doc.permissions, { defaultMode: "bypassPermissions" });
    for (const h of APPROVAL_HOOKED) {
      const ours = (doc.hooks[h.event] as any[]).flatMap((g) => g.hooks).filter((x: any) => /approval-hook\.js/.test(x.command));
      assert.equal(ours.length, 1, h.event);
      assert.equal(ours[0].timeout, h.timeout);
      assert.equal(ours[0].async === true, h.async, h.event);
      assert.match(ours[0].command, new RegExp(`approval-hook\\.js' ${h.arg} --dir '${dir}' --socket '${SOCK}' --managed-by claw-connector$`));
    }
    assert.deepEqual(doc.hooks.PermissionRequest[0], { matcher: "Bash", hooks: [mine] });
    assert.equal(approvalHooksStatus(dir).installed, true);
    assert.equal(hooksStatus(dir).installed, true);

    assert.equal(uninstallApprovalHooks(dir).changed, true);
    const after = read(dir);
    assert.deepEqual(after.hooks.PermissionRequest, [{ matcher: "Bash", hooks: [mine] }]);
    assert.equal(approvalHooksStatus(dir).events.length, 0);
    // The session hooks are still there, SessionEnd included.
    assert.equal(hooksStatus(dir).installed, true);
    for (const h of HOOKED) assert.equal((after.hooks[h.event] as any[]).length, 1);
    uninstallHooks(dir);
    assert.deepEqual(read(dir).hooks, { PermissionRequest: [{ matcher: "Bash", hooks: [mine] }] });
  });

  test("a settings file that is not JSON is left as it is", () => {
    const dir = tmpdir("cc-claude-");
    fs.writeFileSync(settingsFile(dir), "{ not json");
    assert.throws(() => installApprovalHooks(dir, NODE, SCRIPT, SOCK), /not valid JSON/);
    assert.equal(fs.readFileSync(settingsFile(dir), "utf8"), "{ not json");
  });

  test("status names an entry whose program is gone", () => {
    const dir = tmpdir("cc-claude-");
    installApprovalHooks(dir, process.execPath, "/nowhere/approval-hook.js", SOCK);
    const st = approvalHooksStatus(dir);
    assert.equal(st.installed, true);
    assert.equal(st.healthy, false);
    assert.match(st.problem!, /hooks install --approvals/);
  });
});

describe("through a running connector and Claw", () => {
  test("a terminal's question reaches Claw as a card on a terminal_hook session; the owner's decision comes back to the hook", async () => {
    const { Harness } = await import("./support/harness.js");
    const h = await Harness.create({ attach: { sessions: [] } });
    await h.online();
    const sock = approvalSocketFile(h.dirs.state);
    await until(() => fs.existsSync(sock));
    const hook = spawn(process.execPath, ["--import", "tsx", HOOK, "ask", "--dir", h.attachDir, "--socket", sock, "--managed-by", "claw-connector"], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    hook.stdout.on("data", (c) => { out += c; });
    const exited = new Promise<number | null>((res) => hook.on("exit", res));
    hook.stdin.end(JSON.stringify({ ...req("ExitPlanMode", PLAN, { permission_mode: "plan" }), cwd: h.work }));
    await h.claw.until("the terminal session to be opened", () => h.claw.terminalOpens.length === 1);
    assert.deepEqual(Object.keys(h.claw.terminalOpens[0]).sort(), ["agent_id", "cwd", "ref", "title"]);
    assert.equal(h.claw.terminalOpens[0].agent_id, "fake");
    assert.equal(h.claw.terminalOpens[0].ref, REF);
    const sid = h.claw.terminalSessions.get(REF)!;
    const card = await h.permission(sid);
    assert.equal(card.data.origin, "terminal_hook");
    assert.equal(card.data.kind, "switch_mode");
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.origin, "terminal_hook");
    // Anything but a decision or a close is refused on such a session.
    h.claw.issue("prompt", sid, { text: "hello" });
    await h.claw.until("the prompt to be refused", () => h.claw.eventsOf(sid, "command_rejected").length === 1);
    assert.equal(h.claw.eventsOf(sid, "command_rejected")[0]!.data.reason, "terminal_hook_session");
    h.decide(sid, String(card.data.actionId), "plan-approve");
    assert.equal(await exited, 0);
    const decision = JSON.parse(out).hookSpecificOutput.decision;
    assert.equal(decision.behavior, "allow");
    assert.deepEqual(decision.updatedPermissions, [{ type: "setMode", mode: "default", destination: "session" }]);
    await h.claw.until("the answer to be recorded", () => h.claw.eventsOf(sid, "permission_resolved").length === 1);
    assert.equal(h.claw.eventsOf(sid, "permission_resolved")[0]!.data.optionId, "plan-approve");
  });

  test("approvals off at Claw, or a folder outside the agent's roots: the hook gets no decision and no card is made", async () => {
    const { Harness } = await import("./support/harness.js");
    const h = await Harness.create({ attach: { sessions: [] } });
    await h.online();
    const sock = approvalSocketFile(h.dirs.state);
    await until(() => fs.existsSync(sock));
    const run = async (cwd: string) => {
      const c = spawn(process.execPath, ["--import", "tsx", HOOK, "ask", "--dir", h.attachDir, "--socket", sock, "--managed-by", "claw-connector"], {
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let o = "";
      c.stdout.on("data", (x) => { o += x; });
      c.stdin.end(JSON.stringify({ ...req("Bash", { command: "ls" }), cwd }));
      await new Promise((res) => c.on("exit", res));
      return o;
    };
    assert.equal(await run("/"), "");
    assert.equal(h.claw.terminalOpens.length, 0);
    h.claw.approvalsOff = true;
    assert.equal(await run(h.work), "");
    assert.equal(h.claw.terminalOpens.length, 1);
    // Remembered for a minute: Claw is not asked again for every question.
    assert.equal(await run(h.work), "");
    assert.equal(h.claw.terminalOpens.length, 1);
    assert.ok(h.audit().some((r) => r.kind === "approval_not_sent" && r.reason === "approvals_off"));
  });
});

test("a `__proto__` key in what a hook sent stays a plain field of the card's input, never the copy's prototype", () => {
  const raw = JSON.parse('{"command":"ls","__proto__":{"polluted":"yes"}}') as Record<string, unknown>;
  const m = mapRequest(ev(req("Bash", raw)))!;
  const input = m.cards[0]!.input as Record<string, unknown>;
  assert.equal((input as { polluted?: unknown }).polluted, undefined);
  assert.equal(Object.getPrototypeOf(input), Object.prototype);
  assert.deepEqual(Object.keys(input).sort(), ["__proto__", "command"]);
});
