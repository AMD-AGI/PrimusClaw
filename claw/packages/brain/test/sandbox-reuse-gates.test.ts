// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The gates a live sandbox has to pass before a second message lands in it.
 *
 * The pure comparison is pinned next door in sandbox-spec-fingerprint.test.ts.
 * What is pinned here is the decision built on top of it, which is where the
 * behaviour this layer promises actually lives: readiness is read from the
 * recorded status rather than inferred, a spec that changed rebuilds and says
 * so, health is checked before reuse rather than assumed, and an inherited DAG
 * sandbox is probed before a node is told it has one.
 *
 * Every one of those is a decision to tear a running sandbox down or to keep
 * using it. Spec change / pending still reach `destroyHands`; corrupt or
 * unreachable ownership data stops safely. MCP `/health` failing does not,
 * unless the data-plane probe also says `dead` —
 * a container that still answers exec is kept, because Hands 9100 is not the
 * workload.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";

import {
  bindSandboxReuseEffects,
  requestSpecFingerprint,
  tryReuseSessionSandbox,
  assertDagHandleAlive,
} from "../src/sandbox/ensure-hands.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";

const realFetch = globalThis.fetch;
let restoreEffects: (() => void) | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEffects?.();
  restoreEffects = null;
});

/** The KV entry ensureHands writes, in the shape the reuse path reads back. */
interface Entry {
  status?: string;
  handsUrl?: string;
  token?: string;
  specFingerprint?: string;
  workloadId?: string;
  keepalive?: boolean;
  idleSince?: string;
  sessionDeleted?: boolean;
  provider?: string;
  sessionId?: string;
  sandboxName?: string;
  namespace?: string;
  userId?: string;
}

function fakeKv(entry: Entry | null): { kv: KV; puts: string[] } {
  const enc = new TextEncoder();
  const puts: string[] = [];
  const kv = {
    async get(key: string) {
      if (!entry || !key.startsWith("hands.")) return null;
      return { key, value: enc.encode(JSON.stringify(entry)), revision: 7 };
    },
    async put(_key: string, value: Uint8Array) {
      puts.push(new TextDecoder().decode(value));
      return 1;
    },
    async update(_key: string, value: Uint8Array, revision: number) {
      assert.equal(revision, 7);
      puts.push(new TextDecoder().decode(value));
      return 8;
    },
  };
  return { kv: kv as unknown as KV, puts };
}

/**
 * Answer every /health probe the same way, and keep the URLs it was asked
 * about: which URL is probed is half of what the health gate promises, since
 * the entry records the MCP endpoint and the probe has to reach the health one.
 */
function stubHealth(answer: "ok" | "down" | "throw"): { probed: string[] } {
  const probed: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    probed.push(String(input));
    if (answer === "throw") throw new Error("ECONNREFUSED");
    return { ok: answer === "ok", status: answer === "ok" ? 200 : 503 } as Response;
  }) as typeof fetch;
  return { probed };
}

/** What `registerSandbox` was handed, which is what keepalive later addresses. */
interface Registration {
  sessionId: string;
  target: Record<string, unknown>;
}

/** Record the teardown and keepalive registration instead of performing them. */
function stubEffects(
  probe: "alive" | "dead" | "unknown" = "dead",
  restartOk = true,
  /** When set, the restart refuses (never attempts) with this detail. */
  refusal?: string,
): {
  destroyed: string[];
  registered: Registration[];
  restartCalls: number[];
} {
  const destroyed: string[] = [];
  const registered: Registration[] = [];
  const restartCalls: number[] = [];
  restoreEffects = bindSandboxReuseEffects({
    destroyHands: async (sessionId: string) => { destroyed.push(sessionId); },
    registerSandbox: ((sessionId: string, target: Record<string, unknown>) => {
      registered.push({ sessionId, target });
    }) as never,
    probeSandboxContainer: async () => ({ verdict: probe, reason: "exec_ok" as const }),
    restartHandsInSandbox: async () => {
      restartCalls.push(1);
      if (refusal) return { ok: false, detail: refusal, refused: true };
      return { ok: restartOk, detail: restartOk ? "healthy" : "started_but_unhealthy" };
    },
  });
  return { destroyed, registered, restartCalls };
}

/** The session ids passed to `registerSandbox`, for the cases that only count. */
function registeredIds(registered: Registration[]): string[] {
  return registered.map((r) => r.sessionId);
}

const REQUEST: ExecuteRequest = {
  session_id: "s-1",
  prompt: "carry on",
  sandbox_image: "example.io/torch:2.4",
};

function specOf(request: ExecuteRequest = REQUEST): string {
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create", "this fixture has to describe a sandbox to build");
  return requestSpecFingerprint(request, action as never);
}

function attempt(
  entry: Entry | null,
  over: Partial<Parameters<typeof tryReuseSessionSandbox>[0]> = {},
) {
  const events: Array<Record<string, unknown>> = [];
  const { kv, puts } = fakeKv(entry);
  const a = {
    kv,
    sessionId: "s-1",
    request: REQUEST,
    requestedSpec: specOf(),
    onEvent: async (evt: Record<string, unknown>) => { events.push(evt); },
    ...over,
  } as Parameters<typeof tryReuseSessionSandbox>[0];
  return { a, events, puts };
}

const LIVE: Entry = {
  status: "ready",
  handsUrl: "http://hands.test:9100/mcp",
  token: "tok-existing",
  workloadId: "wl-1",
};

test("a sandbox built for this request, and answering, is handed straight back", async () => {
  const { destroyed, registered } = stubEffects();
  const { probed } = stubHealth("ok");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  const result = await tryReuseSessionSandbox(a);

  assert.deepEqual(result, {
    handsUrl: "http://hands.test:9100/mcp",
    created: false,
    token: "tok-existing",
    // The same identity keepalive was registered with. The caller needs it to
    // reach this sandbox later without going through `hands.<sessionId>`, which
    // a DAG's nodes share.
    identity: {
      provider: "safe-workload",
      workloadId: "wl-1",
      platformKey: "",
      sessionId: undefined,
      sandboxName: undefined,
      namespace: undefined,
      userId: undefined,
    },
  }, "the caller reuses the token it was given, and skips the S3 rehydrate");
  assert.deepEqual(destroyed, [], "nothing was wrong with it");
  assert.deepEqual(
    probed, ["http://hands.test:9100/health"],
    "the entry records the MCP endpoint; probing that instead answers 404 and "
    + "tears down a sandbox that was fine",
  );
  assert.deepEqual(
    registeredIds(registered), ["s-1"],
    "keepalive has to own it again or it is collected mid-turn",
  );
});

test("keepalive is re-registered against the sandbox that is actually there", async () => {
  // Not just "it was registered": keepalive addresses the provider, name and
  // namespace it is handed here, and a default substituted for any of them
  // polls something that does not exist while the real sandbox ages out.
  const { registered } = stubEffects();
  stubHealth("ok");
  const { a } = attempt({
    ...LIVE,
    specFingerprint: specOf(),
    provider: "agent-sandbox",
    sessionId: "sbx-77",
    sandboxName: "hands-s-1",
    namespace: "team-a",
    userId: "u-9",
  });

  assert.ok(await tryReuseSessionSandbox(a));
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0]!.target, {
    provider: "agent-sandbox",
    workloadId: "wl-1",
    platformKey: "",
    sessionId: "sbx-77",
    sandboxName: "hands-s-1",
    namespace: "team-a",
    userId: "u-9",
  }, "every field keepalive needs comes from the entry, not from a default");
});

test("a spec that changed rebuilds, and the user is told why", async () => {
  // The whole point of the fingerprint: without the event a rebuild looks from
  // the outside like an unexplained slow turn, and the cause is something the
  // user just did.
  const { destroyed } = stubEffects();
  stubHealth("ok");
  const { a, events } = attempt({
    ...LIVE,
    specFingerprint: specOf().replace(/:[0-9a-f]+$/, ":ffffffffffffffff"),
  });

  assert.equal(await tryReuseSessionSandbox(a), null, "the caller must build a new one");
  assert.deepEqual(destroyed, ["s-1"], "the old workload is ours to collect before we replace it");
  const rebuild = events.find((e) => e.event === "rebuild");
  assert.ok(rebuild, "a rebuild the user caused is a rebuild the user gets told about");
  assert.equal(rebuild.reason, "spec_changed");
  assert.equal(rebuild.status, "recreating");
});

test("a sandbox that stopped answering is torn down rather than handed over", async () => {
  // Readiness used to be inferred from the pod phase, so a Hands that had died
  // inside a running pod was reused and the turn failed on its first tool call.
  // That is still right when the data plane agrees the container is gone.
  for (const answer of ["down", "throw"] as const) {
    const { destroyed } = stubEffects("dead");
    stubHealth(answer);
    const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

    assert.equal(await tryReuseSessionSandbox(a), null, `health ${answer} is not reusable`);
    assert.deepEqual(destroyed, ["s-1"]);
    restoreEffects?.();
    restoreEffects = null;
  }
});

test("Hands MCP down restarts in a live container and never destroys it", async () => {
  // The Hyperloom recurrence: in-flight rebuild correctly skips, the user
  // retries, ensureHands saw /health fail and SIGTERM'd the holder. The
  // data-plane probe is the same gate the rebuild path already uses.
  const { destroyed, registered, restartCalls } = stubEffects("alive");
  stubHealth("throw");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  const result = await tryReuseSessionSandbox(a);
  assert.deepEqual(result, {
      handsUrl: "http://hands.test:9100/mcp",
      created: false,
      token: "tok-existing",
      // Same identity as the healthy path: a caller that gets a sandbox whose
      // Hands is down is the one that most needs to name it, since restarting
      // Hands in place has to reach this container and not a DAG sibling's.
      identity: {
        provider: "safe-workload",
        workloadId: "wl-1",
        platformKey: "",
        sessionId: undefined,
        sandboxName: undefined,
        namespace: undefined,
        userId: undefined,
      },
    }, "an alive probe must keep the pod and repair its Hands");
  assert.deepEqual(destroyed, []);
  assert.deepEqual(registeredIds(registered), ["s-1"]);
  assert.equal(restartCalls.length, 1);
});

test("unknown container state returns no unusable Hands client and destroys nothing", async () => {
  const { destroyed, registered, restartCalls } = stubEffects("unknown");
  stubHealth("throw");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  await assert.rejects(() => tryReuseSessionSandbox(a), /container state is unknown/);
  assert.deepEqual(destroyed, []);
  assert.deepEqual(registered, []);
  assert.deepEqual(restartCalls, []);
});

test("failed in-place restart returns no unusable Hands client", async () => {
  const { destroyed, registered, restartCalls } = stubEffects("alive", false);
  stubHealth("throw");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  await assert.rejects(() => tryReuseSessionSandbox(a), /live sandbox was left intact/);
  assert.deepEqual(destroyed, []);
  assert.deepEqual(registered, []);
  assert.equal(restartCalls.length, 1);
});

test("a healthy sandbox with no token is no more usable than a dead one", async () => {
  // The token is how Brain talks to it. Reusing the URL without one produces a
  // 401 on the first call, which reads like an auth bug rather than a lost
  // sandbox.
  const { destroyed } = stubEffects();
  stubHealth("ok");
  const { a } = attempt({ ...LIVE, token: "", specFingerprint: specOf() });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"]);
});

test("an entry that never reached ready is cleaned up, not resumed", async () => {
  const { destroyed } = stubEffects();
  stubHealth("ok");
  const { a } = attempt({ ...LIVE, status: "pending", specFingerprint: specOf() });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"], "a pending entry names a workload that may well exist");
});

test("a multi-node turn always gets a fresh sandbox, however healthy the old one is", async () => {
  // Cluster env is baked in at create and Hands never reloads it, so a sandbox
  // built for a single-node turn cannot serve a multi-node one -- and the check
  // has to come before the spec comparison, which knows nothing about clusters.
  const { destroyed } = stubEffects();
  stubHealth("ok");
  const { a } = attempt(
    { ...LIVE, specFingerprint: specOf() },
    { multiNodeContext: { clusterId: "c-1" } as never },
  );

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"]);
});

test("reactivating an idle sandbox clears the marker that had it collected", async () => {
  // Reuse after a task went idle: the keepalive ticker stops owning an entry
  // marked `keepalive:false`, so reusing one without clearing the marker gets
  // the sandbox collected out from under the turn that just claimed it.
  stubEffects();
  stubHealth("ok");
  const { a, puts } = attempt({
    ...LIVE, specFingerprint: specOf(), keepalive: false, idleSince: "2026-01-01T00:00:00Z",
  });

  assert.ok(await tryReuseSessionSandbox(a));
  assert.equal(puts.length, 1, "the marker is only rewritten when there is one to clear");
  const written = JSON.parse(puts[0]);
  assert.ok(!("keepalive" in written) && !("idleSince" in written));
});

test("reusing a sandbox with nothing to clear writes nothing at all", async () => {
  // The write only ever existed to clear the idle markers. Doing it anyway on
  // an entry that has none buys nothing -- winning a CAS reserves nothing, and
  // the TTL is refreshed every ten seconds by the run-lease heartbeat -- while
  // giving every reuse one more way to fail.
  stubEffects();
  stubHealth("ok");
  const { a, puts } = attempt({ ...LIVE, specFingerprint: specOf() });

  assert.ok(await tryReuseSessionSandbox(a));
  assert.equal(puts.length, 0, "an unchanged entry must not be rewritten");
});

/** A KV whose first `update` loses the race, then answers as `then` describes. */
function conflictingKv(entry: Entry, then: Entry): { kv: KV; puts: string[] } {
  const enc = new TextEncoder();
  const puts: string[] = [];
  let revision = 7;
  let current = entry;
  const kv = {
    async get(key: string) {
      if (!key.startsWith("hands.")) return null;
      return { key, value: enc.encode(JSON.stringify(current)), revision };
    },
    async update(_key: string, value: Uint8Array, expected: number) {
      // A real KV accepts exactly one revision: the current one. Accepting
      // anything that merely was not the first read let the retry write at a
      // revision it never re-read -- an off-by-one there would fail on every
      // real CAS while the suite stayed green.
      if (expected !== revision) {
        throw new Error(`wrong last sequence: ${expected}`);
      }
      if (revision === 7) {
        // Someone bumped it in the window: the TTL heartbeat, the ticker, or a
        // sibling. This is the throw that used to fail the whole turn.
        current = then;
        revision = 9;
        throw new Error("wrong last sequence: 7");
      }
      puts.push(new TextDecoder().decode(value));
      return ++revision;
    },
    async put() { return 1; },
  };
  return { kv: kv as unknown as KV, puts };
}

test("a lost CAS on the idle markers retries instead of failing the turn", async () => {
  // The revision is read before a health check, and on the recovery path before
  // a probe and a full Hands restart as well -- tens of seconds against a
  // heartbeat that fires every ten. Losing it is the common case, and the
  // sandbox that just passed its health check is still the right one to use.
  stubEffects();
  stubHealth("ok");
  const idle = {
    ...LIVE, specFingerprint: specOf(), keepalive: false, idleSince: "2026-01-01T00:00:00Z",
  };
  const { kv, puts } = conflictingKv(idle, { ...idle });
  const { a } = attempt(idle, { kv });

  const reused = await tryReuseSessionSandbox(a);
  assert.ok(reused, "a benign TTL bump must not cost the run its sandbox");
  assert.equal(puts.length, 1, "the retry writes once, at the revision it re-read");
  const written = JSON.parse(puts[0]!);
  assert.ok(!written.keepalive && written.idleSince == null,
    "the markers still have to come off, or the ticker collects the sandbox");
});

test("a lost CAS whose key now names another sandbox reuses without overwriting it", async () => {
  // A DAG sibling took the shared session key. Our own sandbox passed its own
  // health check under its own identity, so reuse is still right -- but the
  // markers on that key are no longer ours to clear.
  stubEffects();
  stubHealth("ok");
  const idle = {
    ...LIVE, specFingerprint: specOf(), keepalive: false, idleSince: "2026-01-01T00:00:00Z",
  };
  const { kv, puts } = conflictingKv(idle, { ...idle, workloadId: "sibling-9" });
  const { a } = attempt(idle, { kv });

  assert.ok(await tryReuseSessionSandbox(a), "a sibling's write is not our failure");
  assert.equal(puts.length, 0, "a sibling's entry must never be rewritten with ours");
});

test("an entry too corrupt to identify blocks replacement", async () => {
  // The unreadable bytes may be the only handle to a live workload. Building
  // over them would orphan that workload and make later cleanup impossible.
  const { destroyed } = stubEffects();
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) { return { key, value: enc.encode("{not json") }; },
    async put() { return 1; },
  } as unknown as KV;
  const { a } = attempt(null, { kv });

  await assert.rejects(
    () => tryReuseSessionSandbox(a),
    /entry is corrupt; refusing unsafe sandbox replacement/,
  );
  assert.deepEqual(destroyed, []);
});

test("an unavailable KV blocks replacement instead of overwriting unknown ownership", async () => {
  const { destroyed } = stubEffects();
  const kv = {
    async get() { throw new Error("NATS unavailable"); },
  } as unknown as KV;
  const { a } = attempt(null, { kv });

  await assert.rejects(
    () => tryReuseSessionSandbox(a),
    /KV is unavailable; refusing unsafe sandbox replacement/,
  );
  assert.deepEqual(destroyed, []);
});

test("nothing recorded means nothing to reuse, and nothing to tear down", async () => {
  const { destroyed } = stubEffects();
  const { a } = attempt(null);

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, [], "there is no workload to collect and no evidence there ever was");
});

test("an inherited sandbox that is gone fails the node by name", async () => {
  // `use` means "the sandbox an upstream node built". Quietly building a
  // replacement would lose whatever that node left on its disk, so this throws
  // -- and it names the handle and the DAG, because the failure a reader has to
  // act on is upstream of the node reporting it.
  stubHealth("throw");

  await assert.rejects(
    () => assertDagHandleAlive("trainer", "dag-9", "s-1", "http://gone.test:9100/mcp"),
    (e: Error) => {
      assert.match(e.message, /trainer/);
      assert.match(e.message, /dag-9/);
      assert.match(e.message, /not responding/);
      return true;
    },
  );
});

test("an inherited sandbox that answers is accepted without ceremony", async () => {
  stubHealth("ok");
  await assertDagHandleAlive("trainer", "dag-9", "s-1", "http://live.test:9100/mcp");
});

test("an inherited live sandbox restarts Hands in place", async () => {
  const { destroyed, restartCalls } = stubEffects("alive");
  stubHealth("throw");
  await assertDagHandleAlive(
    "trainer",
    "dag-9",
    "s-1",
    "http://live.test:9100/mcp",
    { workloadId: "wl-1", platformKey: "pk" },
    "tok",
  );
  assert.equal(restartCalls.length, 1);
  assert.deepEqual(destroyed, []);
});

test("the SaFE handle records the namespace keepalive will poll", () => {
  // The use-path falls back to the deployment default when the field is
  // missing, so a handle written without it polls a workload that is not
  // there and lets the live one expire. agent-sandbox already writes the
  // field; this is the SaFE register, which is the path `sandbox.use` takes.
  const src = readFileSync(
    fileURLToPath(new URL("../src/sandbox/ensure-hands.ts", import.meta.url)),
    "utf-8",
  );
  const from = src.indexOf("await registerDagHandle(dagRoot, action.handle, {");
  const call = src.slice(from, src.indexOf("});", from) + 3);
  assert.doesNotMatch(call, /provider:\s*"agent-sandbox"/,
    "the first register is the SaFE path, not the kubernetes one");
  assert.match(call, /namespace:\s*nsForSandbox/,
    "keepalive has to poll the namespace the request named");
});

test("a refused in-place restart falls back to rebuilding, it does not wedge the turn", async () => {
  // `restart_disabled` and `env_not_reproducible` mean this deployment will
  // never repair this sandbox in place. Treating that as a failed repair kept
  // the container and threw, so every later turn on the session threw the same
  // way with no path back -- the operator who turned the kill switch off got a
  // dead session rather than the replace-and-rebuild it used to do.
  const { destroyed, restartCalls } = stubEffects("alive", false, "restart_disabled");
  stubHealth("down");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  const reused = await tryReuseSessionSandbox(a);

  assert.equal(reused, null, "null is how this function asks the caller to rebuild");
  assert.equal(restartCalls.length, 1, "the refusal still comes from the restart path");
  assert.deepEqual(destroyed, ["s-1"], "the caller tears the old sandbox down before rebuilding");
});

test("a restart that was attempted and failed still keeps the container", async () => {
  // The other half: this one ran and did not work, so the container is worth
  // keeping and the turn says so. Only a refusal may fall through to rebuild.
  const { destroyed } = stubEffects("alive", false);
  stubHealth("down");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  await assert.rejects(
    () => tryReuseSessionSandbox(a),
    /Hands is unavailable .*the live sandbox was left intact/,
  );
  assert.deepEqual(destroyed, [], "a live container is not destroyed over a failed repair");
});

test("the marker retry leaves a handle parked by a session delete alone", async () => {
  // Losing the CAS to a session delete and then re-reading finds the same
  // sandbox, newly parked. Clearing `keepalive:false` there un-parks it, and
  // eligibleForClusterReclaim rejects any entry whose keepalive is not false --
  // so the session's GPU clusters would never be reclaimed.
  stubEffects();
  stubHealth("ok");
  const idle = { ...LIVE, specFingerprint: specOf(), keepalive: false, idleSince: "2026-01-01T00:00:00Z" };
  const { kv, puts } = conflictingKv(idle, { ...idle, sessionDeleted: true });
  const { a } = attempt(idle, { kv });

  assert.ok(await tryReuseSessionSandbox(a), "the sandbox itself is still reusable");
  assert.equal(puts.length, 0, "a parked handle must keep its parking");
});

test("an entry already parked at first read keeps its parking too", async () => {
  // The guard was put on the retry, where the park lands in the CAS window.
  // The commoner case is the entry being parked before the reuse ever reads it,
  // and that path went straight to `delete info.keepalive` -- stripping the
  // parking on the first write, with no conflict needed to trigger it.
  stubEffects();
  stubHealth("ok");
  const { a, puts } = attempt({
    ...LIVE, specFingerprint: specOf(),
    keepalive: false, idleSince: "2026-01-01T00:00:00Z", sessionDeleted: true,
  });

  assert.ok(await tryReuseSessionSandbox(a), "the sandbox is still reachable and reusable");
  assert.equal(puts.length, 0, "a parked handle must not be written at all");
});

test("a session whose sandbox was torn down builds a new one instead of failing", async () => {
  // Teardown deletes `hands.<sessionId>`, and a deleted key still reads back --
  // as an entry with an empty value. Treating that as a corrupt record made the
  // reuse path throw, and nothing catches it, so every turn of the session
  // failed outright until the tombstone aged out. Nothing is at risk here: the
  // record is gone, so there is no sandbox to replace unsafely.
  const tombstoneKv = {
    async get(key: string) {
      return { key, value: new Uint8Array(0), revision: 4, operation: "DEL" };
    },
    async put() { return 1; },
    async update() { return 5; },
    async delete() {},
  } as never;
  const { a } = attempt(LIVE, { kv: tombstoneKv });

  const reused = await tryReuseSessionSandbox(a);

  assert.equal(reused, null,
    "no entry means no reuse -- and the caller builds a sandbox, which is what "
    + "the turn needs");
});
