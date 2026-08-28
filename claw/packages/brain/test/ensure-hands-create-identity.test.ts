// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The identity the create path hands back is what stops a DAG node addressing
 * its sibling's sandbox, and nothing was watching it.
 *
 * `EnsureHandsResult.identity` is optional, so dropping it from either create
 * return is type-legal, and no test drove `ensureHands` at all -- the reuse
 * producer was pinned, both create producers were not. Losing it there is
 * silent and total: the caller falls back to the session-wide `hands.<id>`
 * key, which every sibling on the session shares, so a node's probe answers
 * about whichever sibling wrote last and its rebuild stops that sibling's
 * live workload. That is the failure the identity-scoping work exists to end.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import {
  bindSandboxReuseEffects,
  ensureHands,
  type SandboxEntry,
} from "../src/sandbox/ensure-hands.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";
import type { ExecuteRequest } from "@claw/protocol";

const sc = StringCodec();
const SESSION = "sess-create";

let restores: Array<() => void> = [];
let realFetch: typeof globalThis.fetch;

afterEach(() => {
  for (const r of restores.reverse()) if (typeof r === "function") r();
  restores = [];
  if (realFetch) globalThis.fetch = realFetch;
});

/** A KV that echoes what was written, so the ready-verify passes first try. */
function echoKv(): { kv: KV; last: () => Record<string, unknown> | null } {
  let stored: Uint8Array | null = null;
  const kv = {
    async get(key: string) {
      if (!stored || !key.startsWith("hands.")) return null;
      return { key, value: stored, revision: 1 };
    },
    async put(_key: string, value: Uint8Array) { stored = value; return 1; },
    async update(_key: string, value: Uint8Array) { stored = value; return 2; },
    async delete() {},
  } as unknown as KV;
  return {
    kv,
    last: () => (stored ? JSON.parse(sc.decode(stored)) as Record<string, unknown> : null),
  };
}

/** A provider whose sandbox comes up cleanly on the first try. */
function stubProvider(): void {
  const provider = {
    kind: "safe-workload",
    async create() {
      return {
        provider: "safe-workload", id: "wl-created", sandboxName: "wl-created",
        namespace: "ns-test", handsBaseUrl: "", platformKey: "pk",
      };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
}

const REQUEST = {
  task_id: "task-1",
  sandbox_spec: {
    handle: "main",
    image: "registry.test/img:1",
    resources: { cpu: "1", memory: "1Gi" },
  },
} as unknown as ExecuteRequest;

test("the create path returns the identity it registered", async () => {
  const { kv } = echoKv();
  bindHandsKv(kv); // returns void, unlike the other seams
  stubProvider();

  let registered: SandboxEntry | undefined;
  restores.push(bindSandboxReuseEffects({
    registerSandbox: (_sid: string, entry: SandboxEntry) => { registered = entry; },
  }));

  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  const res = await ensureHands(SESSION, REQUEST, "pk", async () => {});

  assert.ok(res.created, "the request asked for a new sandbox");
  assert.ok(registered, "create must register the sandbox it built");
  assert.deepEqual(res.identity, registered,
    "the caller has to be handed the same identity that was registered; without "
    + "it every later probe and teardown falls back to the session-wide key that "
    + "DAG siblings share");
  assert.equal(res.identity?.workloadId, "wl-created");
});

test("the caller's abort signal reaches the reuse path", async () => {
  // The plumb is pinned at both ends and was unpinned in the middle: the
  // option is declared and documented on EnsureHandsOptions, and
  // tryReuseSessionSandbox forwards whatever it is given, but nothing checked
  // that ensureHands actually hands one to the other. Delete that one argument
  // and the reuse health check, the probe and a full kill-and-relaunch of
  // Hands all become uncancellable -- inside a container another replica may
  // already be tearing down, which is the hazard the option exists for.
  //
  // The entry is grown by a real create rather than hand-built, so the spec
  // fingerprint is whatever production would have written.
  const { kv } = echoKv();
  bindHandsKv(kv);
  stubProvider();

  let healthy = true;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("ok", { status: healthy ? 200 : 503 })) as unknown as typeof fetch;

  let seen: AbortSignal | undefined;
  let probed = false;
  restores.push(bindSandboxReuseEffects({
    registerSandbox: () => {},
    probeSandboxContainer: async (_sid: string, _entry: unknown, signal?: AbortSignal) => {
      probed = true;
      seen = signal;
      return { verdict: "unknown", reason: "exec_unreachable" };
    },
  } as never));

  await ensureHands(SESSION, REQUEST, "pk", async () => {});

  // Second turn on the same session: the entry is now reusable, and its Hands
  // has stopped answering, so the reuse path probes before deciding anything.
  healthy = false;
  const ctrl = new AbortController();
  await ensureHands(SESSION, REQUEST, "pk", async () => {}, undefined, { signal: ctrl.signal })
    .catch(() => { /* an unknown verdict refuses the reuse; the plumb is the point */ });

  assert.ok(probed, "the unhealthy reuse has to reach the probe, or this proves nothing");
  assert.equal(seen, ctrl.signal,
    "the caller's signal must reach the reuse path; without it a cancelled "
    + "task keeps restarting Hands in a container that may be going away");
});

test("the created entry records the scope the run lease is keyed by", async () => {
  // The reclaim sweeper has to ask "is a run holding this?", and the lease is
  // under `dag_root_task_id` when the run has one. Nothing in the entry could
  // tell it that, so a sweeper guessing the session id looks under a key that
  // does not exist -- and deletes the multi-node cluster the DAG is using.
  const { kv, last } = echoKv();
  bindHandsKv(kv);
  stubProvider();
  restores.push(bindSandboxReuseEffects({ registerSandbox: () => {} }));

  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  const dagRequest = {
    ...REQUEST,
    session_id: SESSION,
    dag_root_task_id: "dag-root-1",
  } as unknown as ExecuteRequest;
  await ensureHands(SESSION, dagRequest, "pk", async () => {});

  assert.equal(last()?.runScope, "dag-root-1",
    "without this the sweeper cannot find the lease that says the run is live");
});

test("a workspace-bound run records the workspace lock key, not its session", async () => {
  // The shape a live cluster actually shows. RUN_GATE_KEY defaults to
  // "workspace", so a run holding files takes `lock.ws.<workspaceId>` -- the
  // session id names no key at all. A guard built on the session, or on
  // pickRunScope, finds nothing here and lets the reclaim through, which is
  // the whole failure it was written to stop.
  const { kv, last } = echoKv();
  bindHandsKv(kv);
  stubProvider();
  restores.push(bindSandboxReuseEffects({ registerSandbox: () => {} }));

  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  const wsRequest = {
    ...REQUEST,
    session_id: SESSION,
    files_workspace_id: "kws_TEST123",
  } as unknown as ExecuteRequest;
  await ensureHands(SESSION, wsRequest, "pk", async () => {});

  assert.equal(last()?.runScope, "ws.kws_TEST123",
    "the lease is under the workspace; recording anything else makes the guard inert");
});
