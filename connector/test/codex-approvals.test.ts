// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Questions a Codex TUI asks in a terminal, answered from the phone (approvals.ts, approval-hook.ts --agent codex,
 * codex-terminal.ts): what a card offers and what Codex reads back, which sessions are handed on (the TUI only, and only while
 * nobody types in its terminal), the hook under a real pseudo-terminal, the merge into CODEX_HOME/hooks.json, and a question
 * reaching Claw through a running connector on the `codex` agent.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ApprovalBroker, approvalSocketFile, CARD_INPUT_MAX, DENIED_MESSAGE, mapCodexRequest, parsePermissionEvent, patchFiles, serveApprovals,
  type BrokerDeps, type ConnectorReply, type PermissionEvent,
} from "../src/approvals.js";
import { skipReason } from "../src/approval-skip.js";
import { codexTuiTranscript, lastInputMs, terminalOf } from "../src/codex-terminal.js";
import {
  CODEX_APPROVAL_HOOKED, codexApprovalHooksStatus, codexHooksFile, installCodexApprovalHooks, uninstallCodexApprovalHooks,
} from "../src/hooks.js";
import { tmpdir } from "./support/tmp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "..", "src", "approval-hook.ts");
const FAKE_CODEX = path.join(here, "support", "fake-codex-tty.mjs");
const REF = "01a1cdb3-a080-7161-b93a-05a9507022a6";
const SID = "11111111-1111-4111-8111-111111111111";

/** A Codex transcript whose first line is the session_meta Codex 0.153.4 writes (cut down), from `originator`. */
function transcript(originator: string, cwd = "/work/proj"): string {
  const f = path.join(tmpdir("cc-codex-tr-"), "rollout.jsonl");
  const meta = { timestamp: "2026-11-12T03:01:03.818Z", ordinal: 0, type: "session_meta", payload: { session_id: REF, id: REF, cwd, originator, cli_version: "0.153.4", source: "cli", base_instructions: { text: "x".repeat(20_000) } } };
  fs.writeFileSync(f, `${JSON.stringify(meta)}\n{"type":"turn_context"}\n`);
  return f;
}

/** What Codex 0.153.4 hands a PermissionRequest hook (measured), for `tool` with `input`. */
const req = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: REF, turn_id: "01a1cdb3-a0ae-7eb3-a110-f4feece66313", transcript_path: "/x/rollout.jsonl", cwd: "/work/proj",
  hook_event_name: "PermissionRequest", model: "gpt-5.5", permission_mode: "default", tool_name: tool, tool_input: input, ...extra,
});
const ev = (raw: Record<string, unknown>): PermissionEvent => parsePermissionEvent(raw)!;
const PATCH = "*** Begin Patch\n*** Add File: /tmp/codex-mock-patch.txt\n+hello\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch";

describe("what a Codex card offers, and what Codex reads back", () => {
  test("a command: Yes or No, and the decision carries only what Codex accepts (no always, no stop)", () => {
    const m = mapCodexRequest(ev(req("Bash", { command: "touch /tmp/proof", description: "needs to write outside the workspace" })));
    assert.equal(m.cards.length, 1);
    assert.equal(m.cards[0]!.tool, "Run: touch /tmp/proof");
    assert.equal(m.cards[0]!.kind, "execute");
    assert.deepEqual(m.cards[0]!.input, { command: "touch /tmp/proof", description: "needs to write outside the workspace" });
    assert.deepEqual(m.cards[0]!.options.map((o) => [o.optionId, o.name, o.kind]), [["allow", "Yes", "allow_once"], ["deny", "No", "reject_once"]]);
    assert.deepEqual(m.decide(["allow"]), { behavior: "allow" });
    assert.deepEqual(m.decide(["deny"]), { behavior: "deny", message: DENIED_MESSAGE });
    assert.equal(m.decide(["allow-session"]), null);
  });

  test("a patch is an edit named by the files its headers name; an MCP tool is an MCP card", () => {
    assert.deepEqual(patchFiles(PATCH), ["/tmp/codex-mock-patch.txt", "src/a.ts"]);
    const p = mapCodexRequest(ev(req("apply_patch", { command: PATCH })));
    assert.equal(p.cards[0]!.kind, "edit");
    assert.equal(p.cards[0]!.tool, "Edit /tmp/codex-mock-patch.txt, src/a.ts");
    assert.equal(mapCodexRequest(ev(req("apply_patch", { command: "garbage" }))).cards[0]!.tool, "Apply a patch");
    const mcp = mapCodexRequest(ev(req("mcp__store__delete", { id: "42" })));
    assert.equal(mcp.cards[0]!.kind, "mcp");
    assert.equal(mcp.cards[0]!.tool, "MCP tool store / delete");
  });

  test("a request too long to show whole can only be turned down from the phone", () => {
    const m = mapCodexRequest(ev(req("apply_patch", { command: `*** Begin Patch\n*** Add File: big\n+${"y".repeat(CARD_INPUT_MAX)}\n*** End Patch` })));
    assert.deepEqual(m.cards[0]!.options.map((o) => o.optionId), ["deny"]);
    assert.equal(m.decide(["allow"]), null);
  });

  test("a credential in the command is masked on the card", () => {
    const m = mapCodexRequest(ev(req("Bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' https://x" })));
    assert.doesNotMatch(JSON.stringify(m.cards[0]!.input), /abcdefghijklmnopqrstuvwxyz0123456789/);
  });
});

function rig() {
  const emitted: Array<{ sid: string; type: string; data: Record<string, unknown> }> = [];
  const opened: Array<Record<string, unknown>> = [];
  const deps: BrokerDeps = {
    async openSession(p) { opened.push(p); return { sessionId: SID }; },
    emit: (sid, type, data) => emitted.push({ sid, type, data }),
    audit: () => {},
    ttlMs: 60_000,
  };
  const broker = new ApprovalBroker(deps);
  const cards = () => emitted.filter((e) => e.type === "permissionRequest");
  return { broker, emitted, opened, cards };
}

describe("the broker, for a Codex conversation", () => {
  test("the session is opened for the codex agent and said to be Codex's; the owner's Yes is a plain allow", async () => {
    const r = rig();
    const replies: ConnectorReply[] = [];
    await r.broker.ask(req("Bash", { command: "ls /root" }), "/home/u/.codex", (x) => replies.push(x), "codex");
    assert.deepEqual(r.opened, [{ configDir: "/home/u/.codex", agent: "codex", ref: REF, cwd: "/work/proj", title: "proj" }]);
    assert.equal(r.emitted.find((e) => e.type === "session_started")!.data.agent, "codex");
    const card = r.cards()[0]!.data;
    assert.deepEqual((card.options as Array<{ optionId: string }>).map((o) => o.optionId), ["allow", "deny"]);
    assert.equal(r.broker.decide(String(card.actionId), "allow", null), true);
    assert.deepEqual(replies, [{ v: 1, decision: { behavior: "allow" } }]);
  });

  test("a question in bypass mode (approval policy never) puts no card out and leaves Codex alone", async () => {
    const r = rig();
    const replies: ConnectorReply[] = [];
    await r.broker.ask(req("Bash", { command: "ls" }, { permission_mode: "bypassPermissions" }), "/c", (x) => replies.push(x), "codex");
    assert.deepEqual(replies, [{ v: 1, decision: null, why: "unattended_mode" }]);
    assert.equal(r.cards().length, 0);
    assert.deepEqual(r.opened, []);
  });

  test("Codex's SessionEnd closes the conversation's Claw session", async () => {
    const r = rig();
    await r.broker.ask(req("Bash", { command: "ls" }), "/c", () => {}, "codex");
    r.broker.settled({ session_id: REF, hook_event_name: "SessionEnd", reason: "other" });
    assert.equal(r.emitted.filter((e) => e.type === "session_closed").length, 1);
  });
});

describe("which Codex sessions are handed on", () => {
  test("the opt-out and the bypass mode hold for Codex; Claude Code's own variables do not (Codex sets neither)", () => {
    const ask = req("Bash", { command: "ls" });
    assert.equal(skipReason({}, ask, "ask", "codex"), null);
    assert.equal(skipReason({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }, ask, "ask", "codex"), null);
    assert.equal(skipReason({ CLAW_APPROVAL_HOOKS: "off" }, ask, "ask", "codex"), "opted_out");
    assert.equal(skipReason({ CLAW_APPROVAL_HOOKS: "off" }, null, "settled", "codex"), "opted_out");
    assert.equal(skipReason({}, req("Bash", { command: "ls" }, { permission_mode: "bypassPermissions" }), "ask", "codex"), "unattended_mode");
    assert.equal(skipReason({}, { session_id: REF, hook_event_name: "PostToolUse", permission_mode: "bypassPermissions" }, "settled", "codex"), null);
    // Without the agent, the same environment is Claude Code's and is left alone.
    assert.equal(skipReason({}, ask, "ask"), "not_a_terminal");
  });

  test("only the TUI: a transcript from codex-tui, not codex_exec, not a missing or foreign file", () => {
    assert.equal(codexTuiTranscript(transcript("codex-tui")), true);
    assert.equal(codexTuiTranscript(transcript("codex_exec")), false);
    assert.equal(codexTuiTranscript("/nowhere/rollout.jsonl"), false);
    assert.equal(codexTuiTranscript(undefined), false);
    // A folder named like the marker is a string value (its quotes escaped), never taken for the key.
    assert.equal(codexTuiTranscript(transcript("codex_exec", '/w/"originator":"codex-tui"')), false);
    const notMeta = path.join(tmpdir("cc-codex-tr-"), "r.jsonl");
    fs.writeFileSync(notMeta, '{"type":"event_msg","payload":{"originator":"codex-tui"}}\n');
    assert.equal(codexTuiTranscript(notMeta), false);
  });

  test("the last input of a file that is not there is unknown", () => {
    assert.equal(lastInputMs("/nowhere/pts/9"), null);
    const pid = terminalOf(process.pid);
    assert.ok(pid === null || /^\/dev\/(pts\/\d+|tty\w+)$/.test(pid));
  });
});

/**
 * Run the hook under two shells whose stdio are pipes, so neither its parent nor that one's parent holds a terminal (whatever
 * runs the tests): it must leave the question alone at once.
 */
function runHook(socket: string, stdin: Record<string, unknown>) {
  const hook = [process.execPath, "--import", "tsx", HOOK, "ask", "--dir", "/c", "--socket", socket, "--agent", "codex", "--idle", "0", "--managed-by", "claw-connector"];
  const inner = hook.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const child = spawn("sh", ["-c", `sh -c ${JSON.stringify(`${inner}; :`)}; :`], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stdin.end(JSON.stringify(stdin));
  return new Promise<{ code: number | null; out: string }>((res) => child.on("exit", (code) => res({ code, out })));
}

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};

const haveScript = (() => { try { execFileSync("script", ["--version"], { stdio: "ignore" }); return fs.existsSync("/proc/self/fd"); } catch { return false; } })();

/** The fake Codex TUI under a real pseudo-terminal; `go()` makes it run the hook, `type()` types into its terminal. */
async function underPty(socket: string, event: Record<string, unknown>, env: Record<string, string> = {}) {
  const hook = [process.execPath, "--import", "tsx", HOOK, "ask", "--dir", "/c", "--socket", socket, "--agent", "codex", "--idle", "30", "--managed-by", "claw-connector"];
  const cmd = [process.execPath, FAKE_CODEX, "--", ...hook].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const child = spawn("script", ["-qfec", cmd, "/dev/null"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env, FAKE_CODEX_EVENT: JSON.stringify(event) } });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  await until(() => /READY \S+ \d+/.test(out));
  const [, tty, pid] = /READY (\S+) (\d+)/.exec(out)!;
  return {
    tty: tty!,
    go: () => process.kill(Number(pid), "SIGUSR1"),
    type: (s: string) => child.stdin.write(s),
    result: async () => {
      await until(() => /HOOK \S+ \S*/.test(out), 20_000);
      const [, code, b64] = /HOOK (\S+) (\S*)/.exec(out)!;
      return { code: Number(code), out: Buffer.from(b64!, "base64").toString("utf8") };
    },
    close: async () => {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) await new Promise((res) => { child.once("exit", res); setTimeout(() => child.kill(), 2000); });
    },
  };
}

describe("the Codex hook program over the real socket", () => {
  test("no terminal to watch (a hook run from a pipe, as in CI): nothing printed, no card, at once", async () => {
    const state = tmpdir("cc-cx-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      const a = await runHook(approvalSocketFile(state), req("Bash", { command: "ls" }, { transcript_path: transcript("codex-tui") }));
      assert.deepEqual(a, { code: 0, out: "" });
      assert.equal(r.cards().length, 0);
    } finally { await close(); }
  });

  test("under a terminal nobody typed in for a while: the card goes out and the owner's answer is Codex's decision", { skip: !haveScript && "needs script(1) and /proc" }, async () => {
    const state = tmpdir("cc-cx-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    const t = await underPty(approvalSocketFile(state), req("Bash", { command: "touch /tmp/proof" }, { transcript_path: transcript("codex-tui") }));
    try {
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(t.tty, old, fs.statSync(t.tty).mtime);
      t.go();
      await until(() => r.cards().length === 1);
      assert.equal(r.emitted.find((e) => e.type === "session_started")!.data.agent, "codex");
      r.broker.decide(String(r.cards()[0]!.data.actionId), "deny", null);
      const res = await t.result();
      assert.equal(res.code, 0);
      assert.deepEqual(JSON.parse(res.out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: DENIED_MESSAGE } } });
    } finally { await t.close(); await close(); }
  });

  test("someone types in the terminal while the card waits: the question goes back to it and the card is withdrawn", { skip: !haveScript && "needs script(1) and /proc" }, async () => {
    const state = tmpdir("cc-cx-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    const t = await underPty(approvalSocketFile(state), req("Bash", { command: "touch /tmp/proof" }, { transcript_path: transcript("codex-tui") }));
    try {
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(t.tty, old, fs.statSync(t.tty).mtime);
      t.go();
      await until(() => r.cards().length === 1);
      t.type("k\n");
      const res = await t.result();
      assert.deepEqual(res, { code: 0, out: "" });
      await until(() => r.emitted.some((e) => e.type === "permission_resolved"));
      assert.equal(r.emitted.find((e) => e.type === "permission_resolved")!.data.by, "terminal");
      assert.equal(r.broker.size, 0);
    } finally { await t.close(); await close(); }
  });

  test("someone typed there just now, or the session is not the TUI: left to the terminal at once, no card", { skip: !haveScript && "needs script(1) and /proc" }, async () => {
    const state = tmpdir("cc-cx-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      const fresh = await underPty(approvalSocketFile(state), req("Bash", { command: "ls" }, { transcript_path: transcript("codex-tui") }));
      try {
        fs.utimesSync(fresh.tty, new Date(), fs.statSync(fresh.tty).mtime);
        fresh.go();
        assert.deepEqual(await fresh.result(), { code: 0, out: "" });
      } finally { await fresh.close(); }
      const exec = await underPty(approvalSocketFile(state), req("Bash", { command: "ls" }, { transcript_path: transcript("codex_exec") }));
      try {
        const old = new Date(Date.now() - 120_000);
        fs.utimesSync(exec.tty, old, fs.statSync(exec.tty).mtime);
        exec.go();
        assert.deepEqual(await exec.result(), { code: 0, out: "" });
      } finally { await exec.close(); }
      assert.equal(r.cards().length, 0);
    } finally { await close(); }
  });

  test("an idle TUI in bypass mode, or started with CLAW_APPROVAL_HOOKS=off: left to the terminal at once, no card", { skip: !haveScript && "needs script(1) and /proc" }, async () => {
    const state = tmpdir("cc-cx-");
    const r = rig();
    const close = await serveApprovals(state, r.broker, (m) => String(m.dir), () => {});
    try {
      const runs: Array<[Record<string, unknown>, Record<string, string>]> = [
        [{ transcript_path: transcript("codex-tui"), permission_mode: "bypassPermissions" }, {}],
        [{ transcript_path: transcript("codex-tui") }, { CLAW_APPROVAL_HOOKS: "off" }],
      ];
      for (const [extra, env] of runs) {
        const t = await underPty(approvalSocketFile(state), req("Bash", { command: "ls" }, extra), env);
        try {
          const old = new Date(Date.now() - 120_000);
          fs.utimesSync(t.tty, old, fs.statSync(t.tty).mtime);
          t.go();
          assert.deepEqual(await t.result(), { code: 0, out: "" });
        } finally { await t.close(); }
      }
      assert.equal(r.cards().length, 0);
    } finally { await close(); }
  });
});

describe("installing the Codex approval hook", () => {
  const NODE = "/usr/bin/node";
  const SCRIPT = "/opt/claw/dist/approval-hook.js";
  const SOCK = "/home/u/.local/state/claw-connector/approvals.sock";
  const read = (dir: string) => JSON.parse(fs.readFileSync(codexHooksFile(dir), "utf8"));

  test("merged into hooks.json next to the user's own hooks, once; status sees it; uninstall takes out only it", () => {
    const dir = tmpdir("cc-codex-");
    const mine = { type: "command", command: "python3 /home/u/policy.py", timeout: 30 };
    fs.writeFileSync(codexHooksFile(dir), JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [mine] }] } }, null, 2));
    assert.equal(installCodexApprovalHooks(dir, NODE, SCRIPT, SOCK).changed, true);
    assert.equal(installCodexApprovalHooks(dir, NODE, SCRIPT, SOCK).changed, false);
    const doc = read(dir);
    for (const h of CODEX_APPROVAL_HOOKED) {
      const ours = (doc.hooks[h.event] as any[]).flatMap((g) => g.hooks).filter((x: any) => /approval-hook\.js/.test(x.command));
      assert.equal(ours.length, 1, h.event);
      assert.equal(ours[0].timeout, h.timeout);
      assert.equal(ours[0].async, undefined);
      assert.match(ours[0].command, new RegExp(`approval-hook\\.js' ${h.arg} --dir '${dir}' --socket '${SOCK}' --agent codex --idle 30 --managed-by claw-connector$`));
    }
    assert.match(doc.hooks.PermissionRequest[1].hooks[0].statusMessage, /phone/);
    assert.deepEqual(doc.hooks.PermissionRequest[0], { matcher: "Bash", hooks: [mine] });
    assert.equal(codexApprovalHooksStatus(dir).installed, true);
    assert.equal(uninstallCodexApprovalHooks(dir).changed, true);
    assert.deepEqual(read(dir), { hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [mine] }] } });
    assert.equal(codexApprovalHooksStatus(dir).events.length, 0);
  });

  test("a hooks.json that is not JSON is left as it is", () => {
    const dir = tmpdir("cc-codex-");
    fs.writeFileSync(codexHooksFile(dir), "{ not json");
    assert.throws(() => installCodexApprovalHooks(dir, NODE, SCRIPT, SOCK), /not valid JSON/);
    assert.equal(fs.readFileSync(codexHooksFile(dir), "utf8"), "{ not json");
  });
});

describe("through a running connector and Claw", () => {
  test("a Codex terminal's question goes on the codex agent whose CODEX_HOME the hook names; the answer comes back", async () => {
    const { Harness } = await import("./support/harness.js");
    const codexHome = tmpdir("cc-codexhome-");
    const h = await Harness.create({ kind: "codex", env: { CODEX_HOME: codexHome } });
    await h.online();
    const sock = approvalSocketFile(h.dirs.state);
    await until(() => fs.existsSync(sock));
    const ask = (dir: string) => new Promise<string>((resolve) => {
      let buf = "";
      const c = net.createConnection(sock, () => c.write(`${JSON.stringify({ v: 1, type: "ask", dir, agent: "codex", event: { ...req("Bash", { command: "touch /tmp/proof" }), cwd: h.work } })}\n`));
      c.setEncoding("utf8");
      c.on("data", (x: string) => { buf += x; });
      c.on("close", () => resolve(buf));
    });
    // A CODEX_HOME no agent reads: no card.
    assert.match(await ask(tmpdir("cc-other-")), /no_agent_for_config_dir/);
    const answered = ask(codexHome);
    await h.claw.until("the terminal session to be opened", () => h.claw.terminalOpens.length === 1);
    assert.equal(h.claw.terminalOpens[0].agent_id, "fake");
    const sid = h.claw.terminalSessions.get(REF)!;
    const card = await h.permission(sid);
    assert.equal(card.data.origin, "terminal_hook");
    assert.equal(card.data.kind, "execute");
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.agent, "codex");
    h.decide(sid, String(card.data.actionId), "allow");
    assert.deepEqual(JSON.parse((await answered).split("\n")[0]!), { v: 1, decision: { behavior: "allow" } });
  });
});
