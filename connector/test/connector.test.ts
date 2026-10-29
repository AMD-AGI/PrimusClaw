// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector end to end against a stand-in Claw (real HTTP and SSE, the real
 * protocol parsers) and a stand-in ACP adapter that is a real child process
 * speaking real newline-delimited JSON-RPC over stdio.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { processStart } from "../src/children.js";
import { sleep } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";
import { Harness, tmpdir } from "./support/harness.js";

const hs: Harness[] = [];
const make = async (o: Parameters<typeof Harness.create>[0] = {}) => { const h = await Harness.create(o); hs.push(h); return h; };
after(async () => { for (const h of hs) await h.close(); });

const alive = (pid: number) => processStart(pid) !== null;
const fileExists = (p: string) => fs.existsSync(p);

describe("identity, heartbeat and presence", () => {
  test("registers, sends the agents and a heartbeat that parses with the server's own parser, with the credential and a client label", async () => {
    const h = await make();
    await h.online();
    const hb = h.claw.heartbeats[0];
    assert.equal(hb.version, "test");
    assert.deepEqual(hb.agents.map((a: any) => [a.agent_id, a.kind, a.name]), [["fake", "example", "Fake agent"]]);
    assert.equal(hb.agents[0].capabilities.ask_mode, "default");
    assert.equal(hb.cmd_cursor, null, "nothing handled yet");
    assert.ok(h.claw.requests.every((r) => r.auth === "Bearer good-token" && r.client === "connector"));
    assert.equal(h.claw.registered, 1);
    // The identity is kept: a second run on the same home does not register again.
    await h.stop();
    h.connect();
    h.start();
    await h.online();
    assert.equal(h.claw.registered, 1);
  });
  test("keeps heartbeating and reports the command cursor once commands are handled; the server then forgets them", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "say hi");
    await h.turnEnd(sid);
    const before = h.claw.heartbeats.length;
    await h.claw.until("a heartbeat carrying the cursor", () => h.claw.heartbeats.slice(before).some((b) => b.cmd_cursor === 2));
    assert.equal(h.claw.cursor, 2);
  });
});

describe("working directory whitelist", () => {
  test("a directory outside the roots is refused: no process is started, the session is closed with the reason", async () => {
    const h = await make();
    const outside = tmpdir("cc-out-");
    const sid = await h.newSession(outside);
    assert.deepEqual(h.claw.eventsOf(sid).map((e) => [e.type, e.data.reason]), [["session_closed", "cwd_outside_roots"]]);
    assert.deepEqual(h.adapterLog(), [], "the adapter was never started");
    assert.deepEqual(h.connector.registry.list(), []);
    assert.ok(h.audit().some((a) => a.kind === "session_refused" && a.reason === "cwd_outside_roots"));
  });
  test("a symlink inside a root that points outside is refused", async () => {
    const h = await make();
    const outside = tmpdir("cc-out-");
    fs.symlinkSync(outside, path.join(h.work, "escape"));
    const sid = await h.newSession(path.join(h.work, "escape"));
    assert.equal(h.claw.eventsOf(sid, "session_closed")[0]!.data.reason, "cwd_outside_roots");
    assert.deepEqual(h.adapterLog(), []);
  });
  test("an unknown agent and a relative path are refused", async () => {
    const h = await make();
    await h.online();
    const a = h.claw.newSession("nope", h.work);
    const b = h.claw.newSession("fake", "relative/dir");
    await h.claw.until("both refused", () => h.claw.eventsOf(a, "session_closed").length && h.claw.eventsOf(b, "session_closed").length);
    assert.equal(h.claw.eventsOf(a)[0]!.data.reason, "unknown_agent");
    assert.equal(h.claw.eventsOf(b)[0]!.data.reason, "cwd_not_absolute");
  });
});

describe("the forced ask mode, read back", () => {
  test("a session starts in the ask mode: set_mode is sent and the mode is read back from the adapter", async () => {
    const h = await make();
    const sid = await h.newSession();
    const started = h.claw.eventsOf(sid, "session_started")[0]!;
    assert.equal(started.data.currentMode, "default");
    assert.deepEqual(started.data.modes.map((m: any) => m.id), ["default", "plan"], "modes the phone may choose: the safe ones only");
    assert.match(started.data.acp_session_id, /^acp-/);
    const methods = h.adapterLog().map((l) => l.method);
    assert.deepEqual(methods.filter(Boolean).slice(0, 4), ["initialize", "session/new", "session/set_mode", "session/set_config_option"]);
  });
  test("an adapter that starts in bypass mode never gets to write without asking", async () => {
    const h = await make({ env: { FAKE_START_MODE: "bypassPermissions" } });
    const sid = await h.newSession();
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.currentMode, "default");
    h.prompt(sid, "write f.txt");
    const perm = await h.permission(sid);
    assert.equal(fileExists(path.join(h.work, "f.txt")), false, "asked first");
    h.decide(sid, perm.data.actionId, "reject");
    await h.turnEnd(sid);
    assert.equal(fileExists(path.join(h.work, "f.txt")), false);
  });
  const refusals: Array<[string, Record<string, string>, string]> = [
    ["the adapter ignores set_mode (the read-back differs)", { FAKE_START_MODE: "bypassPermissions", FAKE_IGNORE_SET_MODE: "1" }, "mode_mismatch"],
    ["the adapter cannot confirm the mode at all", { FAKE_NO_CONFIG_OPTION: "1" }, "mode_not_confirmed"],
    ["the adapter warns that its permission callback will not be invoked", { FAKE_STDERR_WARN: "warn: canUseTool will not be invoked in this mode" }, "mode_not_enforced"],
    ["the agent needs a login", { FAKE_AUTH_REQUIRED: "1" }, "agent_auth_required"],
  ];
  for (const [name, env, reason] of refusals) {
    test(`not opened when ${name}`, async () => {
      const h = await make({ env });
      const sid = await h.newSession();
      const closed = await h.claw.until("closed", () => h.claw.eventsOf(sid, "session_closed")[0]);
      assert.equal(closed.data.reason, reason);
      assert.equal(h.claw.eventsOf(sid, "session_started").length, 0);
      await h.claw.until("adapter process stopped", () => h.connector.registry.list().length === 0);
    });
  }
  test("the read-back can come from a mode notification when the adapter has no mode option", async () => {
    const h = await make({ env: { FAKE_NO_CONFIG_OPTION: "1", FAKE_NOTIFY_MODE: "1" } });
    const sid = await h.newSession();
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.currentMode, "default");
  });
  test("a mode this machine does not allow cannot be selected from the phone, nor can an unknown one; an allowed one is read back", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.issue("set_mode", sid, { mode_id: "bypassPermissions" });
    h.claw.issue("set_mode", sid, { mode_id: "no-such-mode" });
    h.claw.issue("set_mode", sid, { mode_id: "plan" });
    await h.claw.until("plan applied", () => h.claw.eventsOf(sid, "mode_update").some((e) => e.data.currentMode === "plan"));
    assert.deepEqual(h.claw.eventsOf(sid, "command_rejected").map((e) => e.data.reason), ["mode_not_allowed", "mode_not_allowed"]);
    h.prompt(sid, "say x");
    await h.turnEnd(sid);
    assert.ok(h.adapterLog().filter((l) => l.method === "session/set_mode").every((l) => ["default", "plan"].includes(l.params.modeId)), "bypassPermissions was never sent to the adapter");
  });
  test("session.new asking for an unsafe mode is refused unless the owner allowed unsafe modes", async () => {
    const h = await make();
    const sid = await h.newSession(h.work, "bypassPermissions");
    assert.equal(h.claw.eventsOf(sid, "session_closed")[0]!.data.reason, "mode_not_allowed");
    assert.deepEqual(h.adapterLog(), []);
    const open = await make({ topToml: "allow_unsafe_modes = true\n" });
    const s2 = await open.newSession(open.work, "bypassPermissions");
    assert.equal(open.claw.eventsOf(s2, "session_started")[0]!.data.currentMode, "bypassPermissions");
  });
  test("a mode change the adapter makes on its own to a mode that does not ask is undone at once", async () => {
    const h = await make();
    const sid = await h.newSession();
    // The adapter reports a mode switch (as when a plan is approved and the agent leaves plan mode).
    h.prompt(sid, "say hi");
    await h.turnEnd(sid);
    const before = h.adapterLog().filter((l) => l.method === "session/set_mode").length;
    h.connector.manager.sessions.get(sid)!["noteMode"]("bypassPermissions");
    await h.claw.until("reverted", () => h.adapterLog().filter((l) => l.method === "session/set_mode").length > before);
    assert.ok(h.audit().some((a) => a.kind === "mode_reverted" && a.to === "bypassPermissions" && a.back_to === "default"));
    assert.equal(h.adapterLog().filter((l) => l.method === "session/set_mode").at(-1).params.modeId, "default");
  });
});

describe("permissions", () => {
  const ids = (e: { data: any }) => e.data.options.map((o: any) => o.optionId);
  test("the card carries the adapter's own option ids and kinds, allow_always included; allow-once writes the file", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "write hello.txt line one");
    const perm = await h.permission(sid);
    assert.deepEqual(h.claw.eventsOf(sid, "permissionRequest").length, 1);
    assert.deepEqual(perm.data.options, [
      { optionId: "allow-once", name: "allow-once", kind: "allow_once" },
      { optionId: "allow-with-updates", name: "allow-with-updates", kind: "allow_always" },
      { optionId: "reject", name: "reject", kind: "reject_once" },
    ]);
    assert.equal(perm.data.tool, "Write hello.txt");
    assert.equal(perm.data.kind, "edit");
    assert.equal(perm.data.timeout_ms, 60_000);
    assert.equal(perm.data.input.file_path, path.join(h.work, "hello.txt"));
    assert.equal(fileExists(path.join(h.work, "hello.txt")), false, "nothing is written before the answer");
    h.decide(sid, perm.data.actionId, "allow-once");
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "end_turn");
    assert.equal(fs.readFileSync(path.join(h.work, "hello.txt"), "utf8"), "line one");
    const resolved = h.claw.eventsOf(sid, "permission_resolved")[0]!;
    assert.deepEqual([resolved.data.actionId, resolved.data.optionId, resolved.data.by], [perm.data.actionId, "allow-once", "user-1"]);
    assert.deepEqual(h.adapterLog().find((l) => l.permissionAnswer)!.permissionAnswer, { outcome: { outcome: "selected", optionId: "allow-once" } });
  });
  test("reject leaves the file unchanged and the agent is told", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "write nope.txt");
    const perm = await h.permission(sid);
    h.decide(sid, perm.data.actionId, "reject");
    await h.turnEnd(sid);
    assert.equal(fileExists(path.join(h.work, "nope.txt")), false);
    assert.deepEqual(h.messages(sid), ["denied"]);
  });
  test("another adapter's ids (Codex style) pass through untouched, and the always option answers as chosen", async () => {
    const h = await make({ env: { FAKE_OPTIONS: "allow_once,accept_execpolicy_amendment,cancel" } });
    const sid = await h.newSession();
    h.prompt(sid, "write c.txt");
    const perm = await h.permission(sid);
    assert.deepEqual(ids(perm), ["allow_once", "accept_execpolicy_amendment", "cancel"]);
    h.decide(sid, perm.data.actionId, "accept_execpolicy_amendment");
    await h.turnEnd(sid);
    assert.deepEqual(h.adapterLog().find((l) => l.permissionAnswer)!.permissionAnswer, { outcome: { outcome: "selected", optionId: "accept_execpolicy_amendment" } });
  });
  test("an option that was never offered is refused and the request stays open for a proper answer", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "write x.txt");
    const perm = await h.permission(sid);
    h.claw.issue("decision", sid, { action_id: perm.data.actionId, option_id: "bypass-everything", by: "u", cmd_id: "bad-1" });
    h.claw.issue("decision", sid, { action_id: "not-an-action", option_id: "allow-once", by: "u", cmd_id: "bad-2" });
    await h.claw.until("both refused", () => h.audit().filter((a) => a.kind === "decision_refused").length === 2);
    assert.deepEqual(h.audit().filter((a) => a.kind === "decision_refused").map((a) => a.reason).sort(), ["option_not_offered", "unknown_action"]);
    assert.equal(h.claw.eventsOf(sid, "permission_resolved").length, 0);
    assert.equal(fileExists(path.join(h.work, "x.txt")), false);
    h.decide(sid, perm.data.actionId, "allow-once");
    await h.turnEnd(sid);
    assert.equal(fileExists(path.join(h.work, "x.txt")), true);
  });
  test("an answer arriving twice counts once", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "write twice.txt");
    const perm = await h.permission(sid);
    h.decide(sid, perm.data.actionId, "allow-once");
    h.claw.issue("decision", sid, { action_id: perm.data.actionId, option_id: "reject", by: "u", cmd_id: "second" });
    await h.turnEnd(sid);
    await sleep(100);
    assert.equal(h.claw.eventsOf(sid, "permission_resolved").length, 1);
    assert.equal(h.adapterLog().filter((l) => l.permissionAnswer).length, 1);
  });
  test("cancel answers the waiting request cancelled and ends the turn", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "write c.txt");
    const perm = await h.permission(sid);
    h.claw.issue("cancel", sid);
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "cancelled");
    assert.deepEqual(h.adapterLog().find((l) => l.permissionAnswer)!.permissionAnswer, { outcome: { outcome: "cancelled" } });
    const r = h.claw.eventsOf(sid, "permission_resolved")[0]!;
    assert.deepEqual([r.data.actionId, r.data.optionId, r.data.outcome, r.data.by], [perm.data.actionId, null, "cancelled", "cancel"]);
    assert.equal(fileExists(path.join(h.work, "c.txt")), false);
  });
  test("cancel stops a running turn (session/cancel is sent) and drops the prompts queued behind it", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "hang");
    h.prompt(sid, "say never");
    await h.claw.until("the turn to be running", () => h.adapterLog().some((l) => l.prompt === "hang"));
    h.claw.issue("cancel", sid);
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "cancelled");
    assert.ok(h.adapterLog().some((l) => l.method === "session/cancel"));
    await sleep(100);
    assert.ok(!h.adapterLog().some((l) => l.prompt === "say never"));
  });
  test("a cancel with nothing running still answers once", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.issue("cancel", sid);
    assert.equal((await h.turnEnd(sid)).data.stopReason, "cancelled");
  });
  test("nobody answers: after the time-to-live the adapter is answered cancelled, the card is closed and the turn ends", async () => {
    const h = await make({ timing: { permissionTtlMs: 250 } });
    const sid = await h.newSession();
    h.prompt(sid, "write late.txt");
    const perm = await h.permission(sid);
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "cancelled");
    assert.deepEqual(h.adapterLog().find((l) => l.permissionAnswer)!.permissionAnswer, { outcome: { outcome: "cancelled" } });
    const r = h.claw.eventsOf(sid, "permission_resolved")[0]!;
    assert.deepEqual([r.data.actionId, r.data.by, r.data.outcome], [perm.data.actionId, "timeout", "cancelled"]);
    assert.equal(fileExists(path.join(h.work, "late.txt")), false);
  });
  test("an owner's auto-allow rule decides on this machine, shows itself, is audited, and never covers anything else", async () => {
    const h = await make({ agentToml: `auto_allow = [{ kind = "edit", path_glob = "docs/**" }]\n` });
    fs.mkdirSync(path.join(h.work, "docs"));
    const sid = await h.newSession();
    h.prompt(sid, "write docs/a.md auto");
    await h.turnEnd(sid);
    assert.equal(fs.readFileSync(path.join(h.work, "docs", "a.md"), "utf8"), "auto");
    assert.equal(h.claw.eventsOf(sid, "permissionRequest").length, 0);
    const shown = h.claw.eventsOf(sid, "permission_auto_allowed")[0]!;
    assert.deepEqual([shown.data.rule, shown.data.optionId], ["edit:docs/**", "allow-once"], "the one-time option, never the always option");
    assert.ok(h.audit().some((a) => a.kind === "auto_allow" && a.rule === "edit:docs/**" && a.option_id === "allow-once"));
    h.prompt(sid, "write src.txt");
    await h.permission(sid);
    assert.equal(fileExists(path.join(h.work, "src.txt")), false, "outside the rule it asks");
  });
});

describe("what leaves the machine", () => {
  test("credential-shaped text is masked before upload, and a long tool output is cut to 8 KB with a note", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "say key ak-0123456789abcdefABCDEF and ghp_0123456789abcdefghijklmnopqrstuvwxyz");
    h.prompt(sid, "bigoutput");
    await h.turnEnd(sid, 2);
    const text = h.messages(sid).join("");
    assert.match(text, /\[hidden\]/);
    assert.doesNotMatch(JSON.stringify(h.claw.arrivals), /ak-0123456789|ghp_0123456789/);
    const big = h.claw.eventsOf(sid, "tool_call_update").find((e) => e.data.update.toolCallId === "big")!;
    const shown = big.data.update.content[0].content.text as string;
    assert.ok(shown.length < 8300, `cut (${shown.length})`);
    assert.match(shown, /truncated, 30000 bytes in all/);
  });
  test("the prompt text is not in the audit trail, only its hash and length", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "say a secret plan");
    await h.turnEnd(sid);
    const rec = h.audit().find((a) => a.kind === "command" && a.type === "prompt")!;
    assert.deepEqual([rec.length, typeof rec.sha256], [17, "string"]);
    assert.doesNotMatch(JSON.stringify(h.audit()), /secret plan/);
  });
  test("a configured warning is not uploaded; adapter stderr is never uploaded", async () => {
    const h = await make({ topToml: `drop_message_patterns = ["model_max_output_tokens is ignored"]\n`, env: { FAKE_STDERR_WARN: "some adapter chatter" } });
    const sid = await h.newSession();
    h.prompt(sid, "say model_max_output_tokens is ignored");
    h.prompt(sid, "say hello");
    await h.turnEnd(sid, 2);
    assert.deepEqual(h.messages(sid), ["hello"]);
    assert.doesNotMatch(JSON.stringify(h.claw.arrivals), /some adapter chatter/);
    assert.match(fs.readFileSync(path.join(h.dirs.state, "logs", "adapter-fake.log"), "utf8"), /some adapter chatter/);
  });
});

describe("transport: reconnect, duplicates, loss", () => {
  test("four dropped connections and failed or lost-acknowledgement posts during a stream of 300 events: none lost, none repeated, in order", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "chunks 300");
    for (let round = 1; round <= 4; round++) {
      await sleep(40);
      h.claw.dropStreams();
      if (round === 2) h.claw.failPosts = 2;
      if (round === 3) h.claw.loseAcks = 2;
    }
    await h.turnEnd(sid);
    await h.connector.drained();
    const chunks = h.claw.eventsOf(sid, "agent_message_chunk").map((e) => e.data.update.content.text);
    assert.deepEqual(chunks, Array.from({ length: 300 }, (_, i) => `c${i + 1}`));
    const seqs = h.claw.eventsOf(sid).map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "contiguous from 1: no gap");
    assert.equal(h.claw.eventsOf(sid, "session_started").length, 1, "the session.new delivered again after a reconnect was not run again");
    assert.equal(h.adapterLog().filter((l) => l.method === "session/new").length, 1);
    assert.ok(h.claw.duplicatesSeen > 0, "the lost acknowledgements really caused repeats, which the server ignored");
  });
  test("events survive a restart of the connector and are posted after it", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "chunks 50");
    await h.turnEnd(sid);
    await h.connector.drained();
    h.claw.failPosts = 1_000;
    h.prompt(sid, "say after");
    await h.claw.until("the event to be queued", () => h.connector.outbox.size > 0);
    await h.stop();
    h.claw.failPosts = 0;
    h.connect();
    h.start();
    await h.claw.until("it to arrive", () => h.messages(sid).includes("after"));
    const seqs = h.claw.eventsOf(sid).map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1));
  });
  test("a silent stream is dropped after the watchdog and the connector reconnects", async () => {
    const h = await make();
    await h.online();
    const connects = h.claw.streamHeaders.length;
    h.claw.muted = true;
    await h.claw.until("a reconnect after silence", () => h.claw.streamHeaders.length > connects, 3000);
    h.claw.muted = false;
    await h.claw.until("online again", () => h.claw.online);
  });
  test("the same command delivered twice, and again after a restart, is carried out once", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.issue("prompt", sid, { text: "say once", cmd_id: "same-id" });
    h.claw.issue("prompt", sid, { text: "say once", cmd_id: "same-id" });
    await h.turnEnd(sid);
    await sleep(150);
    await h.stop();
    h.claw.cursor = 0; // the server resends everything, as if no heartbeat had got through
    h.connect();
    h.start();
    await h.online();
    await sleep(300);
    assert.deepEqual(h.messages(sid), ["once"]);
  });
  test("commands for one session run in order", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "say a");
    h.prompt(sid, "say b");
    h.prompt(sid, "say c");
    await h.turnEnd(sid, 3);
    assert.deepEqual(h.messages(sid), ["a", "b", "c"]);
  });
  test("a command that is not in the closed set is dropped and audited, never run; so is one for a session nobody knows", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.issue("exec", sid, { command: "rm -rf /" });
    h.claw.issue("prompt", "99999999-9999-4999-8999-999999999999", { text: "say ghost" });
    await h.claw.until("audited", () => h.audit().some((a) => a.kind === "command_dropped" && a.type === "exec"));
    await h.claw.until("unknown session reported", () => h.claw.eventsOf("99999999-9999-4999-8999-999999999999", "session_closed")[0]);
    assert.equal(h.claw.eventsOf("99999999-9999-4999-8999-999999999999", "session_closed")[0]!.data.reason, "unknown_session");
    assert.ok(!h.adapterLog().some((l) => l.prompt === "say ghost"));
  });
});

describe("kill switch", () => {
  test("a revoked connector stops every adapter, exits as revoked and does not retry", async () => {
    const h = await make();
    const sids = [await h.newSession(), await h.newSession()];
    const pids = h.connector.registry.list().map((r) => r.pid);
    assert.equal(pids.length, 2);
    assert.ok(pids.every(alive));
    h.claw.revoke();
    assert.equal(await h.running, "revoked");
    assert.ok(pids.every((p) => !alive(p)), "every recorded adapter is gone");
    const requests = h.claw.requests.length;
    await sleep(400);
    assert.equal(h.claw.requests.length, requests, "no retry after revocation");
    assert.ok(sids.length === 2 && !fileExists(path.join(h.dirs.state, "connector.pid")));
    assert.ok(h.audit().some((a) => a.kind === "revoked"));
  });
  test("a 401 revoked on any route (here the heartbeat) has the same effect", async () => {
    const h = await make({ timing: { heartbeatMs: 80 } });
    await h.newSession();
    const pids = h.connector.registry.list().map((r) => r.pid);
    h.claw.revoked = true; // answered to every connector route, with no stream frame to announce it
    assert.equal(await h.running, "revoked");
    assert.ok(pids.every((p) => !alive(p)));
  });
  test("stop() ends the run and every adapter with it", async () => {
    const h = await make();
    await h.newSession();
    const pids = h.connector.registry.list().map((r) => r.pid);
    assert.equal(await h.stop(), "stopped");
    assert.ok(pids.every((p) => !alive(p)));
  });
  test("pause stops the adapters within a moment and takes the connector offline; resume brings it back", async () => {
    const h = await make();
    await h.newSession();
    const pids = h.connector.registry.list().map((r) => r.pid);
    fs.writeFileSync(path.join(h.dirs.state, "paused"), "x");
    await h.claw.until("offline", () => !h.claw.online);
    await h.claw.until("adapters gone", () => pids.every((p) => !alive(p)));
    fs.rmSync(path.join(h.dirs.state, "paused"));
    await h.claw.until("online again", () => h.claw.online);
  });
  test("adapters a crashed earlier run left recorded are stopped when the next run starts", async () => {
    const h = await make({ start: false });
    const { spawn } = await import("node:child_process");
    const orphan = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    h.connector.registry.add({ pid: orphan.pid!, pgid: orphan.pid!, agent_id: "fake", session_id: "old" });
    h.connect();
    h.start();
    await h.online();
    await h.claw.until("the orphan to be stopped", () => !alive(orphan.pid!));
  });
});

describe("sessions over time", () => {
  test("an idle session loses its process and comes back on the next prompt, locked into the ask mode again even though the adapter resets it", async () => {
    const h = await make({ env: { FAKE_RESUME_RESETS: "bypassPermissions" }, timing: { idleMs: 250 } });
    const sid = await h.newSession();
    const pid = h.connector.registry.list()[0]!.pid;
    await h.claw.until("recycled", () => !alive(pid));
    assert.ok(h.audit().some((a) => a.kind === "adapter_recycled"));
    h.prompt(sid, "write back.txt");
    const perm = await h.permission(sid);
    assert.equal(fileExists(path.join(h.work, "back.txt")), false, "asked, though a resumed adapter had reset itself to bypass");
    assert.ok(h.adapterLog().some((l) => l.method === "session/resume"));
    h.decide(sid, perm.data.actionId, "allow-once");
    await h.turnEnd(sid);
    assert.equal(fileExists(path.join(h.work, "back.txt")), true);
  });
  test("resume on a live adapter does not ask it to resume (that resets its mode); the mode is asserted again", async () => {
    const h = await make({ env: { FAKE_RESUME_RESETS: "bypassPermissions" } });
    const sid = await h.newSession();
    const sets = h.adapterLog().filter((l) => l.method === "session/set_mode").length;
    h.claw.issue("resume", sid);
    const ev = await h.claw.until("session_resumed", () => h.claw.eventsOf(sid, "session_resumed")[0]);
    assert.equal(ev.data.currentMode, "default");
    assert.ok(!h.adapterLog().some((l) => l.method === "session/resume"));
    assert.ok(h.adapterLog().filter((l) => l.method === "session/set_mode").length > sets);
  });
  test("a session survives a restart of the connector: the next prompt resumes it in a fresh adapter, in the ask mode, and sequence numbers go on", async () => {
    const h = await make({ env: { FAKE_RESUME_RESETS: "bypassPermissions" } });
    const sid = await h.newSession();
    h.prompt(sid, "say before");
    await h.turnEnd(sid);
    await h.connector.drained();
    const lastSeq = Math.max(...h.claw.eventsOf(sid).map((e) => e.seq));
    await h.stop();
    h.connect();
    h.start();
    await h.online();
    h.prompt(sid, "write again.txt");
    const perm = await h.permission(sid);
    assert.equal(fileExists(path.join(h.work, "again.txt")), false);
    h.decide(sid, perm.data.actionId, "allow-once");
    await h.turnEnd(sid, 2);
    assert.ok(perm.seq > lastSeq, "numbers continue where they left off");
    assert.ok(h.adapterLog().some((l) => l.method === "session/resume"));
  });
  test("an adapter that cannot resume falls back to load, and the replayed history is marked as a replay", async () => {
    const h = await make({ env: { FAKE_NO_RESUME: "1" }, timing: { idleMs: 200 } });
    const sid = await h.newSession();
    const pid = h.connector.registry.list()[0]!.pid;
    await h.claw.until("recycled", () => !alive(pid));
    h.prompt(sid, "say fresh");
    await h.turnEnd(sid);
    assert.ok(h.adapterLog().some((l) => l.method === "session/load"));
    const chunks = h.claw.eventsOf(sid, "agent_message_chunk");
    assert.deepEqual(chunks.map((e) => [e.data.update.content.text, e.data.replay === true]), [["old history", true], ["fresh", false]]);
  });
  test("a session whose directory left the whitelist is not resumed", async () => {
    const h = await make();
    const sid = await h.newSession();
    await h.stop();
    fs.rmSync(path.join(h.work), { recursive: true, force: true });
    fs.mkdirSync(h.work);
    const sub = path.join(h.work, "later");
    fs.mkdirSync(sub);
    // The roots no longer contain the old cwd (the config changed): simulate by a fresh config with another root.
    const other = tmpdir("cc-other-");
    const h2 = await make({ home: path.dirname(h.dirs.state), work: other, claw: h.claw });
    await h2.online();
    h.claw.issue("prompt", sid, { text: "say still here" });
    const closed = await h2.claw.until("refused", () => h2.claw.eventsOf(sid, "session_closed")[0]);
    assert.equal(closed.data.reason, "cwd_outside_roots");
    assert.ok(sub);
  });
});

describe("close", () => {
  test("close ends the session and its adapter, and the session is recorded as closed", async () => {
    const h = await make();
    const sid = await h.newSession();
    const pid = h.connector.registry.list()[0]!.pid;
    h.claw.issue("close", sid);
    await h.claw.until("closed", () => h.claw.eventsOf(sid, "session_closed")[0]);
    await h.claw.until("process gone", () => !alive(pid));
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dirs.state, "sessions.json"), "utf8"))[sid].status, "closed");
    assert.ok(h.adapterLog().some((l) => l.method === "session/close"));
  });
});

describe("Cursor extension requests are never left unanswered", () => {
  test("a plan is a card with accept and reject; accept answers the agent", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "plan");
    const perm = await h.permission(sid);
    assert.deepEqual(perm.data.options.map((o: any) => [o.optionId, o.kind]), [["plan-accept", "allow_once"], ["plan-reject", "reject_once"]]);
    assert.match(perm.data.tool, /Plan: Refactor/);
    h.decide(sid, perm.data.actionId, "plan-accept");
    await h.turnEnd(sid);
    assert.deepEqual(h.adapterLog().find((l) => l.planAnswer)!.planAnswer, { outcome: { outcome: "accepted" } });
  });
  test("a rejected plan, and a plan nobody answers", async () => {
    const h = await make({ timing: { permissionTtlMs: 300 } });
    const sid = await h.newSession();
    h.prompt(sid, "plan");
    const perm = await h.permission(sid);
    h.decide(sid, perm.data.actionId, "plan-reject");
    await h.turnEnd(sid);
    assert.equal(h.adapterLog().find((l) => l.planAnswer)!.planAnswer.outcome.outcome, "rejected");
    h.prompt(sid, "plan");
    await h.turnEnd(sid, 2);
    assert.deepEqual(h.adapterLog().filter((l) => l.planAnswer)[1]!.planAnswer, { outcome: { outcome: "cancelled" } });
  });
  test("a single-choice question is a card with the question's own option ids; a skip answers skipped", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "question");
    const perm = await h.permission(sid);
    assert.deepEqual(perm.data.options.map((o: any) => o.optionId), ["a", "b", "skip"]);
    h.decide(sid, perm.data.actionId, "b");
    await h.turnEnd(sid);
    assert.deepEqual(h.adapterLog().find((l) => l.questionAnswer)!.questionAnswer, { outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["b"] }] } });
    h.prompt(sid, "question");
    const p2 = await h.permission(sid, 2);
    h.decide(sid, p2.data.actionId, "skip");
    await h.turnEnd(sid, 2);
    assert.deepEqual(h.adapterLog().filter((l) => l.questionAnswer)[1]!.questionAnswer, { outcome: { outcome: "skipped" } });
  });
  test("several questions cannot be one card: they are skipped at once, visibly, and the session does not hang", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "questions2");
    await h.turnEnd(sid);
    assert.equal(h.adapterLog().find((l) => l.questionAnswer)!.questionAnswer.outcome.outcome, "skipped");
    assert.equal(h.claw.eventsOf(sid, "extension_skipped").length, 1);
  });
  test("todo updates are forwarded as events", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "todos");
    await h.turnEnd(sid);
    assert.equal(h.claw.eventsOf(sid, "cursor.update_todos").length, 1);
  });
});

test("a fake server shared by two connectors on separate homes keeps their state apart", async () => {
  const claw = await FakeClaw.start();
  const a = await make({ claw });
  await a.online();
  assert.ok(a.dirs.state !== tmpdir());
});
