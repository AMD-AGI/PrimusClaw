// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Cursor's approval hooks (cursor-approvals.ts, the Cursor half of approvals.ts and approval-hook.ts, hooks.ts): which calls
 * Cursor would ask about, what the card offers and what a choice makes the hook print, how the hold ends (phone, terminal,
 * Ctrl-C, timeout), the hook program over the real socket, the merge into Cursor's hooks.json, and the whole path through a
 * running connector and Claw. The payloads are what the Cursor Agent CLI 2026.11.11-b912975 handed a hook (measured).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { ApprovalBroker, approvalSocketFile, serveApprovals, type BrokerDeps, type ConnectorReply } from "../src/approvals.js";
import {
  CURSOR_DENIED_AGENT, cursorConfigDir, cursorWouldAsk, loadCursorRules, mapCursorRequest, matchesShellRule, parseCursorEvent, simpleCommands,
  type CursorEvent, type CursorRules,
} from "../src/cursor-approvals.js";
import {
  CURSOR_APPROVAL_HOOKED, cursorApprovalHooksStatus, cursorHooksFile, installCursorApprovalHooks, uninstallCursorApprovalHooks,
} from "../src/hooks.js";
import { tmpdir } from "./support/tmp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "..", "src", "approval-hook.ts");
const CONV = "3f55caf4-d7a9-492c-82d7-b9ac84704ae2";
const CWD = "/work/proj";

/** What the Cursor Agent CLI hands `beforeShellExecution` (measured). */
const shell = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  conversation_id: CONV, generation_id: "ebccadee-bde3-456d-b915-18e2c1cb988c", model: "m", command, cwd: CWD, sandbox: false,
  tool_use_id: "a556189c-4b67-4922-a09c-2e95e7d1c7b2", session_id: CONV, hook_event_name: "beforeShellExecution",
  cursor_version: "2026.11.11-b912975", workspace_roots: [CWD], user_email: null, transcript_path: null, ...extra,
});
const mcp = (server: string, tool: string, input: unknown): Record<string, unknown> => ({
  conversation_id: CONV, generation_id: "g", model: "m", tool_name: tool, tool_input: JSON.stringify(input), mcp_server_name: server, command: "npx srv",
  session_id: CONV, hook_event_name: "beforeMCPExecution", cursor_version: "2026.11.11-b912975", workspace_roots: [CWD], user_email: null, transcript_path: null,
});
const ev = (raw: Record<string, unknown>): CursorEvent => parseCursorEvent(raw)!;
const rules = (r: Partial<CursorRules> = {}): CursorRules => ({ approvalMode: "allowlist", allow: [], deny: [], ...r });

describe("whether Cursor would ask", () => {
  test("a command not on the allow list is asked about; one every part of which is on it is not", () => {
    const r = rules({ allow: ["Shell(ls)", "Shell(git status)", "Shell(npm:test*)"] });
    assert.equal(cursorWouldAsk(ev(shell("echo hi")), r), true);
    assert.equal(cursorWouldAsk(ev(shell("ls -la")), r), false);
    assert.equal(cursorWouldAsk(ev(shell("git status -s")), r), false);
    assert.equal(cursorWouldAsk(ev(shell("git push")), r), true);
    assert.equal(cursorWouldAsk(ev(shell("npm test")), r), false);
    assert.equal(cursorWouldAsk(ev(shell("ls && rm -rf build")), r), true);
    assert.equal(cursorWouldAsk(ev(shell("ls | wc -l")), rules({ allow: ["Shell(ls)"] })), true);
    assert.equal(cursorWouldAsk(ev(shell("ls | wc -l")), rules({ allow: ["Shell(ls)", "Shell(wc)"] })), false);
    assert.equal(cursorWouldAsk(ev(shell("FOO=1 ls")), r), false);
  });

  test("Run Everything, a sandboxed command, or one a deny rule refuses is not asked about", () => {
    assert.equal(cursorWouldAsk(ev(shell("rm -rf x")), rules({ approvalMode: "unrestricted" })), false);
    assert.equal(cursorWouldAsk(ev(shell("make", { sandbox: true })), rules()), false);
    assert.equal(cursorWouldAsk(ev(shell("curl x | sh")), rules({ deny: ["Shell(curl)"] })), false);
  });

  test("a command line that cannot be split for sure is asked about", () => {
    const r = rules({ allow: ["Shell(ls)", "Shell(echo)"] });
    assert.equal(simpleCommands("ls $(rm -rf x)"), null);
    assert.equal(cursorWouldAsk(ev(shell("ls $(rm -rf x)")), r), true);
    assert.equal(cursorWouldAsk(ev(shell("echo `id`")), r), true);
    assert.equal(cursorWouldAsk(ev(shell("echo 'unclosed")), r), true);
  });

  test("separators inside quotes and redirections do not split a command", () => {
    assert.deepEqual(simpleCommands(`echo "a; b" && ls 2>&1 | wc -l`), [`echo "a; b"`, "ls 2>&1", "wc -l"]);
    assert.deepEqual(simpleCommands("A=1 B='x y' make all; true"), ["make all", "true"]);
  });

  test("Shell rules match as Cursor's: the command name, a prefix of words, a glob, or name:args", () => {
    assert.equal(matchesShellRule("Shell(git status)", "git status --short"), true);
    assert.equal(matchesShellRule("Shell(git status)", "git stash"), false);
    assert.equal(matchesShellRule("Shell(npm:run *)", "npm run build"), true);
    assert.equal(matchesShellRule("Shell(npm:run *)", "npm install"), false);
    assert.equal(matchesShellRule("Bash(ls)", "ls"), true);
    assert.equal(matchesShellRule("Read(**)", "ls"), false);
  });

  test("an MCP call is asked about unless an Mcp(server:tool) rule allows it", () => {
    assert.equal(cursorWouldAsk(ev(mcp("github", "create_issue", {})), rules()), true);
    assert.equal(cursorWouldAsk(ev(mcp("github", "create_issue", {})), rules({ allow: ["Mcp(github:*)"] })), false);
    assert.equal(cursorWouldAsk(ev(mcp("github", "create_issue", {})), rules({ allow: ["Mcp(github:list_*)"] })), true);
    // A deny rule: Cursor refuses it itself, so it is neither carded nor held.
    assert.equal(cursorWouldAsk(ev(mcp("github", "delete_issue", {})), rules({ deny: ["Mcp(github:delete_issue)"] })), false);
  });

  test("the rules come from the user's cli-config.json and each workspace root's .cursor/cli.json", () => {
    const cfg = tmpdir("cc-cursor-");
    const root = tmpdir("cc-root-");
    fs.writeFileSync(path.join(cfg, "cli-config.json"), JSON.stringify({ approvalMode: "allowlist", permissions: { allow: ["Shell(ls)"], deny: [] } }));
    fs.mkdirSync(path.join(root, ".cursor"));
    fs.writeFileSync(path.join(root, ".cursor", "cli.json"), JSON.stringify({ permissions: { allow: ["Shell(make)"], deny: ["Shell(curl)"] } }));
    assert.deepEqual(loadCursorRules(cfg, [root]), { approvalMode: "allowlist", allow: ["Shell(ls)", "Shell(make)"], deny: ["Shell(curl)"] });
    // Nothing readable: no rules, so every command is taken as one Cursor asks about.
    assert.deepEqual(loadCursorRules(path.join(cfg, "missing"), []), { approvalMode: null, allow: [], deny: [] });
  });

  test("the Cursor directory is found the way the CLI finds it", () => {
    assert.equal(cursorConfigDir({ CURSOR_CONFIG_DIR: "/c" }, "/h"), "/c");
    assert.equal(cursorConfigDir({ XDG_CONFIG_HOME: "/x" }, "/h"), "/x/cursor");
    assert.equal(cursorConfigDir({}, "/h"), "/h/.cursor");
  });
});

describe("the card and what a choice prints", () => {
  test("a command: No blocks it; 'ask me at the terminal' prints nothing, so Cursor asks; there is no Yes", () => {
    const m = mapCursorRequest(ev(shell("npm publish")));
    assert.equal(m.cards.length, 1);
    assert.equal(m.cards[0]!.tool, "Run: npm publish");
    assert.equal(m.cards[0]!.kind, "execute");
    assert.deepEqual(m.cards[0]!.input, { command: "npm publish", cwd: CWD });
    assert.deepEqual(m.cards[0]!.options.map((o) => [o.optionId, o.kind]), [["deny", "reject_once"], ["terminal", "allow_once"]]);
    assert.deepEqual(m.decide(["deny"]), { permission: "deny", user_message: "Declined from your phone (Claw).", agent_message: CURSOR_DENIED_AGENT });
    assert.equal(m.decide(["terminal"]), null);
  });

  test("a credential typed into a command is masked in the card's title as well as in its input", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const m = mapCursorRequest(ev(shell(`curl -H "Authorization: token ${token}" https://api.github.com/user`)));
    assert.ok(!m.cards[0]!.tool.includes(token), m.cards[0]!.tool);
    assert.ok(!JSON.stringify(m.cards[0]!.input).includes(token));
    assert.match(m.cards[0]!.tool, /^Run: curl /);
  });

  test("an MCP call shows its server, tool and arguments; a credential is masked", () => {
    const m = mapCursorRequest(ev(mcp("github", "create_issue", { title: "x", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" })));
    assert.equal(m.cards[0]!.tool, "MCP tool github / create_issue");
    assert.equal(m.cards[0]!.kind, "mcp");
    const input = m.cards[0]!.input as { server: string; tool: string; arguments: Record<string, unknown> };
    assert.equal(input.server, "github");
    assert.equal(input.arguments.title, "x");
    assert.ok(!JSON.stringify(input).includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  });

  test("only a before-hook with a usable conversation, folder and command is taken", () => {
    assert.equal(parseCursorEvent({ ...shell("ls"), hook_event_name: "afterShellExecution" }), null);
    assert.equal(parseCursorEvent({ ...shell("ls"), conversation_id: "../x" }), null);
    assert.equal(parseCursorEvent({ ...shell("  ") }), null);
    assert.equal(parseCursorEvent({ ...shell("ls"), cwd: "relative", workspace_roots: [] }), null);
    assert.equal(ev({ ...shell("ls"), cwd: undefined }).cwd, CWD);
  });
});

function rig(o: { refuse?: string; ttlMs?: number; rules?: CursorRules } = {}) {
  const emitted: Array<{ sid: string; type: string; data: Record<string, unknown> }> = [];
  const opened: Array<Record<string, unknown>> = [];
  const deps: BrokerDeps = {
    async openSession(p) { opened.push(p); return o.refuse ? { refused: o.refuse } : { sessionId: "22222222-2222-4222-8222-222222222222" }; },
    emit: (sid, type, data) => emitted.push({ sid, type, data }),
    audit: () => {},
    ttlMs: o.ttlMs ?? 60_000,
    cursorRules: () => o.rules ?? rules({ allow: ["Shell(ls)"] }),
  };
  const broker = new ApprovalBroker(deps);
  const replies: ConnectorReply[] = [];
  const ask = (raw: Record<string, unknown>, holdMs = 60_000) => broker.askCursor(raw, "/cursor", holdMs, (r) => replies.push(r));
  const cards = () => emitted.filter((e) => e.type === "permissionRequest");
  return { broker, emitted, opened, replies, ask, cards };
}

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};

describe("the broker, for Cursor", () => {
  test("a call Cursor would not ask about is answered at once: no session, no card, no hold", async () => {
    const r = rig();
    await r.ask(shell("ls -la"));
    assert.deepEqual(r.replies, [{ v: 1, decision: null, why: "cursor_would_not_ask" }]);
    assert.equal(r.opened.length, 0);
    assert.equal(r.cards().length, 0);
  });

  test("No from the phone: the hook gets the refusal; the session is a cursor terminal_hook session", async () => {
    const r = rig();
    await r.ask(shell("npm publish"));
    assert.equal(r.opened[0]!.agent, "cursor");
    assert.equal(r.opened[0]!.ref, CONV);
    const started = r.emitted.find((e) => e.type === "session_started")!.data;
    assert.deepEqual([started.origin, started.agent, started.ref], ["terminal_hook", "cursor", CONV]);
    const card = r.cards()[0]!.data;
    assert.equal(card.timeout_ms, 60_000);
    assert.equal(card.terminal_asks, "after_card");
    assert.equal(r.broker.decide(String(card.actionId), "deny", null), true);
    assert.deepEqual(r.replies, [{ v: 1, decision: { permission: "deny", user_message: "Declined from your phone (Claw).", agent_message: CURSOR_DENIED_AGENT } }]);
  });

  test("'ask me at the terminal' from the phone lets the hook go with no decision", async () => {
    const r = rig();
    await r.ask(shell("npm publish"));
    r.broker.decide(String(r.cards()[0]!.data.actionId), "terminal", null);
    assert.deepEqual(r.replies, [{ v: 1, decision: null, why: "phone" }]);
  });

  test("the hold runs out: the card is withdrawn and Cursor asks at the terminal", async () => {
    const r = rig();
    await r.ask(shell("npm publish"), 1_000);
    assert.equal(r.cards()[0]!.data.timeout_ms, 1_000);
    await until(() => r.replies.length === 1, 5_000);
    assert.deepEqual(r.replies, [{ v: 1, decision: null, why: "timeout" }]);
    assert.deepEqual(r.emitted.at(-1)!.data, { actionId: r.cards()[0]!.data.actionId, optionId: null, outcome: "cancelled", by: "timeout" });
  });

  test("Ctrl-C at the terminal (stop) or a new prompt settles the conversation's requests as answered there", async () => {
    const r = rig();
    await r.ask(shell("npm publish"));
    r.broker.settled({ conversation_id: "other", hook_event_name: "stop", status: "aborted" });
    assert.equal(r.replies.length, 0);
    r.broker.settled({ conversation_id: CONV, session_id: CONV, hook_event_name: "stop", status: "aborted" });
    assert.deepEqual(r.replies, [{ v: 1, decision: null, why: "terminal" }]);
    await r.ask(shell("make deploy", { tool_use_id: "t2" }));
    r.broker.settled({ conversation_id: CONV, hook_event_name: "beforeSubmitPrompt", prompt: "x" });
    assert.equal(r.replies.length, 2);
  });

  test("the call's own result or failure settles it, by its tool_use_id; another call's does not", async () => {
    const r = rig();
    await r.ask(shell("npm publish", { tool_use_id: "t1" }));
    r.broker.settled({ conversation_id: CONV, hook_event_name: "afterShellExecution", command: "ls", tool_use_id: "t0" });
    assert.equal(r.replies.length, 0);
    r.broker.settled({ conversation_id: CONV, hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_use_id: "t1", failure_type: "error" });
    assert.equal(r.replies.length, 1);
  });

  test("the conversation's end closes its Claw session", async () => {
    const r = rig();
    await r.ask(shell("npm publish"));
    r.broker.settled({ conversation_id: CONV, session_id: CONV, hook_event_name: "sessionEnd", reason: "user_close" });
    assert.equal(r.emitted.at(-1)!.type, "session_closed");
    assert.equal(r.broker.owns("22222222-2222-4222-8222-222222222222"), false);
  });

  test("Claw will not take it (approvals off, no cursor agent): no decision at once", async () => {
    const r = rig({ refuse: "no_agent_for_config_dir" });
    await r.ask(shell("npm publish"));
    assert.deepEqual(r.replies, [{ v: 1, decision: null, why: "no_agent_for_config_dir" }]);
    assert.equal(r.cards().length, 0);
  });
});

function runCursorHook(mode: "ask" | "settled", socket: string, stdin: Record<string, unknown>, env: Record<string, string | undefined> = { CURSOR_INVOKED_AS: "agent" }) {
  const childEnv: Record<string, string | undefined> = { ...process.env, CLAW_CONNECTOR_AGENT: undefined, CURSOR_INVOKED_AS: undefined, ...env };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const child = spawn(process.execPath, ["--import", "tsx", HOOK, mode, "--agent", "cursor", ...(mode === "ask" ? ["--hold", "30"] : []), "--dir", "/cursor", "--socket", socket, "--managed-by", "claw-connector"], {
    env: childEnv as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stdin.end(JSON.stringify(stdin));
  const exited = new Promise<{ code: number | null; out: string }>((res) => child.on("exit", (code) => res({ code, out })));
  return { child, exited };
}

describe("the Cursor hook program over the real socket", () => {
  test("No from the phone comes out as Cursor's deny; the hold the entry names reaches the card", async () => {
    const state = tmpdir("cc-appr-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      const h = runCursorHook("ask", approvalSocketFile(state), shell("npm publish"));
      await until(() => r.cards().length === 1);
      assert.equal(r.cards()[0]!.data.timeout_ms, 30_000);
      r.broker.decide(String(r.cards()[0]!.data.actionId), "deny", null);
      const { code, out } = await h.exited;
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(out), { permission: "deny", user_message: "Declined from your phone (Claw).", agent_message: CURSOR_DENIED_AGENT });
    } finally { await close(); }
  });

  test("Ctrl-C at the terminal: the stop hook settles it and the waiting hook exits printing nothing", async () => {
    const state = tmpdir("cc-appr-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      const h = runCursorHook("ask", approvalSocketFile(state), shell("npm publish"));
      await until(() => r.cards().length === 1);
      const s = runCursorHook("settled", approvalSocketFile(state), { conversation_id: CONV, hook_event_name: "stop", status: "aborted" });
      assert.equal((await s.exited).code, 0);
      assert.deepEqual(await h.exited, { code: 0, out: "" });
      assert.equal(r.emitted.at(-1)!.data.by, "terminal");
    } finally { await close(); }
  });

  test("not a hand-started Cursor CLI session (no CURSOR_INVOKED_AS, or one the connector runs): nothing sent, nothing printed", async () => {
    const state = tmpdir("cc-appr-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      assert.deepEqual(await runCursorHook("ask", approvalSocketFile(state), shell("npm publish"), {}).exited, { code: 0, out: "" });
      assert.deepEqual(await runCursorHook("ask", approvalSocketFile(state), shell("npm publish"), { CURSOR_INVOKED_AS: "agent", CLAW_CONNECTOR_AGENT: "cursor" }).exited, { code: 0, out: "" });
      assert.equal(r.cards().length, 0);
      assert.equal(r.opened.length, 0);
    } finally { await close(); }
  });
});

describe("installing the Cursor hooks", () => {
  const NODE = "/usr/bin/node";
  const SCRIPT = "/opt/claw/dist/approval-hook.js";
  const SOCK = "/home/u/.local/state/claw-connector/approvals.sock";
  const read = (dir: string) => JSON.parse(fs.readFileSync(cursorHooksFile(dir), "utf8"));

  test("added next to the user's own hooks, once; status sees them and the hold; uninstall takes out only ours", () => {
    const dir = tmpdir("cc-cursor-");
    const own = { command: "./hooks/audit.sh", timeout: 10 };
    fs.writeFileSync(cursorHooksFile(dir), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [own], afterFileEdit: [{ command: "fmt" }] } }, null, 2));
    assert.equal(installCursorApprovalHooks(dir, NODE, SCRIPT, SOCK, 90).changed, true);
    let doc = read(dir);
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.hooks.beforeShellExecution[0], own);
    const ours = doc.hooks.beforeShellExecution[1];
    assert.equal(ours.timeout, 120);
    assert.equal(ours.command, `'${NODE}' '${SCRIPT}' ask --agent cursor --hold 90 --dir '${dir}' --socket '${SOCK}' --managed-by claw-connector`);
    assert.equal(doc.hooks.stop[0].timeout, 5);
    for (const h of CURSOR_APPROVAL_HOOKED) assert.equal(doc.hooks[h.event].filter((x: { command: string }) => x.command.includes("approval-hook")).length, 1, h.event);
    // Again with another hold: brought up to date in place, not added twice.
    assert.equal(installCursorApprovalHooks(dir, NODE, SCRIPT, SOCK, 30).changed, true);
    assert.equal(installCursorApprovalHooks(dir, NODE, SCRIPT, SOCK, 30).changed, false);
    doc = read(dir);
    assert.equal(doc.hooks.beforeShellExecution.length, 2);
    const st = cursorApprovalHooksStatus(dir);
    assert.equal(st.installed, true);
    assert.equal(st.holdS, 30);
    assert.equal(st.healthy, false); // the node and script named above do not exist here
    assert.match(String(st.problem), /hooks install --approvals --agent cursor/);
    assert.equal(uninstallCursorApprovalHooks(dir).changed, true);
    assert.deepEqual(read(dir), { version: 1, hooks: { beforeShellExecution: [own], afterFileEdit: [{ command: "fmt" }] } });
    assert.equal(uninstallCursorApprovalHooks(dir).changed, false);
  });

  test("a missing file is created as version 1; a file that is not JSON, or of another version, is left as it is", () => {
    const dir = tmpdir("cc-cursor-");
    installCursorApprovalHooks(dir, NODE, SCRIPT, SOCK, 60);
    assert.equal(read(dir).version, 1);
    assert.equal(fs.statSync(cursorHooksFile(dir)).mode & 0o777, 0o600);
    const bad = tmpdir("cc-cursor-");
    fs.writeFileSync(cursorHooksFile(bad), "{ not json");
    assert.throws(() => installCursorApprovalHooks(bad, NODE, SCRIPT, SOCK, 60), /not valid JSON/);
    assert.equal(fs.readFileSync(cursorHooksFile(bad), "utf8"), "{ not json");
    fs.writeFileSync(cursorHooksFile(bad), JSON.stringify({ version: 2, hooks: {} }));
    assert.throws(() => installCursorApprovalHooks(bad, NODE, SCRIPT, SOCK, 60), /version 2/);
    assert.equal(uninstallCursorApprovalHooks(tmpdir("cc-cursor-")).changed, false);
  });
});

describe("through a running connector and Claw", () => {
  test("a Cursor command reaches Claw as a card on a cursor terminal_hook session; No from the phone comes back to the hook as deny", async () => {
    const { Harness } = await import("./support/harness.js");
    const cursorDir = tmpdir("cc-cursor-");
    const h = await Harness.create({ kind: "cursor", env: { CURSOR_CONFIG_DIR: cursorDir } });
    await h.online();
    const sock = approvalSocketFile(h.dirs.state);
    await until(() => fs.existsSync(sock));
    const child = spawn(process.execPath, ["--import", "tsx", HOOK, "ask", "--agent", "cursor", "--hold", "30", "--dir", cursorDir, "--socket", sock, "--managed-by", "claw-connector"], {
      env: { ...process.env, CURSOR_INVOKED_AS: "agent" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    const exited = new Promise<number | null>((res) => child.on("exit", res));
    child.stdin.end(JSON.stringify({ ...shell("npm publish"), cwd: h.work, workspace_roots: [h.work] }));
    await h.claw.until("the terminal session to be opened", () => h.claw.terminalOpens.length === 1);
    assert.equal(h.claw.terminalOpens[0].agent_id, "fake");
    assert.equal(h.claw.terminalOpens[0].ref, CONV);
    const sid = h.claw.terminalSessions.get(CONV)!;
    const card = await h.permission(sid);
    assert.equal(card.data.origin, "terminal_hook");
    assert.equal(card.data.kind, "execute");
    assert.equal(card.data.tool, "Run: npm publish");
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.agent, "cursor");
    h.decide(sid, String(card.data.actionId), "deny");
    assert.equal(await exited, 0);
    assert.equal(JSON.parse(out).permission, "deny");
    await h.claw.until("the answer to be recorded", () => h.claw.eventsOf(sid, "permission_resolved").length === 1);
  });

  test("no cursor agent reads that Cursor directory: no card, no decision", async () => {
    const { Harness } = await import("./support/harness.js");
    const h = await Harness.create({ kind: "cursor", env: { CURSOR_CONFIG_DIR: tmpdir("cc-cursor-") } });
    await h.online();
    const sock = approvalSocketFile(h.dirs.state);
    await until(() => fs.existsSync(sock));
    const child = spawn(process.execPath, ["--import", "tsx", HOOK, "ask", "--agent", "cursor", "--hold", "30", "--dir", tmpdir("cc-other-"), "--socket", sock, "--managed-by", "claw-connector"], {
      env: { ...process.env, CURSOR_INVOKED_AS: "agent" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    const exited = new Promise<number | null>((res) => child.on("exit", res));
    child.stdin.end(JSON.stringify({ ...shell("npm publish"), cwd: h.work, workspace_roots: [h.work] }));
    assert.equal(await exited, 0);
    assert.equal(out, "");
    assert.equal(h.claw.terminalOpens.length, 0);
    assert.ok(h.audit().some((r) => r.kind === "approval_not_sent" && r.reason === "no_agent_for_config_dir"));
  });
});
