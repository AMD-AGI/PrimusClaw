// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The account-linking endpoint: a posted key gets a code, and only typing the code in the chat binds it. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { openTestStore } from "../../../../test-support/store.js";
import { healthzRoute, linkRoute } from "../../src/http/link.js";
import { buildServer, listen } from "../../src/http/server.js";

async function serve(checkKey: (key: string) => Promise<boolean>) {
  const { store } = openTestStore();
  const app = buildServer({ routes: [linkRoute(store.links, checkKey), healthzRoute], maxBodyBytes: 128 * 1024 });
  const port = await listen(app, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${String(port)}`;
  return { store, app, base };
}

const accept = (key: string) => Promise.resolve(key !== "ak-bad");

function post(base: string, body: string, path = "/primus-claw-agent/link") {
  return fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": "application/json" } });
}

test("posting a key returns a code and that code binds it when typed", async () => {
  const { store, app, base } = await serve(accept);
  try {
    const r = await post(base, JSON.stringify({ key: "ak-alice" }));
    const body = (await r.json()) as { code: string; expires_in: number };
    assert.equal(r.status, 200);
    assert.equal(body.code.length, 8);
    assert.equal(body.expires_in, 600);
    assert.equal(store.links.getKey("aad-a"), null); // nothing is bound until a Teams user types the code
    assert.equal(store.links.redeemPending("aad-a", "Alice", body.code), "ok");
    assert.equal(store.links.getKey("aad-a"), "ak-alice");
  } finally {
    await app.close();
  }
});

test("rejected key gets no code", async () => {
  const { app, base } = await serve(accept);
  try {
    const r = await post(base, JSON.stringify({ key: "ak-bad" }));
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), { error: "key_rejected" });
    assert.deepEqual((await post(base, JSON.stringify({ key: "ak-ok" }))).status, 200);
  } finally {
    await app.close();
  }
});

test("a teams originated identifier cannot be combined with a posted key", async () => {
  // (the reviewed attack: B sends A a link, A confirms, A's key lands on B. Every old shape must be gone.)
  const { store, app, base } = await serve(accept);
  try {
    assert.equal((await fetch(`${base}/primus-claw-agent/link/info?code=anything`)).status, 404);
    for (const extra of [{ code: "B-ISSUED" }, { aadObjectId: "aad-b" }]) {
      const r = await post(base, JSON.stringify({ ...extra, key: "ak-victim" }));
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys((await r.json()) as object).sort(), ["code", "expires_in"]);
    }
    assert.deepEqual(store.links.linkedUsers(), []);
  } finally {
    await app.close();
  }
});

test("malformed requests", async () => {
  const { app, base } = await serve(accept);
  try {
    assert.equal((await post(base, "{}")).status, 400);
    assert.equal((await post(base, "not json")).status, 400);
    assert.equal((await post(base, JSON.stringify({ key: { nested: 1 } }))).status, 400);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
  } finally {
    await app.close();
  }
});
