// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The claim surface authenticates with the cluster token, not a run's lease.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

import { PG_INT4_MAX } from "@claw/utils";

import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { db } from "../src/infra/db.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import { runClaimPorts } from "../src/tasks/run-claim.js";
import { sealRunCredentials } from "../src/tasks/run-secrets.js";

const TOKEN = "cluster-internal-token";
const originalQuery = db.query;
const originalConnect = db.pool.connect;
const originalEnvToken = process.env.AUTH_INTERNAL_TOKEN;

let app: FastifyInstance;
let blob: string;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
  blob = sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" });
  app = Fastify();
  await registerInternalRunRoutes(app);
  await app.ready();
  // A release settles the attempt's ledger in the same transaction as its
  // status change, which takes its own connection; without this the tests
  // reach the real pool instead of the stub each of them installs.
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as never;
});

after(async () => {
  db.query = originalQuery;
  db.pool.connect = originalConnect;
  if (originalEnvToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalEnvToken;
  await app.close();
});

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
    if (sql.includes("claw_user_env_vars")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
}

test("claim-by-id accepts the cluster token and returns a hydrated request", async () => {
  stubClaimable();
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.request.llm_api_key, "sk-live");
  assert.equal(body.request.platform_key, "pk-live");
  assert.ok(body.request.run_lease.token);
});

test("claim-by-id rejects a run's own lease token", async () => {
  stubClaimable();
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/claim",
    headers: { authorization: "Bearer a-run-lease-token" },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 401);
});

test("claim-next with nothing queued answers with a null request, not an error", async () => {
  db.query = (async () => ({ rows: [], rowCount: 0 })) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/runs/claim-next",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, request: null });
});

test("claim-by-id requires brain_id", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test("claim-next requires brain_id", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/runs/claim-next",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test("a missing run is 404", async () => {
  db.query = (async () => ({ rows: [], rowCount: 0 })) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_gone/claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 404);
});

test("a held lease is 409", async () => {
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/UPDATE claw_tasks/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [{ status: "preparing", lease_expires_at: "2099-01-01" }], rowCount: 1 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 409);
});

test("a row that cannot be hydrated is 422", async () => {
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/UPDATE claw_tasks/.test(sql) && sql.includes("lease_owner")) {
      return {
        rows: [{
          task_id: "ktsk_1",
          session_id: "s-1",
          status: "preparing",
          deadline_at: null,
          input: { prompt: "hello", session_id: "s-1" },
        }],
        rowCount: 1,
      };
    }
    return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, "unclaimable");
});

test("unclaim by a non-holder is 409", async () => {
  db.query = (async () => ({ rows: [], rowCount: 0 })) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/unclaim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-other" },
  });
  assert.equal(res.statusCode, 409);
});

test("unclaim rejects a run lease token", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/unclaim",
    headers: { authorization: "Bearer a-run-lease-token" },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 401);
});

test("fail-claim by a non-holder is 409", async () => {
  db.query = (async () => ({ rows: [], rowCount: 0 })) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/fail-claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-other" },
  });
  assert.equal(res.statusCode, 409);
});

test("fail-claim by the holder ends the row", async () => {
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/UPDATE claw_tasks/.test(sql) && sql.includes("origin = 'chat'")) {
      return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/fail-claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("fail-claim can mark a doorbell term as claim_abandoned", async () => {
  let reason: unknown;
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("UPDATE claw_tasks") && sql.includes("origin = 'chat'")) {
      reason = params[0];
      return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/fail-claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7", reason: "claim_abandoned" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(reason, "claim_abandoned");
});

test("fail-claim can mark an unbound claimed run as workspace_unbound", async () => {
  let reason: unknown;
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("UPDATE claw_tasks") && sql.includes("origin = 'chat'")) {
      reason = params[0];
      return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/fail-claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7", reason: "workspace_unbound" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(reason, "workspace_unbound");
});

// A reason the API does not know is a holder asking for something this build
// cannot do. Defaulting it to `session_deleted` would close the row for good
// on a guess, so the request is refused and no statement runs.
test("fail-claim refuses an unknown reason instead of defaulting it", async () => {
  let touched = false;
  db.query = (async () => {
    touched = true;
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/fail-claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7", reason: "not_a_reason" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "reason_invalid");
  assert.equal(touched, false, "a refused body reaches no statement");
});

test("fail-claim still defaults an absent reason to session_deleted", async () => {
  let reason: unknown;
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("UPDATE claw_tasks") && sql.includes("origin = 'chat'")) {
      reason = params[0];
      return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/fail-claim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(reason, "session_deleted");
});

// The generation fence is `($3::int IS NULL OR claim_count = $3)`, so a
// malformed count coerced to absent releases whatever generation the row is
// on -- including a turn a later holder is running. One past the column's own
// range is the same class: it reached the statement and Postgres answered
// `22003`, which the route reported as a 500.
for (const [label, claimCount] of [
  ["a string", "malformed"],
  ["a fraction", 1.9],
  ["a negative", -1],
  ["null", null],
  ["NaN", Number.NaN],
  ["one past int4", PG_INT4_MAX + 1],
  ["Number.MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
] as const) {
  for (const route of ["unclaim", "fail-claim"] as const) {
    test(`${route} refuses ${label} claim_count rather than dropping the fence`, async () => {
      let touched = false;
      db.query = (async () => {
        touched = true;
        return { rows: [], rowCount: 0 };
      }) as typeof db.query;
      const res = await app.inject({
        method: "POST",
        url: `/v1/internal/tasks/ktsk_1/${route}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { brain_id: "brain-7", claim_count: claimCount },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, "claim_count_invalid");
      assert.equal(touched, false, "a refused body reaches no statement");
    });
  }
}

for (const route of ["unclaim", "fail-claim"] as const) {
  test(`${route} accepts the largest generation the column can hold`, async () => {
    let seen: unknown;
    db.query = (async (text: string, params: unknown[] = []) => {
      if (/UPDATE claw_tasks/.test(text.replace(/\s+/g, " "))) {
        seen = params.find((p) => p === PG_INT4_MAX);
        return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as typeof db.query;
    const res = await app.inject({
      method: "POST",
      url: `/v1/internal/tasks/ktsk_1/${route}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { brain_id: "brain-7", claim_count: PG_INT4_MAX },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(seen, PG_INT4_MAX, "the boundary itself is a generation, not a malformed body");
  });
}

test("unclaim passes an integer claim_count through to the fence", async () => {
  let seen: unknown;
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/UPDATE claw_tasks/.test(text.replace(/\s+/g, " "))) {
      seen = params[2];
      return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/unclaim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7", claim_count: 3, reason: "retry" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(seen, 3);
});

// `unspecified` is a metric label for a body that named no reason. A body that
// names it is a client inventing a protocol value, which is version skew.
for (const reason of ["unspecified", "not_a_reason", "", 7, null] as const) {
  test(`unclaim refuses ${JSON.stringify(reason)} as a reason`, async () => {
    let touched = false;
    db.query = (async () => {
      touched = true;
      return { rows: [], rowCount: 0 };
    }) as typeof db.query;
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/tasks/ktsk_1/unclaim",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { brain_id: "brain-7", reason },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "reason_invalid");
    assert.equal(touched, false, "a refused body reaches no statement");
  });
}

test("unclaim with no reason is accepted and writes no last_release", async () => {
  let seen: unknown = "unset";
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/UPDATE claw_tasks/.test(text.replace(/\s+/g, " "))) {
      seen = params[3];
      return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/unclaim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(seen, null, "absence stays absent rather than becoming a reason");
});

test("fail-claim rejects a run lease token", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/internal/tasks/ktsk_1/fail-claim",
    headers: { authorization: "Bearer a-run-lease-token" },
    payload: { brain_id: "brain-7" },
  });
  assert.equal(res.statusCode, 401);
});

test("exhausted claims are 422 max_retries_exceeded", async () => {
  const originalPublish = runClaimPorts.publishSessionEvent;
  runClaimPorts.publishSessionEvent = async () => {};
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/UPDATE claw_tasks/.test(sql) && sql.includes("claim_count")) {
      return {
        rows: [{
          task_id: "ktsk_1",
          session_id: "s-1",
          status: "preparing",
          deadline_at: null,
          claim_count: 100,
          input: { prompt: "hello", session_id: "s-1", user_id: "u-1", credentials: blob },
        }],
        rowCount: 1,
      };
    }
    if ((sql.includes("status = 'failed'") && sql.includes("completed_at = NOW()"))) {
      return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/internal/tasks/ktsk_1/claim",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { brain_id: "brain-7" },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error, "max_retries_exceeded");
  } finally {
    runClaimPorts.publishSessionEvent = originalPublish;
  }
});

test("the claim route reports the row's generation, and the settle routes read it back", async () => {
  // The wire hop. Both halves were producer-unpinned: the API line that puts
  // claim_count into the claim response, and claimCountFrom, which parses it
  // off an unclaim body. Neuter either and the CAS silently compares against a
  // generation no row can have, so every settle is refused as stale.
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    if (sql.includes("claim_count = COALESCE")) {
      return {
        rows: [{
          task_id: "ktsk_1", session_id: "s-1", status: "preparing", deadline_at: null,
          claim_count: 4,
          input: { prompt: "hello", session_id: "s-1", user_id: "u-1", credentials: blob },
        }],
        rowCount: 1,
      };
    }
    return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
  }) as typeof db.query;

  const claimed = await app.inject({
    method: "POST", url: "/v1/internal/tasks/ktsk_1/claim",
    headers: { authorization: `Bearer ${TOKEN}` }, payload: { brain_id: "brain-7" },
  });
  assert.equal(claimed.statusCode, 200);
  assert.equal(claimed.json().claim_count, 4, "the response carries the row's own count");

  seen.length = 0;
  const released = await app.inject({
    method: "POST", url: "/v1/internal/tasks/ktsk_1/unclaim",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { brain_id: "brain-7", claim_count: 4, reason: "lock_contention" },
  });
  assert.equal(released.statusCode, 200);
  const upd = seen.find((q) => /SET status = 'queued'/.test(q.sql));
  assert.ok(upd, "the release ran");
  assert.ok(upd?.params.includes(4), "and it carried the parsed generation into the CAS");
  assert.match(String(upd?.params.find((p) => typeof p === "string" && p.includes("last_release"))),
    /lock_contention/, "and the reason");
});
