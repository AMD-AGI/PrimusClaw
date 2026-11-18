// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `CLAW_MEMORY_DEFAULT_ON=true` on a deployment without memory (`CLAW_MEMORY_ENABLED` off): the default turns nothing
 * on, so a user who never chose reads as off; and the REST writes refuse everyone, a user whose own row says on
 * included, since nothing else would ever read what they wrote.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

process.env.CLAW_MEMORY_ENABLED = "false";
process.env.CLAW_MEMORY_DEFAULT_ON = "true";

test("neither the default nor a user's own on writes memory where the deployment has none", async () => {
  const config = await import("../src/config.js");
  assert.equal(config.CLAW_MEMORY_DEFAULT_ON, true);
  assert.equal(config.CLAW_MEMORY_ENABLED, false);
  const svc = await import("../src/memory/service.js");
  const { db } = await import("../src/infra/db.js");
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { userId: String(req.headers["x-test-user"]), userName: "u", roles: ["default"] };
    (req as any).authMethod = "identity_token";
  });
  await (await import("../src/routes/memory.js")).registerMemoryRoutes(app);
  await app.ready();

  const real = db.query;
  let rows: Array<{ enabled: boolean }> = [];
  const statements: string[] = [];
  db.query = (async (text: string) => { statements.push(text); return { rows }; }) as unknown as typeof db.query;
  try {
    assert.equal(await svc.getMemoryPreference("never-chose"), false, "no row: off, the default notwithstanding");
    rows = [{ enabled: false }];
    assert.equal(await svc.getMemoryPreference("chose-off"), false);

    for (const [user, row] of [["never-chose", []], ["chose-on", [{ enabled: true }]]] as const) {
      rows = [...row];
      statements.length = 0;
      const post = await app.inject({
        method: "POST", url: "/v1/users/me/memories", headers: { "x-test-user": user },
        payload: { type: "user", title: "prefers tabs", body: "indent with tabs" },
      });
      assert.equal(post.statusCode, 409, `${user}: POST ${post.body}`);
      assert.equal(post.json().error, "memory_disabled");
      const put = await app.inject({
        method: "PUT", url: "/v1/users/me/memories/1", headers: { "x-test-user": user }, payload: { title: "x" },
      });
      assert.equal(put.statusCode, 409, `${user}: PUT ${put.body}`);
      assert.ok(!statements.some((s) => /INSERT|UPDATE/i.test(s)), `${user}: nothing written`);
    }
  } finally {
    db.query = real;
    await app.close();
  }
});
