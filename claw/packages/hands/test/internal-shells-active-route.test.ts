// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The active-shells route as Brain actually reaches it.
 *
 * bg-shell-ownership covers the predicate underneath; this covers the layer
 * above, which is where the scope question is really decided. The route takes
 * the owner from the credential the caller presented and from nowhere else: a
 * body field naming one is refused rather than read, so no holder of the
 * sandbox token can count a scope it holds no proof for.
 *
 * Three layers have to agree on what an unproven scope means. The Brain client
 * refuses to ask, the predicate counts nothing, and this pins the one in the
 * middle: the route refuses to answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mintScopeCredential } from "@claw/utils";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
// Gates the listen at the bottom of index.ts, so importing it binds no port and
// installs no signal handlers.
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const { spawnBackground, killShell, shutdownAllShells } =
  await import("../src/tools/shell/bg-manager.js");
const { UNOWNED } = await import("../src/runtime/owner-context.js");

const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

const TOKEN = "test-internal-token";
const SESSION = "sess-route";

const proving = (owner: string, run: string | null = null) => ({
  authorization: `Bearer ${mintScopeCredential({ owner, run }, TOKEN)}`,
});

function ask(headers: Record<string, string>, body: unknown = {}) {
  return app.inject({
    method: "POST",
    url: "/internal/shells/active",
    headers,
    payload: body as object,
  });
}

test.after(async () => {
  await shutdownAllShells(200);
  await app.close();
});

test("the proved owner is answered with its own running count", async () => {
  spawnBackground(SESSION, "ktsk_1", "sleep 60", "srv");
  try {
    const res = await ask(proving(SESSION));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { running: 1 });
  } finally {
    killShell(SESSION, "ktsk_1", "srv");
  }
});

test("a body naming a scope is refused by name, never answered from", async () => {
  // Refused rather than ignored: a caller that believes it is addressing one
  // scope must not be answered about a different one, and an owner read from
  // the body behind a token bound to no scope is any holder's to choose.
  spawnBackground(UNOWNED, "ktsk_1", "sleep 60", "stray");
  try {
    for (const field of ["owner", "run"]) {
      const res = await ask(proving(SESSION), { [field]: UNOWNED });
      assert.equal(res.statusCode, 400, `a body ${field} must be refused`);
      assert.deepEqual(res.json(), { error: "scope_not_in_body", field });
    }
  } finally {
    killShell(UNOWNED, "ktsk_1", "stray");
  }
});

test("the unowned bucket is addressable, by proving it like any other scope", async () => {
  spawnBackground(UNOWNED, "ktsk_1", "sleep 60", "explicit");
  try {
    const res = await ask(proving(UNOWNED));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { running: 1 });
  } finally {
    killShell(UNOWNED, "ktsk_1", "explicit");
  }
});

test("a credential proving nothing counts nothing", async () => {
  const anonymous = await ask({});
  assert.equal(anonymous.statusCode, 401, "an unauthenticated caller must not learn what is running");
  assert.deepEqual(anonymous.json(), { error: "scope_credential_malformed" });

  // The bare sandbox token names no scope. It authenticated the old route and
  // is exactly what must stop working here.
  const bare = await ask({ authorization: `Bearer ${TOKEN}` });
  assert.equal(bare.statusCode, 401);

  // A well-formed scope with somebody else's proof, and a proof minted under a
  // different secret: both are refused rather than read from.
  const forged = await ask({ authorization: `Bearer ${SESSION}/.norun.${"0".repeat(64)}` });
  assert.equal(forged.statusCode, 401);
  assert.deepEqual(forged.json(), { error: "scope_proof_invalid" });

  const otherSecret = await ask({
    authorization: `Bearer ${mintScopeCredential({ owner: SESSION, run: null }, "another-token")}`,
  });
  assert.equal(otherSecret.statusCode, 401);
});

test("a proof for one owner cannot be presented for another", async () => {
  // The pair's parts cannot span the separator, so no re-reading of one
  // credential's bytes yields a different pair with the same proof.
  spawnBackground("owner-x", "ktsk_1", "sleep 60", "x-shell");
  try {
    const own = await ask(proving("owner-x"));
    assert.deepEqual(own.json(), { running: 1 });

    const neighbour = await ask(proving("owner-y"));
    assert.equal(neighbour.statusCode, 200);
    assert.deepEqual(neighbour.json(), { running: 0 }, "another scope's work is not this scope's count");
  } finally {
    killShell("owner-x", "ktsk_1", "x-shell");
  }
});
