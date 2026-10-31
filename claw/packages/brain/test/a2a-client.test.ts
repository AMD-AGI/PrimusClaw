// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The a2a_call client against real HTTP peers: where it calls (the card, not a guess), what it
 * sends, what it hands back, how long it waits, what a Stop does to the peer's task, and whose
 * identity it carries. Every assertion about what left the process reads what the peer received.
 */
import "./a2a-client-env.js";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { IdentityExchangeRefusedError, IdentityUnavailableError, type ExchangeRequest } from "@claw/utils";

import {
  a2aApprovalHold, addPeer, handleA2ACall, initA2ARegistry, parseA2AAgents, resolvePeer, scrubCredentials, streamBudgetMs, type A2ACallOptions,
} from "../src/clients/a2a.js";
import { HitlController } from "../src/agent/hitl.js";
import type { NatsDecisionMessage } from "../src/delivery/decision-dispatcher.js";

// ── A peer that records what it was sent and answers as scripted ────────────

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; rpc?: { method?: string; params?: any } }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void;
interface Peer { port: number; origin: string; seen: Seen[]; rpcs(): string[]; close(): Promise<void> }

const peers: Peer[] = [];
async function startPeer(handler: Handler): Promise<Peer> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      let rpc: Seen["rpc"];
      try { rpc = body ? JSON.parse(body) : undefined; } catch { /* not JSON */ }
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, rpc };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const peer: Peer = {
    port, origin: `http://127.0.0.1:${port}`, seen,
    rpcs: () => seen.filter((s) => s.rpc?.method).map((s) => s.rpc!.method!),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  peers.push(peer);
  return peer;
}

afterEach(async () => {
  await Promise.all(peers.splice(0).map((p) => p.close()));
  initA2ARegistry("");
});

const json = (res: http.ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const rpcResult = (res: http.ServerResponse, seen: Seen, result: unknown) => json(res, { jsonrpc: "2.0", id: seen.rpc?.params ? 1 : 1, result });
const rpcError = (res: http.ServerResponse, code: number, message: string) => json(res, { jsonrpc: "2.0", id: 1, error: { code, message } });

function sse(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  return {
    event: (result: unknown) => res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`),
    comment: () => res.write(": keep-alive\n\n"),
    end: () => res.end(),
  };
}

const card = (origin: string, interfaces: unknown, extra: Record<string, unknown> = {}) => ({
  name: "peer", description: "", version: "1", capabilities: { streaming: true }, skills: [],
  ...(interfaces === undefined ? {} : { supportedInterfaces: interfaces }), ...extra,
});
const jsonrpc = (url: string, version = "1.0") => ({ url, protocolBinding: "JSONRPC", protocolVersion: version });
const CARD_PATH = "/.well-known/agent-card.json";

const working = { id: "t-1", contextId: "c-1", status: { state: "TASK_STATE_WORKING" } };
const done = (text: string) => ({
  id: "t-1", contextId: "c-1", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "a", parts: [{ text }] }],
});

/** A well-behaved peer: its card names `/rpc`, SendStreamingMessage streams a completed task. */
async function standardPeer(
  over: { card?: (peer: { origin: string }) => unknown; cardHeaders?: Record<string, string>; rpc?: Handler } = {},
): Promise<Peer> {
  const self: { origin: string } = { origin: "" };
  const p = await startPeer((req, res, seen) => {
    if (req.method === "GET" && req.url === CARD_PATH) {
      return json(res, over.card ? over.card(self) : card(self.origin, [jsonrpc(`${self.origin}/rpc`)]), 200, over.cardHeaders);
    }
    if (over.rpc) return over.rpc(req, res, seen);
    if (seen.rpc?.method === "SendStreamingMessage") {
      const s = sse(res);
      s.event({ task: { id: "t-1", contextId: "c-1", status: { state: "TASK_STATE_SUBMITTED" } } });
      s.event({ artifactUpdate: { taskId: "t-1", artifact: { artifactId: "a", parts: [{ text: "hello" }] } } });
      s.event({ statusUpdate: { taskId: "t-1", status: { state: "TASK_STATE_COMPLETED" } } });
      return s.end();
    }
    if (seen.rpc?.method === "GetTask") return rpcResult(res, seen, done("fetched"));
    if (seen.rpc?.method === "CancelTask") return rpcResult(res, seen, { id: "t-1", status: { state: "TASK_STATE_CANCELED" } });
    return rpcResult(res, seen, { task: working });
  });
  self.origin = p.origin;
  return p;
}

const registry = (entries: unknown[]) => initA2ARegistry(JSON.stringify(entries));
const entry = (p: Peer, extra: Record<string, unknown> = {}) => ({ name: "p", card_url: `${p.origin}${CARD_PATH}`, allow_local: true, ...extra });
const call = async (input: Record<string, unknown>, opts: A2ACallOptions = {}) => handleA2ACall({ agent: "p", ...input }, opts);
const parse = (out: string) => JSON.parse(out);

/**
 * The lines the client logs while `run` goes. The logger is a module-private pino writing to fd 1,
 * so there is no object to swap; taking `fs.write` keeps the real serializers on the path and reads
 * the bytes the process was about to emit.
 */
async function captureLogLines(run: () => Promise<unknown>, waitFor: string): Promise<string[]> {
  const lines: string[] = [];
  const realWrite = fs.write as unknown as (...args: unknown[]) => unknown;
  const realWriteSync = fs.writeSync as unknown as (...args: unknown[]) => unknown;
  const take = (chunk: unknown) => { for (const line of String(chunk).split("\n")) if (line) lines.push(line); };
  fs.write = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWrite(fd, chunk, ...rest);
    take(chunk);
    const done = rest[rest.length - 1];
    if (typeof done === "function") done(null, Buffer.byteLength(String(chunk)), chunk);
    return undefined;
  }) as unknown as typeof fs.write;
  fs.writeSync = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWriteSync(fd, chunk, ...rest);
    take(chunk);
    return Buffer.byteLength(String(chunk));
  }) as unknown as typeof fs.writeSync;
  try {
    await run();
    // pino hands the line to the sink asynchronously: wait for the line by name, not for a fixed time.
    const wanted = `"msg":${JSON.stringify(waitFor)}`;
    for (let i = 0; i < 500 && !lines.some((l) => l.includes(wanted)); i++) await new Promise((r) => setTimeout(r, 1));
  } finally {
    fs.write = realWrite as unknown as typeof fs.write;
    fs.writeSync = realWriteSync as unknown as typeof fs.writeSync;
  }
  return lines;
}

// ── Where the call goes: the card ───────────────────────────────────────────

test("the endpoint is the card's JSONRPC 1.0 interface, not <base>/a2a", async () => {
  const p = await standardPeer();
  registry([entry(p)]);
  const r = parse(await call({ message: "hi" }));
  assert.equal(r.state, "completed");
  assert.equal(r.text, "hello");
  assert.equal(r.task_id, "t-1");
  assert.equal(r.context_id, "c-1");
  const rpc = p.seen.find((s) => s.rpc?.method === "SendStreamingMessage")!;
  assert.equal(rpc.url, "/rpc");
  assert.equal(rpc.headers["a2a-version"], "1.0");
  assert.equal(rpc.rpc!.params.message.parts[0].text, "hi");
});

test("a card that names an endpoint elsewhere is refused before anything is sent there", async () => {
  const victim = await startPeer((_q, res) => json(res, {}));
  const table: Array<[string, (origin: string) => string, Record<string, unknown>?]> = [
    ["another host's port", () => `${victim.origin}/rpc`],
    ["the same host on http while the card was fetched from another scheme is a different origin", () => `https://127.0.0.1/rpc`],
  ];
  for (const [what, urlFor] of table) {
    const p = await standardPeer({ card: ({ origin }) => card(origin, [jsonrpc(urlFor(origin))]) });
    registry([entry(p, { auth_env: "A2A_PEER_TOKEN_TEST" })]);
    process.env.A2A_PEER_TOKEN_TEST = "tok-sentinel";
    const out = await call({ message: "hi" });
    assert.match(out, /not the origin of its card_url or url/, what);
    assert.equal(p.rpcs().length, 0, `${what}: nothing was sent to the peer`);
  }
  assert.equal(victim.seen.length, 0, "the host the card pointed at received nothing, and so no token");

  // The operator may say that origin is theirs: the entry's url.
  const p = await standardPeer({ card: ({ origin }) => card(origin, [jsonrpc(`${victim.origin}/rpc`)]) });
  victim.seen.length = 0;
  registry([entry(p, { url: victim.origin })]);
  await call({ message: "hi" });
  assert.equal(victim.seen.length, 1, "an origin the operator wrote down is allowed");
  delete process.env.A2A_PEER_TOKEN_TEST;
});

test("a card without a usable JSONRPC 1.0 interface is an error that says what it found", async () => {
  const table: Array<[string, unknown]> = [
    ["only gRPC", [{ url: "http://x:1", protocolBinding: "GRPC", protocolVersion: "1.0" }]],
    ["JSONRPC at 0.3", [jsonrpc("http://x:1/rpc", "0.3")]],
    ["no interfaces on a card_url peer", undefined],
  ];
  for (const [what, interfaces] of table) {
    const p = await startPeer((req, res) => json(res, card("", interfaces)));
    registry([{ name: "p", card_url: `${p.origin}${CARD_PATH}`, allow_local: true }]);
    const out = await call({ message: "hi" });
    assert.match(out, /lists no JSONRPC 1.0 interface/, what);
    assert.equal(p.seen.length, 1, `${what}: only the card was read`);
  }
});

test("a bare-URL peer that publishes no usable card is called where it always was; a card_url peer is not guessed at", async () => {
  const p = await startPeer((req, res, seen) => {
    if (req.method === "GET") return json(res, { error: "no card" }, 404);
    return rpcResult(res, seen, { task: done("legacy") });
  });
  registry([{ name: "p", url: p.origin, allow_local: true }]);
  const ok = parse(await call({ message: "hi", mode: "fire_and_forget" }));
  assert.equal(ok.state, "completed");
  assert.equal(p.seen.find((s) => s.rpc)?.url, "/a2a");

  registry([{ name: "p", card_url: `${p.origin}${CARD_PATH}`, allow_local: true }]);
  const bad = await call({ message: "hi" });
  assert.match(bad, /Agent discovery failed: 404/);
});

// ── The card cache ──────────────────────────────────────────────────────────

test("the card is cached by Cache-Control and revalidated by ETag", async () => {
  let cc = "max-age=3600";
  let mode: "etag" | "plain" = "etag";
  const p = await startPeer((req, res, seen) => {
    if (req.method === "GET") {
      if (mode === "etag" && req.headers["if-none-match"] === '"v1"') { res.writeHead(304, { "cache-control": cc }); return res.end(); }
      return json(res, card(p.origin, [jsonrpc(`${p.origin}/rpc`)]), 200, { etag: '"v1"', "cache-control": cc });
    }
    return rpcResult(res, seen, { task: done("ok") });
  });
  const cardGets = () => p.seen.filter((s) => s.method === "GET");
  registry([entry(p)]);

  await call({ message: "1", mode: "fire_and_forget" });
  await call({ message: "2", mode: "fire_and_forget" });
  assert.equal(cardGets().length, 1, "a fresh card is not asked for again");

  cc = "max-age=0";
  registry([entry(p)]);
  await call({ message: "3", mode: "fire_and_forget" });
  await call({ message: "4", mode: "fire_and_forget" });
  assert.equal(cardGets().length, 3, "a stale card is revalidated each time");
  assert.equal(cardGets()[2].headers["if-none-match"], '"v1"');
  assert.equal(p.rpcs().length, 4, "and the 304 left the call working");

  cc = "no-store";
  registry([entry(p)]);
  const before = cardGets().length;
  await call({ message: "5", mode: "fire_and_forget" });
  await call({ message: "6", mode: "fire_and_forget" });
  assert.equal(cardGets().length - before, 2, "no-store is never served from memory");
});

test("a peer that cannot be asked for its card is called with the one held", async () => {
  let down = false;
  const p = await startPeer((req, res, seen) => {
    if (req.method === "GET") {
      if (down) return json(res, {}, 503);
      return json(res, card(p.origin, [jsonrpc(`${p.origin}/rpc`)]), 200, { "cache-control": "max-age=0" });
    }
    return rpcResult(res, seen, { task: done("ok") });
  });
  registry([entry(p)]);
  assert.equal(parse(await call({ message: "a", mode: "fire_and_forget" })).state, "completed");
  down = true;
  assert.equal(parse(await call({ message: "b", mode: "fire_and_forget" })).state, "completed", "stale card, 503");
  assert.equal(p.rpcs().length, 2);
});

// ── Modes ───────────────────────────────────────────────────────────────────

test("get and cancel call GetTask and CancelTask with the task id, and return the structured result", async () => {
  const p = await standardPeer();
  registry([entry(p)]);
  const got = parse(await call({ mode: "get", task_id: "t-1" }));
  assert.equal(got.state, "completed");
  assert.equal(got.text, "fetched");
  const cancelled = parse(await call({ mode: "cancel", task_id: "t-1" }));
  assert.equal(cancelled.state, "canceled");
  const rpcs = p.seen.filter((s) => s.rpc?.method);
  assert.deepEqual(rpcs.map((s) => [s.rpc!.method, s.rpc!.params]), [["GetTask", { id: "t-1" }], ["CancelTask", { id: "t-1" }]]);
});

test("argument rules: what each mode needs, and every refusal is a failed call", async () => {
  const p = await standardPeer();
  registry([entry(p)]);
  const table: Array<[string, Record<string, unknown>, RegExp]> = [
    ["no message to stream", {}, /'message' is required/],
    ["no message to fire", { mode: "fire_and_forget" }, /'message' is required/],
    ["get without a task", { mode: "get" }, /'task_id' is required for mode "get"/],
    ["cancel without a task", { mode: "cancel" }, /'task_id' is required for mode "cancel"/],
    ["an unknown mode", { mode: "subscribe", message: "x" }, /unknown mode "subscribe"/],
    ["an approval with no task", { approval: { action_id: "a", decision: "allow" } }, /'task_id' is required/],
    ["a malformed approval", { task_id: "t", approval: { action_id: "a", decision: "maybe" } }, /decision/],
    ["an approval that is not an object", { task_id: "t", approval: "allow" }, /'approval' must be an object/],
  ];
  for (const [what, input, want] of table) {
    const outcome = { isError: false };
    const out = await call(input, { outcome });
    assert.match(out, want, what);
    assert.equal(outcome.isError, true, `${what}: recorded as a failure`);
  }
  assert.equal(p.seen.length, 0, "nothing reached the peer");

  const noAgent = await handleA2ACall({ message: "x" });
  assert.match(noAgent, /'agent' is required/);
  const outcome = { isError: false };
  // discover, get and cancel do not need a message
  await call({ mode: "discover" }, { outcome });
  assert.equal(outcome.isError, false);
});

test("a peer's JSON-RPC error is a failed call carrying its code and message", async () => {
  const p = await standardPeer({ rpc: (_q, res) => rpcError(res, -32001, "Task not found") });
  registry([entry(p)]);
  const outcome = { isError: false };
  const out = await call({ mode: "get", task_id: "nope" }, { outcome });
  assert.match(out, /A2A call to "p" failed: A2A RPC error \[-32001\]: Task not found/);
  assert.equal(outcome.isError, true);
});

test("a peer whose task failed is a failed call; one that is merely working is not", async () => {
  const table: Array<[string, string, boolean]> = [
    ["TASK_STATE_FAILED", "failed", true], ["TASK_STATE_REJECTED", "rejected", true],
    ["TASK_STATE_WORKING", "working", false], ["TASK_STATE_CANCELED", "canceled", false],
    ["TASK_STATE_COMPLETED", "completed", false], ["TASK_STATE_INPUT_REQUIRED", "input_required", false],
  ];
  for (const [state, want, isError] of table) {
    const p = await standardPeer({ rpc: (_q, res, seen) => rpcResult(res, seen, { id: "t", status: { state } }) });
    registry([entry(p)]);
    const outcome = { isError: false };
    const r = parse(await call({ mode: "get", task_id: "t" }, { outcome }));
    assert.equal(r.state, want);
    assert.equal(outcome.isError, isError, state);
  }
});

// ── Streaming: input_required, timeouts, Stop ───────────────────────────────

test("input_required ends the wait and surfaces the question and the approval request", async () => {
  const p = await standardPeer({
    rpc: (_q, res) => {
      const s = sse(res);
      s.event({ task: { id: "t-9", contextId: "c-9", status: { state: "TASK_STATE_WORKING" } } });
      s.event({ statusUpdate: { taskId: "t-9", contextId: "c-9", status: { state: "TASK_STATE_INPUT_REQUIRED", message: { role: "ROLE_AGENT", parts: [
        { text: "Deploy to production?" },
        { data: { kind: "approval", actionId: "act-1", tool: "deploy", input: { env: "prod" }, options: ["allow", "deny"] } },
      ] } } } });
      // the stream stays open, as a peer waiting for the caller's reply does
    },
  });
  registry([entry(p)]);
  const started = Date.now();
  const r = parse(await call({ message: "deploy" }));
  assert.ok(Date.now() - started < 3000, "returned without waiting for the peer to close the stream");
  assert.equal(r.state, "input_required");
  assert.equal(r.task_id, "t-9");
  assert.equal(r.input_required.text, "Deploy to production?");
  assert.equal(r.input_required.approval.action_id, "act-1");
  assert.match(r.note, /ask_user_question/);
});

test("an answer is sent as a message on the same task and context; an approval as a data part", async () => {
  const p = await standardPeer();
  registry([entry(p)]);
  await call({ message: "blue", task_id: "t-9", context_id: "c-9" });
  await call({ task_id: "t-9", context_id: "c-9", approval: { action_id: "act-1", decision: "allow" } });
  await call({ message: "and another thing", context_id: "c-9" });
  const sent = p.seen.filter((s) => s.rpc?.method === "SendStreamingMessage").map((s) => s.rpc!.params.message);
  assert.equal(sent[0].taskId, "t-9");
  assert.equal(sent[0].contextId, "c-9");
  assert.deepEqual(sent[0].parts, [{ text: "blue" }]);
  assert.deepEqual(sent[1].parts, [{ data: { actionId: "act-1", decision: "allow" } }]);
  assert.equal(sent[2].taskId, undefined, "a context alone starts a new task in it");
  assert.equal(sent[2].contextId, "c-9");
});

test("no event for the idle timeout: the wait ends, the result is working with a task_id, and the peer's task is left alone", async () => {
  const p = await standardPeer({
    rpc: (_q, res) => {
      const s = sse(res);
      s.event({ task: { id: "t-q", contextId: "c-q", status: { state: "TASK_STATE_WORKING" } } });
      // keep-alive comments are the connection's liveness, not progress: they do not extend the wait
      const t = setInterval(() => s.comment(), 30);
      res.on("close", () => clearInterval(t));
    },
  });
  registry([entry(p)]);
  const started = Date.now();
  const outcome = { isError: false };
  const r = parse(await call({ message: "quiet" }, { idleTimeoutMs: 200, outcome }));
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.state, "working");
  assert.equal(r.task_id, "t-q");
  assert.match(r.note, /mode "get"/);
  assert.equal(outcome.isError, false, "outliving the wait is not a failure");
  assert.deepEqual(p.rpcs(), ["SendStreamingMessage"], "no CancelTask: the work is still wanted");
});

test("the total limit ends the wait the same way, however steadily events arrive", async () => {
  const p = await standardPeer({
    rpc: (_q, res) => {
      const s = sse(res);
      s.event({ task: { id: "t-l", contextId: "c-l", status: { state: "TASK_STATE_WORKING" } } });
      const t = setInterval(() => s.event({ artifactUpdate: { taskId: "t-l", artifact: { artifactId: "a", parts: [{ text: "." }] }, append: true } }), 20);
      res.on("close", () => clearInterval(t));
    },
  });
  registry([entry(p)]);
  const r = parse(await call({ message: "long" }, { idleTimeoutMs: 5_000, maxStreamMs: 300 }));
  assert.equal(r.state, "working");
  assert.equal(r.task_id, "t-l");
  assert.ok(r.text.length > 3, "what had arrived is reported");
  assert.match(r.note, /time allowed for this call ran out/);
});

test("the total wait is the configured cap, or what is left of the run's budget less a margin, never under the floor", () => {
  const now = 1_000_000;
  const table: Array<[string, { maxStreamMs?: number; deadlineAtMs?: number }, number]> = [
    ["no deadline: the cap", { maxStreamMs: 600_000 }, 600_000],
    ["plenty of budget: the cap", { maxStreamMs: 600_000, deadlineAtMs: now + 3_600_000 }, 600_000],
    ["less budget than the cap: the budget less a 10 s margin", { maxStreamMs: 600_000, deadlineAtMs: now + 100_000 }, 90_000],
    ["almost no budget: the 5 s floor", { maxStreamMs: 600_000, deadlineAtMs: now + 12_000 }, 5_000],
    ["budget already spent: the floor, so the call can still report", { maxStreamMs: 600_000, deadlineAtMs: now - 1_000 }, 5_000],
  ];
  for (const [what, o, want] of table) assert.equal(streamBudgetMs(o, now), want, what);
});

test("a peer that never reports a task before the wait ends is an error, not a handle", async () => {
  const p = await standardPeer({ rpc: (_q, res) => { sse(res).comment(); } });
  registry([entry(p)]);
  const outcome = { isError: false };
  const out = await call({ message: "x" }, { idleTimeoutMs: 150, outcome });
  assert.match(out, /did not report a task/);
  assert.equal(outcome.isError, true);
});

test("a peer that closes the stream early says so; one that errors in the stream is a failure", async () => {
  const early = await standardPeer({
    rpc: (_q, res) => { const s = sse(res); s.event({ task: working }); s.end(); },
  });
  registry([entry(early)]);
  const r = parse(await call({ message: "x" }));
  assert.equal(r.state, "working");
  assert.match(r.note, /closed the stream before the task finished/);

  const erring = await standardPeer({
    rpc: (_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } })}\n\n`);
    },
  });
  registry([entry(erring)]);
  assert.match(await call({ message: "x" }), /A2A RPC error \[-32603\]: boom/);

  const refusing = await standardPeer({ rpc: (_q, res) => rpcError(res, -32009, "version not supported") });
  registry([entry(refusing)]);
  assert.match(await call({ message: "x" }), /A2A RPC error \[-32009\]: version not supported/);
});

test("a peer that does not stream is asked the ordinary way", async () => {
  const p = await standardPeer({
    card: ({ origin }) => card(origin, [jsonrpc(`${origin}/rpc`)], { capabilities: { streaming: false } }),
    rpc: (_q, res, seen) => rpcResult(res, seen, { task: done("blocking answer") }),
  });
  registry([entry(p)]);
  const r = parse(await call({ message: "x" }));
  assert.equal(r.text, "blocking answer");
  assert.deepEqual(p.rpcs(), ["SendMessage"]);
  assert.equal(p.seen.find((s) => s.rpc)!.rpc!.params.configuration.returnImmediately, false);
});

test("a Message reply with no task is a completed answer", async () => {
  const p = await standardPeer({
    rpc: (_q, res, seen) => rpcResult(res, seen, { message: { role: "ROLE_AGENT", parts: [{ text: "42" }] } }),
    card: ({ origin }) => card(origin, [jsonrpc(`${origin}/rpc`)], { capabilities: { streaming: false } }),
  });
  registry([entry(p)]);
  const r = parse(await call({ message: "answer" }));
  assert.equal(r.state, "completed");
  assert.equal(r.text, "42");
  assert.equal(r.task_id, undefined);
});

// ── Stop ────────────────────────────────────────────────────────────────────

/** A peer whose stream announces task t-s and then goes quiet; CancelTask answers canceled. */
async function holdingPeer(): Promise<Peer> {
  return standardPeer({
    rpc: (_q, res, seen) => {
      if (seen.rpc?.method === "CancelTask") return rpcResult(res, seen, { id: "t-s", contextId: "c-s", status: { state: "TASK_STATE_CANCELED" } });
      const s = sse(res);
      s.event({ task: { id: "t-s", contextId: "c-s", status: { state: "TASK_STATE_WORKING" } } });
    },
  });
}

test("Stop cancels the peer's task, on a request of its own, and the result says canceled", async () => {
  const p = await holdingPeer();
  registry([entry(p)]);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 150);
  const r = parse(await call({ message: "slow" }, { signal: stop.signal }));
  assert.equal(r.state, "canceled");
  assert.equal(r.task_id, "t-s");
  assert.deepEqual(p.rpcs(), ["SendStreamingMessage", "CancelTask"]);
  assert.deepEqual(p.seen.find((s) => s.rpc?.method === "CancelTask")!.rpc!.params, { id: "t-s" });
});

test("a Stop the peer cannot be told about is reported, not hidden", async () => {
  const p = await standardPeer({
    rpc: (_q, res, seen) => {
      if (seen.rpc?.method === "CancelTask") return rpcError(res, -32002, "Task cannot be canceled");
      sse(res).event({ task: { id: "t-s", contextId: "c-s", status: { state: "TASK_STATE_WORKING" } } });
    },
  });
  registry([entry(p)]);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 150);
  const r = parse(await call({ message: "slow" }, { signal: stop.signal }));
  assert.equal(r.state, "working", "not claimed canceled");
  assert.match(r.note, /CancelTask to the peer failed/);
});

test("an abort that is a restart, not a Stop, leaves the peer's task running", async () => {
  const p = await holdingPeer();
  registry([entry(p)]);
  const restart = Symbol("sigterm");
  const stop = new AbortController();
  setTimeout(() => stop.abort(restart), 150);
  const r = parse(await call({ message: "slow" }, { signal: stop.signal, cancelOnAbort: (reason) => reason !== restart }));
  assert.equal(r.task_id, "t-s");
  assert.match(r.note, /left running/);
  assert.deepEqual(p.rpcs(), ["SendStreamingMessage"]);
});

test("Stop before the peer has named a task has nothing to cancel; Stop before the call makes no call", async () => {
  const silent = await standardPeer({ rpc: () => { /* never answers */ } });
  registry([entry(silent)]);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 150);
  const r = parse(await call({ message: "x" }, { signal: stop.signal }));
  assert.equal(r.state, "canceled");
  assert.deepEqual(silent.rpcs(), ["SendStreamingMessage"]);

  const before = silent.seen.length;
  const already = new AbortController();
  already.abort();
  assert.equal(parse(await call({ message: "x" }, { signal: already.signal })).state, "canceled");
  assert.equal(silent.seen.length, before, "no request at all");
});

test("Stop still cancels the peer's task when its card is no longer fresh", async () => {
  // A stream can outlive the card's freshness (5 minutes by default, a call may run 10), and a card
  // served no-store is never held. The card is then fetched again to find the endpoint, and by then
  // the run's signal has fired: the fetch must not be tied to it, or CancelTask is never sent.
  const stale: Array<[string, Record<string, string>]> = [
    ["no-cache", { "cache-control": "no-cache" }],
    ["no-store", { "cache-control": "no-store" }],
    ["max-age=0", { "cache-control": "max-age=0" }],
  ];
  for (const [how, cardHeaders] of stale) {
    const p = await standardPeer({
      cardHeaders,
      rpc: (_q, res, seen) => {
        if (seen.rpc?.method === "CancelTask") return rpcResult(res, seen, { id: "t-s", contextId: "c-s", status: { state: "TASK_STATE_CANCELED" } });
        sse(res).event({ task: { id: "t-s", contextId: "c-s", status: { state: "TASK_STATE_WORKING" } } });
      },
    });
    registry([entry(p)]);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 150);
    const r = parse(await call({ message: "slow" }, { signal: stop.signal }));
    const cardFetches = p.seen.filter((s) => s.method === "GET" && s.url === CARD_PATH).length;
    assert.ok(cardFetches >= 2, `${how}: the card was asked for again at Stop (otherwise this proves nothing), got ${cardFetches}`);
    assert.deepEqual(p.rpcs(), ["SendStreamingMessage", "CancelTask"], `${how}: CancelTask was sent`);
    assert.equal(r.state, "canceled", how);
    assert.match(r.note, /CancelTask was sent to the peer/, how);
  }
});

// ── What the peer says never reaches the Brain log with the credential it was sent ──

test("a failed CancelTask does not put the peer's echo of its credential in the log", async () => {
  const TOKEN = "svc-log-token-sentinel-7c1e9d";
  process.env.A2A_PEER_TOKEN_TEST = TOKEN;
  try {
    const p = await standardPeer({
      rpc: (req, res, seen) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (seen.rpc?.method === "CancelTask") return rpcError(res, -32002, `cannot cancel; you sent ${auth}`);
        sse(res).event({ task: { id: `t-${auth}`, contextId: "c-s", status: { state: "TASK_STATE_WORKING" } } });
      },
    });
    registry([entry(p, { auth_env: "A2A_PEER_TOKEN_TEST" })]);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 150);
    let out = "";
    const lines = await captureLogLines(async () => { out = await call({ message: "slow" }, { signal: stop.signal }); }, "a2a.cancel_on_stop.failed");
    const failed = lines.filter((l) => l.includes('"msg":"a2a.cancel_on_stop.failed"'));
    assert.equal(failed.length, 1, `the failure is logged once, got ${lines.length} lines`);
    assert.match(failed[0], /cannot cancel; you sent \[credential removed\]/, "the rest of the peer's words is still there");
    assert.match(failed[0], /t-\[credential removed\]/, "the peer-named task id is scrubbed too");
    for (const l of lines) assert.ok(!l.includes(TOKEN), `the credential reached the log: ${l.slice(0, 300)}`);
    assert.ok(!out.includes(TOKEN), "nor the result");
  } finally {
    delete process.env.A2A_PEER_TOKEN_TEST;
  }
});

test("a task id the peer made out of its credential is not logged as it is", async () => {
  const TOKEN = "svc-log-token-sentinel-4b8f2a";
  process.env.A2A_PEER_TOKEN_TEST = TOKEN;
  try {
    const p = await standardPeer({
      rpc: (req, res) => {
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        const s = sse(res);
        s.event({ task: { id: `task-${auth}`, status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "a", parts: [{ text: "done" }] }] } });
        s.end();
      },
    });
    registry([entry(p, { auth_env: "A2A_PEER_TOKEN_TEST" })]);
    let out = "";
    const lines = await captureLogLines(async () => { out = await call({ message: "x" }); }, "a2a.call");
    const info = lines.filter((l) => l.includes('"msg":"a2a.call"'));
    assert.equal(info.length, 1);
    assert.match(info[0], /task-\[credential removed\]/);
    for (const l of lines) assert.ok(!l.includes(TOKEN), `the credential reached the log: ${l.slice(0, 300)}`);
    assert.ok(!out.includes(TOKEN));
  } finally {
    delete process.env.A2A_PEER_TOKEN_TEST;
  }
});

// ── Whose identity the peer is called with ──────────────────────────────────

/** Like the real client: a token is minted once per (subject, audience, scope) and served from memory until forceRefresh. */
function fakeIdentity(behave: (req: ExchangeRequest, minted: number) => string | Error = (_r, n) => `tok-${n}`) {
  const calls: ExchangeRequest[] = [];
  const cache = new Map<string, string>();
  const state = { minted: 0 };
  return {
    calls,
    state,
    exchange: async (req: ExchangeRequest) => {
      calls.push(req);
      const key = JSON.stringify([req.subjectToken, req.audience, req.scope]);
      let token = req.forceRefresh ? undefined : cache.get(key);
      if (token === undefined) {
        state.minted++;
        const out = behave(req, state.minted);
        if (out instanceof Error) throw out;
        token = out;
        cache.set(key, token);
      }
      return { accessToken: token, tokenType: "Bearer", expiresAt: Date.now() + 300_000 };
    },
  };
}

const AUDIENCE_ENTRY = { audience: "claw-api", scope: "claw.api" };

test("an identity peer is called as the session's owner: the exchange names the user and the peer, and the token reaches the peer alone", async () => {
  const p = await standardPeer();
  registry([entry(p, AUDIENCE_ENTRY)]);
  const id = fakeIdentity((_r, n) => `exchanged-token-sentinel-${n}`);
  const out = await call({ message: "hi" }, { identity: id, userId: "user-42" });
  assert.equal(id.state.minted, 1, "one token served the card and the call");
  assert.deepEqual(id.calls[0], {
    subjectToken: "user_id:user-42",
    subjectTokenType: "urn:primus:params:oauth:token-type:user-ref",
    audience: "claw-api",
    scope: "claw.api",
  });
  assert.ok(p.seen.length >= 2);
  for (const s of p.seen) assert.equal(s.headers.authorization, "Bearer exchanged-token-sentinel-1", `${s.method} ${s.url}`);
  assert.ok(!out.includes("exchanged-token-sentinel"), "the token is not in what the model reads");
});

test("the token never reaches the model, whatever the outcome", async () => {
  const p = await standardPeer({ rpc: (_q, res) => rpcError(res, -32603, "boom") });
  registry([entry(p, AUDIENCE_ENTRY)]);
  const outs = [
    await call({ message: "x" }, { identity: fakeIdentity(() => "tok-sentinel-aaa"), userId: "u" }),
    await call({ mode: "get", task_id: "t" }, { identity: fakeIdentity(() => "tok-sentinel-aaa"), userId: "u" }),
    await call({ mode: "discover" }, { identity: fakeIdentity(() => "tok-sentinel-aaa"), userId: "u" }),
  ];
  for (const o of outs) assert.ok(!o.includes("tok-sentinel-aaa"));
});

test("what stops an identity call, and what the model is told", async () => {
  const p = await standardPeer();
  registry([entry(p, AUDIENCE_ENTRY)]);
  const table: Array<[string, A2ACallOptions, RegExp]> = [
    ["a revoked binding", { identity: fakeIdentity(() => new IdentityExchangeRefusedError("invalid_grant", 400)), userId: "u" }, /refused to issue a token for this user.*invalid_grant.*binding was revoked/],
    ["identity down", { identity: fakeIdentity(() => new IdentityUnavailableError("exchange", "timeout")), userId: "u" }, /could not be asked for a token.*timeout/],
    ["no identity client in this deployment", { identity: null, userId: "u" }, /no identity client \(IDENTITY_CLIENT_ENABLED is off\)/],
    ["a run with no user", { identity: fakeIdentity(), userId: undefined }, /this run has none/],
    ["a blank user", { identity: fakeIdentity(), userId: "  " }, /this run has none/],
  ];
  for (const [what, opts, want] of table) {
    const outcome = { isError: false };
    const out = await call({ message: "hi" }, { ...opts, outcome });
    assert.match(out, want, what);
    assert.equal(outcome.isError, true, what);
  }
  assert.equal(p.seen.length, 0, "no refused call reached the peer, not even for its card");
});

test("a token the peer refuses is replaced once with a fresh exchange; a second refusal is the answer", async () => {
  let refuse = 1;
  const p = await standardPeer({
    rpc: (_q, res, seen) => {
      if (refuse-- > 0) { res.writeHead(401); return res.end(); }
      rpcResult(res, seen, { task: done("ok") });
    },
  });
  registry([entry(p, AUDIENCE_ENTRY)]);
  const id = fakeIdentity();
  const r = parse(await call({ message: "x", mode: "fire_and_forget" }, { identity: id, userId: "u" }));
  assert.equal(r.state, "completed");
  assert.equal(id.state.minted, 2);
  assert.deepEqual(id.calls.map((c) => c.forceRefresh), [undefined, undefined, true], "card, call, then the replacement the 401 asked for");
  const rpcAuth = p.seen.filter((s) => s.rpc).map((s) => s.headers.authorization);
  assert.deepEqual(rpcAuth, ["Bearer tok-1", "Bearer tok-2"]);

  refuse = 99;
  const id2 = fakeIdentity();
  const out = await call({ message: "x", mode: "fire_and_forget" }, { identity: id2, userId: "u" });
  assert.match(out, /HTTP 401/);
  assert.equal(id2.state.minted, 2, "one retry, not a loop");
});

test("an identity peer's card is per user; a service-credential peer's is shared", async () => {
  const p = await standardPeer();
  registry([entry(p, AUDIENCE_ENTRY)]);
  const id = fakeIdentity();
  const gets = () => p.seen.filter((s) => s.method === "GET").length;
  await call({ mode: "discover" }, { identity: id, userId: "alice" });
  await call({ mode: "discover" }, { identity: id, userId: "alice" });
  assert.equal(gets(), 1);
  await call({ mode: "discover" }, { identity: id, userId: "bob" });
  assert.equal(gets(), 2, "bob never reads the card alice's identity fetched");

  process.env.A2A_PEER_TOKEN_TEST = "svc";
  registry([entry(p, { auth_env: "A2A_PEER_TOKEN_TEST" })]);
  const before = gets();
  await call({ mode: "discover" }, { userId: "alice" });
  await call({ mode: "discover" }, { userId: "bob" });
  assert.equal(gets() - before, 1);
  delete process.env.A2A_PEER_TOKEN_TEST;
});

test("an entry cannot ask for both ways to authenticate, and a misspelt key is refused rather than ignored", () => {
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["both", { name: "p", url: "https://x.example", auth_env: "A2A_PEER_TOKEN_T", audience: "a" }, /set one/],
    ["scope without audience", { name: "p", url: "https://x.example", scope: "claw.api" }, /scope only applies with audience/],
    ["a misspelt audience", { name: "p", url: "https://x.example", audiance: "a" }, /unknown key "audiance"/],
    ["a camel-cased card url", { name: "p", cardUrl: "https://x.example/c" }, /unknown key "cardUrl"/],
    ["neither url nor card_url", { name: "p", audience: "a" }, /url or card_url is required/],
    ["a bad scope", { name: "p", url: "https://x.example", audience: "a", scope: "a;b" }, /scope must be/],
    ["an audience with a space", { name: "p", url: "https://x.example", audience: "a b" }, /audience must be/],
    ["a card_url with credentials", { name: "p", card_url: "https://u:p@x.example/c" }, /must not embed credentials/],
  ];
  for (const [what, e, want] of bad) {
    const r = parseA2AAgents(JSON.stringify([e]));
    assert.equal(r.peers.length, 0, `${what}: the entry is dropped, never half-applied`);
    assert.equal(r.errors.length, 1, what);
    assert.match(r.errors[0], want, what);
  }
});

// ── A peer's words never carry the peer's own credential into the model's context ──

test("a peer that echoes the credential it was sent cannot put it in front of the model", async () => {
  const echoes: Array<[string, (token: string) => string]> = [
    ["as it arrived", (t) => `Authorization: Bearer ${t}`],
    ["base64", (t) => Buffer.from(t).toString("base64")],
    ["base64url", (t) => Buffer.from(t).toString("base64url")],
    ["URL-encoded", (t) => encodeURIComponent(t)],
  ];
  const TOKEN = "svc/token+sentinel==with.odd:chars-9f3a";
  process.env.A2A_PEER_TOKEN_TEST = TOKEN;
  try {
    for (const [how, echo] of echoes) {
      const p = await standardPeer({
        card: ({ origin }) => card(origin, [jsonrpc(`${origin}/rpc`)], { description: `card says ${echo(TOKEN)}` }),
        rpc: (req, res, seen) => {
          const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
          const said = echo(auth);
          const m = seen.rpc?.method;
          if (m === "GetTask") return rpcError(res, -32001, `no such task, and your token was ${said}`);
          const s = sse(res);
          s.event({ task: { id: "t-e", contextId: "c-e", status: { state: "TASK_STATE_WORKING", message: { parts: [{ text: `status ${said}` }] } } } });
          s.event({ artifactUpdate: { taskId: "t-e", artifact: { artifactId: "a", parts: [{ text: `artifact ${said}` }] } } });
          s.event({ statusUpdate: { taskId: "t-e", status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: `failure ${said}` }] } } } });
          s.end();
        },
      });
      registry([entry(p, { auth_env: "A2A_PEER_TOKEN_TEST" })]);
      const outs = [
        await call({ message: "x" }),
        await call({ mode: "get", task_id: "t" }),
        await call({ mode: "discover" }),
      ];
      for (const out of outs) assert.ok(!out.includes(echo(TOKEN)) && !out.includes(TOKEN), `${how}: the credential reached the result: ${out.slice(0, 200)}`);
      assert.match(outs[0], /artifact .*\[credential removed\]/, `${how}: the rest of what the peer said is still there`);
      assert.match(outs[1], /your token was .*\[credential removed\]/, how);
      assert.match(outs[2], /card says .*\[credential removed\]/, how);
    }
  } finally {
    delete process.env.A2A_PEER_TOKEN_TEST;
  }
});

test("the same holds for an identity token, which the peer is sent per call", async () => {
  const p = await standardPeer({
    rpc: (req, res) => {
      const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const s = sse(res);
      s.event({ task: { id: "t-i", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "a", parts: [{ text: `you are ${auth}` }] }] } });
      s.end();
    },
  });
  registry([entry(p, AUDIENCE_ENTRY)]);
  const out = await call({ message: "x" }, { identity: fakeIdentity(() => "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1In0.signature-sentinel"), userId: "u" });
  assert.ok(!out.includes("signature-sentinel"));
  assert.match(out, /you are \[credential removed\]/);
});

test("scrubCredentials removes every occurrence; a short credential only as a whole word, so ordinary text survives", () => {
  assert.equal(scrubCredentials("x SECRET-TOKEN-1 y SECRET-TOKEN-1", new Set(["SECRET-TOKEN-1"])), "x [credential removed] y [credential removed]");
  assert.equal(scrubCredentials("nothing here", new Set(["SECRET-TOKEN-1"])), "nothing here");
  // a short one (a weak operator secret) is still removed where it stands alone ...
  assert.equal(scrubCredentials("Authorization: Bearer abc.", new Set(["abc"])), "Authorization: Bearer [credential removed].");
  assert.equal(scrubCredentials('{"token":"abc"}', new Set(["abc"])), '{"token":"[credential removed]"}');
  assert.equal(scrubCredentials("Bearer YWJj", new Set(["abc"])), "Bearer [credential removed]");
  // ... and left alone inside a longer word
  assert.equal(scrubCredentials("abcdef and xabc", new Set(["abc"])), "abcdef and xabc");
  // a regex metacharacter in a short credential is not a pattern
  assert.equal(scrubCredentials("pw a.c and abc", new Set(["a.c"])), "pw [credential removed] and abc");
});

test("a peer echoing a SHORT service credential cannot put it in front of the model either", async () => {
  process.env.A2A_PEER_TOKEN_TEST = "abc";
  try {
    const p = await standardPeer({
      rpc: (req, res) => {
        const s = sse(res);
        s.event({ task: { id: "t-s", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "a", parts: [{ text: `Authorization: ${req.headers.authorization}` }] }] } });
        s.end();
      },
    });
    registry([entry(p, { auth_env: "A2A_PEER_TOKEN_TEST" })]);
    const out = parse(await call({ message: "x" }));
    assert.equal(out.text, "Authorization: Bearer [credential removed]");
  } finally {
    delete process.env.A2A_PEER_TOKEN_TEST;
  }
});

// ── Per-user entries (room for them) ────────────────────────────────────────

test("an entry with an owner is its owner's alone", () => {
  initA2ARegistry("shared=https://s.example");
  addPeer({ name: "mine", cardUrl: "https://m.example/c", allowLocal: false, owner: "alice" });
  assert.equal(resolvePeer("shared", "bob").name, "shared");
  assert.equal(resolvePeer("mine", "alice").name, "mine");
  assert.throws(() => resolvePeer("mine", "bob"), /Unknown agent "mine". Available: shared$/);
  assert.throws(() => resolvePeer("mine"), /Unknown agent "mine". Available: shared$/);
});

// ── A peer's approval request is the user's to answer ───────────────────────

test("an allow that answers a peer's approval request is held for the user; nothing else is", async () => {
  const hold = (input: Record<string, unknown>, tool = "a2a_call") => a2aApprovalHold(tool, input);
  assert.equal(hold({ approval: { action_id: "a", decision: "allow" } }), "a2a_peer_approval");
  assert.equal(hold({ approval: { action_id: "a", decision: "deny" } }), null, "a refusal needs no approval");
  assert.equal(hold({ message: "allow" }), null);
  assert.equal(hold({ approval: { action_id: "a", decision: "allow" } }, "bash"), null);

  const asked: string[] = [];
  const dispatcher = {
    register: async (r: { actionId: string }) => { asked.push(r.actionId); return { type: "decision", session_id: "s", action_id: r.actionId, decision: "deny" } as NatsDecisionMessage; },
  };
  const events: Array<Record<string, unknown>> = [];
  const hitl = new HitlController(dispatcher as never, async (e) => { events.push(e as never); }, { requireApprovalFor: a2aApprovalHold });
  const req = (input: Record<string, unknown>, id: string) => ({ sessionId: "s", actionId: id, tool: "a2a_call", input });

  const allow = await hitl.beforeToolUse(req({ agent: "p", task_id: "t", approval: { action_id: "x", decision: "allow" } }, "call-1"));
  assert.deepEqual(asked, ["call-1"], "the user was asked");
  assert.equal(allow.action, "deny", "and said no");
  assert.ok(events.some((e) => e.type === "permissionRequest" && e.approval_label === "a2a_peer_approval"));

  const plain = await hitl.beforeToolUse(req({ agent: "p", message: "hello" }, "call-2"));
  assert.equal(plain.action, "allow");
  assert.deepEqual(asked, ["call-1"], "an ordinary call asks nobody");

  const nobody = new HitlController(null, async () => {}, { requireApprovalFor: a2aApprovalHold });
  const r = await nobody.beforeToolUse(req({ agent: "p", task_id: "t", approval: { action_id: "x", decision: "allow" } }, "call-3"));
  assert.equal(r.action, "deny", "with no one to ask, an allow is not given");
});
