// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The AppRunner's session-level MCP (hosting design 5.8): the URL it builds, the
 * `initialize` probe, the registration only after the probe passes, and the
 * record's removal when the run ends. The application is a generic
 * Streamable-HTTP stub (support/mcp-stub.ts) behind a stand-in Router; the
 * runner is the real one over the fake world.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AppRunner } from "../src/apps/app-runner.js";
import { appMcpSeams, appMcpUrl, probeAppMcp } from "../src/apps/app-mcp.js";
import { World, MANIFEST, RUN_ID, TOKEN } from "./support/app-runner-world.js";
import { startMcpStub, type McpStub } from "./support/mcp-stub.js";

const HEADER = MANIFEST.mcp!.token_header; // X-App-Token
const MCP_PATH = MANIFEST.mcp!.path;
const PORT = MANIFEST.mcp!.port;
const PLATFORM_KEY = "pk";

function rig(base: () => string | null, opts: { routerAuth?: boolean; seamsOf?: ReturnType<typeof appMcpSeams> } = {}) {
  const world = new World(MANIFEST);
  const seams = opts.seamsOf ?? appMcpSeams({ routerBase: base, routerAuth: () => opts.routerAuth === true });
  const runner = new AppRunner(RUN_ID, PLATFORM_KEY, {
    store: world.store, sandbox: world.sandbox, seams, now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  return { world, runner, seams };
}

async function toRunning(r: ReturnType<typeof rig>, extraTicks = 0) {
  for (let i = 0; i < 12 && r.world.rec.state !== "running"; i++) await r.runner.reconcile();
  assert.equal(r.world.rec.state, "running");
  for (let i = 0; i < extraTicks; i++) await r.runner.reconcile();
}

/** A port nothing listens on. */
async function deadBase(): Promise<string> {
  const s = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  const base = s.base;
  await s.close();
  return base;
}

test("URL: Router port proxy for the manifest's port and path", () => {
  assert.equal(
    appMcpUrl("https://router.example.invalid/", "ws-1", "wl-1", { port: 8765, path: "/mcp" }),
    "https://router.example.invalid/v1/namespaces/ws-1/code-interpreters/wl-1/invocations/proxy/8765/mcp",
  );
  assert.equal(
    appMcpUrl("http://r/base", "ns a", "w/1", { port: 9, path: "/x/y" }),
    "http://r/base/v1/namespaces/ns%20a/code-interpreters/w%2F1/invocations/proxy/9/x/y",
  );
});

test("probe: success, wrong token, nothing listening, and an answer that is not initialize", async () => {
  const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  try {
    const url = appMcpUrl(stub.base, "ws-1", "wl-1", { port: PORT, path: MCP_PATH });
    const input = { url, tokenHeader: HEADER, token: TOKEN, sandboxSessionId: "wl-1", bearer: TOKEN };
    assert.deepEqual(await probeAppMcp(input), { kind: "ok" });
    const sent = stub.seen[0]!;
    assert.equal(sent.method, "POST");
    assert.equal(JSON.parse(sent.body).method, "initialize");
    assert.equal(sent.headers["x-app-token"], TOKEN);
    assert.equal(sent.headers["x-session-id"], "wl-1");

    assert.deepEqual(await probeAppMcp({ ...input, token: "wrong-token-0000000000" }), { kind: "auth_failed", status: 401 });
  } finally { await stub.close(); }

  const dead = await probeAppMcp({ url: appMcpUrl(await deadBase(), "ws-1", "wl-1", { port: PORT, path: MCP_PATH }), tokenHeader: HEADER, token: TOKEN, sandboxSessionId: "wl-1", bearer: TOKEN });
  assert.equal(dead.kind, "unreachable");

  const odd = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH, garbage: true });
  try {
    const v = await probeAppMcp({ url: appMcpUrl(odd.base, "ws-1", "wl-1", { port: PORT, path: MCP_PATH }), tokenHeader: HEADER, token: TOKEN, sandboxSessionId: "wl-1", bearer: TOKEN });
    assert.equal(v.kind, "bad_response");
  } finally { await odd.close(); }
});

test("probe verdicts never carry the token", async () => {
  const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  try {
    const v = await probeAppMcp({ url: appMcpUrl(stub.base, "ws-1", "wl-1", { port: PORT, path: MCP_PATH }), tokenHeader: HEADER, token: "wrong-token-0000000000", sandboxSessionId: "wl-1", bearer: "wrong-token-0000000000" });
    assert.ok(!JSON.stringify(v).includes("wrong-token-0000000000"));
  } finally { await stub.close(); }
});

test("running: the probe passes, the record is the URL and the sandbox id, and it is made once", async () => {
  const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  try {
    const r = rig(() => stub.base);
    await toRunning(r, 3);
    const wl = r.world.rec.sandbox_workload_id!;
    assert.deepEqual(r.world.mcpRecord, {
      url: `${stub.base}/v1/namespaces/ws-1/code-interpreters/${wl}/invocations/proxy/${PORT}${MCP_PATH}`,
      sandbox_session_id: wl,
    });
    assert.equal(stub.seen.length, 1, "one probe, not one per tick");
    assert.equal(stub.seen[0]!.headers["x-app-token"], TOKEN);
    // Nothing the record holds is a credential.
    assert.ok(!JSON.stringify(r.world.mcpRecord).includes(TOKEN));
  } finally { await stub.close(); }
});

test("Router auth off: the probe's bearer is the MCP token; on: the submitter's platform key", async () => {
  for (const routerAuth of [false, true]) {
    const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH, routerAuth: routerAuth ? { platformKey: PLATFORM_KEY } : undefined });
    try {
      const r = rig(() => stub.base, { routerAuth });
      await toRunning(r, 1);
      assert.ok(r.world.mcpRecord, `registered with routerAuth=${routerAuth}`);
      assert.equal(stub.seen[0]!.headers.authorization, `Bearer ${routerAuth ? PLATFORM_KEY : TOKEN}`);
      assert.equal(stub.seen[0]!.headers["x-app-token"], TOKEN, "the token header is the MCP token either way");
    } finally { await stub.close(); }
  }
});

test("auth failure: no record, and the probe is retried on a later tick", async () => {
  const stub = await startMcpStub({ tokenHeader: "X-Other-Header", token: TOKEN, path: MCP_PATH });
  try {
    const r = rig(() => stub.base);
    await toRunning(r, 2);
    assert.equal(r.world.mcpRecord, null);
    assert.ok(stub.seen.length >= 2, "retried");
  } finally { await stub.close(); }
});

test("unreachable: no record; once the application answers, the next tick registers", async () => {
  const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  const port = Number(new URL(stub.base).port);
  await stub.close();
  const r = rig(() => stub.base);
  await toRunning(r, 2);
  assert.equal(r.world.mcpRecord, null);
  const up = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH }, port);
  try {
    await r.runner.reconcile();
    assert.ok(r.world.mcpRecord, "registered once reachable");
  } finally { await up.close(); }
});

test("a manifest without mcp: nothing is probed or recorded", async () => {
  const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  try {
    const { mcp: _drop, ...rest } = MANIFEST;
    const world = new World({ ...rest, env_map: { ...rest.env_map, mcp_port: undefined, mcp_token: undefined } } as typeof MANIFEST);
    const runner = new AppRunner(RUN_ID, PLATFORM_KEY, {
      store: world.store, sandbox: world.sandbox, seams: appMcpSeams({ routerBase: () => stub.base }), now: world.now, sleep: world.sleep, tickMs: 5000,
    });
    for (let i = 0; i < 8; i++) await runner.reconcile();
    assert.equal(stub.seen.length, 0);
    assert.equal(world.mcpRecord, null);
  } finally { await stub.close(); }
});

test("cleanup: when the run ends the record is removed", async () => {
  const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  try {
    const r = rig(() => stub.base);
    await toRunning(r, 1);
    assert.ok(r.world.mcpRecord, "precondition: registered while running");
    await r.runner.finishNow("cancelled");
    assert.equal(r.world.rec.state, "ended");
    assert.equal(r.world.mcpRecord, null);
  } finally { await stub.close(); }
});

test("a lost sandbox is a new id: the record follows it", async () => {
  const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  try {
    const r = rig(() => stub.base);
    await toRunning(r, 1);
    const first = r.world.mcpRecord!.sandbox_session_id;
    r.world.killWorkload(first, "absent");
    for (let i = 0; i < 20 && r.world.mcpRecord?.sandbox_session_id === first; i++) await r.runner.reconcile();
    assert.ok(r.world.mcpRecord);
    assert.notEqual(r.world.mcpRecord!.sandbox_session_id, first);
  } finally { await stub.close(); }
});

test("a Brain that takes the run over registers again (the API upserts)", async () => {
  const stub = await startMcpStub({ tokenHeader: HEADER, token: TOKEN, path: MCP_PATH });
  try {
    const a = rig(() => stub.base);
    await toRunning(a, 1);
    const b = new AppRunner(RUN_ID, PLATFORM_KEY, {
      store: a.world.store, sandbox: a.world.sandbox, seams: appMcpSeams({ routerBase: () => stub.base }),
      now: a.world.now, sleep: a.world.sleep, tickMs: 5000,
    });
    await b.reconcile();
    assert.equal(stub.seen.length, 2);
  } finally { await stub.close(); }
});
