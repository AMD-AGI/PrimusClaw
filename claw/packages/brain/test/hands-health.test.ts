// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One definition of "is Hands answering", shared by the reuse gate, the
 * reaper's sweep and the recovery decision.
 *
 * They had a copy each, and the copies disagreed about what a non-2xx meant --
 * which matters because the same answer is used to hand a sandbox to a new
 * turn, to evict one, and to decide whether a container needs its tool server
 * restarted. Getting different verdicts from the same sandbox is worse than any
 * one of those being wrong.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkHandsHealth } from "../src/sandbox/hands-health.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(impl: (url: string, init?: RequestInit) => unknown): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push(String(input));
    return impl(String(input), init) as Response;
  }) as typeof fetch;
  return seen;
}

test("the MCP url is turned into the health route, not probed as-is", async () => {
  // Probing the recorded endpoint directly answers 404 and tears down a sandbox
  // that was fine.
  const seen = stubFetch(() => ({ ok: true, status: 200 }));
  await checkHandsHealth("http://sandbox.ns.svc:9100/mcp", 1_000);
  assert.deepEqual(seen, ["http://sandbox.ns.svc:9100/health"]);
});

test("a 2xx is the only healthy answer", async () => {
  stubFetch(() => ({ ok: true, status: 200 }));
  assert.deepEqual(
    await checkHandsHealth("http://sandbox:9100/mcp", 1_000),
    { ok: true, detail: "ok" },
  );
});

test("a server that answers with a refusal is unhealthy, and says which", async () => {
  stubFetch(() => ({ ok: false, status: 503 }));
  assert.deepEqual(
    await checkHandsHealth("http://sandbox:9100/mcp", 1_000),
    { ok: false, detail: "http_503" },
  );
});

test("nothing listening is unhealthy, and named apart from a refusal", async () => {
  stubFetch(() => { throw new Error("connect ECONNREFUSED 10.0.0.1:9100"); });
  const r = await checkHandsHealth("http://sandbox:9100/mcp", 1_000);
  assert.equal(r.ok, false);
  assert.match(r.detail, /ECONNREFUSED/);
});

test("the caller's timeout is passed to the request, not left to undici", async () => {
  // Without it the fetch inherits a five-minute header timeout, and a health
  // check that hangs blocks whichever decision was waiting on it.
  let signal: AbortSignal | undefined;
  stubFetch((_url, init) => {
    signal = init?.signal ?? undefined;
    return { ok: true, status: 200 };
  });
  await checkHandsHealth("http://sandbox:9100/mcp", 1_000);
  assert.ok(signal instanceof AbortSignal, "a health check must be able to give up");
});

test("no url is unhealthy without a request going out at all", async () => {
  const seen = stubFetch(() => { throw new Error("must not be called"); });
  assert.deepEqual(await checkHandsHealth("", 1_000), { ok: false, detail: "no_url" });
  assert.deepEqual(seen, []);
});
