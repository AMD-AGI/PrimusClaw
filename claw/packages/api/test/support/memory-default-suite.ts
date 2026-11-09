// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The memory preference of three users, under one value of `CLAW_MEMORY_DEFAULT_ON`, over a real Postgres:
 * one who never chose (no row in claw_user_memory_prefs), one who turned memory on and one who turned it off.
 * Each is read every way the API reads a preference -- `getMemoryPreference`, `GET /memory-settings`, the
 * session access every chat turn asks, the REST write's gate and the assistant router's memory section -- and
 * every way must give the same answer: the user's own row when there is one, the deployment default when not.
 *
 * Config is read once per process, so each default runs in a test file of its own
 * (`memory-default-on.test.ts`, `memory-default-off.test.ts`).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./pg-cluster.js";
import { startWorld, type World } from "./assistant-world.js";

/** `defaultOn` undefined leaves the variable unset, which must read as the code default (off). */
export function memoryDefaultSuite(defaultOn: boolean | undefined): void {
  const expectedDefault = defaultOn === true;
  describe(`memory preference with CLAW_MEMORY_DEFAULT_ON=${defaultOn ?? "(unset)"}`, { skip: postgresSkipReason() }, () => {
    let w: World;
    let app: FastifyInstance;
    let svc: typeof import("../../src/memory/service.js");
    let mt: typeof import("../../src/assistant/memory-tools.js");
    let prompts: typeof import("../../src/assistant/prompts.js");

    before(async () => {
      if (defaultOn === undefined) delete process.env.CLAW_MEMORY_DEFAULT_ON;
      w = await startWorld({
        CLAW_MEMORY_ENABLED: "true", CLAW_ASSISTANT_MEMORY_TOOLS: "on",
        ...(defaultOn === undefined ? {} : { CLAW_MEMORY_DEFAULT_ON: String(defaultOn) }),
      });
      const config = await import("../../src/config.js");
      assert.equal(config.CLAW_MEMORY_DEFAULT_ON, expectedDefault, "the process read the default this file is for");
      svc = await import("../../src/memory/service.js");
      mt = await import("../../src/assistant/memory-tools.js");
      prompts = await import("../../src/assistant/prompts.js");
      svc.memoryPorts.publishSessionEvent = async () => {};
      app = Fastify();
      app.addHook("onRequest", async (req) => {
        const user = req.headers["x-test-user"];
        if (typeof user === "string") (req as any).user = { userId: user, userName: user, roles: ["default"] };
        (req as any).authMethod = "identity_token";
      });
      await (await import("../../src/routes/memory.js")).registerMemoryRoutes(app);
      await app.ready();
    });
    after(async () => { await app?.close(); await w?.stop(); });
    beforeEach(async () => {
      await w.q("TRUNCATE claw_memory_entries, claw_memory_events, claw_user_memory_prefs, claw_sessions CASCADE");
      await svc.setMemoryPreference("chose-on", true);
      await svc.setMemoryPreference("chose-off", false);
    });

    const users: Array<[string, boolean]> = [
      ["never-chose", expectedDefault],
      ["chose-on", true],
      ["chose-off", false],
    ];

    async function chat(userId: string): Promise<string> {
      const sessionId = `s-${userId}-${Math.random().toString(36).slice(2, 8)}`;
      await w.q("INSERT INTO claw_sessions (session_id, name, user_id, mode, config) VALUES ($1, 'chat', $2, 'claw', '{}')", [sessionId, userId]);
      return sessionId;
    }

    for (const [user, on] of users) {
      test(`${user}: memory is ${on ? "on" : "off"} on every read`, async () => {
        assert.equal(await svc.getMemoryPreference(user), on, "getMemoryPreference");

        const settings = await app.inject({ method: "GET", url: "/v1/users/me/memory-settings", headers: { "x-test-user": user } });
        assert.equal(settings.statusCode, 200);
        assert.deepEqual(settings.json().data, { enabled: on, available: true }, "GET memory-settings");

        const sid = await chat(user);
        assert.deepEqual(await svc.memoryAccess(sid, user), { optedIn: on, serves: on }, "memoryAccess");

        const router = await mt.routerMemoryParts(user, sid);
        assert.ok(router, "the router has a memory section either way");
        assert.equal(router.prompt === prompts.ROUTER_MEMORY_OFF, !on, "router memory section");

        const write = await app.inject({
          method: "POST", url: "/v1/users/me/memories", headers: { "x-test-user": user },
          payload: { type: "user", title: `${user} prefers tabs`, body: "indent with tabs" },
        });
        if (on) {
          assert.equal(write.statusCode, 200, write.body);
          assert.equal(write.json().ok, true);
        } else {
          assert.equal(write.statusCode, 409, write.body);
          assert.equal(write.json().error, "memory_disabled");
        }
        const stored = await w.q("SELECT 1 FROM claw_memory_entries WHERE user_id = $1", [user]);
        assert.equal(stored.length, on ? 1 : 0, "what the write stored");
      });
    }

    test("reading a preference never writes one: a user who never chose keeps following the default", async () => {
      await svc.getMemoryPreference("never-chose");
      await app.inject({ method: "GET", url: "/v1/users/me/memory-settings", headers: { "x-test-user": "never-chose" } });
      assert.deepEqual(await w.q("SELECT 1 FROM claw_user_memory_prefs WHERE user_id = 'never-chose'"), []);
    });

    test("turning memory off is kept, whatever the default", async () => {
      const put = await app.inject({
        method: "PUT", url: "/v1/users/me/memory-settings", headers: { "x-test-user": "never-chose" }, payload: { enabled: false },
      });
      assert.equal(put.statusCode, 200);
      assert.equal(await svc.getMemoryPreference("never-chose"), false);
      const get = await app.inject({ method: "GET", url: "/v1/users/me/memory-settings", headers: { "x-test-user": "never-chose" } });
      assert.equal(get.json().data.enabled, false);
      assert.deepEqual(await svc.memoryAccess(await chat("never-chose"), "never-chose"), { optedIn: false, serves: false });
    });
  });
}
