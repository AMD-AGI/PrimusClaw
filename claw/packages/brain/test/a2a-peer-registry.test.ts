// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `a2a_call` reaches only operator-configured peers, and the only credential a
 * peer ever sees is its own. The model used to be able to name any http(s) URL,
 * and the request went out with the user's LLM key (or the platform key) as its
 * bearer token: a prompt-injected model could hand that key to any host, or
 * aim the call at an address inside the cluster.
 *
 * The peers here are real HTTP servers, and every assertion about what left the
 * process reads what the server received, not what the code meant to send.
 */
import "./a2a-client-env.js";
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  A2A_PEER_TOKEN_PREFIX, handleA2ACall, initA2ARegistry, isLocalAddress, parseA2AAgents,
} from "../src/clients/a2a.js";
import { ToolRouter } from "../src/tools/router.js";

// ── A fake peer that records exactly what it was sent ──────────────────────

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

interface FakePeer { port: number; seen: Seen[]; close(): Promise<void> }

async function startPeer(onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean): Promise<FakePeer> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (onRequest?.(req, res)) return;
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "fake-peer", description: "", version: "1", capabilities: {}, skills: [] }));
        return;
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { id?: number; method?: string };
      if (rpc.method === "SendStreamingMessage") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { artifactUpdate: { artifact: { parts: [{ text: "hello from peer" }] } } } })}\n\n`);
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } } } })}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { task: { id: "t-1", status: { state: "TASK_STATE_SUBMITTED" } } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

// Stand-ins for what the old code sent: the user's own LLM key and the platform key.
const USER_LLM_KEY = "sk-USER-LLM-KEY-sentinel-4f1c";
const PLATFORM_KEY = "pk-PLATFORM-KEY-sentinel-9b27";
const PEER_TOKEN = "peer-own-token-sentinel-77aa";

const ENV_KEYS = ["ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "PLATFORM_KEY", "LLM_API_KEY", "A2A_PEER_TOKEN_TEST", "A2A_PEER_TOKEN_EMPTY"];
let saved: Record<string, string | undefined>;
const peers: FakePeer[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ANTHROPIC_AUTH_TOKEN = USER_LLM_KEY;
  process.env.OPENAI_API_KEY = USER_LLM_KEY;
  process.env.LLM_API_KEY = USER_LLM_KEY;
  process.env.PLATFORM_KEY = PLATFORM_KEY;
  process.env.A2A_PEER_TOKEN_TEST = PEER_TOKEN;
  process.env.A2A_PEER_TOKEN_EMPTY = "";
});

afterEach(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await Promise.all(peers.splice(0).map((p) => p.close()));
  initA2ARegistry("");
});

async function peer(onRequest?: Parameters<typeof startPeer>[0]): Promise<FakePeer> {
  const p = await startPeer(onRequest);
  peers.push(p);
  return p;
}

const registry = (entries: unknown[]) => initA2ARegistry(JSON.stringify(entries));

// ── Raw URLs are refused ────────────────────────────────────────────────────

test("a raw URL is refused, whatever it points at, and nothing is sent", async () => {
  const p = await peer();
  registry([{ name: "good", url: `http://127.0.0.1:${p.port}`, allow_local: true }]);
  const table: Array<[string, string]> = [
    ["the registered peer's own URL", `http://127.0.0.1:${p.port}`],
    ["a loopback URL", `http://127.0.0.1:${p.port}/a2a`],
    ["an attacker's https URL", "https://attacker.example.invalid/collect"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["an upper-case scheme", `HTTP://127.0.0.1:${p.port}`],
    ["a cluster-internal service name", "http://claw-api.claw.svc.cluster.local:3000"],
  ];
  for (const [what, agent] of table) {
    for (const mode of ["stream", "fire_and_forget", "discover"]) {
      const out = await handleA2ACall({ agent, message: "hi", mode });
      assert.match(out, /not a URL/, `${what} (${mode}) must be refused as a URL: ${out}`);
      assert.match(out, /Available: good/, `${what} (${mode}): the model is told the configured names`);
    }
  }
  assert.equal(p.seen.length, 0, "the peer received nothing for any raw URL");
});

test("an unknown name is refused with the configured names", async () => {
  registry([{ name: "good", url: "https://good.example.invalid" }]);
  const out = await handleA2ACall({ agent: "nope", message: "hi" });
  assert.match(out, /Unknown agent "nope"/);
  assert.match(out, /Available: good/);
});

test("with no peers configured the tool says so, and a URL still is not an answer", async () => {
  initA2ARegistry("");
  const out = await handleA2ACall({ agent: "http://127.0.0.1:1", message: "hi" });
  assert.match(out, /not a URL/);
  assert.match(out, /none configured/);
});

test("the router's a2a_call takes the same path: a URL through the tool is refused", async () => {
  const p = await peer();
  registry([{ name: "good", url: `http://127.0.0.1:${p.port}`, allow_local: true }]);
  const router = new ToolRouter(null);
  const out = await router.route("a2a_call", { agent: `http://127.0.0.1:${p.port}`, message: "hi" });
  assert.match(out, /not a URL/);
  assert.equal(p.seen.length, 0);
  const schema = router.getToolSchemas().find((t) => t.name === "a2a_call");
  assert.ok(schema);
  const agentDoc = (schema.input_schema as { properties: { agent: { description: string } } }).properties.agent.description;
  assert.doesNotMatch(agentDoc, /full URL/, "the model is no longer invited to pass one");
});

// ── Credentials: only the peer's own ────────────────────────────────────────

// Header names undici itself adds. A header outside this set is something we added.
const TRANSPORT_HEADERS = new Set([
  "host", "connection", "content-type", "content-length", "accept", "accept-language",
  "sec-fetch-mode", "user-agent", "accept-encoding", "a2a-version",
]);

function assertNoForeignCredential(seen: Seen[], expectedAuthorization: string | undefined, what: string) {
  assert.ok(seen.length > 0, `${what}: the peer was reached`);
  for (const r of seen) {
    assert.equal(r.headers.authorization, expectedAuthorization, `${what}: Authorization on ${r.method} ${r.url}`);
    for (const [name, value] of Object.entries(r.headers)) {
      const v = String(value);
      assert.ok(!v.includes(USER_LLM_KEY), `${what}: the user's LLM key must not be in header ${name}`);
      assert.ok(!v.includes(PLATFORM_KEY), `${what}: the platform key must not be in header ${name}`);
      assert.ok(TRANSPORT_HEADERS.has(name) || name === "authorization", `${what}: unexpected header ${name}`);
    }
    assert.ok(!r.body.includes(USER_LLM_KEY) && !r.body.includes(PLATFORM_KEY), `${what}: no key in the body`);
  }
}

test("outbound headers carry no key of the user's: the captured header set, per mode and per peer", async () => {
  const table: Array<{ what: string; entry: Record<string, unknown>; expected: string | undefined }> = [
    { what: "a peer with no credential configured", entry: {}, expected: undefined },
    { what: "a peer with its own credential", entry: { auth_env: "A2A_PEER_TOKEN_TEST" }, expected: `Bearer ${PEER_TOKEN}` },
  ];
  for (const { what, entry, expected } of table) {
    for (const mode of ["stream", "fire_and_forget", "discover"]) {
      const p = await peer();
      registry([{ name: "p", url: `http://127.0.0.1:${p.port}`, allow_local: true, ...entry }]);
      const out = await handleA2ACall({ agent: "p", message: "hi", mode });
      assert.doesNotMatch(out, /failed/, `${what} / ${mode}: ${out}`);
      assertNoForeignCredential(p.seen, expected, `${what} / ${mode}`);
    }
  }
});

test("a registry peer works with its own credential: path, method and result", async () => {
  const p = await peer();
  registry([{ name: "ci", url: `http://127.0.0.1:${p.port}/`, auth_env: "A2A_PEER_TOKEN_TEST", allow_local: true }]);

  const streamed = JSON.parse(await handleA2ACall({ agent: "ci", message: "lint it" }));
  assert.equal(streamed.state, "completed");
  assert.equal(streamed.text, "hello from peer");
  const ff = JSON.parse(await handleA2ACall({ agent: "ci", message: "lint it", mode: "fire_and_forget" }));
  assert.equal(ff.state, "submitted");
  assert.equal(ff.task_id, "t-1");
  assert.match(await handleA2ACall({ agent: "ci", message: "x", mode: "discover" }), /"name": "fake-peer"/);

  // The card is read once and served from the cache after; the peer is then called where a bare-URL entry
  // always was (its card names no interface, so `<base>/a2a`).
  const [card, streamReq, ffReq] = p.seen;
  assert.equal(card.url, "/.well-known/agent-card.json");
  assert.equal(streamReq.url, "/a2a");
  assert.equal(JSON.parse(streamReq.body).method, "SendStreamingMessage");
  assert.equal(JSON.parse(streamReq.body).params.message.parts[0].text, "lint it");
  assert.equal(JSON.parse(ffReq.body).method, "SendMessage");
  assert.equal(p.seen.length, 3);
  for (const r of p.seen) assert.equal(r.headers.authorization, `Bearer ${PEER_TOKEN}`);
});

test("a peer naming an empty credential is not called unauthenticated", async () => {
  const p = await peer();
  registry([{ name: "p", url: `http://127.0.0.1:${p.port}`, auth_env: "A2A_PEER_TOKEN_EMPTY", allow_local: true }]);
  for (const mode of ["stream", "fire_and_forget", "discover"]) {
    const out = await handleA2ACall({ agent: "p", message: "hi", mode });
    assert.match(out, /A2A_PEER_TOKEN_EMPTY, which is empty/, mode);
  }
  assert.equal(p.seen.length, 0);
});

// ── Loopback / link-local ───────────────────────────────────────────────────

test("a peer on a loopback or link-local address is refused unless its entry allows it", async () => {
  const p = await peer();
  const port = p.port;
  const table: Array<[string, string]> = [
    ["IPv4 loopback literal", `http://127.0.0.1:${port}`],
    ["a name that resolves to loopback", `http://localhost:${port}`],
    ["the unspecified address", `http://0.0.0.0:${port}`],
    ["IPv4-mapped loopback", `http://[::ffff:127.0.0.1]:${port}`],
    ["IPv6 loopback", `http://[::1]:${port}`],
    ["decimal-encoded loopback", `http://2130706433:${port}`],
    ["the cloud metadata address", "http://169.254.169.254"],
    ["IPv6 link-local", "http://[fe80::1]:8080"],
  ];
  for (const [what, url] of table) {
    registry([{ name: "p", url }]);
    for (const mode of ["stream", "fire_and_forget", "discover"]) {
      const out = await handleA2ACall({ agent: "p", message: "hi", mode });
      assert.match(out, /loopback or link-local/, `${what} (${mode}) must be refused: ${out}`);
    }
  }
  assert.equal(p.seen.length, 0, "no refused peer was ever connected to");

  const textOf = async () => JSON.parse(await handleA2ACall({ agent: "p", message: "hi" })).text;
  registry([{ name: "p", url: `http://127.0.0.1:${port}`, allow_local: true }]);
  assert.equal(await textOf(), "hello from peer", "allow_local is the explicit exception");
  assert.equal(p.seen.length, 2, "the card, then the call");

  // The exception covers a name that resolves to loopback too, not only a literal.
  registry([{ name: "p", url: `http://localhost:${port}`, allow_local: true }]);
  assert.equal(await textOf(), "hello from peer");
  assert.equal(p.seen.length, 4);
});

test("isLocalAddress: loopback, link-local and unspecified only; private ranges stay reachable", () => {
  const table: Array<[string, boolean]> = [
    ["127.0.0.1", true], ["127.255.255.254", true], ["169.254.169.254", true], ["169.254.0.1", true],
    ["0.0.0.0", true], ["::1", true], ["::", true], ["fe80::1", true], ["febf::1", true],
    ["::ffff:127.0.0.1", true], ["::ffff:7f00:1", true], ["::ffff:a9fe:a9fe", true],
    ["64:ff9b::7f00:1", true], ["64:ff9b::a9fe:a9fe", true], ["64:ff9b::1", true],
    // the local-use NAT64 prefix (RFC 8215) lays the IPv4 address out around the u-octet:
    // 127.0.0.1, 169.254.169.254 and 0.0.0.1 below
    ["64:ff9b:1:7f00:0:100::", true], ["64:ff9b:1:a9fe:a9:fe00::", true], ["64:ff9b:1::100:0:0", true],
    ["64:ff9b:1:808:8:800::", false], ["64:ff9b::808:808", false],
    // an in-cluster peer lives in a private range, and the operator named it
    ["10.0.0.5", false], ["172.16.4.4", false], ["192.168.1.1", false], ["100.64.0.1", false],
    ["8.8.8.8", false], ["169.253.1.1", false], ["128.0.0.1", false],
    ["fc00::1", false], ["fd12::1", false], ["2001:db8::1", false], ["::ffff:10.0.0.5", false],
    ["not-an-ip", false], ["", false],
  ];
  for (const [addr, local] of table) assert.equal(isLocalAddress(addr), local, addr);
});

// ── Redirects ───────────────────────────────────────────────────────────────

test("a peer that redirects does not move the request somewhere the registry never named", async () => {
  const victim = await peer();
  for (const status of [302, 307, 308]) {
    const redirecting = await peer((_req, res) => {
      res.writeHead(status, { location: `http://127.0.0.1:${victim.port}/stolen` });
      res.end();
      return true;
    });
    registry([{ name: "p", url: `http://127.0.0.1:${redirecting.port}`, auth_env: "A2A_PEER_TOKEN_TEST", allow_local: true }]);
    for (const mode of ["stream", "fire_and_forget", "discover"]) {
      const out = await handleA2ACall({ agent: "p", message: "hi", mode });
      assert.match(out, /failed/, `${status} / ${mode}`);
    }
  }
  assert.equal(victim.seen.length, 0, "the redirect target received nothing");
});

// ── A2A_AGENTS parsing ──────────────────────────────────────────────────────

test("A2A_AGENTS parsing: both forms, and a bad entry is dropped and reported, never half-applied", () => {
  // What an entry becomes, written out: the keys a later reader may rely on.
  const peer = (over: Record<string, unknown>) => ({
    name: "", url: undefined, cardUrl: "", authEnv: undefined, audience: undefined, scope: undefined, allowLocal: false, ...over,
  });
  const legacy = parseA2AAgents("a=https://a.example/, b = http://b.svc:8080 ,c=https://c.example/x?y=1");
  assert.deepEqual(legacy.errors, []);
  assert.deepEqual(legacy.peers, [
    peer({ name: "a", url: "https://a.example", cardUrl: "https://a.example/.well-known/agent-card.json" }),
    peer({ name: "b", url: "http://b.svc:8080", cardUrl: "http://b.svc:8080/.well-known/agent-card.json" }),
    peer({ name: "c", url: "https://c.example/x?y=1", cardUrl: "https://c.example/x/.well-known/agent-card.json" }),
  ]);

  const json = parseA2AAgents(JSON.stringify([
    { name: "ci", url: "https://ci.example/", auth_env: "A2A_PEER_TOKEN_CI" },
    { name: "dev", url: "http://127.0.0.1:3000", allow_local: true },
    { name: "claw2", card_url: "https://claw.example/claw-api/a2a/plugins/7/.well-known/agent-card.json", audience: "claw-api", scope: "claw.api" },
  ]));
  assert.deepEqual(json.errors, []);
  assert.deepEqual(json.peers, [
    peer({ name: "ci", url: "https://ci.example", cardUrl: "https://ci.example/.well-known/agent-card.json", authEnv: "A2A_PEER_TOKEN_CI" }),
    peer({ name: "dev", url: "http://127.0.0.1:3000", cardUrl: "http://127.0.0.1:3000/.well-known/agent-card.json", allowLocal: true }),
    peer({
      name: "claw2", cardUrl: "https://claw.example/claw-api/a2a/plugins/7/.well-known/agent-card.json",
      audience: "claw-api", scope: "claw.api",
    }),
  ]);

  const bad: Array<[string, string]> = [
    ["a name that is itself a URL", JSON.stringify([{ name: "http://evil.example", url: "https://x.example" }])],
    ["a non-http scheme", JSON.stringify([{ name: "p", url: "file:///etc/passwd" }])],
    ["credentials embedded in the URL", JSON.stringify([{ name: "p", url: "https://user:secret@x.example" }])],
    ["an auth_env that is not a variable name", JSON.stringify([{ name: "p", url: "https://x.example", auth_env: "x; rm -rf /" }])],
    ["an allow_local that is not a boolean", JSON.stringify([{ name: "p", url: "https://x.example", allow_local: "yes" }])],
    ["a missing url", JSON.stringify([{ name: "p" }])],
    ["a null entry", "[null]"],
    ["a legacy entry without a URL", "p"],
    ["JSON that does not parse", "[{"],
    ["JSON that is not an array", "[1"],
  ];
  for (const [what, raw] of bad) {
    const r = parseA2AAgents(raw);
    assert.equal(r.peers.length, 0, `${what}: no peer is registered`);
    assert.equal(r.errors.length, 1, `${what}: one error is reported`);
  }
  const mixed = parseA2AAgents(JSON.stringify([{ name: "ok", url: "https://ok.example" }, { name: "bad name", url: "https://x.example" }]));
  assert.deepEqual(mixed.peers.map((p) => p.name), ["ok"], "one bad entry does not drop its neighbours");
  assert.equal(mixed.errors.length, 1);
});

// ── auth_env must name a variable set aside for peers ───────────────────────

test("auth_env must start with A2A_PEER_TOKEN_: any other variable is refused, with a message that says why", () => {
  const table: Array<[string, boolean]> = [
    // the deployment-wide secrets an entry could otherwise be pointed at
    ["ANTHROPIC_API_KEY", false], ["ANTHROPIC_AUTH_TOKEN", false], ["OPENAI_API_KEY", false],
    ["LLM_API_KEY", false], ["PLATFORM_KEY", false], ["DATABASE_URL", false], ["NATS_TOKEN", false],
    // near misses: the prefix must be the start of the name, whole, and in upper case
    ["A2A_PEER_TOKEN", false], ["A2A_PEER_TOKENS_CI", false], ["A2A_PEER_TOKE_CI", false],
    ["XA2A_PEER_TOKEN_CI", false], ["MY_A2A_PEER_TOKEN_CI", false], ["_A2A_PEER_TOKEN_CI", false],
    ["a2a_peer_token_ci", false], ["A2a_Peer_Token_CI", false],
    // not even a variable name stays refused for its own reason
    ["A2A_PEER_TOKEN_CI; rm -rf /", false], ["A2A_PEER_TOKEN_C-I", false],
    // the names an operator is told to use
    ["A2A_PEER_TOKEN_CI", true], ["A2A_PEER_TOKEN_DEV_1", true], ["A2A_PEER_TOKEN_x", true],
  ];
  for (const [authEnv, accepted] of table) {
    const r = parseA2AAgents(JSON.stringify([{ name: "ci", url: "https://ci.example", auth_env: authEnv }]));
    if (accepted) {
      assert.deepEqual(r.errors, [], authEnv);
      assert.deepEqual(r.peers.map((p) => p.authEnv), [authEnv], authEnv);
    } else {
      assert.equal(r.peers.length, 0, `${authEnv}: the peer is not registered`);
      assert.equal(r.errors.length, 1, `${authEnv}: one error is reported`);
      assert.match(r.errors[0], /peer "ci"/, `${authEnv}: the message names the peer`);
      assert.ok(r.errors[0].includes(authEnv) || /environment variable name/.test(r.errors[0]), `${authEnv}: the message names the variable`);
    }
  }
  // The refusals that are about the prefix say so, and say what to use instead.
  const r = parseA2AAgents(JSON.stringify([{ name: "ci", url: "https://ci.example", auth_env: "ANTHROPIC_API_KEY" }]));
  assert.match(r.errors[0], new RegExp(`must name a variable that starts with ${A2A_PEER_TOKEN_PREFIX}`));
  assert.match(r.errors[0], /A2A_PEER_TOKEN_CI/);
  assert.equal(A2A_PEER_TOKEN_PREFIX, "A2A_PEER_TOKEN_");
});

test("an entry whose auth_env names the user's or the platform key is never registered, so nothing reaches the peer", async () => {
  const p = await peer();
  // Both are set in the process (beforeEach) to the sentinels, exactly as a real deployment has them.
  for (const authEnv of ["ANTHROPIC_AUTH_TOKEN", "LLM_API_KEY", "PLATFORM_KEY"]) {
    registry([
      { name: "bad", url: `http://127.0.0.1:${p.port}`, allow_local: true, auth_env: authEnv },
      { name: "good", url: `http://127.0.0.1:${p.port}`, allow_local: true, auth_env: "A2A_PEER_TOKEN_TEST" },
    ]);
    for (const mode of ["stream", "fire_and_forget", "discover"]) {
      const out = await handleA2ACall({ agent: "bad", message: "hi", mode });
      assert.match(out, /Unknown agent "bad"/, `${authEnv} / ${mode}: ${out}`);
      assert.match(out, /Available: good/, `${authEnv} / ${mode}: its neighbour still loads`);
    }
    assert.equal(p.seen.length, 0, `${authEnv}: the peer received nothing`);
    // the neighbour with a conforming auth_env is called with its own token, and only that
    assert.equal(JSON.parse(await handleA2ACall({ agent: "good", message: "hi" })).text, "hello from peer");
    assertNoForeignCredential(p.seen.splice(0), `Bearer ${PEER_TOKEN}`, authEnv);
  }
});
