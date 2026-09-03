// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The active-shells route as Brain actually reaches it.
 *
 * bg-shell-ownership covers the predicate underneath; this covers the layer
 * above, which is where the empty-owner question is really decided. The route
 * normalizes before it validates, and `normalizeOwner` substitutes the shared
 * `unowned` bucket for anything it cannot use -- so a `!owner` guard written
 * after it can never fire, and a malformed question would be answered with the
 * count of every caller that sent no owner header. Only a request driven
 * through the route shows that; calling the predicate cannot, because
 * normalization happens above it.
 *
 * Three layers have to agree on what an empty owner means. The Brain client
 * refuses to ask, the predicate counts nothing, and this pins the one in the
 * middle: the route refuses to answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

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

const AUTH = { authorization: "Bearer test-internal-token" };
const SESSION = "sess-route";

function ask(body: unknown, headers: Record<string, string> = AUTH) {
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

test("a real owner is answered with its own running count", async () => {
  spawnBackground(SESSION, "ktsk_1", "sleep 60", "srv");
  try {
    const res = await ask({ owner: SESSION });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { running: 1 });
  } finally {
    killShell(SESSION, "srv");
  }
});

test("an owner that did not survive normalization is refused, not answered from the shared bucket", async () => {
  // The regression: every one of these normalizes to `unowned`, which is
  // truthy, so a `!owner` guard let them through -- and the reply would then
  // report somebody else's work, keeping a pod alive for a session that has
  // nothing running in it.
  spawnBackground(UNOWNED, "ktsk_1", "sleep 60", "stray");
  try {
    // Every rejection `normalizeCallerKey` can make: not a string, blank,
    // whitespace-only, over the length cap, and control characters -- the last
    // being the one that matters, since the owner is a registry key prefix.
    const unusable = [undefined, null, 123, "", "   ", "x".repeat(201), "sess\u0000forged"];
    for (const owner of unusable) {
      const res = await ask({ owner });
      assert.equal(
        res.statusCode,
        400,
        `owner=${JSON.stringify(owner)} must be refused, not answered with the unowned bucket`,
      );
      assert.deepEqual(res.json(), { error: "owner_required" });
    }

    // A body with no owner field at all asks the same unanswerable question.
    const absent = await ask({});
    assert.equal(absent.statusCode, 400);
    assert.deepEqual(absent.json(), { error: "owner_required" });
  } finally {
    killShell(UNOWNED, "stray");
  }
});

test("naming the unowned bucket explicitly is a real question and is answered", async () => {
  // Refusing this too would make the bucket unaddressable. Only values that
  // landed there by failing normalization are rejected.
  spawnBackground(UNOWNED, "ktsk_1", "sleep 60", "explicit");
  try {
    const res = await ask({ owner: UNOWNED });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { running: 1 });
  } finally {
    killShell(UNOWNED, "explicit");
  }
});

test("the route proves it is Brain before it counts anything", async () => {
  const anonymous = await ask({ owner: SESSION }, {});
  assert.equal(anonymous.statusCode, 401, "an unauthenticated caller must not learn what is running");

  const wrong = await ask({ owner: SESSION }, { authorization: "Bearer nope" });
  assert.equal(wrong.statusCode, 401);
});
