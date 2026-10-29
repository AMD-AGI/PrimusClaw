// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/models` and `GET /v1/me` are served by the process, and served behind
 * authentication.
 *
 * Fastify applies a hook only to routes registered after it, so the global auth
 * hook in src/index.ts has to come BEFORE the route modules; a registration moved
 * above it would answer anonymously, and every route test here (which builds its
 * own app) would stay green. `index.ts` runs `main()` at import and cannot be
 * imported, so this reads its text, as the lints do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAnonymousPath } from "../src/auth/middleware.js";

const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");

test("both route modules are registered, once, after the global auth hook", () => {
  // The statement, not the comment above it that quotes it: that one comes first.
  const hooks = [...INDEX.matchAll(/^[ \t]*app\.addHook\("preHandler", authMiddleware\);/gm)];
  assert.equal(hooks.length, 1, "the global auth hook is registered once in index.ts");
  const hook = hooks[0].index;
  for (const call of ["registerModelsRoutes(app)", "registerMeRoutes(app)"]) {
    const at = INDEX.indexOf(`await ${call}`);
    assert.notEqual(at, -1, `${call} is awaited in main()`);
    assert.equal(INDEX.indexOf(`await ${call}`, at + 1), -1, `${call} is registered once`);
    assert.ok(at > hook, `${call} must come after the auth hook`);
  }
});

test("neither path is on the anonymous list", () => {
  assert.equal(isAnonymousPath("/v1/models"), false);
  assert.equal(isAnonymousPath("/v1/me"), false);
});
