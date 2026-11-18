// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session's `placement.nodeLabels`, from `POST /v1/sessions` to the workload SaFE is sent.
 *
 * The real create route (PGlite), the execute request it publishes as Brain receives it
 * (a JSON round trip), Brain's real `ensureHands` and the real SaFE workload provider,
 * against a stand-in SaFE HTTP server that records every workload create body.
 *
 *   E1 no placement: no `placement` on the request and the create body has exactly the
 *      fields it always had, no `customerLabels`
 *   E2 a placement reaches SaFE as `customerLabels`, exactly
 *   E3 malformed and reserved placements are refused with 400 before any row, turn or workload
 *   E4 a sandbox rebuilt later in the session (a new Brain state, a later turn) keeps it
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// --- the stand-in SaFE --------------------------------------------------------------
const creates: Array<Record<string, unknown>> = [];
let nextId = 0;
const safe = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && url === "/api/v1/workloads") {
      creates.push(JSON.parse(raw) as Record<string, unknown>);
      res.end(JSON.stringify({ workloadId: `wl-${++nextId}` }));
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/v1/workloads/")) {
      res.end(JSON.stringify({ phase: "Running" }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/sandbox/")) {
      res.end(JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }));
      return;
    }
    if (req.method === "POST" && url.endsWith("/stop")) { res.end("{}"); return; }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((resolve) => safe.listen(0, "127.0.0.1", resolve));
const SAFE = `http://127.0.0.1:${(safe.address() as AddressInfo).port}`;
process.env.SAFE_API_URL = SAFE;
process.env.CLAW_DEPLOY_MODE = "safe";

const Fastify = (await import("fastify")).default;
const { db } = await import("../src/infra/db.js");
const { registerSessionRoutes } = await import("../src/routes/sessions.js");
const { sessionDispatchPorts, dispatchTaskToBrain } = await import("../src/sessions/dispatch.js");
const { startHarness } = await import("./scenario-harness.js");
const { closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");
const { ensureHands, bindSandboxReuseEffects } = await import("../../brain/src/sandbox/ensure-hands.js");
const { bindHandsKv } = await import("../../brain/src/sandbox/registry.js");
const { bindDagHandleKvForTest } = await import("../../brain/src/sandbox/handles.js");
import type { UserInfo } from "../src/auth/models.js";
import type { Harness } from "./scenario-harness.js";
import type { ExecuteRequest } from "@claw/protocol";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};
const PLACEMENT = { nodeLabels: { "autopilot.amd.com/preemptible": "false" } };
/** Every field the workload create body carried before `customerLabels` existed. */
const BODY_FIELDS = [
  "displayName", "env", "groupVersionKind", "images", "labels", "priority", "resources",
  "timeout", "ttlSecondsAfterFinished", "workspace",
];

let h: Harness;
let pristinePorts: Record<string, unknown> | null = null;
let originalConnect: typeof db.pool.connect;
let published: Array<Record<string, unknown>> = [];
let realFetch: typeof globalThis.fetch;
const restores: Array<() => void> = [];

/** A fresh Brain-side state: what a later turn meets after the sandbox was reclaimed. */
function freshBrainState(): void {
  let stored: Uint8Array | null = null;
  bindHandsKv({
    async get(key: string) { return stored && key.startsWith("hands.") ? { key, value: stored, revision: 1 } : null; },
    async put(_k: string, v: Uint8Array) { stored = v; return 1; },
    async update(_k: string, v: Uint8Array) { stored = v; return 2; },
    async delete() { stored = null; },
  } as never);
  const rows: Record<string, Uint8Array> = {};
  const revs: Record<string, number> = {};
  bindDagHandleKvForTest({
    async get(key: string) { return rows[key] ? { key, value: rows[key], revision: revs[key], operation: "PUT" } : null; },
    async create(key: string, value: Uint8Array) {
      if (rows[key]) throw new Error("wrong last sequence: key exists");
      rows[key] = value; revs[key] = 1; return 1;
    },
    async update(key: string, value: Uint8Array, rev: number) {
      if (revs[key] !== rev) throw new Error("wrong last sequence");
      rows[key] = value; revs[key] = rev + 1; return revs[key];
    },
    async delete(key: string) { delete rows[key]; delete revs[key]; },
    async keys() { return (async function* () { for (const k of Object.keys(rows)) yield k; })(); },
  } as never);
}

before(async () => {
  h = await startHarness();
  pristinePorts = { ...sessionDispatchPorts };
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
  // SaFE is the stand-in server; Hands' own health endpoint (cluster DNS) answers ok.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(SAFE) ? realFetch(input, init) : new Response("ok", { status: 200 });
  }) as typeof fetch;
  restores.push(bindSandboxReuseEffects({ registerSandbox: () => {} } as never));
});

beforeEach(async () => {
  await h.reset();
  Object.assign(sessionDispatchPorts, pristinePorts);
  published = [];
  creates.length = 0;
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
  freshBrainState();
});

after(async () => {
  for (const r of restores.reverse()) r();
  globalThis.fetch = realFetch;
  if (pristinePorts) Object.assign(sessionDispatchPorts, pristinePorts);
  db.pool.connect = originalConnect;
  await h?.close();
  await new Promise<void>((resolve) => safe.close(() => resolve()));
});

async function app() {
  const a = Fastify();
  a.addHook("preHandler", async (req) => { (req as unknown as { user: UserInfo }).user = OWNER; });
  await registerSessionRoutes(a);
  await a.ready();
  return a;
}

const MESSAGE = {
  content: "run the release test", workspaceId: "ws-test", image: "registry.example/img:1",
  resource: { cpu: "1", memory: "4Gi", ephemeralStorage: "20Gi" }, timeout: 900,
};

/** POST /v1/sessions, then hand the published request to Brain, as the wire would. */
async function createAndProvision(payload: Record<string, unknown>): Promise<{ sessionId: string; request: ExecuteRequest }> {
  const a = await app();
  try {
    const res = await a.inject({ method: "POST", url: "/v1/sessions", payload });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(published.length, 1, "the first turn was not published");
    const request = JSON.parse(JSON.stringify(published[0])) as ExecuteRequest;
    const sessionId = (res.json() as { data: { session_id: string } }).data.session_id;
    await ensureHands(sessionId, request, request.platform_key ?? "", async () => {});
    return { sessionId, request };
  } finally {
    await a.close();
  }
}

test("E1 no placement: no request field, and the workload body SaFE gets is unchanged", async () => {
  const { sessionId, request } = await createAndProvision({ name: "plain", message: MESSAGE });
  assert.equal("placement" in request, false, "a session with no placement put one on the request");
  const cfg = (await h.sql("SELECT config FROM claw_sessions WHERE session_id = $1", [sessionId]))[0].config;
  assert.equal("placement" in (cfg as object), false, "nothing is stored for a session with no placement");
  assert.equal(creates.length, 1, "the sandbox was not created");
  assert.deepEqual(Object.keys(creates[0]).sort(), BODY_FIELDS);
  assert.equal("customerLabels" in creates[0], false);
});

test("E1 an empty placement is no placement", async () => {
  for (const placement of [null, {}, { nodeLabels: {} }]) {
    published = []; creates.length = 0; freshBrainState();
    const { request } = await createAndProvision({ name: "empty", placement, message: MESSAGE });
    assert.equal("placement" in request, false, JSON.stringify(placement));
    assert.deepEqual(Object.keys(creates[0]).sort(), BODY_FIELDS, JSON.stringify(placement));
  }
});

test("E2 a placement reaches SaFE as customerLabels, exactly", async () => {
  const placement = { nodeLabels: { "autopilot.amd.com/preemptible": "false", "example.com/pool": "reserved" } };
  const { sessionId, request } = await createAndProvision({ name: "placed", placement, message: MESSAGE });
  assert.deepEqual(request.placement, placement);
  const cfg = (await h.sql("SELECT config FROM claw_sessions WHERE session_id = $1", [sessionId]))[0].config;
  assert.deepEqual((cfg as Record<string, unknown>).placement, placement, "the placement is kept with the session");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].customerLabels, placement.nodeLabels);
  assert.deepEqual(Object.keys(creates[0]).filter((k) => k !== "customerLabels").sort(), BODY_FIELDS,
    "nothing else in the body changed");
});

test("E2 a session created without a message keeps the placement for its first turn", async () => {
  const a = await app();
  try {
    const res = await a.inject({ method: "POST", url: "/v1/sessions", payload: { name: "later", placement: PLACEMENT } });
    assert.equal(res.statusCode, 200, res.body);
    const sessionId = (res.json() as { data: { session_id: string } }).data.session_id;
    const cfg = (await h.sql("SELECT config FROM claw_sessions WHERE session_id = $1", [sessionId]))[0].config;
    assert.deepEqual((cfg as Record<string, unknown>).placement, PLACEMENT);
  } finally {
    await a.close();
  }
});

const REFUSED: Array<[string, unknown, RegExp]> = [
  ["a value with a space", { nodeLabels: { "example.com/pool": "a b" } }, /is not a label value/],
  ["a boolean value", { nodeLabels: { "autopilot.amd.com/preemptible": false } }, /must be a string/],
  ["a malformed key", { nodeLabels: { "Bad Key": "v" } }, /is not a label key/],
  ["too many entries", { nodeLabels: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v"])) }, /at most 8/],
  ["an unknown field", { nodeSelector: { a: "b" } }, /not a known field/],
  ["not an object", "autopilot.amd.com/preemptible=false", /must be an object/],
  ["the hostname key", { nodeLabels: { "kubernetes.io/hostname": "node-1" } }, /reserved by the platform/],
  ["the specified-nodes key", { nodeLabels: { "specified-nodes": "node-1" } }, /reserved by the platform/],
  ["the excluded-nodes key", { nodeLabels: { "excluded-nodes": "node-1" } }, /reserved by the platform/],
  ["the workspace id label", { nodeLabels: { "primus-safe.workspace.id": "other" } }, /reserved by the platform/],
  ["the external workspace label", { nodeLabels: { "autopilot.amd.com/w": "other" } }, /reserved by the platform/],
];

for (const [label, placement, message] of REFUSED) {
  test(`E3 refuses ${label} with 400, and nothing is created`, async () => {
    const a = await app();
    try {
      const res = await a.inject({ method: "POST", url: "/v1/sessions", payload: { name: "bad", placement, message: MESSAGE } });
      assert.equal(res.statusCode, 400, res.body);
      const body = res.json() as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.match(body.error, /^placement/);
      assert.match(body.error, message);
      assert.equal(Number((await h.sql("SELECT count(*)::int AS n FROM claw_sessions"))[0].n), 0);
      assert.equal(published.length, 0);
      assert.equal(creates.length, 0);
    } finally {
      await a.close();
    }
  });
}

test("E3 config.placement is server-managed: the unchecked door is closed", async () => {
  const a = await app();
  try {
    const res = await a.inject({
      method: "POST", url: "/v1/sessions",
      payload: { name: "s", config: { placement: { nodeLabels: { "kubernetes.io/hostname": "node-1" } } }, message: MESSAGE },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, "config.placement is server-managed");
    assert.equal(creates.length, 0);
  } finally {
    await a.close();
  }
});

test("E4 a sandbox rebuilt later in the session keeps the placement", async () => {
  const { sessionId, request } = await createAndProvision({ name: "rebuild", placement: PLACEMENT, message: MESSAGE });
  assert.deepEqual(creates.at(-1)?.customerLabels, PLACEMENT.nodeLabels);

  // The same run loses its sandbox and Brain builds another from the same request.
  freshBrainState();
  await ensureHands(sessionId, request, "pk", async () => {});
  assert.equal(creates.length, 2, "the sandbox was not rebuilt");
  assert.deepEqual(creates[1].customerLabels, PLACEMENT.nodeLabels, "the rebuild within the run dropped it");

  // A later turn, after the sandbox was reclaimed: the request is built again from the session.
  await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [sessionId]);
  published = [];
  const result = await dispatchTaskToBrain(
    {
      sessionId, userId: OWNER.userId, user: OWNER, content: "again", messageType: "text",
      toolIds: [], pluginId: undefined, requestImage: MESSAGE.image, requestResource: MESSAGE.resource,
      requestTimeout: MESSAGE.timeout, workspaceId: MESSAGE.workspaceId, mcpServers: undefined,
      capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
    },
    async () => assert.fail("unexpected rollback"),
  );
  assert.equal(result.kind, "dispatched");
  const later = JSON.parse(JSON.stringify(published[0])) as ExecuteRequest;
  assert.deepEqual(later.placement, PLACEMENT, "the later turn's request lost the placement");
  freshBrainState();
  await ensureHands(sessionId, later, "pk", async () => {});
  assert.equal(creates.length, 3);
  assert.deepEqual(creates[2].customerLabels, PLACEMENT.nodeLabels, "the rebuilt sandbox lost the placement");
});
