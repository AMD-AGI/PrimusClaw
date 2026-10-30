// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A stand-in ACP agent over stdio (newline JSON-RPC), driven by environment variables and by
// the text of each prompt. It does what a real adapter does that the connector depends on: modes
// and their read-back, permission requests with the adapter's own option ids, tool updates, the
// resume-resets-the-mode trap, cancellation, and the Cursor extension requests.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const env = process.env;
const START_MODE = env.FAKE_START_MODE || "default";
const MODES = ["default", "plan", "acceptEdits", "bypassPermissions"].map((id) => ({ id, name: id === "default" && env.FAKE_MODE_NAME ? env.FAKE_MODE_NAME : id }));
const OPTION_IDS = (env.FAKE_OPTIONS || "allow-once,allow-with-updates,reject").split(",");
const OPTION_KINDS = ["allow_once", "allow_always", "reject_once"];
const log = env.FAKE_LOG ? (o) => fs.appendFileSync(env.FAKE_LOG, JSON.stringify(o) + "\n") : () => {};
const sessions = new Map();
let nextId = 1;
let nextOut = 1000;
const waiting = new Map();

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const ask = (method, params) => new Promise((resolve) => { const id = nextOut++; waiting.set(id, resolve); send({ id, method, params }); });
const configOptions = (s) => [{ id: "mode", category: "mode", currentValue: s.mode, type: "select", name: "Mode", options: MODES.map((m) => ({ value: m.id, name: m.name })) }];
const modesOf = (s) => ({ currentModeId: s.mode, availableModes: MODES });

if (env.FAKE_STDERR_WARN) process.stderr.write(env.FAKE_STDERR_WARN + "\n");
// A credential written to stderr in two pieces, with a pause between them.
if (env.FAKE_STDERR_SPLIT === "1") { process.stderr.write("auth: Bearer abcdefghijkl"); setTimeout(() => process.stderr.write("mnopqrstuvwxyz0123456789 done\n"), 80); }
// Some real adapters do not leave when their stdin closes; this one can be told not to either.
if (env.FAKE_SURVIVE_EOF === "1") setInterval(() => {}, 1000);

async function prompt(id, params) {
  const s = sessions.get(params.sessionId);
  const text = (params.prompt || []).map((p) => p.text || "").join(" ");
  s.cancelled = false;
  log({ prompt: text, mode: s.mode });
  const done = (stopReason) => reply(id, { stopReason, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
  const m = /^write (\S+)(?: (.*))?$/.exec(text);
  if (m) {
    const file = path.join(s.cwd, m[1]);
    const toolCallId = "tc-" + nextOut;
    update(params.sessionId, { sessionUpdate: "tool_call", toolCallId, title: `Write ${m[1]}`, kind: "edit", status: "pending", rawInput: { file_path: file, content: m[2] ?? "hello\n" }, locations: [{ path: file }] });
    // A bypass mode never asks: that is what the connector's mode lock exists to prevent.
    let allowed = s.mode === "bypassPermissions";
    if (!allowed) {
      const res = await ask("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: { toolCallId, title: `Write ${m[1]}`, kind: "edit", rawInput: { file_path: file, content: m[2] ?? "hello\n" }, locations: [{ path: file }] },
        options: OPTION_IDS.map((optionId, i) => ({ optionId, name: optionId, kind: OPTION_KINDS[i] })),
      });
      log({ permissionAnswer: res });
      if (res?.outcome?.outcome === "cancelled" || s.cancelled) { update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cancelled" } }); return done("cancelled"); }
      const picked = OPTION_IDS.indexOf(res?.outcome?.optionId);
      allowed = picked >= 0 && OPTION_KINDS[picked].startsWith("allow");
    }
    if (allowed) {
      fs.writeFileSync(file, m[2] ?? "hello\n");
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "wrote " + m[1] } }] });
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
    } else {
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "denied" } });
    }
    return done("end_turn");
  }
  let n;
  if ((n = /^chunks (\d+)$/.exec(text))) {
    for (let i = 1; i <= Number(n[1]); i++) update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `c${i}` } });
    return done("end_turn");
  }
  if (text === "bigoutput") {
    update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "big", status: "completed", content: [{ type: "content", content: { type: "text", text: "x".repeat(30000) } }] });
    return done("end_turn");
  }
  if (text.startsWith("say ")) {
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.slice(4) } });
    return done("end_turn");
  }
  // A turn that lasts until the test lets it end: `wait <file>` returns once <file> exists.
  if ((n = /^wait (\S+)$/.exec(text))) {
    for (let i = 0; i < 1200 && !s.cancelled && !fs.existsSync(n[1]); i++) await new Promise((r) => setTimeout(r, 25));
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waited" } });
    return done(s.cancelled ? "cancelled" : "end_turn");
  }
  if (text === "hang") {
    for (let i = 0; i < 600 && !s.cancelled; i++) await new Promise((r) => setTimeout(r, 25));
    return done(s.cancelled ? "cancelled" : "end_turn");
  }
  if (text === "plan") {
    const res = await ask("cursor/create_plan", { toolCallId: "p1", name: "Refactor", overview: "o", plan: "1. a\n2. b", todos: [{ id: "t", content: "a", status: "pending" }] });
    log({ planAnswer: res });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "plan:" + JSON.stringify(res?.outcome) } });
    return done("end_turn");
  }
  if (text === "question" || text === "questions2") {
    const q = { id: "q1", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
    const res = await ask("cursor/ask_question", { toolCallId: "q", questions: text === "question" ? [q] : [q, { ...q, id: "q2" }] });
    log({ questionAnswer: res });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "q:" + JSON.stringify(res?.outcome) } });
    return done("end_turn");
  }
  if (text === "todos") {
    send({ method: "cursor/update_todos", params: { toolCallId: "t", todos: [{ id: "1", content: "x", status: "pending" }], merge: false } });
    return done("end_turn");
  }
  if (text === "whoami") {
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mode=${s.mode} pid=${process.pid}` } });
    return done("end_turn");
  }
  return done("end_turn");
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === undefined && msg.id !== undefined) { const r = waiting.get(msg.id); if (r) { waiting.delete(msg.id); r(msg.result); } return; }
  const { id, method, params } = msg;
  log({ method, params: method === "session/prompt" ? undefined : params });
  switch (method) {
    case "initialize":
      return reply(id, { protocolVersion: 1, agentInfo: { name: "fake" }, authMethods: [], agentCapabilities: { loadSession: true, sessionCapabilities: env.FAKE_NO_RESUME === "1" ? { close: {} } : { resume: {}, close: {}, list: {} } } });
    case "session/list": {
      // The shape of a real adapter's answer: {sessionId, cwd, title, updatedAt}, newest first, paged by an opaque cursor.
      const all = JSON.parse(env.FAKE_SESSIONS || "[]");
      const size = Number(env.FAKE_PAGE_SIZE || 100);
      const from = params?.cursor ? Number(String(params.cursor).replace("offset:", "")) : 0;
      return reply(id, { sessions: all.slice(from, from + size), ...(from + size < all.length ? { nextCursor: `offset:${from + size}` } : {}) });
    }
    case "session/new": {
      if (env.FAKE_AUTH_REQUIRED) return fail(id, -32000, "Authentication required");
      const sessionId = "acp-" + nextId++;
      const s = { cwd: params.cwd, mode: START_MODE, cancelled: false };
      sessions.set(sessionId, s);
      return reply(id, { sessionId, modes: modesOf(s), configOptions: configOptions(s) });
    }
    case "session/resume": case "session/load": {
      const s = sessions.get(params.sessionId) ?? { cwd: params.cwd, mode: START_MODE, cancelled: false };
      sessions.set(params.sessionId, s);
      // The trap measured on a real adapter: resuming puts the user's own configured mode back.
      if (env.FAKE_RESUME_RESETS) s.mode = env.FAKE_RESUME_RESETS;
      // ... and, in a mode that never asks, it says so while it sets the session up (measured on claude-agent-acp 0.99.0).
      if (env.FAKE_RESUME_WARN === "1" && method === "session/resume") process.stderr.write("Warning: canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call\n");
      // A resume that takes its time (reading a long transcript), so that a test can act while it runs.
      if (env.FAKE_RESUME_DELAY_MS) await new Promise((r) => setTimeout(r, Number(env.FAKE_RESUME_DELAY_MS)));
      if (method === "session/load") update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old history" } });
      return reply(id, { modes: modesOf(s), configOptions: configOptions(s) });
    }
    case "session/set_mode": {
      const s = sessions.get(params.sessionId);
      if (!s) return fail(id, -32602, "no such session");
      if (env.FAKE_IGNORE_SET_MODE !== "1") s.mode = params.modeId;
      reply(id, {});
      if (env.FAKE_WARN_AFTER_LOCK === "1") setTimeout(() => process.stderr.write("Warning: canUseTool will not be invoked: late\n"), 300);
      if (env.FAKE_NOTIFY_MODE === "1") update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: s.mode });
      return;
    }
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      if (env.FAKE_NO_CONFIG_OPTION === "1") return fail(id, -32601, "Method not found");
      if (env.FAKE_IGNORE_SET_MODE !== "1" && params.configId === "mode") s.mode = params.value;
      return reply(id, { configOptions: configOptions(s) });
    }
    case "session/prompt":
      return void prompt(id, params).catch((e) => fail(id, -32603, String(e)));
    case "session/cancel": {
      const s = sessions.get(params.sessionId);
      if (s) s.cancelled = true;
      return;
    }
    case "session/close":
      return reply(id, {});
    default:
      if (id !== undefined) fail(id, -32601, "Method not found: " + method);
  }
});
