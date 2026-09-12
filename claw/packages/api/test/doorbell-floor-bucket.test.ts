// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which bucket the operator's floor assertion lands in.
 *
 * `doorbell-semantics-routes.test.ts` proves what the route refuses; this one
 * proves where an accepted write goes. The floor has its own non-expiring
 * bucket because the registry's five-minute TTL would age it out from under a
 * running fleet, and because the watch every replica reads is attached to that
 * bucket alone: a 200 whose value went anywhere else enables doorbell dispatch
 * on no pod at all, with nothing in the response to say so.
 *
 * `kvDoorbellFloor` is a module binding `initNats` assigns, so there is no seam
 * to write to; the resolve hook swaps the nats module for this file's fakes,
 * for the import in `routes/admin.ts` only.
 */

import { registerHooks } from "node:module";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import Fastify, { type FastifyInstance } from "fastify";
import { StringCodec } from "nats";
import { DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

const ADMIN_MODULE = new URL("../src/routes/admin.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ADMIN_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const sc = StringCodec();
export const nc = {} as unknown as Record<string, unknown>;

/** Enough of a KV bucket to say which one was written. */
function fakeBucket() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      const value = store.get(key);
      return value === undefined ? null : { value: sc.encode(value) };
    },
    async put(key: string, value: Uint8Array) { store.set(key, sc.decode(value)); return 1; },
    async delete(key: string) { store.delete(key); },
  };
}

export const kv = fakeBucket();
export const kvDoorbellFloor = fakeBucket();

const TOKEN = "cluster-internal-token";
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;
let app: FastifyInstance;
let key: string;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  const { registerAdminRoutes } = await import("../src/routes/admin.js");
  ({ DOORBELL_SEMANTICS_KEY: key } = await import("../src/tasks/doorbell-gate.js"));
  app = Fastify();
  await registerAdminRoutes(app);
  await app.ready();
});

after(async () => {
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app?.close();
});

function writeFloor(semantics: number) {
  return app.inject({
    method: "POST",
    url: "/v1/internal/brain/doorbell-semantics",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { semantics },
  });
}

test("an accepted floor lands in the bucket the fleet watches, not the registry", async () => {
  kv.store.clear();
  kvDoorbellFloor.store.clear();

  const res = await writeFloor(DOORBELL_SEMANTICS_VERSION);

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ok, true);
  assert.equal(
    kvDoorbellFloor.store.get(key), String(DOORBELL_SEMANTICS_VERSION),
    "the enable has to be where the watch and the restart both read it",
  );
  assert.equal(
    kv.store.has(key), false,
    "the registry bucket expires in five minutes, which would revoke the floor unasked",
  );
});

test("the enable is durable enough that the next write reports it back", async () => {
  // The operator's own evidence that the assertion took: a second write quotes
  // the first as `previous`. A write that went to another bucket answers 200
  // and reports null for ever, so nothing distinguishes an enable that landed
  // from one that vanished.
  kv.store.clear();
  kvDoorbellFloor.store.clear();

  const first = await writeFloor(DOORBELL_SEMANTICS_VERSION);
  const second = await writeFloor(DOORBELL_SEMANTICS_VERSION);

  assert.equal(first.json().previous, null, "nothing was asserted before this");
  assert.equal(
    second.json().previous, String(DOORBELL_SEMANTICS_VERSION),
    "the floor the first call wrote is the one this call read back",
  );
});

test("a revocation deletes from that same bucket", async () => {
  kvDoorbellFloor.store.clear();
  await writeFloor(DOORBELL_SEMANTICS_VERSION);

  const res = await app.inject({
    method: "DELETE",
    url: "/v1/internal/brain/doorbell-semantics",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().previous, String(DOORBELL_SEMANTICS_VERSION));
  assert.equal(kvDoorbellFloor.store.has(key), false, "a revocation the fleet can see");
});
