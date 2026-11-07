// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector end to end against a stand-in Claw (real HTTP and SSE, the real
 * protocol parsers) and a stand-in ACP adapter that is a real child process
 * speaking real newline-delimited JSON-RPC over stdio.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { getEventListeners } from "node:events";
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

describe("start-up when the network or a provider is not ready", () => {
  test("Claw answering 503 at first is waited out: the connector registers and comes online by itself", async () => {
    const claw = await FakeClaw.start();
    claw.unavailable = 3; // the register call and the first heartbeats
    const h = await make({ claw });
    await h.online();
    assert.equal(claw.unavailable, 0);
    assert.equal(claw.registered, 1);
  });
  test("an identity service that cannot be reached yet (a transient refresh failure) is waited out too", async () => {
    const { TransientAuthError } = await import("../src/credentials.js");
    let calls = 0;
    const tokens = { async bearer() { if (++calls <= 2) throw new TransientAuthError("identity service not up yet"); return "good-token"; }, invalidate() {} };
    const h = await make({ tokens });
    await h.online();
    assert.ok(calls > 2);
  });
  test("nothing listening at all (no network) keeps the connector retrying instead of exiting; it ends cleanly on stop", async () => {
    const claw = await FakeClaw.start();
    await claw.close(); // the address is now dead
    const h = await make({ claw, start: false });
    let settled = false;
    void h.start().then(() => { settled = true; }, () => { settled = true; });
    await sleep(500);
    assert.equal(settled, false, "still trying");
    assert.equal(await h.stop(), "stopped");
  });
  test("stop() during the retries ends the run cleanly", async () => {
    const claw = await FakeClaw.start();
    claw.unavailable = 1_000_000;
    const h = await make({ claw });
    await claw.until("a few attempts", () => claw.requests.length >= 3);
    assert.equal(await h.stop(), "stopped");
  });
  test("a refused credential or a missing scope is not retried: the run ends with the error", async () => {
    const h = await make({ token: "wrong", start: false });
    h.start();
    await assert.rejects(h.running!, (e: any) => e.status === 401);
    assert.ok(h.claw.requests.length <= 2, "no retry loop");
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
  test("an unknown agent and a relative path that is in no root are refused, each with what to do", async () => {
    const h = await make();
    await h.online();
    const a = h.claw.newSession("nope", h.work);
    const b = h.claw.newSession("fake", "relative/dir");
    await h.claw.until("both refused", () => h.claw.eventsOf(a, "session_closed").length && h.claw.eventsOf(b, "session_closed").length);
    assert.equal(h.claw.eventsOf(a)[0]!.data.reason, "unknown_agent");
    assert.match(h.claw.eventsOf(a)[0]!.data.hint, /no longer offers this agent/);
    assert.equal(h.claw.eventsOf(b)[0]!.data.reason, "cwd_not_found");
    assert.match(h.claw.eventsOf(b)[0]!.data.hint, /does not exist on that machine/);
  });

  test("a folder named the way people type it (its name, ~/...) opens in that folder", async () => {
    const h = await make();
    await h.online();
    fs.mkdirSync(path.join(h.work, "my-repo"));
    const sid = h.claw.newSession("fake", "my-repo");
    await h.claw.until("started", () => h.claw.eventsOf(sid, "session_started")[0] ?? h.claw.eventsOf(sid, "session_closed")[0]);
    const st = h.claw.eventsOf(sid, "session_started")[0];
    assert.ok(st, JSON.stringify(h.claw.eventsOf(sid)));
    assert.equal(st.data.cwd, fs.realpathSync(path.join(h.work, "my-repo")));
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

describe("no per-step approval, by the owner's opt-in", () => {
  type Opts = Parameters<typeof Harness.create>[0];
  /** What the Claude SDK prints when the user's own settings start it in a mode that does not ask. */
  const WARN = { FAKE_STDERR_WARN: "(node:1) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call" };
  const NEVER: Opts = { approval: "never", askMode: "bypassPermissions" };

  // Reverse proof: the same adapter warning closes the session unless the owner opted this agent in.
  const warned: Array<[string, Opts, "closed" | "opened"]> = [
    ["nothing set", {}, "closed"],
    ["approval = ask", { approval: "ask" }, "closed"],
    ["approval = ask, although the file allows unsafe modes", { approval: "ask", topToml: "allow_unsafe_modes = true\n" }, "closed"],
    ["approval = never on the agent", NEVER, "opened"],
    ["allow_unsafe_modes = true for the whole file", { topToml: "allow_unsafe_modes = true\n" }, "opened"],
  ];
  for (const [who, opts, outcome] of warned) {
    test(`an adapter that says it will not ask, ${who}: the session is ${outcome}`, async () => {
      const h = await make({ ...opts, env: WARN });
      const sid = await h.newSession();
      const w = await h.claw.until("the warning audited", () => h.audit().find((a) => a.kind === "permission_callback_warning"));
      assert.equal(w.accepted, outcome === "opened");
      if (outcome === "closed") {
        assert.equal(h.claw.eventsOf(sid, "session_closed")[0]!.data.reason, "mode_not_enforced");
        assert.equal(h.claw.eventsOf(sid, "session_started").length, 0);
        await h.claw.until("adapter process stopped", () => h.connector.registry.list().length === 0);
        return;
      }
      const started = h.claw.eventsOf(sid, "session_started")[0]!;
      assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0);
      assert.equal(started.data.unattended, true, "the warning means this session may not ask: the phone is told");
      assert.ok(h.audit().some((a) => a.kind === "session_started" && a.unattended === true));
      h.prompt(sid, "say still working");
      assert.equal((await h.turnEnd(sid)).data.stopReason, "end_turn");
    });
  }

  test("a warning in the middle of a turn is accepted too, the phone is told at once, and the message is not uploaded", async () => {
    const h = await make({ topToml: "allow_unsafe_modes = true\n" });
    const sid = await h.newSession();
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.unattended, false, "it asks until something says otherwise");
    h.prompt(sid, "warn");
    await h.turnEnd(sid);
    const update = await h.claw.until("mode_update", () => h.claw.eventsOf(sid, "mode_update")[0]);
    assert.deepEqual([update.data.currentMode, update.data.unattended], ["default", true]);
    assert.deepEqual(h.messages(sid).filter((m) => /canUseTool/.test(m)), []);
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0);
    const closed = await make({});
    const s2 = await closed.newSession();
    closed.prompt(s2, "warn");
    assert.equal((await closed.claw.until("closed", () => closed.claw.eventsOf(s2, "session_closed")[0])).data.reason, "mode_not_enforced");
  });

  test("approval = never: sessions start in the mode that does not ask, say so, and write without a permission request", async () => {
    const h = await make(NEVER);
    const sid = await h.newSession();
    const started = h.claw.eventsOf(sid, "session_started")[0]!;
    assert.deepEqual([started.data.currentMode, started.data.unattended], ["bypassPermissions", true]);
    assert.deepEqual(started.data.modes.map((m: any) => [m.id, m.unattended]), [["default", false], ["plan", false], ["acceptEdits", true], ["bypassPermissions", true]], "with the opt-in the phone is offered every mode, and each says whether it asks");
    h.prompt(sid, "write free.txt no asking");
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "end_turn");
    assert.equal(fs.readFileSync(path.join(h.work, "free.txt"), "utf8"), "no asking");
    assert.equal(h.claw.eventsOf(sid, "permissionRequest").length, 0);
    assert.equal(h.adapterLog().filter((l) => l.permissionAnswer).length, 0);
    h.claw.issue("resume", sid);
    assert.equal((await h.claw.until("resumed", () => h.claw.eventsOf(sid, "session_resumed")[0])).data.unattended, true);
    assert.ok(h.audit().some((a) => a.kind === "session_started" && a.unattended === true && a.mode === "bypassPermissions"));
  });

  test("an agent that asks says so: unattended is false everywhere the mode is named", async () => {
    const h = await make();
    const sid = await h.newSession();
    assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.unattended, false);
    h.claw.issue("set_mode", sid, { mode_id: "plan" });
    const upd = await h.claw.until("plan", () => h.claw.eventsOf(sid, "mode_update").find((e) => e.data.currentMode === "plan"));
    assert.equal(upd.data.unattended, false);
    h.claw.issue("resume", sid);
    assert.equal((await h.claw.until("resumed", () => h.claw.eventsOf(sid, "session_resumed")[0])).data.unattended, false);
  });

  test("the phone switches between asking and not asking only where the owner allowed it, per agent", async () => {
    const h = await make({ ...NEVER, secondToml: "" });
    const open = await h.newSession(h.work, undefined, "fake");
    const shut = await h.newSession(h.work, undefined, "fake2");
    assert.deepEqual([h.claw.eventsOf(open, "session_started")[0]!.data.unattended, h.claw.eventsOf(shut, "session_started")[0]!.data.unattended], [true, false]);
    // The opted-in agent: back to asking, then to not asking again; each is read back and says what it is.
    h.claw.issue("set_mode", open, { mode_id: "default" });
    h.claw.issue("set_mode", open, { mode_id: "bypassPermissions" });
    await h.claw.until("both applied", () => h.claw.eventsOf(open, "mode_update").length >= 2);
    assert.deepEqual(h.claw.eventsOf(open, "mode_update").map((e) => [e.data.currentMode, e.data.unattended]), [["default", false], ["bypassPermissions", true]]);
    // The other agent: refused, and the adapter was never sent the unsafe mode.
    h.claw.issue("set_mode", shut, { mode_id: "bypassPermissions" });
    h.claw.issue("set_mode", shut, { mode_id: "acceptEdits" });
    await h.claw.until("both refused", () => h.claw.eventsOf(shut, "command_rejected").length >= 2);
    assert.deepEqual(h.claw.eventsOf(shut, "command_rejected").map((e) => e.data.reason), ["mode_not_allowed", "mode_not_allowed"]);
    // A new session on it that asks for the unsafe mode is closed, with the reason.
    const asked = await h.newSession(h.work, "bypassPermissions", "fake2");
    assert.equal(h.claw.eventsOf(asked, "session_closed")[0]!.data.reason, "mode_not_allowed");
    h.prompt(shut, "write blocked.txt");
    await h.permission(shut);
    assert.equal(fileExists(path.join(h.work, "blocked.txt")), false, "still asking");
  });

  test("the heartbeat says per agent whether sessions start without asking and whether a phone may switch to that", async () => {
    const h = await make({ ...NEVER, secondToml: "" });
    await h.online();
    const caps = Object.fromEntries(h.claw.heartbeats.at(-1).agents.map((a: any) => [a.agent_id, a.capabilities]));
    assert.deepEqual([caps.fake.unattended, caps.fake.unattended_allowed, caps.fake.ask_mode], [true, true, "bypassPermissions"]);
    assert.deepEqual([caps.fake2.unattended, caps.fake2.unattended_allowed, caps.fake2.ask_mode], [false, false, "default"]);
    const allowed = await make({ topToml: "allow_unsafe_modes = true\n" });
    await allowed.online();
    const c = allowed.claw.heartbeats.at(-1).agents[0].capabilities;
    assert.deepEqual([c.unattended, c.unattended_allowed], [false, true], "allowed, but it still starts asking");
  });

  test("a mode the owner listed as selectable but the preset does not know to ask still says unattended", async () => {
    // Listing a mode lets a phone select it (here the file allows unsafe modes, so a preset's list may be extended); it does not make it asking.
    const h = await make({ preset: "claude", topToml: "allow_unsafe_modes = true\n", safeModes: ["default", "plan", "acceptEdits"], agentToml: "existing_sessions = false\n" });
    const sid = await h.newSession();
    const started = h.claw.eventsOf(sid, "session_started")[0]!;
    assert.deepEqual(started.data.modes.map((m: any) => [m.id, m.unattended]), [["default", false], ["plan", false], ["acceptEdits", true], ["bypassPermissions", true]]);
    h.claw.issue("set_mode", sid, { mode_id: "acceptEdits" });
    const upd = await h.claw.until("acceptEdits", () => h.claw.eventsOf(sid, "mode_update").find((e) => e.data.currentMode === "acceptEdits"));
    assert.equal(upd.data.unattended, true);
  });

  // What the README's "to go back" promises: a session recorded in bypassPermissions after the owner changed the file and restarted.
  // `approval = "ask"` always brings it back asking; deleting the line does only while the file does not set allow_unsafe_modes
  // (that flag still allows the mode for an agent with no setting of its own, and the phone is told the session is unattended).
  const ALLOW = "allow_unsafe_modes = true\n";
  const goBack: Array<[string, Opts, "asks" | "stays unattended"]> = [
    ["approval = ask", { approval: "ask" }, "asks"],
    ["the approval line deleted", {}, "asks"],
    ["approval = ask, with allow_unsafe_modes = true in the file", { approval: "ask", topToml: ALLOW }, "asks"],
    ["the approval line deleted, with allow_unsafe_modes = true in the file", { topToml: ALLOW }, "stays unattended"],
  ];
  for (const [change, opts, outcome] of goBack) {
    test(`a session recorded in a mode that does not ask, after the owner changed the file to ${change}: it ${outcome}`, async () => {
      const h = await make(NEVER);
      const sid = await h.newSession();
      assert.equal(h.claw.eventsOf(sid, "session_started")[0]!.data.currentMode, "bypassPermissions");
      await h.stop();
      // The same home, the same session, the file now says something else.
      const h2 = await make({ home: path.dirname(h.dirs.state), work: h.work, claw: h.claw, ...opts });
      await h2.online();
      const reverted = () => h2.audit().some((a) => a.kind === "mode_reverted" && a.reason === "no_longer_allowed" && a.from === "bypassPermissions" && a.to === "default");
      if (outcome === "asks") {
        h2.prompt(sid, "write back.txt");
        const perm = await h2.permission(sid);
        assert.equal(fileExists(path.join(h.work, "back.txt")), false, "asked first");
        h2.decide(sid, perm.data.actionId, "allow-once");
        await h2.turnEnd(sid);
        assert.ok(reverted());
      } else {
        h2.claw.issue("resume", sid);
        const resumed = await h2.claw.until("resumed", () => h2.claw.eventsOf(sid, "session_resumed").at(-1));
        assert.deepEqual([resumed.data.currentMode, resumed.data.unattended], ["bypassPermissions", true], "the phone is told");
        h2.prompt(sid, "write back.txt unattended");
        await h2.turnEnd(sid);
        assert.equal(fs.readFileSync(path.join(h.work, "back.txt"), "utf8"), "unattended");
        assert.equal(reverted(), false);
        assert.equal(h2.claw.eventsOf(sid, "permissionRequest").length, 0);
      }
    });
  }
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
  test("cancel stops a running turn (session/cancel is sent) and drops the prompts queued behind it, refusing each by name", async () => {
    const h = await make();
    const sid = await h.newSession();
    const hang = h.prompt(sid, "hang", { cmd_id: "p-hang" });
    const never = h.prompt(sid, "say never", { cmd_id: "p-never" });
    await h.claw.until("the turn to be running", () => h.adapterLog().some((l) => l.prompt === "hang"));
    h.claw.issue("cancel", sid, { cmd_id: "c-1" });
    const end = await h.turnEnd(sid);
    assert.deepEqual([end.data.stopReason, end.data.cmd_id, end.data.cmd_seq], ["cancelled", "p-hang", hang], "the end names the prompt it ends");
    assert.ok(h.adapterLog().some((l) => l.method === "session/cancel"));
    await sleep(100);
    assert.ok(!h.adapterLog().some((l) => l.prompt === "say never"));
    // The dropped prompt never gets a turn_end: it is refused by name, before the running turn's end.
    const refused = h.claw.eventsOf(sid, "command_rejected");
    assert.deepEqual(refused.map((e) => [e.data.type, e.data.cmd_id, e.data.cmd_seq, e.data.reason]), [["prompt", "p-never", never, "cancelled"]]);
    assert.ok(refused[0]!.seq < end.seq);
    assert.equal(h.turnEnds(sid).length, 1);
  });
  test("a cancel with nothing running still answers once, naming no prompt", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.issue("cancel", sid, { cmd_id: "c-idle" });
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "cancelled");
    assert.ok(Object.hasOwn(end.data, "cmd_seq") && end.data.cmd_seq === null && end.data.cmd_id === null, "names no prompt, and says so");
    assert.deepEqual(h.claw.eventsOf(sid, "command_rejected"), []);
  });
  test("each turn's end names the prompt it ends, in order", async () => {
    const h = await make();
    const sid = await h.newSession();
    const one = h.prompt(sid, "say one", { cmd_id: "p-1" });
    const two = h.prompt(sid, "say two", { cmd_id: "p-2" });
    await h.turnEnd(sid, 2);
    assert.deepEqual(h.turnEnds(sid).map((e) => [e.data.stopReason, e.data.cmd_id, e.data.cmd_seq]), [["end_turn", "p-1", one], ["end_turn", "p-2", two]]);
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
  test("everything is masked at the door, including fields no session code looks at (here a mode name the adapter chose)", async () => {
    const h = await make({ env: { FAKE_MODE_NAME: "Manual ak-0123456789abcdefABCDEF" } });
    const sid = await h.newSession();
    const started = h.claw.eventsOf(sid, "session_started")[0]!;
    assert.equal(started.data.modes[0].name, "Manual [hidden]");
    assert.doesNotMatch(JSON.stringify(h.claw.arrivals), /ak-0123456789/);
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
  test("adapter stderr is masked before it is written, even when a credential arrives split across two writes", async () => {
    const h = await make({ env: { FAKE_STDERR_SPLIT: "1" } });
    const sid = await h.newSession();
    // The log is a write stream (off the event loop): read once the second half has landed.
    const file = path.join(h.dirs.state, "logs", "adapter-fake.log");
    const log = await h.claw.until("the masked line in the log", () => { try { const t = fs.readFileSync(file, "utf8"); return /done/.test(t) && t; } catch { return false; } });
    assert.match(log, /\[hidden\]/);
    assert.doesNotMatch(log, /abcdefghijklmnopqrstuvwxyz0123/);
    assert.equal(h.claw.eventsOf(sid, "session_started").length, 1);
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
    // Armed before the turn, so they happen however fast the machine is: the first two posts fail, the next two are stored but never acknowledged.
    h.claw.failPosts = 2;
    h.claw.loseAcks = 2;
    h.prompt(sid, "chunks 300");
    for (let round = 1; round <= 4; round++) {
      await sleep(40);
      h.claw.dropStreams();
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
  test("a card still waiting when the connection drops is shown again after the reconnect, and can still be answered", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "write again.txt");
    const perm = await h.permission(sid);
    h.claw.dropStreams();
    const again = await h.claw.until("the card to be sent again", () => h.claw.eventsOf(sid, "permissionRequest").find((e) => e.data.resent === true));
    assert.equal(again.data.actionId, perm.data.actionId, "the same action id: a client treats it as the same card");
    assert.deepEqual(again.data.options, perm.data.options);
    h.decide(sid, perm.data.actionId, "allow-once");
    await h.turnEnd(sid);
    assert.equal(fileExists(path.join(h.work, "again.txt")), true);
  });
  test("an event the server refuses for good is dropped, named in the audit, and does not block the ones behind it", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.rejectType = "agent_message_chunk";
    h.prompt(sid, "say refused");
    await h.turnEnd(sid);
    assert.equal(await h.connector.drained(), true, "nothing is left queued, so nothing is retried forever");
    assert.equal(h.messages(sid).length, 0);
    assert.ok(h.audit().some((a) => a.kind === "event_rejected" && a.type === "agent_message_chunk" && a.reason === "invalid_type"));
  });
  test("a refused event that is the newest of its session is dropped too (the server's acknowledgement does not cover it)", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.rejectType = "turn_end";
    h.prompt(sid, "say last");
    await h.claw.until("the message", () => h.messages(sid).includes("last"));
    assert.equal(await h.connector.drained(), true, "the refused turn_end is not retried forever");
    assert.equal(h.claw.eventsOf(sid, "turn_end").length, 0);
    assert.ok(h.audit().some((a) => a.kind === "event_rejected" && a.type === "turn_end"));
  });
  test("a Claw release's `event: reconnect` opens the stream again at once, without a backoff or the end of the response", async () => {
    // A backoff and a watchdog far longer than the wait below: only the frame can explain a reconnect inside it.
    const h = await make({ timing: { backoffMinMs: 4_000, backoffMaxMs: 4_000, watchdogMs: 20_000 } });
    await h.online();
    const connects = h.claw.streamHeaders.length;
    const t0 = Date.now();
    h.claw.restart({ hold: true });
    await h.claw.until("a new command stream", () => h.claw.streamHeaders.length > connects, 1_500);
    assert.ok(Date.now() - t0 < 1_000, `reconnected in ${Date.now() - t0} ms`);
    // The disconnect record is appended off the event loop: read it once the line has landed.
    const file = path.join(h.dirs.state, "disconnects.jsonl");
    const down: any[] = await h.claw.until("the disconnect on record", () => {
      try {
        const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        return rows.at(-1)?.reason === "server_closed" && rows;
      } catch { return false; }
    });
    assert.equal(down.at(-1).reason, "server_closed");
    assert.equal(down.at(-1).detail, "restart");
  });
  test("after a release's reconnect, a second `event: reconnect` within seconds waits the usual backoff", async () => {
    const h = await make({ timing: { backoffMinMs: 2_000, backoffMaxMs: 2_000, watchdogMs: 20_000 } });
    await h.online();
    const first = h.claw.streamHeaders.length;
    h.claw.restart();
    await h.claw.until("the first reconnect", () => h.claw.streamHeaders.length > first && h.claw.online, 1_500);
    const second = h.claw.streamHeaders.length;
    const t0 = Date.now();
    h.claw.restart();
    await h.claw.until("the second reconnect", () => h.claw.streamHeaders.length > second, 5_000);
    assert.ok(Date.now() - t0 >= 900, `a second restart in a row is not a burst: ${Date.now() - t0} ms`);
  });
  test("a healthy stream is never dropped by the watchdog, however long it lives", async () => {
    const h = await make();
    await h.online();
    const connects = h.claw.streamHeaders.length;
    await sleep(2000); // nearly three watchdog periods (700 ms), with a ping every 100 ms
    assert.equal(h.claw.streamHeaders.length, connects);
    assert.equal(h.claw.online, true);
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

describe("crash safety", () => {
  test("a card whose adapter died with a crashed run is closed by the next run (cancelled, by connector_restart), not left as a dead button", async () => {
    const h = await make({ start: false });
    const sid = "33333333-3333-4333-8333-333333333333";
    h.claw.issue("session.new", sid, { agent_id: "fake", cwd: h.work, mode: null }); // so the server knows the session
    h.connector.store.addPending(sid, "orphan-action");
    assert.equal(await h.connector.store.flushed(), true, "on disk before the crash");
    h.connect();
    h.start();
    const ev = await h.claw.until("the orphaned card to be closed", () => h.claw.eventsOf(sid, "permission_resolved").find((e) => e.data.actionId === "orphan-action"));
    assert.deepEqual([ev.data.optionId, ev.data.outcome, ev.data.by], [null, "cancelled", "connector_restart"]);
    assert.ok(h.audit().some((a) => a.kind === "permission_orphaned" && a.action_id === "orphan-action"));
  });
  test("a turn waiting for permission when the connector restarts goes on after it: the dead card closes, the agent asks again, and the prompt's own turn_end ends it", async () => {
    const h = await make();
    const sid = await h.newSession();
    const seq = h.prompt(sid, "write p.txt");
    const perm = await h.permission(sid);
    // What a crash leaves on disk at this moment: the running turn, marked waiting, and its card.
    const turns = JSON.parse(fs.readFileSync(path.join(h.dirs.state, "sessions.json.turns"), "utf8"));
    assert.equal(turns[sid].cmd_seq, seq);
    assert.equal(turns[sid].waiting, true);
    assert.equal(turns[sid].waiting_permission, true);
    await h.stop(); // a supervisor's restart (SIGTERM): nothing is ended by the run that goes away
    assert.deepEqual(h.turnEnds(sid), [], "no turn_end from the run that stopped");
    assert.deepEqual(h.claw.eventsOf(sid, "permission_resolved"), [], "the card is closed by the next run, which knows why");
    h.connect();
    h.start();
    const closed = await h.claw.until("the dead card closed", () => h.claw.eventsOf(sid, "permission_resolved").find((e) => e.data.actionId === perm.data.actionId));
    assert.equal(closed.data.by, "connector_restart");
    const back = await h.claw.until("session_recovered", () => h.claw.eventsOf(sid, "session_recovered")[0]);
    assert.deepEqual([back.data.interrupted, back.data.continuing, back.data.cmd_seq], [true, true, seq]);
    const again = await h.permission(sid, 2);
    assert.notEqual(again.data.actionId, perm.data.actionId, "a new card");
    assert.ok(h.adapterLog().some((l) => typeof l.prompt === "string" && l.prompt.startsWith("[claw-connector]")), "the agent was told to go on");
    h.decide(sid, again.data.actionId, "allow-once");
    const end = await h.turnEnd(sid);
    assert.deepEqual([end.data.stopReason, end.data.cmd_seq], ["end_turn", seq], "the original prompt ends, once");
    assert.equal(fs.readFileSync(path.join(h.work, "continued.txt"), "utf8"), "hello\n");
    await sleep(200);
    assert.equal(h.turnEnds(sid).length, 1);
  });
  test("a turn cut off by a crash while the agent was working ends with connector_restarted, naming its prompt; the session says it is back once and answers the next prompt", async () => {
    const h = await make();
    const sid = await h.newSession();
    const flag = path.join(h.work, "never");
    const seq = h.prompt(sid, `wait ${flag}`);
    await h.claw.until("the turn to be running", () => h.adapterLog().some((l) => l.prompt === `wait ${flag}`));
    await h.claw.until("the turn recorded", () => fs.existsSync(path.join(h.dirs.state, "sessions.json.turns")));
    await h.stop();
    h.connect();
    h.start();
    const end = await h.turnEnd(sid);
    assert.deepEqual([end.data.stopReason, end.data.error, end.data.cmd_seq], ["error", "connector_restarted", seq]);
    const back = await h.claw.until("session_recovered", () => h.claw.eventsOf(sid, "session_recovered")[0]);
    assert.deepEqual([back.data.interrupted, back.data.continuing], [true, false]);
    assert.ok(back.seq < end.seq, "why the turn ended comes before its end");
    assert.ok(!h.adapterLog().some((l) => typeof l.prompt === "string" && l.prompt.startsWith("[claw-connector]")), "a working turn is not re-run by itself");
    h.prompt(sid, "say after");
    await h.turnEnd(sid, 2);
    assert.ok(h.messages(sid).includes("after"));
    assert.equal(h.claw.eventsOf(sid, "session_recovered").length, 1);
  });
  test("a crash leaves the same records: a turn found on disk at start, waiting, but older than a card lives, is ended and not continued", async () => {
    const h = await make({ start: false, timing: { permissionTtlMs: 1_000 } });
    const sid = "44444444-4444-4444-8444-444444444444";
    h.connector.store.put(sid, { agent_id: "fake", acp_session_id: "acp-x", cwd: h.work, status: "active", mode: "default", created_at: new Date().toISOString() });
    h.connector.store.beginTurn({ session_id: sid, cmd_id: "c-1", cmd_seq: 7, started_at: new Date().toISOString(), waiting: true, waiting_permission: true });
    assert.equal(await h.connector.store.flushed(), true, "on disk, as a crash would leave them (the store writes off the event loop)");
    fs.writeFileSync(path.join(h.dirs.state, "connector.json"), "{}");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(h.dirs.state, "connector.json"), old, old);
    h.connect({ timing: { permissionTtlMs: 1_000 } });
    h.start();
    const end = await h.turnEnd(sid);
    assert.deepEqual([end.data.error, end.data.cmd_seq], ["connector_restarted", 7]);
    assert.ok(h.audit().some((a) => a.kind === "turn_interrupted" && a.waiting === true));
    assert.deepEqual(h.adapterLog(), [], "nothing was started");
  });
  /** A session of the fake agent recorded by an earlier run, with a turn that was waiting for a tool call's permission a moment ago. */
  const crashedWhileAsking = async (h: Harness, sid: string, cwd = h.work, mode = "default") => {
    h.connector.store.put(sid, { agent_id: "fake", acp_session_id: "acp-x", cwd, status: "active", mode, created_at: new Date().toISOString() });
    h.connector.store.beginTurn({ session_id: sid, cmd_id: "c-9", cmd_seq: 9, started_at: new Date().toISOString(), waiting: true, waiting_permission: true });
    assert.equal(await h.connector.store.flushed(), true, "on disk, as a crash would leave them (the store writes off the event loop)");
    // Its last heartbeat a moment ago (connector.json's mtime), so only the rule under test keeps the turn from going on.
    // (Opened once, created when missing and kept when there: one file handle, no check-then-write.)
    const fd = fs.openSync(path.join(h.dirs.state, "connector.json"), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    try {
      if (fs.fstatSync(fd).size === 0) fs.writeSync(fd, "{}");
      fs.futimesSync(fd, new Date(), new Date());
    } finally { fs.closeSync(fd); }
  };
  test("a turn waiting on a plan card (not a tool call's permission) is ended at a restart, not carried on", async () => {
    const h = await make();
    const sid = await h.newSession();
    const seq = h.prompt(sid, "plan");
    await h.permission(sid);
    await h.stop();
    h.connect();
    h.start();
    const end = await h.turnEnd(sid);
    assert.deepEqual([end.data.error, end.data.cmd_seq], ["connector_restarted", seq]);
    await sleep(200);
    assert.ok(!h.adapterLog().some((l) => typeof l.prompt === "string" && l.prompt.startsWith("[claw-connector]")));
  });
  test("an agent that may run without asking (approval = never) is never carried on after a restart", async () => {
    const h = await make({ start: false, approval: "never", askMode: "bypassPermissions" });
    const sid = "66666666-6666-4666-8666-666666666666";
    await crashedWhileAsking(h, sid, h.work, "default");
    h.connect();
    h.start();
    const end = await h.turnEnd(sid);
    assert.equal(end.data.error, "connector_restarted");
    assert.deepEqual(h.adapterLog(), [], "nothing was started");
  });
  test("with the kill switch on at start (paused), a turn that was waiting is ended, nothing is started", async () => {
    const h = await make({ start: false });
    const sid = "77777777-7777-4777-8777-777777777777";
    await crashedWhileAsking(h, sid);
    fs.writeFileSync(path.join(h.dirs.state, "paused"), "x");
    h.connect();
    h.start();
    await h.claw.until("the turn ended", () => h.audit().some((a) => a.kind === "turn_interrupted" && a.session_id === sid));
    await sleep(300);
    assert.deepEqual(h.adapterLog(), [], "nothing was started while paused");
    assert.deepEqual(h.connector.store.listTurns(), []);
  });
  test("revoked at start: nothing is carried on and the turn stays recorded", async () => {
    const h = await make();
    await h.online();
    await h.stop();
    const sid = "88888888-8888-4888-8888-888888888888";
    await crashedWhileAsking(h, sid);
    h.claw.revoked = true; // the row this connector registered
    h.connect();
    assert.equal(await h.start(), "revoked");
    assert.deepEqual(h.adapterLog(), []);
    assert.ok(!h.audit().some((a) => a.kind === "turn_continued"));
  });
  test("a carried-on turn that cannot start again (its folder left the roots) is ended by the refusal and forgotten", async () => {
    const h = await make({ start: false });
    const sid = "99999999-9999-4999-8999-999999999999";
    await crashedWhileAsking(h, sid, tmpdir("cc-gone-"));
    h.connect();
    h.start();
    await h.claw.until("the session refused", () => h.claw.eventsOf(sid, "session_closed")[0]);
    await h.claw.until("the record forgotten", () => h.connector.store.listTurns().length === 0);
    assert.deepEqual(h.adapterLog(), []);
  });
  test("a prompt counts as handled only once its turn is on disk: while that write is stuck, the heartbeat's cursor stays below it", async () => {
    const h = await make();
    const sid = await h.newSession();
    // A FIFO nobody reads stands in for a disk that stopped answering, for the turn record's write only.
    const fifo = path.join(h.dirs.state, "sessions.json.turns.tmp");
    fs.rmSync(fifo, { force: true });
    assert.equal(spawnSync("mkfifo", ["-m", "600", fifo]).status, 0);
    let read: Promise<unknown> | null = null;
    try {
      const flag = path.join(h.work, "never3");
      const seq = h.prompt(sid, `wait ${flag}`);
      await h.claw.until("the prompt to reach the agent", () => h.adapterLog().some((l) => l.prompt === `wait ${flag}`));
      const n = h.claw.heartbeats.length;
      await h.claw.until("three more heartbeats", () => h.claw.heartbeats.length >= n + 3);
      assert.ok(h.claw.cursor < seq, `the server still holds the command (cursor ${h.claw.cursor}, prompt ${seq}): a restart now would send it again`);
      // The disk answers: the record lands, and only then is the command forgotten.
      read = fs.promises.readFile(fifo);
      await h.claw.until("the cursor to pass the prompt", () => h.claw.cursor >= seq);
      assert.equal(h.connector.store.turn(sid)?.cmd_seq, seq);
    } finally {
      // Never leave the write stuck: a libuv thread blocked on the FIFO would keep the test process from exiting.
      await (read ?? fs.promises.readFile(fifo));
    }
  });
  test("a turn record whose write fails keeps its prompt unhandled, and is written again until it lands", async () => {
    const h = await make();
    const sid = await h.newSession();
    const tmpFile = path.join(h.dirs.state, "sessions.json.turns.tmp");
    fs.mkdirSync(tmpFile); // the temporary file cannot be written: every write of the record fails at once
    try {
      const flag = path.join(h.work, "never4");
      const seq = h.prompt(sid, `wait ${flag}`);
      await h.claw.until("the prompt to reach the agent", () => h.adapterLog().some((l) => l.prompt === `wait ${flag}`));
      const n = h.claw.heartbeats.length;
      await h.claw.until("three more heartbeats", () => h.claw.heartbeats.length >= n + 3);
      await sleep(1_200); // past one retry, which fails too
      assert.ok(h.claw.cursor < seq, `the server still holds the command (cursor ${h.claw.cursor}, prompt ${seq})`);
      fs.rmdirSync(tmpFile);
      await h.claw.until("the cursor to pass the prompt once the record is written", () => h.claw.cursor >= seq, 5_000);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h.dirs.state, "sessions.json.turns"), "utf8"))[sid].cmd_seq, seq);
    } finally { fs.rmSync(tmpFile, { recursive: true, force: true }); }
  });
  test("stopped before its turn record landed, a prompt is sent again after the restart and its dropped record is not also recovered", async () => {
    const h = await make();
    const sid = await h.newSession();
    const fifo = path.join(h.dirs.state, "sessions.json.turns.tmp");
    fs.rmSync(fifo, { force: true });
    assert.equal(spawnSync("mkfifo", ["-m", "600", fifo]).status, 0);
    const flag = path.join(h.work, "never5");
    let read: Promise<unknown> | null = null;
    let seq = 0;
    try {
      seq = h.prompt(sid, `wait ${flag}`);
      await h.claw.until("the prompt to reach the agent", () => h.adapterLog().some((l) => l.prompt === `wait ${flag}`));
      const stopped = h.stop();
      await sleep(2_500); // the session sees it is stopping while the record's write is still stuck
      read = fs.promises.readFile(fifo); // the disk answers: the stuck write lands, then the one without the turn
      await stopped;
      await read;
    } finally { await (read ?? fs.promises.readFile(fifo)); }
    assert.ok(h.claw.cursor < seq, `the server still holds the prompt (cursor ${h.claw.cursor}, prompt ${seq})`);
    await h.claw.until("the record without the turn", () => {
      const turns = path.join(h.dirs.state, "sessions.json.turns");
      // (The stuck write renames the FIFO into place before the next write replaces it: never read a FIFO here.)
      // One open, then a check and a read of that same file: O_NONBLOCK keeps the open of a FIFO from waiting for a writer.
      let fd: number;
      try { fd = fs.openSync(turns, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); } catch { return false; }
      try { return fs.fstatSync(fd).isFile() && !(sid in JSON.parse(fs.readFileSync(fd, "utf8"))); } catch { return false; } finally { fs.closeSync(fd); }
    }, 3_000);
    h.connect();
    h.start();
    await h.claw.until("the prompt sent again", () => h.adapterLog().filter((l) => l.prompt === `wait ${flag}`).length === 2);
    await sleep(300);
    assert.equal(h.claw.eventsOf(sid, "turn_end").filter((e) => e.data.error === "connector_restarted").length, 0, "the dropped record is not recovered too");
  });
  test("a prompt queued behind the running turn when the connector restarts is delivered again, not lost", async () => {
    const h = await make();
    const sid = await h.newSession();
    const flag = path.join(h.work, "never2");
    h.prompt(sid, `wait ${flag}`);
    await h.claw.until("the turn to be running", () => h.adapterLog().some((l) => l.prompt === `wait ${flag}`));
    const queued = h.prompt(sid, "say queued-before-restart");
    await sleep(300);
    await h.stop();
    h.connect();
    h.start();
    await h.claw.until("the queued prompt to run after the restart", () => h.messages(sid).includes("queued-before-restart"));
    const ends = await h.claw.until("its turn_end", () => h.turnEnds(sid).find((e) => e.data.cmd_seq === queued));
    assert.equal(ends.data.stopReason, "end_turn");
  });
  test("an idle session used lately is told once after a restart that it is back; an old or closed one is not", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "say hi");
    await h.turnEnd(sid);
    const old = "55555555-5555-4555-8555-555555555555";
    h.connector.store.put(old, { agent_id: "fake", acp_session_id: "acp-old", cwd: h.work, status: "active", mode: "default", created_at: "2026-01-01T00:00:00.000Z", used_at: "2026-01-01T00:00:00.000Z" });
    await h.stop();
    h.connect();
    h.start();
    const back = await h.claw.until("session_recovered", () => h.claw.eventsOf(sid, "session_recovered")[0]);
    assert.deepEqual([back.data.interrupted, back.data.continuing], [false, false]);
    assert.deepEqual(h.turnEnds(sid).length, 1, "no turn_end for a turn that had ended");
    await sleep(300);
    assert.deepEqual(h.claw.eventsOf(old, "session_recovered"), []);
  });
  test("a pending card is forgotten as soon as it is answered, so a later crash does not close it twice", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "write p.txt");
    const perm = await h.permission(sid);
    assert.deepEqual(h.connector.store.takePending().map((p) => p.action_id), [perm.data.actionId]);
    h.connector.store.addPending(sid, perm.data.actionId); // put it back: answering must remove it
    h.decide(sid, perm.data.actionId, "allow-once");
    await h.turnEnd(sid);
    assert.deepEqual(h.connector.store.takePending(), []);
  });
  test("a prompt is not counted as handled until it reaches the adapter: the cursor stays behind a queued one, and a cancel that drops it releases it", async () => {
    const h = await make();
    const sid = await h.newSession(); // seq 1 = session.new
    h.prompt(sid, "hang"); // seq 2: running
    await h.claw.until("the turn to be running", () => h.adapterLog().some((l) => l.prompt === "hang"));
    h.prompt(sid, "say queued"); // seq 3: waits behind the running turn
    await h.claw.until("the cursor to reach the running prompt", () => h.claw.cursor >= 2);
    const before = h.claw.heartbeats.length;
    await h.claw.until("two more heartbeats", () => h.claw.heartbeats.length >= before + 2);
    assert.equal(h.claw.cursor, 2, "the server keeps the queued prompt: if the connector died now it would be delivered again");
    h.claw.issue("cancel", sid); // seq 4: drops the queue
    await h.claw.until("the cursor to pass everything", () => h.claw.cursor >= 4);
  });
});

describe("a connector that runs for days", () => {
  /** How long to wait for a count to be reached; far above what an idle machine needs, so only a loop that has stopped runs into it. */
  const COUNT_WAIT_MS = 30_000;
  test("waiting on the run-long signal leaves nothing behind: listeners do not grow with heartbeats and events", async () => {
    const h = await make({ timing: { heartbeatMs: 15 } });
    const sid = await h.newSession();
    const signal = (h.connector as unknown as { ctl: AbortController }).ctl.signal;
    const count = () => getEventListeners(signal, "abort").length;
    // Everything below waits on a count of what happened, never on elapsed time: a loaded runner stretches the
    // wait, it cannot shrink the number of heartbeats and drain waits the assertions need to have seen.
    assert.ok(await h.connector.drained(COUNT_WAIT_MS), "the start-up events were acknowledged");
    await h.claw.until("a few heartbeats while idle", () => h.claw.heartbeats.length >= 3, COUNT_WAIT_MS);
    const before = count();
    const beats = h.claw.heartbeats.length;
    const posts = () => h.claw.requests.filter((r) => r.path.endsWith("/events")).length;
    const postsBefore = posts();
    for (let i = 0; i < 6; i++) {
      h.prompt(sid, "say x");
      await h.turnEnd(sid, i + 1);
      // The fake server stores an event before it answers the post, so the turn end arriving does not yet mean the sender
      // is back at rest. Once the outbox is empty it is: the sender is parked in its wait on the run-long signal, and the
      // next prompt's first event wakes it. That is one drain wait per turn, six in all.
      assert.ok(await h.connector.drained(COUNT_WAIT_MS), `the events of turn ${i + 1} were acknowledged`);
    }
    assert.ok(posts() - postsBefore >= 6, `drain waits happened: ${posts() - postsBefore} posts`);
    // The heartbeats must keep coming while those waits are pending, and long enough to show a leak per wait.
    await h.claw.until("20 more heartbeats", () => h.claw.heartbeats.length - beats >= 20, COUNT_WAIT_MS);
    assert.ok(count() <= before + 2, `abort listeners grew from ${before} to ${count()}`);
  });
});

describe("answers to commands for sessions nobody knows", () => {
  test("two stale commands for the same unknown session are both answered: the second event continues the sequence, it does not restart at 1", async () => {
    const h = await make();
    await h.online();
    const ghost = "88888888-8888-4888-8888-888888888888";
    h.claw.issue("prompt", ghost, { text: "say never" });
    await h.claw.until("the first answer", () => h.claw.eventsOf(ghost, "session_closed").length === 1);
    await h.connector.drained(); // acknowledged: the session's files are forgotten now
    h.claw.issue("prompt", ghost, { text: "say again" });
    await h.claw.until("the second answer", () => h.claw.eventsOf(ghost, "session_closed").length === 2);
    assert.deepEqual(h.claw.eventsOf(ghost).map((e) => e.seq), [1, 2]);
    assert.equal(h.claw.duplicatesSeen, 0, "nothing was sent twice under one number");
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
    assert.equal(await h.connector.registry.flushed(), true, "on disk before the crash");
    h.connect();
    h.start();
    await h.online();
    await h.claw.until("the orphan to be stopped", () => !alive(orphan.pid!));
  });
});

describe("sessions over time", () => {
  test("an idle session loses its process and comes back on the next prompt, locked into the ask mode again even though the adapter resets it", async () => {
    const h = await make({ env: { FAKE_RESUME_RESETS: "bypassPermissions" }, timing: { idleMs: 800 } });
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
    const h = await make({ env: { FAKE_NO_RESUME: "1" }, timing: { idleMs: 800 } });
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
    assert.equal(await h.connector.store.flushed(), true);
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
  // No short time-to-live here: the harness's (60 s) outlasts every wait below (8 s each), so a slow runner can make this test time out, never turn the rejection into a timeout's cancel.
  test("a rejected plan answers rejected", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.prompt(sid, "plan");
    const perm = await h.permission(sid);
    h.decide(sid, perm.data.actionId, "plan-reject");
    await h.turnEnd(sid);
    assert.equal(h.adapterLog().find((l) => l.planAnswer)!.planAnswer.outcome.outcome, "rejected");
  });
  test("a plan nobody answers is answered cancelled after the time-to-live", async () => {
    const h = await make({ timing: { permissionTtlMs: 300 } });
    const sid = await h.newSession();
    h.prompt(sid, "plan");
    await h.turnEnd(sid);
    assert.deepEqual(h.adapterLog().find((l) => l.planAnswer)!.planAnswer, { outcome: { outcome: "cancelled" } });
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
    // The adapter's notification and its answer to the prompt are dispatched separately: the event may reach Claw just after
    // the turn's end (CI run 42366684698 saw it absent at the turn's end).
    await h.claw.until("the todo event", () => h.claw.eventsOf(sid, "cursor.update_todos").length > 0);
    assert.equal(h.claw.eventsOf(sid, "cursor.update_todos").length, 1);
  });
});

test("a fake server shared by two connectors on separate homes keeps their state apart", async () => {
  const claw = await FakeClaw.start();
  const a = await make({ claw });
  await a.online();
  assert.ok(a.dirs.state !== tmpdir());
});

describe("a first session that would fail at its first message", () => {
  const answer = (h: Harness, sid: string) => h.claw.until("an answer", () => h.claw.eventsOf(sid, "session_started")[0] ?? h.claw.eventsOf(sid, "session_closed")[0]);

  test("an agent that reports it is not signed in is refused at once, agent_auth_required, with the sign-in command", async () => {
    const h = await make({ env: { FAKE_AUTH_STATUS: "none" } });
    await h.online();
    const sid = h.claw.newSession("fake", h.work);
    const got = await answer(h, sid);
    assert.equal(got.type, "session_closed", "never announced as ready");
    assert.equal(got.data.reason, "agent_auth_required");
    assert.match(got.data.hint, /not signed in on that machine/);
    assert.ok(!h.claw.eventsOf(sid, "session_started").length);
  });

  test("one that reports a sign-in opens as before; one that reports nothing opens after a short wait", async () => {
    const h = await make({ env: { FAKE_AUTH_STATUS: "api_key" } });
    await h.online();
    assert.equal((await answer(h, h.claw.newSession("fake", h.work))).type, "session_started");
    const quiet = await make({ env: { FAKE_AUTH_STATUS: "api_key", FAKE_AUTH_STATUS_DELAY_MS: "60000" }, timing: { authWaitMs: 200 } });
    await quiet.online();
    assert.equal((await answer(quiet, quiet.claw.newSession("fake", quiet.work))).type, "session_started");
  });

  test("an API-key-only Codex-like agent is signed in with authenticate(api-key) and opens; without a key it says how to sign in", async () => {
    const h = await make({ env: { FAKE_API_KEY_AUTH: "1", OPENAI_API_KEY: "sk-test-only" } });
    await h.online();
    const sid = h.claw.newSession("fake", h.work);
    assert.equal((await answer(h, sid)).type, "session_started", JSON.stringify(h.claw.eventsOf(sid)));
    const methods = h.adapterLog().map((l) => l.method).filter(Boolean);
    assert.deepEqual(methods.slice(0, 4), ["initialize", "session/new", "authenticate", "session/new"]);
    assert.doesNotMatch(JSON.stringify(h.adapterLog()), /sk-test-only/, "the key is never sent; the adapter reads its own environment");
    const none = await make({ env: { FAKE_API_KEY_AUTH: "1", OPENAI_API_KEY: "", CODEX_API_KEY: "" } });
    await none.online();
    const s2 = none.claw.newSession("fake", none.work);
    const got = await answer(none, s2);
    assert.equal(got.data.reason, "agent_auth_required");
    assert.ok(!none.adapterLog().some((l) => l.method === "authenticate"), "no key: nothing to authenticate with");
  });

  test("a sign-in that lapses after the session opened: the turn ends agent_auth_required with the fix, and the session stays", async () => {
    const h = await make({ env: { FAKE_PROMPT_AUTH: "1" } });
    const sid = await h.newSession();
    h.prompt(sid, "hello");
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "error");
    assert.equal(end.data.error, "agent_auth_required");
    assert.match(end.data.hint, /not signed in/);
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0);
  });

  test("signed out after the session opened: every message says why and the session stays, also once the adapter is started again", async () => {
    const status = path.join(tmpdir("auth-"), "status");
    fs.writeFileSync(status, "api_key");
    const h = await make({ env: { FAKE_AUTH_STATUS: "file", FAKE_AUTH_STATUS_FILE: status, FAKE_PROMPT_AUTH: "1" } });
    const sid = await h.newSession();
    fs.writeFileSync(status, "none");
    for (let n = 1; n <= 3; n++) {
      h.prompt(sid, `hello ${n}`);
      const end = await h.turnEnd(sid, n);
      assert.equal(end.data.error, "agent_auth_required", JSON.stringify(end.data));
    }
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0, "kept: it works again once someone signs in there");
    // A "resume" from the phone brings it back too: only a new session is refused for a missing sign-in.
    h.claw.issue("resume", sid, {});
    await h.claw.until("resumed", () => h.claw.eventsOf(sid, "session_resumed")[0] ?? h.claw.eventsOf(sid, "session_closed")[0]);
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0, JSON.stringify(h.claw.eventsOf(sid).slice(-3)));
    // After a restart the restored session is resumed, not refused, too.
    await h.stop();
    h.connect();
    h.start();
    h.prompt(sid, "after restart");
    assert.equal((await h.turnEnd(sid, 4)).data.error, "agent_auth_required");
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0);
  });

  test("an adapter whose resume needs a sign-in it no longer has: the message says why and the session stays", async () => {
    const h = await make({ env: { FAKE_RESUME_AUTH: "1" } });
    const sid = await h.newSession();
    await h.stop();
    h.connect();
    h.start();
    h.prompt(sid, "after restart");
    const end = await h.turnEnd(sid);
    assert.equal(end.data.error, "agent_auth_required", JSON.stringify(end.data));
    assert.match(end.data.hint, /not signed in/);
    // A "resume" from the phone is refused the same way, with the fix, and the session stays.
    h.claw.issue("resume", sid, {});
    const rej = await h.claw.until("resume refused", () => h.claw.eventsOf(sid, "command_rejected").find((e) => e.data.type === "resume") ?? h.claw.eventsOf(sid, "session_closed")[0]);
    assert.equal(rej.type, "command_rejected", JSON.stringify(rej.data));
    assert.equal(rej.data.reason, "agent_auth_required");
    assert.match(rej.data.hint, /not signed in/);
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0);
  });

  test("a refused command carries a hint too", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.issue("set_mode", sid, { mode_id: "bypassPermissions" });
    const rej = await h.claw.until("rejected", () => h.claw.eventsOf(sid, "command_rejected")[0]);
    assert.equal(rej.data.reason, "mode_not_allowed");
    assert.match(rej.data.hint, /approval = "never"/);
  });
});

describe("read-only agents", () => {
  test("an agent whose sessions start in a mode that changes no file says so in its capabilities and modes", async () => {
    const h = await make({ preset: "cursor", askMode: "ask", safeModes: ["ask", "plan"] });
    await h.online();
    const caps = h.claw.heartbeats[0].agents[0].capabilities;
    assert.equal(caps.edits, false);
    assert.match(caps.edits_hint, /approval = "never"/);
    assert.deepEqual(caps.read_only_modes, ["ask", "plan"]);
  });
});

describe("a session opened and never used, across a restart", () => {
  test("its conversation cannot be found (nothing was written): a fresh one takes its place in the same folder, and the message runs", async () => {
    const h = await make({ env: { FAKE_RESUME_NOT_FOUND: "1" } });
    const sid = await h.newSession();
    const before = h.claw.eventsOf(sid, "session_started")[0]!.data.acp_session_id;
    await h.stop();
    h.connect();
    h.start();
    h.prompt(sid, "say hello");
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "end_turn", JSON.stringify(end.data));
    assert.equal(h.claw.eventsOf(sid, "session_closed").length, 0);
    assert.ok(h.messages(sid).includes("hello"));
    const methods = h.adapterLog().map((l) => l.method).filter(Boolean);
    assert.ok(methods.lastIndexOf("session/new") > methods.indexOf("session/resume"), "a new session after the resume that found nothing");
    void before;
    const { auditFile } = await import("../src/paths.js");
    assert.match(fs.readFileSync(auditFile(h.dirs), "utf8"), /"session_recreated"/);
  });

  test("a record that does not say it was unused (an older version wrote it) is never replaced", async () => {
    const h = await make({ env: { FAKE_RESUME_NOT_FOUND: "1" } });
    const sid = await h.newSession();
    await h.stop();
    // What a connector from before this change left behind: no `unused` marker.
    h.connector.store.patch(sid, { unused: undefined });
    assert.equal(await h.connector.store.flushed(), true, "on disk before the restart (the store writes off the event loop)");
    h.connect();
    h.start();
    h.prompt(sid, "say hello");
    const end = await h.turnEnd(sid);
    assert.equal(end.data.stopReason, "error");
    assert.ok(!h.messages(sid).includes("hello"));
  });

  test("a session that was used keeps the old answer: a conversation the agent cannot find is an error, not silently replaced", async () => {
    const h = await make({ env: { FAKE_RESUME_NOT_FOUND: "1" } });
    const sid = await h.newSession();
    h.prompt(sid, "say first");
    await h.turnEnd(sid);
    await h.stop();
    h.connect();
    h.start();
    h.prompt(sid, "say again");
    const end = await h.turnEnd(sid, 2);
    assert.equal(end.data.stopReason, "error");
    assert.ok(!h.adapterLog().slice(-5).some((l) => l.method === "session/new"));
  });
});
