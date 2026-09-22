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
import { handsSessionKey, legacyHandsKey } from "../src/sandbox/hands-key.js";

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
  /** What the record-derived gate answers. Default: nothing left running. */
  liveWork: "clear" | "protected" | "unknown" = "clear",
  /** Whether the caller's DAG holds a handle on the entry's workload. */
  holds?: boolean | (() => Promise<boolean>),
  /** Whether some OTHER DAG also holds a handle on it. */
  heldByOther?: boolean | (() => Promise<boolean>),
): {
  destroyed: string[];
  registered: Registration[];
  restartCalls: number[];
  retained: string[];
  /** The session keys a retention released, which is the binding it unbound. */
  retainedKeys: string[];
  /** One entry per `releaseHandlesForWorkload` call the path made. */
  released: string[];
} {
  const destroyed: string[] = [];
  const released: string[] = [];
  const registered: Registration[] = [];
  const restartCalls: number[] = [];
  const retained: string[] = [];
  const retainedKeys: string[] = [];
  restoreEffects = bindSandboxReuseEffects({
    destroyHands: async (sessionId: string) => { destroyed.push(sessionId); },
    registerSandbox: ((sessionId: string, target: Record<string, unknown>) => {
      registered.push({ sessionId, target });
    }) as never,
    probeSandboxContainer: async () => ({ verdict: probe, reason: "exec_ok" as const }),
    // Succeeds by default: the retention path releases the handed-over
    // container's handle before it retains it, so a fixture that threw here
    // would stop every retention test short of its assertion.
    releaseHandlesForWorkload: (async () => { released.push("release"); }) as never,
    dagHoldsWorkload: (async () => {
      if (typeof holds === "function") return holds();
      return holds ?? false;
    }) as never,
    workloadHeldByOtherDag: (async () => {
      if (typeof heldByOther === "function") return heldByOther();
      return heldByOther ?? false;
    }) as never,
    restartHandsInSandbox: async () => {
      restartCalls.push(1);
      if (refusal) return { ok: false, detail: refusal, refused: true };
      return { ok: restartOk, detail: restartOk ? "healthy" : "started_but_unhealthy" };
    },
    countLiveWork: async () => ({ verdict: liveWork, classes: {}, reason: liveWork }),
    retainContainer: async (input) => {
      retained.push(input.generation);
      retainedKeys.push(input.sessionKey);
      return "retained";
    },
  });
  return { destroyed, registered, restartCalls, retained, retainedKeys, released };
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
  // Selected by what the call IS, not by where it sits. Several registrations
  // match this shape -- the early provisioning write, SaFE create,
  // agent-sandbox create, the reuse adoption -- and this test wants the SaFE
  // create; picking "the first
  // occurrence" silently retargeted it at the reuse call when that was added.
  const calls = [...src.matchAll(/await replaceDagHandle\(dagRoot, action\.handle, \{/g)]
    .map((m) => src.slice(m.index!, src.indexOf("});", m.index!) + 3));
  const call = calls.find((c) => /workload_id:\s*workloadId\b/.test(c));

  assert.ok(call, "no SaFE registration found -- has it been renamed or reshaped?");
  assert.doesNotMatch(call!, /provider:\s*"agent-sandbox"/,
    "this is the SaFE path, not the kubernetes one");
  assert.match(call!, /namespace:\s*nsForSandbox/,
    "keepalive has to poll the namespace the request named");
});

test("a refused in-place restart releases the claim, and destroys only an empty container", async () => {
  // `restart_disabled` and `env_not_reproducible` mean this deployment will
  // never repair this sandbox in place, so the session's claim on it has to go
  // or every later turn fails the same way. What happens to the container is a
  // separate question, answered by what is still running in it.
  const { destroyed, restartCalls, retained } = stubEffects("alive", false, "restart_disabled");
  stubHealth("down");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  const reused = await tryReuseSessionSandbox(a);

  assert.equal(reused, null, "null is how this function asks the caller to build a fresh one");
  assert.equal(restartCalls.length, 1, "the refusal still comes from the restart path");
  assert.deepEqual(destroyed, ["s-1"], "nothing was running, so the container is the caller's to reap");
  assert.deepEqual(retained, [], "and nothing was retained");
});

test("a refusal over live work retains the container instead of replacing it", async () => {
  // A fresh Hands reads an empty registry, so a rebuild that asks nothing about
  // what is running reads empty as "destroying this is harmless".
  for (const verdict of ["protected", "unknown"] as const) {
    const { destroyed, retained } = stubEffects("alive", false, "env_not_reproducible", verdict);
    stubHealth("down");
    const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

    const reused = await tryReuseSessionSandbox(a);

    assert.equal(reused, null, `${verdict}: the caller still gets a fresh sandbox`);
    assert.deepEqual(destroyed, [], `${verdict}: the live container was destroyed`);
    assert.equal(retained.length, 1, `${verdict}: the binding was not moved into the retention namespace`);
    restoreEffects?.();
    restoreEffects = null;
  }
});

test("an unanswerable gate keeps the container, exactly as a nonzero count does", async () => {
  // The caller-visible outcome is one acquisition either way: the count decides
  // which container it gets, never what it is told, so no response and no
  // combination of responses is a function of what was found.
  const held = stubEffects("alive", false, "env_not_reproducible", "unknown");
  stubHealth("down");
  const { a: unknownAttempt } = attempt({ ...LIVE, specFingerprint: specOf() });
  const unknownResult = await tryReuseSessionSandbox(unknownAttempt);
  restoreEffects?.();
  restoreEffects = null;

  const busy = stubEffects("alive", false, "env_not_reproducible", "protected");
  stubHealth("down");
  const { a: protectedAttempt } = attempt({ ...LIVE, specFingerprint: specOf() });
  const protectedResult = await tryReuseSessionSandbox(protectedAttempt);

  assert.deepEqual(unknownResult, protectedResult, "the two are indistinguishable to a caller");
  assert.deepEqual(held.destroyed, []);
  assert.deepEqual(busy.destroyed, []);
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

test("a retention is keyed by the generation its shells' rows record", async () => {
  // A per-shell reference row records the endpoint its shell ran under, and a
  // query resolves the container by matching that against the retention's key
  // part. A key built from a workload id or a sandbox name is a container no
  // poll, wait or kill can route back to.
  const { retained } = stubEffects("alive", false, "env_not_reproducible", "protected");
  stubHealth("down");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(retained, [LIVE.handsUrl],
    "the retention key part must be the generation the rows carry, not another identifier");
});

test("a retention releases the key the binding was read under, not a re-derived one", async () => {
  // The reuse path reads through both names a binding can sit under, so for the
  // length of a rolling upgrade the binding it acted on can be the legacy one
  // while the canonical key holds a different generation of the same session.
  // Re-deriving the key here deleted that sibling's binding -- the sweeps walk
  // `hands.*`, so the sandbox it named became reachable by nothing -- and left
  // the retained container still bound to the session it was being unbound from.
  const sessionId = "retained-rollout";
  const legacyKey = legacyHandsKey(sessionId);
  assert.notEqual(handsSessionKey(sessionId), legacyKey,
    "this fixture only describes a rolling upgrade while the two names differ");
  const enc = new TextEncoder();
  const legacyOnlyKv = {
    async get(key: string) {
      if (key !== legacyKey) return null;
      return {
        key,
        value: enc.encode(JSON.stringify({ ...LIVE, specFingerprint: specOf() })),
        revision: 7,
      };
    },
    async put() { return 1; },
    async update() { return 8; },
  } as unknown as KV;
  const { destroyed, retainedKeys } = stubEffects("alive", false, "env_not_reproducible", "protected");
  stubHealth("down");
  const { a } = attempt(null, { kv: legacyOnlyKv, sessionId });

  assert.equal(await tryReuseSessionSandbox(a), null, "the caller still gets a fresh sandbox");
  assert.deepEqual(destroyed, [], "the live container is kept either way");
  assert.deepEqual(retainedKeys, [legacyKey],
    "the retention has to release the binding it acted on, never the canonical name");
});

test("a binding naming no endpoint is refused rather than retained under an address nothing resolves", async () => {
  // Deriving a key part here would produce a container that is swept and pinged
  // and that no reference row can name -- protected on paper only.
  const { destroyed, retained } = stubEffects("alive", false, "env_not_reproducible", "protected");
  stubHealth("down");
  const { a } = attempt({ ...LIVE, handsUrl: "", specFingerprint: specOf() });

  await assert.rejects(() => tryReuseSessionSandbox(a), /names no endpoint/);
  assert.deepEqual(destroyed, [], "nothing was destroyed on the way out");
  assert.deepEqual(retained, [], "and nothing was retained under an unresolvable key");
});

test("reuse is refused while the fleet is uncounted, and registers nothing", async () => {
  // Reuse makes no admission claim -- the container is already in the fleet --
  // but it does register a ping target, and a target this replica serves while
  // its roster does not hold it is the ceiling enforced after the fact rather
  // than before. Provisioning is refused in the same window, so reuse falling
  // through to it would only meet the same answer one pod later.
  const {
    SandboxCapacityRefused, bindAdmission, markCensusReconciled,
  } = await import("../src/sandbox/admission.js");
  const { registered } = stubEffects();
  stubHealth("ok");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });
  const rosterKv = {
    async get() { return null; },
    async create() { return 1; },
    async update() { return 1; },
  } as unknown as KV;

  await bindAdmission(rosterKv, { ceiling: 8, reconciliationReserve: 2 });
  try {
    await assert.rejects(() => tryReuseSessionSandbox(a), SandboxCapacityRefused);
    assert.deepEqual(registered, [], "nothing is pinged on the strength of an uncounted fleet");

    markCensusReconciled();
    assert.ok(await tryReuseSessionSandbox(a), "and reuse resumes once a sweep has counted it");
    assert.deepEqual(registeredIds(registered), ["s-1"]);
  } finally {
    // A ceiling of zero binds no roster, which is this module's off state.
    await bindAdmission(rosterKv, { ceiling: 0, reconciliationReserve: 0 });
  }
});

// A pending entry is not automatically this task's leftover.
//
// Under a session-scoped run gate two DAG roots take different lock keys and
// run at the same time over one `hands.<sessionId>` entry. So the pending entry
// a lazily-attaching task finds may be a sibling's create still in flight --
// and destroying it stopped a workload the sibling went on to promote and use.
// Round 33 reproduced exactly that: `stopped=[{id:"W2", inUse:true,
// currentStatus:"ready"}], deleted=true`.
const PENDING_OF = (taskId?: string) => ({
  status: "pending" as const,
  handsUrl: "http://hands.test:9100/mcp",
  token: "tok-existing",
  workloadId: "wl-sibling",
  ...(taskId === undefined ? {} : { taskId }),
});

test("a pending entry another task wrote is left where it is", async () => {
  const { destroyed } = stubEffects();
  const { a } = attempt(PENDING_OF("t-sibling") as never, {
    request: { ...REQUEST, task_id: "t-mine" },
  });

  const result = await tryReuseSessionSandbox(a);

  assert.equal(result, null, "this task still goes on to create its own");
  assert.deepEqual(destroyed, [], "but not over the top of a sibling's workload");
});

test("a pending entry this task wrote is still cleaned up", async () => {
  const { destroyed } = stubEffects();
  const { a } = attempt(PENDING_OF("t-mine") as never, {
    request: { ...REQUEST, task_id: "t-mine" },
  });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"], "its own leftover is exactly what this branch is for");
});

test("a pending entry with no task on it is cleaned up as before", async () => {
  // It predates the field, so it can only have come from a process running
  // before this rollout. Leaving those would leak them.
  const { destroyed } = stubEffects();
  const { a } = attempt(PENDING_OF() as never, { request: { ...REQUEST, task_id: "t-mine" } });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"]);
});

// Every replace branch reads the one shared session entry, takes the workload
// it names, and stops it. Right when a session runs one task at a time; under a
// session-scoped run gate two DAG roots run at once over that entry, so the
// workload it names can be a sibling's -- already promoted and in use. Round 34
// reproduced both remaining branches as
// `stopped=[{"id":"W2","inUse":true,"currentStatus":"ready"}]`, the spec one
// with no race at all: B builds image:1 and keeps using it, A asks for image:2
// and the fingerprint comparison alone routes it into the rebuild.
const OWNED_BY = (dagRootTaskId: string, over: Record<string, unknown> = {}) => ({
  ...LIVE, specFingerprint: specOf(), dagRootTaskId, ...over,
});
/** A recorded fingerprint that parses but does not match -- the shape
 *  evaluateReuse actually refuses on. A non-fingerprint string is treated as
 *  unknown and reuses, which routes past this branch into the health check. */
const STALE_SPEC = () => specOf().replace(/:[0-9a-f]+$/, ":ffffffffffffffff");
const MINE = { ...REQUEST, task_id: "t-a", dag_root_task_id: "dag-a" };

test("a spec rebuild does not stop a sandbox another DAG owns", async () => {
  const { destroyed } = stubEffects();
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-b", { specFingerprint: STALE_SPEC() }) as never,
    { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null, "this task goes on to build its own");
  assert.deepEqual(destroyed, [], "but not by stopping one a sibling DAG is using");
});

test("a multi-node replace does not stop a sandbox another DAG owns", async () => {
  const { destroyed } = stubEffects();
  const { a } = attempt(OWNED_BY("dag-b") as never, {
    request: MINE,
    multiNodeContext: { serviceUrl: "http://mn.test" } as never,
  });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, [], "multi-node replaces its own prior sandbox, not a sibling's");
});

test("an unhealthy sandbox another DAG owns is not recreated over", async () => {
  // The probe that failed was of somebody else's sandbox.
  const { destroyed } = stubEffects("dead", false);
  stubHealth("fail");
  const { a } = attempt(OWNED_BY("dag-b") as never, { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, []);
});

test("a task rebuilding its OWN DAG's sandbox still replaces it", async () => {
  // Nodes of one DAG share the session's sandbox on purpose: this is the
  // behaviour the guard must not break.
  const { destroyed } = stubEffects();
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-a", { specFingerprint: STALE_SPEC() }) as never,
    { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"], "its own DAG's sandbox is its to rebuild");
});

test("an entry with no owner recorded is replaced as before", async () => {
  const { destroyed } = stubEffects();
  stubHealth("ok");
  const { a } = attempt({ ...LIVE, specFingerprint: STALE_SPEC() } as never, { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"], "refusing to rebuild an unowned session would be worse");
});

// Who WROTE the session entry is not who holds the workload now.
//
// A task that reused another's sandbox registers its own handle on it, and is
// from then on just as much a holder -- but the entry still names whoever
// created it. Round 35: refusing on that alone left such a task unable to
// rebuild a sandbox that had broken under it. The replace was skipped as
// somebody else's, and its own handle, still naming the dead workload, then
// refused the registration of the replacement -- two attempts, two rolled-back
// workloads, no way forward, while a brand new task succeeded.
test("a task that reused a sandbox may still rebuild it when it breaks", async () => {
  const { destroyed } = stubEffects("dead", true, undefined, "clear", true);
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-creator", { specFingerprint: STALE_SPEC() }) as never,
    { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"], "holding a handle on it makes it yours to replace");
});

test("a task holding no handle on it still may not", async () => {
  const { destroyed } = stubEffects("dead", true, undefined, "clear", false);
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-creator", { specFingerprint: STALE_SPEC() }) as never,
    { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, [], "this is still a sibling's live workload");
});

test("a registry that cannot be read answers 'not mine'", async () => {
  // The conservative direction: the cost of being wrong here is the rebuild
  // regression above, and the cost of being wrong the other way is stopping a
  // workload somebody is using.
  const { destroyed } = stubEffects("dead", true, undefined, "clear", true,
    async () => { throw new Error("kv down"); });
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-creator", { specFingerprint: STALE_SPEC() }) as never,
    { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, []);
});

test("holding a handle is not the same as being the only holder", async () => {
  // Round 36, and a regression I introduced answering round 35. Reuse is the
  // point of the handle registry, so a DAG holding a handle on a workload says
  // it is A holder -- which is what makes rebuilding it that DAG's right. It
  // does not say it is the ONLY one: the creator can still be running on the
  // same workload. Permission read off the first question alone stopped a
  // sandbox somebody was using -- `stopped=[{id:"W1", inUse:true}]`.
  const { destroyed } = stubEffects("dead", true, undefined, "clear", true, true);
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-creator", { specFingerprint: STALE_SPEC() }) as never,
    { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, [], "the creator is still using it");
});

test("a scan that cannot answer who else holds it refuses the destroy", async () => {
  const { destroyed } = stubEffects("dead", true, undefined, "clear", true,
    async () => { throw new Error("scan timed out"); });
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-creator", { specFingerprint: STALE_SPEC() }) as never,
    { request: MINE });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, [], "a refused rebuild beats stopping a live workload");
});

test("the creator is not exempt from asking who else holds it", async () => {
  // Round 37. My own predicate short-circuited on `entryRoot === mineRoot` and
  // returned "mine" without asking either question -- so a creator whose
  // sandbox had since been reused by another DAG stopped it underneath them:
  // `stopped=[{id:"W1", bUsing:true}], holdsQueries=0, otherQueries=0`.
  //
  // Creating it answers the first question (am I entitled at all). It says
  // nothing about the second.
  const { destroyed } = stubEffects("dead", true, undefined, "clear", false, true);
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-a", { specFingerprint: STALE_SPEC() }) as never, {
    request: { ...MINE, task_id: "a2", dag_root_task_id: "dag-a" },
  });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, [], "another DAG reused it and is running on it");
});

test("the creator may still rebuild when nobody else holds it", async () => {
  // The ordinary case, and the one the extra question must not break.
  const { destroyed } = stubEffects("dead", true, undefined, "clear", false, false);
  stubHealth("ok");
  const { a } = attempt(OWNED_BY("dag-a", { specFingerprint: STALE_SPEC() }) as never, {
    request: { ...MINE, task_id: "a2", dag_root_task_id: "dag-a" },
  });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"], "its own sandbox, held by nobody else");
});

test("an agent-sandbox entry is identified by its Router session, not a blank workload id", async () => {
  // Round 38. An agent-sandbox entry records `workloadId: ""` and names its
  // Router session instead. Keying ownership on the workload id meant the
  // question short-circuited before either query ran -- `holderQueries=0` --
  // so a Router sandbox another DAG was using was deleted on the strength of
  // an answer nobody had asked for.
  const queries: string[] = [];
  const { destroyed } = stubEffects("dead", true, undefined, "clear", false,
    async () => { queries.push("other"); return true; });
  stubHealth("ok");
  const { a } = attempt({
    ...LIVE, specFingerprint: STALE_SPEC(), dagRootTaskId: "dag-a",
    provider: "agent-sandbox", workloadId: "", sessionId: "router-R",
  } as never, { request: { ...MINE, task_id: "a2", dag_root_task_id: "dag-a" } });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(queries, ["other"], "the holder question has to actually be asked");
  assert.deepEqual(destroyed, [], "another DAG is using that Router sandbox");
});

test("a retention lands its reference before it gives up the handle", async () => {
  // This assertion has been both ways round, and round 43 settled it.
  //
  // It first said "release first, so a failed release leaves everything as it
  // was and the next attempt retries". That premise is false: a delete whose
  // ACK is lost has committed. The container then ends with no handle, no
  // retention record and no session binding, because the caller goes on to
  // provision a replacement whose own pending write takes the binding. The same
  // window opens on a crash between the two, and for a DAG that REUSED the
  // container its handle was also its way back into this path.
  //
  // So the reference that replaces the handle has to exist before the handle
  // can go. A release that then fails leaves a stale handle -- recoverable,
  // because a registration refused by a RETAINED workload may take the name
  // (see H25 and `mayTakeFrom`).
  const order: string[] = [];
  restoreEffects = bindSandboxReuseEffects({
    retainContainer: (async () => { order.push("retain"); }) as never,
    releaseHandlesForWorkload: (async () => { order.push("release"); }) as never,
    probeSandboxContainer: async () => ({ verdict: "alive" as const, reason: "exec_ok" }),
    restartHandsInSandbox: async () => ({ ok: false, detail: "refused", refused: true }),
    countLiveWork: (async () => ({ verdict: "protected", classes: {}, reason: "shells" })) as never,
    destroyHands: (async () => { order.push("destroy"); }) as never,
  });
  stubHealth("fail");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf(), workloadId: "W-old" } as never);

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(order, ["retain", "release"],
    "the retention record has to exist before the handle naming it is freed");
});

test("a retention whose handle release fails still retains the container", async () => {
  // The failure this ordering is FOR: the release throwing must not cost the
  // container its retention record, because that record is now its only
  // reference. The stale handle it leaves behind is the recoverable half.
  const order: string[] = [];
  restoreEffects = bindSandboxReuseEffects({
    retainContainer: (async () => { order.push("retain"); }) as never,
    releaseHandlesForWorkload: (async () => { throw new Error("kv down"); }) as never,
    probeSandboxContainer: async () => ({ verdict: "alive" as const, reason: "exec_ok" }),
    restartHandsInSandbox: async () => ({ ok: false, detail: "refused", refused: true }),
    countLiveWork: (async () => ({ verdict: "protected", classes: {}, reason: "shells" })) as never,
    destroyHands: (async () => { order.push("destroy"); }) as never,
  });
  stubHealth("fail");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf(), workloadId: "W-old" } as never);

  assert.equal(await tryReuseSessionSandbox(a), null, "a failed release must not fail the turn");
  assert.deepEqual(order, ["retain"], "the container keeps the reference that replaced its handle");
});

test("a gone container is released rather than retained when the live gate cannot answer", async () => {
  // The pair that cannot both be honoured: the provider has confirmed the
  // workload is absent, and the record-derived gate answers anything but
  // `clear`. It is not a rare pair -- it is the ONLY one a gone container can
  // produce, because `countLiveWork` has to reach the container to answer and
  // gets `unknown` from one that is not there.
  //
  // Retaining on `unknown` is right for a container that is merely unreachable
  // and wrong for one that is absent: there is no work to protect and no stop
  // to protect it from, and `runRetentionReadPhase` re-runs that same
  // unanswerable read every sweep and reads `unknown` too, for ever. With
  // SANDBOX_SWEEPER_EVICT_AFTER_FAILURES and SANDBOX_KEEPALIVE_FAIL_LIMIT both
  // defaulting to 0 nothing else removes it, so the record outlives everything
  // that could release it while counting against the keepalive ceiling live
  // sandboxes need room in.
  //
  // The `entryOwnedByAnother` branch has asked this question since it was
  // written. This asserts it for the path that reaches the retention without
  // going through that branch -- which a release of this function's own can
  // produce: `releaseHandlesForWorkload` walks one DAG row at a time with no
  // transaction over the set, so a release that frees a sibling's name and then
  // exhausts its CAS attempts on its own row throws with the first deletion
  // already durable, and the redelivery re-runs this path against a table where
  // the sibling reference is gone.
  const { destroyed, retained, released } = stubEffects("dead", true, undefined, "unknown");
  stubHealth("throw");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(retained, [], "a container that is not there gets no retention record");
  assert.equal(released.length > 0, true, "its handles are freed instead");
  assert.deepEqual(destroyed, [], "and nothing is stopped: there is nothing to stop");
});

test("an unreachable container is still retained", async () => {
  // The other side of the same line, and the reason the check sits where it
  // does rather than earlier. `unknown` from the probe is not `dead`: the
  // container may be running with work in it that nothing can currently see,
  // which is exactly what a retention is for. A fix that read "unknown live
  // work means release" would destroy the protection it was meant to keep.
  const { retained } = stubEffects("unknown", true, undefined, "unknown");
  stubHealth("throw");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  await assert.rejects(() => tryReuseSessionSandbox(a), /container state is unknown/);
  assert.deepEqual(retained, [], "this path refuses before it decides anything");
});

test("a gone container with a clear gate is still destroyed", async () => {
  // The teardown a gone container needs as much as a live one: the entry has to
  // be cleaned up. The release check is placed AFTER this branch for that
  // reason -- it is not "skip the teardown for gone containers".
  const { destroyed, retained } = stubEffects("dead", true, undefined, "clear");
  stubHealth("throw");
  const { a } = attempt({ ...LIVE, specFingerprint: specOf() });

  assert.equal(await tryReuseSessionSandbox(a), null);
  assert.deepEqual(destroyed, ["s-1"], "the entry cleanup still happens");
  assert.deepEqual(retained, []);
});

test("taking over a warm sandbox re-stamps who holds it", async () => {
  // Reuse across the tasks of a session is the feature; this asserts the record
  // keeps up with it. The entry was left by an earlier task, and the run taking
  // it on now writes its own task and attempt into the SAME write that takes it
  // on -- so if the container dies under this run, this run can report it.
  //
  // Recording the minter instead would be the opposite defect: a legitimate
  // reuser refused its own ending. Nothing here gates the reuse -- that is
  // `entryOwnedByAnother`, at DAG-root grain, and it is untouched.
  stubEffects();
  stubHealth("ok");
  const { a, puts } = attempt(
    { ...LIVE, specFingerprint: specOf(), taskId: "task-earlier", attemptId: "attempt-earlier" },
    { attemptId: "attempt-now" },
  );

  const result = await tryReuseSessionSandbox(a);

  assert.ok(result, "the reuse still happens -- attribution never refuses one");
  const written = puts.map((p) => JSON.parse(p) as Record<string, unknown>);
  const stamped = written.find((w) => w.attemptId === "attempt-now");
  assert.ok(
    stamped,
    `the take-over has to re-stamp the holder: ${JSON.stringify(written.map(
      (w) => ({ taskId: w.taskId, attemptId: w.attemptId })))}`,
  );
  assert.equal(stamped!.taskId, REQUEST.task_id ?? null,
    "task and attempt travel together, or the weaker half disagrees with the stronger");
});

test("a stamp that loses its race never costs the sandbox", async () => {
  // The regression this refactor introduced and then had to take back. An entry
  // with no idle markers used to take no CAS at all; making one mandatory for
  // the stamp added a way for a LIVE sandbox to be refused: the retry re-reads
  // by key, and a key a rolling migration has moved reads as a deleted record,
  // so the caller rebuilds a container to fix a record.
  //
  // The refusal belongs to the reason that earns it -- clearing markers is
  // load-bearing for the reuse, stamping is not.
  stubEffects();
  stubHealth("ok");
  const { a } = attempt(
    // No idle markers, so the only reason to write is the holder change.
    { ...LIVE, specFingerprint: specOf(), taskId: "task-earlier", attemptId: "attempt-earlier" },
    { attemptId: "attempt-now" },
  );
  // The write loses, and the re-read that follows finds nothing under that key
  // -- the shape a key migrated by `reconcileReservedKeys` presents. The FIRST
  // read still answers, or the reuse would never begin.
  const realGet = (a.kv as unknown as { get: (k: string) => Promise<unknown> }).get;
  let reads = 0;
  (a.kv as unknown as { update: unknown }).update = async () => {
    throw new Error("wrong last sequence: 7");
  };
  (a.kv as unknown as { get: unknown }).get = async (k: string) => {
    reads += 1;
    return reads === 1 ? realGet.call(a.kv, k) : null;
  };

  const result = await tryReuseSessionSandbox(a);

  assert.ok(result,
    "a sandbox that answered its health check is still reused; a stale holder "
    + "costs a misreported ending, not a GPU container");
});

test("but a marker clear that loses its race still refuses", async () => {
  // The other half, unchanged. Clearing `keepalive:false` is what the caller
  // reads as "this slot is mine to take"; if the record went out from under it,
  // reusing anyway is how a swept slot gets handed back.
  stubEffects();
  stubHealth("ok");
  const { a } = attempt(
    { ...LIVE, specFingerprint: specOf(), keepalive: false, taskId: "task-earlier" },
    { attemptId: "attempt-now" },
  );
  const realGet2 = (a.kv as unknown as { get: (k: string) => Promise<unknown> }).get;
  let reads2 = 0;
  (a.kv as unknown as { update: unknown }).update = async () => {
    throw new Error("wrong last sequence: 7");
  };
  (a.kv as unknown as { get: unknown }).get = async (k: string) => {
    reads2 += 1;
    return reads2 === 1 ? realGet2.call(a.kv, k) : null;
  };

  const result = await tryReuseSessionSandbox(a);

  assert.equal(result, null, "the slot was taken; this run does not get it");
});
