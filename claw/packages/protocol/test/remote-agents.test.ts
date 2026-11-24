// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  PERMISSION_PARK_MAX_MS,
  REMOTE_EVENT_PERMISSION_PARKED,
  REMOTE_AGENT_LIMITS, REMOTE_AGENT_TIMING, REMOTE_COMMANDS, REMOTE_COMMAND_TYPES,
  isRemoteCommandType, parseConnectorRegistration, parseCursor, parseEventBatch, parseHeartbeat,
  parseHiddenRequest, parseRemoteId, parseSessionNew, sseFrame, REMOTE_HIDDEN_INCLUDE, REMOTE_HIDE_LIMITS,
  normalizeGitBranch, normalizeGitRemote, normalizedRemote, parseWorkspacesReport, REMOTE_WORKSPACE_LIMITS,
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
  assert.deepEqual([...REMOTE_COMMAND_TYPES], ["prompt", "cancel", "set_mode", "resume", "close", "decision", "withdraw"]);
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

test("a prompt may carry files: safe names, media types and base64 bytes, within the limits", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const ok = REMOTE_COMMANDS.prompt.parse({
    text: "look",
    files: [
      { name: "image-1.png", media_type: "image/png", data: png },
      { name: "report v2.pdf", media_type: "application/pdf", data: "JVBERi0=" },
    ],
  });
  assert.deepEqual(ok, {
    ok: true,
    value: {
      text: "look",
      files: [
        { name: "image-1.png", media_type: "image/png", data: png },
        { name: "report v2.pdf", media_type: "application/pdf", data: "JVBERi0=" },
      ],
    },
  });
  // no files, or an empty list: the prompt is as it always was
  assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "x", files: [] }), { ok: true, value: { text: "x" } });
  const file = { name: "a.txt", media_type: "text/plain", data: "eA==" };
  const big = "A".repeat(Math.ceil((REMOTE_AGENT_LIMITS.maxPromptFileBytes + 3) / 3) * 4);
  const bad: Array<[string, unknown, string]> = [
    ["not a list", { a: 1 }, "invalid_files"],
    ["too many", Array.from({ length: REMOTE_AGENT_LIMITS.maxPromptFiles + 1 }, (_, i) => ({ ...file, name: `f${i}` })), "invalid_files"],
    ["a path", [{ ...file, name: "../etc/passwd" }], "invalid_file_name"],
    ["a dot file", [{ ...file, name: ".bashrc" }], "invalid_file_name"],
    ["the parent", [{ ...file, name: ".." }], "invalid_file_name"],
    ["a directory", [{ ...file, name: "a/b.txt" }], "invalid_file_name"],
    ["a line break", [{ ...file, name: "a\nb.txt" }], "invalid_file_name"],
    ["two of one name", [file, file], "invalid_file_name"],
    ["two names that differ only in case", [file, { ...file, name: file.name.toUpperCase() }], "invalid_file_name"],
    ["no type", [{ ...file, media_type: "" }], "invalid_file_media_type"],
    ["not base64", [{ ...file, data: "eA=?" }], "invalid_file_data"],
    ["empty", [{ ...file, data: "" }], "invalid_file_data"],
    ["over the bytes", [{ ...file, data: big }], "files_too_large"],
  ];
  for (const [label, files, error] of bad) {
    assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "x", files }), { ok: false, error }, label);
  }
});

test("a prompt's audit record names its files by name, type, size and hash, never their bytes", () => {
  const spec = REMOTE_COMMANDS.prompt;
  const parsed = spec.parse({ text: "hi", files: [{ name: "a.txt", media_type: "text/plain", data: "aGVsbG8=" }] });
  assert.ok(parsed.ok);
  assert.deepEqual(spec.audit(parsed.value).files, [
    {
      name: "a.txt",
      media_type: "text/plain",
      size: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    },
  ]);
  assert.ok(!JSON.stringify(spec.audit(parsed.value)).includes("aGVsbG8="));
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
    ["a type only Claw writes (what the person sent)", { ...ok, type: "user_prompt" }, "reserved_type"],
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

test("a takeover is a yes or a no, and only with a reference to the session it takes over", () => {
  const base = { connector_id: "0f8fad5b-d9cb-469f-a165-70867728950e", agent_id: "a1", cwd: "/w" };
  const ref = "1f8fad5b-d9cb-469f-a165-70867728950e";
  const ok = (body: Record<string, unknown>) => { const r = parseSessionNew(body); return r.ok ? r.value.takeover : r.error; };
  assert.equal(ok({ ...base, resume_ref: ref, takeover: true }), true);
  assert.equal(ok({ ...base, resume_ref: ref, takeover: false }), false);
  assert.equal(ok({ ...base, resume_ref: ref }), false, "absent is no");
  assert.equal(ok({ ...base, resume_ref: ref, takeover: null }), false);
  assert.equal(ok({ ...base, takeover: true }), "takeover_needs_resume_ref", "there is nothing to take over without a reference");
  for (const bad of ["true", 1, {}, ["x"]]) assert.equal(ok({ ...base, resume_ref: ref, takeover: bad }), "invalid_takeover", JSON.stringify(bad));
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

test("connector versions order as semver, and a connector's status follows the minimum and the recommended version", async () => {
  const { CONNECTOR_PACKAGE, CONNECTOR_VERSIONS, compareConnectorVersions, connectorVersionStatus } = await import("../src/remote-agents.js");
  assert.equal(CONNECTOR_PACKAGE, "@primusclaw/connector");
  const pairs: Array<[string, string, number | null]> = [
    ["0.1.3", "0.1.4", -1], ["0.1.10", "0.1.9", 1], ["1.0.0", "0.99.99", 1], ["0.1.4", "v0.1.4", 0],
    ["0.1.5-rc.1", "0.1.5", -1], ["0.1.5", "0.1.5-rc.1", 1], ["0.1.5-rc.1", "0.1.5-rc.2", -1], ["0.1.5-rc.2", "0.1.5-rc.10", -1], ["0.1.5-rc", "0.1.5-rc.1", -1],
    ["0.1.5-1", "0.1.5-alpha", -1], ["0.1.5-beta", "0.1.5-alpha", 1], ["0.1.4+build", "0.1.4", 0],
    ["0.1", "0.1.0", null], ["latest", "0.1.0", null], ["", "0.1.0", null],
  ];
  for (const [a, b, want] of pairs) assert.equal(compareConnectorVersions(a, b), want, `${a} vs ${b}`);
  assert.ok(compareConnectorVersions(CONNECTOR_VERSIONS.minimum, CONNECTOR_VERSIONS.recommended)! <= 0, "the minimum is not above the recommended");
  const policy = { minimum: "0.1.3", recommended: "0.1.4" };
  const status = (v: string | null) => connectorVersionStatus(v, policy);
  assert.deepEqual(["0.0.0-stage", "0.1.2", "0.1.3", "0.1.4-rc.1", "0.1.4", "0.2.0", null, "dev"].map(status),
    ["unsupported", "unsupported", "outdated", "outdated", "current", "current", "unknown", "unknown"]);
});

test("a hide request: hidden a boolean first, then 1 to 50 refs of printable ASCII", () => {
  assert.deepEqual(parseHiddenRequest({ refs: ["r1", "x".repeat(128)], hidden: true }), { ok: true, value: { refs: ["r1", "x".repeat(128)], hidden: true } });
  assert.deepEqual(parseHiddenRequest({ refs: ["r1"], hidden: false }), { ok: true, value: { refs: ["r1"], hidden: false } });
  for (const body of [undefined, null, [], "x", { refs: ["r1"] }, { refs: ["r1"], hidden: "true" }]) {
    assert.deepEqual(parseHiddenRequest(body), { ok: false, error: "hidden_must_be_boolean" }, JSON.stringify(body));
  }
  const refs = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
  for (const bad of [[], "x", ["has space"], ["é"], ["x".repeat(129)], [1], refs(REMOTE_HIDE_LIMITS.maxRefs + 1)]) {
    assert.deepEqual(parseHiddenRequest({ refs: bad, hidden: true }), { ok: false, error: "invalid_refs" }, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(parseHiddenRequest({ refs: refs(REMOTE_HIDE_LIMITS.maxRefs), hidden: true }).ok, true);
  assert.equal(REMOTE_HIDDEN_INCLUDE, "include");
});

test("a terminal's session open: agent, conversation ref, folder and a title cut to one line's length", async () => {
  const { parseTerminalSessionOpen, parseApprovalsSetting, TERMINAL_HOOK_COMMANDS } = await import("../src/remote-agents.js");
  const ok = parseTerminalSessionOpen({ agent_id: "claude", ref: "0b1c-2d", cwd: "/home/u/repo", title: `  ${"长".repeat(100)}  ` });
  assert.ok(ok.ok);
  assert.deepEqual([ok.value.ref, Array.from(ok.value.title).length], ["0b1c-2d", 80]);
  assert.deepEqual(parseTerminalSessionOpen({ agent_id: "claude", ref: "r", cwd: "/x" }), { ok: true, value: { agent_id: "claude", ref: "r", cwd: "/x", title: "" } });
  for (const [body, error] of [
    [null, "body_required"],
    [{ agent_id: "bad id", ref: "r", cwd: "/x" }, "invalid_agent_id"],
    [{ agent_id: "claude", ref: "has space", cwd: "/x" }, "invalid_ref"],
    [{ agent_id: "claude", ref: "r".repeat(129), cwd: "/x" }, "invalid_ref"],
    [{ agent_id: "claude", ref: "r", cwd: "" }, "invalid_cwd"],
    [{ agent_id: "claude", ref: "r", cwd: "/x\n" }, "invalid_cwd"],
    [{ agent_id: "claude", ref: "r", cwd: "/x", title: "a\nb" }, "invalid_title"],
    [{ agent_id: "claude", ref: "r", cwd: "/x", title: 3 }, "invalid_title"],
  ] as const) {
    assert.deepEqual(parseTerminalSessionOpen(body), { ok: false, error }, JSON.stringify(body));
  }
  assert.deepEqual(parseApprovalsSetting({ enabled: false }), { ok: true, value: { enabled: false } });
  assert.deepEqual(parseApprovalsSetting({ enabled: "false" }), { ok: false, error: "enabled_required" });
  assert.deepEqual([...TERMINAL_HOOK_COMMANDS], ["decision", "close"]);
});

test("a heartbeat's workspaces: each folder's remote as host/owner/repo with no user or credential, a checked branch, bounded; absent from an older connector", () => {
  const hb = (workspaces?: unknown) => parseHeartbeat({ version: "0.3.1", agents: [], ...(workspaces === undefined ? {} : { workspaces }) });
  const old = hb();
  assert.ok(old.ok);
  assert.equal(old.value.workspaces, null, "an older connector sends none, and its heartbeat is taken");
  const bad = hb("not a list");
  assert.ok(bad.ok, "a malformed report never refuses the heartbeat");
  assert.equal(bad.value.workspaces, null);
  const got = hb([
    { cwd: "/w/a", git_remote: "github.com/Org/Repo", git_branch: "main" },
    { cwd: "/w/b", git_remote: "https://user:s3cret@gitlab.example.com/g/p.git", git_branch: "feat/x" },
    { cwd: "/w/c", git_remote: "github.com/ghp_abcdefghijklmnopqrstuvwxyz0123456789/x", git_branch: "a..b" },
    { cwd: "/w/a", git_remote: "github.com/dup/dup", git_branch: "dup" },
    { cwd: "/w/\u0007bell", git_remote: null, git_branch: null },
    { cwd: 5 }, "x", null,
    { cwd: "/w/d", git_remote: "GitHub.com/Upper/Case", git_branch: "x;rm -rf /" },
  ]);
  assert.ok(got.ok);
  assert.deepEqual(got.value.workspaces, [
    { cwd: "/w/a", git_remote: "github.com/Org/Repo", git_branch: "main" },
    { cwd: "/w/b", git_remote: "gitlab.example.com/g/p", git_branch: "feat/x" },
    { cwd: "/w/c", git_remote: null, git_branch: null },
    { cwd: "/w/d", git_remote: null, git_branch: null },
  ]);
  assert.ok(!JSON.stringify(got.value).includes("s3cret"));
  const many = hb(Array.from({ length: 100 }, (_, i) => ({ cwd: `/w/${i}`, git_remote: null, git_branch: null })));
  assert.ok(many.ok);
  assert.equal(many.value.workspaces!.length, REMOTE_WORKSPACE_LIMITS.maxEntries);
  assert.equal(normalizedRemote("github.com/Org/Repo"), "github.com/Org/Repo");
  assert.equal(normalizedRemote("github.com/Org/Repo.git"), null, "the normalized shape exactly, or nothing");
  assert.equal(normalizeGitRemote("git@github.com:Org/Repo.git"), "github.com/Org/Repo");
  assert.equal(normalizeGitRemote("/srv/repo.git"), null);
  assert.equal(normalizeGitBranch("refs/heads/release/1.2"), "release/1.2");
  assert.equal(normalizeGitBranch("-x"), null);
});

test("a prompt may ask for an answer only; anything but a boolean there is refused", () => {
  assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "hi", answer_only: true }), { ok: true, value: { text: "hi", answer_only: true } });
  assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "hi", answer_only: false }), { ok: true, value: { text: "hi" } });
  assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "hi" }), { ok: true, value: { text: "hi" } });
  assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "hi", answer_only: "yes" }), { ok: false, error: "invalid_answer_only" });
  assert.deepEqual(REMOTE_COMMANDS.prompt.audit({ text: "hi", answer_only: true }).answer_only, true);
});

test("a prompt may ask that its permission requests park instead of timing out; anything but a boolean there is refused", () => {
  assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "hi", park_permissions: true }), { ok: true, value: { text: "hi", park_permissions: true } });
  assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "hi", park_permissions: false }), { ok: true, value: { text: "hi" } });
  assert.deepEqual(REMOTE_COMMANDS.prompt.parse({ text: "hi", park_permissions: 1 }), { ok: false, error: "invalid_park_permissions" });
  assert.equal(REMOTE_COMMANDS.prompt.audit({ text: "hi", park_permissions: true }).park_permissions, true);
  assert.equal(PERMISSION_PARK_MAX_MS, 24 * 3600_000);
  assert.equal(REMOTE_EVENT_PERMISSION_PARKED, "permission_parked");
});
