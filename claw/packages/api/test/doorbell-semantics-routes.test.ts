// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two HTTP surfaces that carry a delivery-semantics version, proved at the
 * route rather than at the parser they delegate to.
 *
 * The capability write route may not be told the fleet speaks a contract this
 * binary does not implement, so its rejections bracket the accepted interval
 * from both ends and each end answers with its own message. The claim routes
 * split absence from corruption: a body that predates the field is a version-1
 * client and is served, while a present but malformed value is refused before
 * the database is touched. A test that only refused would pass against a route
 * that refuses everything, so both halves of the split are pinned here.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { DOORBELL_SEMANTICS_MAX, DOORBELL_SEMANTICS_VERSION } from "@claw/protocol";

import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { db } from "../src/infra/db.js";
import { registerAdminRoutes } from "../src/routes/admin.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import { sealRunCredentials } from "../src/tasks/run-secrets.js";

const TOKEN = "cluster-internal-token";
const BELOW_ONE = "semantics must be an integer of at least 1";
const ABOVE_VERSION = `semantics must not exceed this API's own ${DOORBELL_SEMANTICS_VERSION}`;
const SEMANTICS_INVALID = {
  ok: false,
  error: "doorbell_semantics_invalid",
  message: `doorbell_semantics must be an integer between 1 and ${DOORBELL_SEMANTICS_MAX}, or absent`,
};

const originalQuery = db.query;
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;

let adminApp: FastifyInstance;
let claimApp: FastifyInstance;
let blob: string;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  blob = sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" });
  adminApp = Fastify();
  await registerAdminRoutes(adminApp);
  await adminApp.ready();
  claimApp = Fastify();
  await registerInternalRunRoutes(claimApp);
  await claimApp.ready();
});

after(async () => {
  db.query = originalQuery;
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await adminApp.close();
  await claimApp.close();
});

function writeSemantics(payload: unknown) {
  return adminApp.inject({
    method: "POST",
    url: "/v1/internal/brain/doorbell-semantics",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: payload as Record<string, unknown>,
  });
}

function claim(url: string, payload: unknown) {
  return claimApp.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: payload as Record<string, unknown>,
  });
}

function stubClaimable(): void {
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/UPDATE claw_tasks/.test(sql)) {
      return {
        rows: [{
          task_id: "ktsk_1",
          session_id: "s-1",
          status: "preparing",
          deadline_at: null,
          input: { prompt: "hello", session_id: "s-1", user_id: "u-1", credentials: blob },
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

function stubEmpty(): void {
  db.query = (async () => ({ rows: [], rowCount: 0 })) as typeof db.query;
}

function tripwireDb(): void {
  db.query = (async () => {
    throw new Error("db must not be reached on a rejected body");
  }) as typeof db.query;
}

test("the capability write route refuses a value that is not an integer", async () => {
  const unauthorized = await adminApp.inject({
    method: "POST",
    url: "/v1/internal/brain/doorbell-semantics",
    payload: { semantics: "1" },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().error, "internal auth required");

  for (const bad of [1.5, "1", null, true, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    const res = await writeSemantics({ semantics: bad });
    const where = JSON.stringify(bad) ?? String(bad);
    assert.equal(res.statusCode, 400, `expected ${where} to be refused`);
    assert.equal(res.json().ok, false, where);
    assert.equal(res.json().error, BELOW_ONE, where);
    assert.match(res.json().error, /semantics/, where);
  }

  const absent = await writeSemantics({});
  assert.equal(absent.statusCode, 400);
  assert.deepEqual(absent.json(), { ok: false, error: BELOW_ONE });
});

test("the capability write route refuses a floor below 1", async () => {
  for (const bad of [0, -1, -DOORBELL_SEMANTICS_MAX]) {
    const res = await writeSemantics({ semantics: bad });
    assert.equal(res.statusCode, 400, `expected ${bad} to be refused`);
    assert.deepEqual(res.json(), { ok: false, error: BELOW_ONE }, `for ${bad}`);
  }
});

test("the capability write route refuses a floor above this API's own version", async () => {
  const above = [DOORBELL_SEMANTICS_VERSION + 1];
  if (DOORBELL_SEMANTICS_MAX > DOORBELL_SEMANTICS_VERSION) above.push(DOORBELL_SEMANTICS_MAX);
  for (const value of above) {
    const res = await writeSemantics({ semantics: value });
    assert.equal(res.statusCode, 400, `expected ${value} to be refused`);
    assert.deepEqual(res.json(), { ok: false, error: ABOVE_VERSION }, `for ${value}`);
    assert.notEqual(res.json().error, BELOW_ONE, `for ${value}`);
  }
});

test("claim-by-id refuses a present but malformed doorbell_semantics", async () => {
  tripwireDb();
  for (const bad of ["2", 0, -1, 1.5, DOORBELL_SEMANTICS_MAX + 1, null]) {
    const res = await claim("/v1/internal/tasks/ktsk_1/claim", {
      brain_id: "brain-7",
      doorbell_semantics: bad,
    });
    const where = JSON.stringify(bad) ?? String(bad);
    assert.equal(res.statusCode, 400, `expected ${where} to be refused`);
    assert.deepEqual(res.json(), SEMANTICS_INVALID, where);
  }
});

test("claim-next refuses a present but malformed doorbell_semantics", async () => {
  tripwireDb();
  for (const bad of ["2", 0, -1, 1.5, DOORBELL_SEMANTICS_MAX + 1, null]) {
    const res = await claim("/v1/internal/runs/claim-next", {
      brain_id: "brain-7",
      doorbell_semantics: bad,
    });
    const where = JSON.stringify(bad) ?? String(bad);
    assert.equal(res.statusCode, 400, `expected ${where} to be refused`);
    assert.deepEqual(res.json(), SEMANTICS_INVALID, where);
  }
});

test("absence is not corruption: a legacy body is claimed by both routes", async () => {
  stubClaimable();
  const byId = await claim("/v1/internal/tasks/ktsk_1/claim", { brain_id: "brain-7" });
  assert.equal(byId.statusCode, 200);
  assert.equal(byId.json().ok, true);

  stubEmpty();
  const next = await claim("/v1/internal/runs/claim-next", { brain_id: "brain-7" });
  assert.equal(next.statusCode, 200);
  assert.deepEqual(next.json(), { ok: true, request: null });

  for (const good of [1, DOORBELL_SEMANTICS_MAX]) {
    const res = await claim("/v1/internal/runs/claim-next", {
      brain_id: "brain-7",
      doorbell_semantics: good,
    });
    assert.equal(res.statusCode, 200, `expected ${good} to be accepted`);
    assert.deepEqual(res.json(), { ok: true, request: null }, `for ${good}`);
  }
});

test("brain_id is refused before doorbell_semantics is read", async () => {
  tripwireDb();
  for (const url of ["/v1/internal/tasks/ktsk_1/claim", "/v1/internal/runs/claim-next"]) {
    const res = await claim(url, { doorbell_semantics: "2" });
    assert.equal(res.statusCode, 400, url);
    assert.deepEqual(res.json(), { ok: false, error: "brain_id_required" }, url);
  }
});
