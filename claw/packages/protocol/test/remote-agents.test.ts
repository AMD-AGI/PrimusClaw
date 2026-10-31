// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_AGENT_LIMITS, REMOTE_AGENT_TIMING, REMOTE_COMMANDS, REMOTE_COMMAND_TYPES,
  isRemoteCommandType, parseConnectorRegistration, parseCursor, parseEventBatch, parseHeartbeat,
  parseRemoteId, parseSessionNew, sseFrame,
} from "../src/remote-agents.js";

const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("the timings keep a stream alive through the gateway's 180 s idle cut and survive missed beats", () => {
  // Measured: the gateway closes a connection with no byte for 180 s.
  assert.ok(REMOTE_AGENT_TIMING.pingMs * 3 <= 180_000, "at least three pings fit in the idle limit");
  assert.ok(REMOTE_AGENT_TIMING.watchdogMs > REMOTE_AGENT_TIMING.pingMs, "a client does not give up between two pings");
  assert.ok(REMOTE_AGENT_TIMING.watchdogMs < 180_000, "the client reconnects before the gateway does it for it");
  assert.equal(REMOTE_AGENT_TIMING.onlineWindowMs, REMOTE_AGENT_TIMING.heartbeatMs * 3, "three missed heartbeats");
  // A command that needs a watcher outlives a dropped connection (watchdog, then a reconnect), but not a night.
  assert.ok(REMOTE_AGENT_TIMING.liveCommandTtlMs > REMOTE_AGENT_TIMING.watchdogMs + REMOTE_AGENT_TIMING.onlineWindowMs);
  assert.ok(REMOTE_AGENT_TIMING.liveCommandTtlMs <= 10 * 60_000, "minutes, not hours");
});

test("the command set is closed, and only commands that can wait may be queued offline", () => {
  assert.deepEqual([...REMOTE_COMMAND_TYPES], ["prompt", "cancel", "set_mode", "resume", "close", "decision"]);
  const needsOnline = REMOTE_COMMAND_TYPES.filter((t) => REMOTE_COMMANDS[t].needsOnline);
  assert.deepEqual(needsOnline, ["prompt", "set_mode", "resume"]);
  assert.deepEqual(REMOTE_COMMAND_TYPES.filter((t) => REMOTE_COMMANDS[t].closesSession), ["close"]);
  for (const bad of ["exec", "shell", "session.new", "", undefined, 5, "Prompt"]) assert.equal(isRemoteCommandType(bad), false, String(bad));
});

test("a prompt's audit record carries a hash and a length, never the text", () => {
  const spec = REMOTE_COMMANDS.prompt;
  const parsed = spec.parse({ text: "hello world" });
  assert.ok(parsed.ok);
  const audit = spec.audit(parsed.value);
  assert.deepEqual(Object.keys(audit).sort(), ["length", "sha256"]);
  assert.equal(audit.length, 11);
  assert.equal(audit.sha256, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
});

test("command parsers", () => {
  const table: Array<[string, Record<string, unknown>, boolean, unknown?]> = [
    ["prompt", { text: "hi" }, true, { text: "hi" }],
    ["prompt", { text: "" }, false],
    ["prompt", { text: 5 }, false],
    ["set_mode", { mode_id: "read-only" }, true, { mode_id: "read-only" }],
    ["set_mode", { mode_id: "x y" }, false],
    ["decision", { action_id: "a1", option_id: "allow_once" }, true, { action_id: "a1", option_id: "allow_once" }],
    ["decision", { actionId: "a1", optionId: "allow-once" }, true, { action_id: "a1", option_id: "allow-once" }],
    ["decision", { action_id: "a1" }, false],
    ["decision", { action_id: "a\n1", option_id: "x" }, false],
    ["cancel", { text: "ignored" }, true, {}],
    ["close", {}, true, {}],
  ];
  for (const [type, body, ok, value] of table) {
    const r = REMOTE_COMMANDS[type as keyof typeof REMOTE_COMMANDS].parse(body);
    assert.equal(r.ok, ok, `${type} ${JSON.stringify(body)}`);
    if (r.ok && value !== undefined) assert.deepEqual(r.value, value);
  }
});

test("cursor parsing: the first present candidate wins, and anything but a count is refused", () => {
  const table: Array<[unknown[], unknown]> = [
    [[], { ok: true, value: 0 }],
    [[undefined, ""], { ok: true, value: 0 }],
    [["12"], { ok: true, value: 12 }],
    [[undefined, "7"], { ok: true, value: 7 }],
    [["3", "9"], { ok: true, value: 3 }],
    [[["5"]], { ok: true, value: 5 }],
    [["-1"], { ok: false, error: "invalid_cursor" }],
    [["1.5"], { ok: false, error: "invalid_cursor" }],
    [["abc"], { ok: false, error: "invalid_cursor" }],
    [["1".repeat(16)], { ok: false, error: "invalid_cursor" }],
  ];
  for (const [args, want] of table) assert.deepEqual(parseCursor(...args), want, JSON.stringify(args));
});

test("ids and frames", () => {
  assert.equal(parseRemoteId(SID.toUpperCase()), SID);
  for (const bad of [undefined, "", "nope", SID + "0", `${SID}\n`, 5]) assert.equal(parseRemoteId(bad), null, String(bad));
  assert.equal(sseFrame("command", { a: 1 }, 7), 'id: 7\nevent: command\ndata: {"a":1}\n\n');
  assert.equal(sseFrame("ping", { t: 1 }), 'event: ping\ndata: {"t":1}\n\n');
  // Newlines in data are escaped by JSON, so a payload cannot start a new frame.
  assert.equal(sseFrame("x", { s: "a\n\nid: 9" }).split("\n\n").length, 2);
});

test("event batches: the envelope refuses the batch, an event refuses only itself", () => {
  const ok = { session_id: SID, seq: 1, type: "tool_call", ts: 1_700_000_000_000, data: { a: 1 } };
  const good = parseEventBatch({ batch_id: "b", events: [ok] });
  assert.ok(good.ok);
  assert.deepEqual(good.value.events.map((e) => e.index), [0]);
  const table: Array<[string, unknown, string]> = [
    ["seq zero", { ...ok, seq: 0 }, "invalid_seq"],
    ["seq beyond a safe integer", { ...ok, seq: 2 ** 53 }, "invalid_seq"],
    ["seq fractional", { ...ok, seq: 1.1 }, "invalid_seq"],
    ["seq a string", { ...ok, seq: "1" }, "invalid_seq"],
    ["type with a newline", { ...ok, type: "a\nb" }, "invalid_type"],
    ["type too long", { ...ok, type: "a".repeat(65) }, "invalid_type"],
    ["ts negative", { ...ok, ts: -1 }, "invalid_ts"],
    ["ts not finite", { ...ok, ts: null }, "invalid_ts"],
    ["data null", { ...ok, data: null }, "invalid_data"],
    ["data an array", { ...ok, data: [] }, "invalid_data"],
    ["data over the limit", { ...ok, data: { x: "y".repeat(REMOTE_AGENT_LIMITS.maxEventBytes) } }, "event_too_large"],
    ["session id not a uuid", { ...ok, session_id: "x" }, "invalid_session_id"],
    ["not an object", 3, "invalid_event"],
  ];
  for (const [label, event, reason] of table) {
    const r = parseEventBatch({ batch_id: "b", events: [ok, event] });
    assert.ok(r.ok, label);
    assert.deepEqual(r.value.rejected.map((x) => [x.index, x.reason]), [[1, reason]], label);
    assert.deepEqual(r.value.events.map((e) => e.index), [0], `${label}: the good one is kept`);
  }
  // Multi-byte data is counted in bytes, not characters.
  const wide = parseEventBatch({ batch_id: "b", events: [{ ...ok, data: { x: "é".repeat(REMOTE_AGENT_LIMITS.maxEventBytes / 2) } }] });
  assert.ok(wide.ok && wide.value.rejected[0]?.reason === "event_too_large");
  for (const body of [null, [], {}, { batch_id: "", events: [] }, { batch_id: "b" }, { batch_id: "b", events: new Array(201).fill(ok) }]) {
    assert.equal(parseEventBatch(body).ok, false, JSON.stringify(body)?.slice(0, 40));
  }
});

test("registration, heartbeat and session bodies", () => {
  assert.deepEqual(parseConnectorRegistration({ name: "  my laptop  ", version: "1.2.3" }), { ok: true, value: { name: "my laptop", version: "1.2.3" } });
  for (const bad of [{}, { name: "a\u0007" }, { name: "x".repeat(65) }, { name: "n", version: "v\n" }]) {
    assert.equal(parseConnectorRegistration(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseHeartbeat({ agents: [] }).ok, true);
  assert.equal(parseHeartbeat({ agents: [], cmd_cursor: 4 }).ok, true);
  assert.equal(parseHeartbeat({ agents: [], cmd_cursor: 1.5 }).ok, false);
  const base = { connector_id: SID, agent_id: "a1", cwd: "C:\\Users\\me\\repo" };
  assert.equal(parseSessionNew(base).ok, true, "any operating system's path");
  for (const bad of [{ ...base, cwd: "" }, { ...base, cwd: "x".repeat(4097) }, { ...base, agent_id: "a b" }, { ...base, connector_id: "x" }, { ...base, mode: "a b" }]) {
    assert.equal(parseSessionNew(bad).ok, false, JSON.stringify(bad).slice(0, 60));
  }
  // `resume_ref` names an existing session; Claw keeps its shape sane and never reads it.
  const refs: Array<[unknown, string | null | "invalid_resume_ref"]> = [
    [undefined, null], [null, null], ["0f8fad5b-d9cb-469f-a165-70867728950e", "0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["any opaque value", "any opaque value"], ["x".repeat(128), "x".repeat(128)],
    ["", "invalid_resume_ref"], ["x".repeat(129), "invalid_resume_ref"], ["a\nb", "invalid_resume_ref"], ["a\u0000b", "invalid_resume_ref"],
    [5, "invalid_resume_ref"], [{}, "invalid_resume_ref"], [["a"], "invalid_resume_ref"], [true, "invalid_resume_ref"],
  ];
  for (const [resume_ref, want] of refs) {
    const r = parseSessionNew({ ...base, resume_ref });
    if (want === "invalid_resume_ref") assert.deepEqual(r, { ok: false, error: want }, JSON.stringify(resume_ref)?.slice(0, 40));
    else assert.deepEqual(r.ok && r.value.resume_ref, want, JSON.stringify(resume_ref)?.slice(0, 40));
  }
});

test("a heartbeat's capabilities are carried as the connector wrote them, whatever they say about approval", () => {
  const capabilities = { ask_mode: "m", modes: ["a"], unattended: true, unattended_allowed: false, protocol: 1, nested: { x: [1, { y: null }] } };
  const parsed = parseHeartbeat({ agents: [{ agent_id: "a1", kind: "k", name: "n", capabilities }] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.agents[0]!.capabilities, capabilities);
});

test("a session event's data is carried whole, so a flag a connector adds to it reaches every client", () => {
  const data = { currentMode: "m", unattended: true, modes: [{ id: "m", unattended: true }] };
  const parsed = parseEventBatch({ batch_id: "b", events: [{ session_id: SID, seq: 1, type: "mode_update", ts: 1, data }] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.events[0]!.data, data);
  assert.deepEqual(parsed.value.rejected, []);
});
