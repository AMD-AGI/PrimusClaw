// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Several Router bases for one Router, and what moving between them may do.
 *
 * The point of listing more than one is that a gateway node going away must
 * not take exec with it. The limit on that is just as important: a request
 * that may have reached the Router is never sent again, because an exec sent
 * twice runs twice. So only "no connection opened" moves on.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SANDBOX_ROUTER_URL = "http://r1.test, http://r2.test/ ,http://r3.test";
delete process.env.SANDBOX_HANDS_VIA_ROUTER;

const {
  parseRouterBases, isConnectFailure, fetchThroughRouters, withRouterFailover,
  resetRouterPreferenceForTest, sandboxRouterBases, handsViaRouter, safeHandsBaseUrl,
} = await import("../src/sandbox/sandbox-router.js");
const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRouterPreferenceForTest();
});

function refused(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
}
function reset(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
}

const BASES = ["http://a.test", "http://b.test", "http://c.test"];

test("the list is split, trimmed, de-slashed, de-duplicated and normalised", () => {
  assert.deepEqual(
    parseRouterBases(" http://a.test/, http://B.test:80  http://a.test\nhttp://c.test:8080/x/ "),
    ["http://a.test", "http://b.test", "http://c.test:8080/x"],
  );
  assert.deepEqual(parseRouterBases(""), []);
  assert.deepEqual(sandboxRouterBases(), ["http://r1.test", "http://r2.test", "http://r3.test"]);
});

test("only errors that prove nothing was sent count as connect failures", () => {
  assert.equal(isConnectFailure(refused()), true);
  for (const code of ["EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "ENOTFOUND"]) {
    assert.equal(isConnectFailure({ cause: { code } }), true, code);
  }
  assert.equal(isConnectFailure(reset()), false);
  assert.equal(isConnectFailure({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }), false);
  assert.equal(isConnectFailure(new Error("boom")), false);
  // Happy-eyeballs: every dial must have failed to connect.
  assert.equal(isConnectFailure({ cause: { errors: [{ code: "ECONNREFUSED" }, { code: "EHOSTUNREACH" }] } }), true);
  assert.equal(isConnectFailure({ cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }] } }), false);
});

test("a refused connection moves to the next base, and the answering one is tried first after", async () => {
  const seen: string[] = [];
  const f = async (url: string) => {
    seen.push(url);
    if (new URL(url).host === "a.test") throw refused();
    return `ok ${url}`;
  };
  assert.equal(await fetchThroughRouters(BASES, "/p?q=1", { method: "POST", body: "{}" }, f), "ok http://b.test/p?q=1");
  assert.deepEqual(seen, ["http://a.test/p?q=1", "http://b.test/p?q=1"]);
  seen.length = 0;
  await fetchThroughRouters(BASES, "/p", undefined, f);
  assert.deepEqual(seen, ["http://b.test/p"], "b answered last, so it goes first");
});

test("an error after the connection opened is never retried elsewhere", async () => {
  const seen: string[] = [];
  const f = async (url: string) => { seen.push(url); throw reset(); };
  await assert.rejects(() => fetchThroughRouters(BASES, "/x", { method: "POST", body: "{}" }, f), /fetch failed/);
  assert.deepEqual(seen, ["http://a.test/x"]);
});

test("a body that cannot be replayed gets exactly one try", async () => {
  const seen: string[] = [];
  const f = async (url: string) => { seen.push(url); throw refused(); };
  const body = new ReadableStream();
  await assert.rejects(() => fetchThroughRouters(BASES, "/x", { method: "POST", body, duplex: "half" } as RequestInit, f));
  assert.deepEqual(seen, ["http://a.test/x"]);
});

test("all bases refusing surfaces the last connect error", async () => {
  const seen: string[] = [];
  const f = async (url: string) => { seen.push(url); throw refused(); };
  await assert.rejects(() => fetchThroughRouters(BASES, "/x", undefined, f), (e: unknown) => isConnectFailure(e));
  assert.deepEqual(seen, BASES.map((b) => `${b}/x`));
});

test("the URL wrapper keeps the path and only swaps a configured base", async () => {
  const seen: string[] = [];
  const f = withRouterFailover(async (input: string) => {
    seen.push(String(input));
    if (new URL(String(input)).host === "a.test") throw refused();
    return "ok";
  }, () => BASES);
  await f("http://a.test/v1/namespaces/ns/code-interpreters/w/invocations/proxy/9100/health");
  assert.deepEqual(seen, [
    "http://a.test/v1/namespaces/ns/code-interpreters/w/invocations/proxy/9100/health",
    "http://b.test/v1/namespaces/ns/code-interpreters/w/invocations/proxy/9100/health",
  ]);
  seen.length = 0;
  await f(new URL("http://a.test/mcp"));
  assert.deepEqual(seen, ["http://b.test/mcp"], "a URL object is followed too, starting at the base that answered");
  seen.length = 0;
  await f("http://w.ns.svc.cluster.local:9100/health");
  assert.deepEqual(seen, ["http://w.ns.svc.cluster.local:9100/health"], "a direct URL passes through untouched");
});

test("with the flag off, Hands keeps its cluster DNS name even though a Router is set", () => {
  assert.equal(handsViaRouter(), false);
  assert.equal(safeHandsBaseUrl("ns", "wl-1", "9100"), "http://wl-1.ns.svc.cluster.local:9100");
});

test("exec moves to the next Router base when the first refuses, and runs once", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push(`${init?.method} ${String(input)}`);
    if (new URL(String(input)).host === "r1.test") throw refused();
    return { ok: true, status: 200, json: async () => ({ exit_code: 0, stdout: "hi\n", stderr: "" }) } as Response;
  }) as typeof fetch;
  const inst = { provider: "safe-workload" as const, id: "wl-1", sandboxName: "wl-1", namespace: "ns", handsBaseUrl: "", platformKey: "pk" };
  const r = await new SafeWorkloadProvider().exec(inst, "echo hi", "5s");
  assert.deepEqual(r, { exitCode: 0, stdout: "hi\n", stderr: "" });
  assert.deepEqual(seen, [
    "POST http://r1.test/v1/namespaces/ns/code-interpreters/wl-1/invocations/api/execute",
    "POST http://r2.test/v1/namespaces/ns/code-interpreters/wl-1/invocations/api/execute",
  ]);
});

test("exec is not re-sent when the connection broke after it opened", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => { seen.push(String(input)); throw reset(); }) as typeof fetch;
  const inst = { provider: "safe-workload" as const, id: "wl-1", sandboxName: "wl-1", namespace: "ns", handsBaseUrl: "", platformKey: "pk" };
  await assert.rejects(() => new SafeWorkloadProvider().exec(inst, "echo hi", "5s"));
  assert.equal(seen.length, 1);
});

test("a single base is sent exactly as given, init and all", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const init: RequestInit = { method: "POST", body: "{}" };
  await fetchThroughRouters(["http://only.test"], "/x", init, async (u: string, i?: RequestInit) => { calls.push([u, i]); return "ok"; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "http://only.test/x");
  assert.equal(calls[0][1], init, "the same init object, redirect policy untouched");
});

test("with several bases a redirect is not followed, so its second hop cannot look like a connect failure", async () => {
  const inits: Array<RequestInit | undefined> = [];
  await fetchThroughRouters(BASES, "/x", { method: "POST", body: "{}" }, async (_u: string, i?: RequestInit) => { inits.push(i); return "ok"; });
  assert.equal(inits[0]?.redirect, "manual");
});

test("an aborted signal stops the walk with the abort reason", async () => {
  const ac = new AbortController();
  const seen: string[] = [];
  const f = async (url: string) => { seen.push(url); ac.abort(new Error("stop")); throw refused(); };
  await assert.rejects(() => fetchThroughRouters(BASES, "/x", { signal: ac.signal }, f), /stop/);
  assert.deepEqual(seen, ["http://a.test/x"]);
});
