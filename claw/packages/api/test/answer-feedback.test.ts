// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `PUT /v1/sessions/:sessionId/feedback` and
 * `DELETE /v1/sessions/:sessionId/feedback/:messageId`, against a real Postgres
 * whose schema `initDb` built.
 *
 * Every refusal is asserted with its status AND with what the table holds
 * afterwards, and is paired with the same request made by the owner, because a
 * route that refuses everything would otherwise pass. The suite is skipped
 * without DATABASE_URL; a skip is not a pass.
 *
 * Coverage:
 *   B1 the body: every spelling of message_id, vote and reason (table-driven, no database)
 *   V1 a vote is stored, replaced by a repeat (reason included) and kept apart per message
 *   V2 a vote is taken back; taking back what is not there is still ok; only that vote goes
 *   O1 another user, an administrator, a deleted session, a legacy ownerless one and a
 *      missing one all answer the same 404, and write and delete nothing
 *   R1 a refused body writes nothing; an unauthenticated call is 401
 *   L1 the per-session bound: refused past it, a replacement at it, a freed slot
 *   S1 the table: re-running the migration keeps votes; the key and the check are in the schema
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

// DATABASE_URL is read once, when the db module first loads, and the route module
// imports that module. So the private database is chosen before anything here is
// imported: a static import of the route would point the pools at whatever
// DATABASE_URL names (a shared database that keeps its tables from run to run),
// and every assertion about the schema would be made against a leftover.
const skip = postgresSkipReason();
const cluster: PgCluster | undefined = skip ? undefined : await startPgCluster();
if (cluster) {
  process.env.DATABASE_URL = cluster.url;
  delete process.env.DB_SCHEMA;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
}
const {
  FEEDBACK_MAX_VOTES_PER_SESSION,
  FEEDBACK_MESSAGE_ID_PATTERN,
  FEEDBACK_REASON_MAX_CHARS,
  parseVoteBody,
  registerAnswerFeedbackRoutes,
} = await import("../src/routes/answer-feedback.js");

const user = (id: string, roles: string[] = ["default"]) => ({
  userId: id, userName: id, roles, platformKey: "", virtualKey: `vk-${id}`,
});
const OWNER = user("u1");
const OTHER = user("u2");
const ADMIN = user("u-admin", ["system-admin"]);

describe("the vote body", () => {
  const ok = (body: unknown) => {
    const parsed = parseVoteBody(body);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    return parsed as Extract<typeof parsed, { ok: true }>;
  };
  const refused = (body: unknown) => {
    const parsed = parseVoteBody(body);
    assert.equal(parsed.ok, false, `${JSON.stringify(body)} should be refused`);
    return parsed as Extract<typeof parsed, { ok: false }>;
  };

  const ACCEPTED_IDS: Array<[string, string]> = [
    ["the id Claw gives an answer", "claw-1776336103765"],
    ["a queued turn's id", "claw-pending-42"],
    ["a uuid", "claw-6f1c7a52-9d1e-4f0b-8f43-0c2d6b1f9a10"],
    ["a plain number, as text", "17"],
    ["every allowed separator", "a.b_c:d@e-f"],
    ["one character", "m"],
    ["exactly the longest length", "m".repeat(100)],
  ];
  for (const [name, id] of ACCEPTED_IDS) {
    test(`accepts ${name}`, () => {
      assert.equal(ok({ message_id: id, vote: "up" }).messageId, id);
    });
  }

  const REFUSED_IDS: Array<[string, unknown]> = [
    ["absent", undefined],
    ["empty", ""],
    ["one over the longest length", "m".repeat(101)],
    ["a space inside", "claw 1"],
    ["a trailing newline", "claw-1\n"],
    ["a slash, which a path cannot carry", "a/b"],
    ["a percent sign", "a%20b"],
    ["a quote", 'a"b'],
    ["non-ASCII", "消息"],
    ["a number", 17],
    ["null", null],
    ["an array", ["claw-1"]],
    ["an object", { id: "claw-1" }],
  ];
  for (const [name, id] of REFUSED_IDS) {
    test(`refuses a message_id that is ${name}`, () => {
      assert.equal(refused({ message_id: id, vote: "up" }).error, "invalid_message_id");
    });
  }

  for (const [name, vote] of [
    ["absent", undefined], ["empty", ""], ["upper case", "UP"], ["a word that is not a vote", "sideways"],
    ["a number", 1], ["a boolean", true], ["null", null], ["an array", ["up"]],
  ] as Array<[string, unknown]>) {
    test(`refuses a vote that is ${name}`, () => {
      assert.equal(refused({ message_id: "claw-1", vote }).error, "invalid_vote");
    });
  }
  test("accepts both votes", () => {
    assert.equal(ok({ message_id: "claw-1", vote: "up" }).vote, "up");
    assert.equal(ok({ message_id: "claw-1", vote: "down" }).vote, "down");
  });

  test("a reason is optional and an empty one is none", () => {
    assert.equal(ok({ message_id: "claw-1", vote: "down" }).reason, null);
    assert.equal(ok({ message_id: "claw-1", vote: "down", reason: null }).reason, null);
    assert.equal(ok({ message_id: "claw-1", vote: "down", reason: "" }).reason, null);
    assert.equal(ok({ message_id: "claw-1", vote: "down", reason: "too slow" }).reason, "too slow");
  });
  test("a reason of exactly the longest length is accepted, one more is not", () => {
    assert.equal(ok({ message_id: "claw-1", vote: "down", reason: "r".repeat(FEEDBACK_REASON_MAX_CHARS) }).reason?.length, FEEDBACK_REASON_MAX_CHARS);
    assert.equal(refused({ message_id: "claw-1", vote: "down", reason: "r".repeat(FEEDBACK_REASON_MAX_CHARS + 1) }).error, "invalid_reason");
  });
  for (const [name, reason] of [
    ["a number", 5], ["an object", { a: 1 }], ["a NUL character", "bad\u0000reason"],
  ] as Array<[string, unknown]>) {
    test(`refuses a reason that is ${name}`, () => {
      assert.equal(refused({ message_id: "claw-1", vote: "down", reason }).error, "invalid_reason");
    });
  }
  for (const [name, body] of [
    ["absent", undefined], ["null", null], ["an array", []], ["a string", "up"], ["a number", 3],
  ] as Array<[string, unknown]>) {
    test(`refuses a body that is ${name}`, () => {
      assert.equal(refused(body).error, "invalid_body");
    });
  }

  test("the pattern is the same one the DELETE route applies", () => {
    assert.equal(FEEDBACK_MESSAGE_ID_PATTERN.test("claw-1"), true);
    assert.equal(FEEDBACK_MESSAGE_ID_PATTERN.test("a/b"), false);
  });
});

describe("answer feedback routes", { skip }, () => {
  let app: FastifyInstance;
  let caller: ReturnType<typeof user> | null = OWNER;
  let dbModule: typeof import("../src/infra/db.js");

  const q = (text: string, params: unknown[] = []) => dbModule.db.query(text, params);
  const votes = async (sessionId = "s1") =>
    (await q(
      "SELECT message_id, user_id, vote, reason FROM claw_answer_feedback WHERE session_id = $1 ORDER BY message_id",
      [sessionId],
    )).rows as Array<{ message_id: string; user_id: string; vote: string; reason: string | null }>;
  const total = async () => Number(((await q("SELECT COUNT(*)::int AS n FROM claw_answer_feedback")).rows[0] as { n: number }).n);

  const put = (sessionId: string, payload: unknown) =>
    app.inject({ method: "PUT", url: `/v1/sessions/${sessionId}/feedback`, payload: payload as object });
  const del = (sessionId: string, messageId: string) =>
    app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}/feedback/${messageId}` });

  before(async () => {
    dbModule = await import("../src/infra/db.js");
    // The pools point at the private database, or this suite is proving nothing
    // about the schema it is about to assert on.
    const named = (await dbModule.db.query("SELECT current_database() AS name")).rows[0] as { name: string };
    assert.equal(named.name, cluster!.schema);
    await dbModule.initDb();
    app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = caller; });
    await registerAnswerFeedbackRoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await dbModule?.db.pool.end().catch(() => {});
    await dbModule?.db.lockPool.end().catch(() => {});
    await cluster?.end();
  });

  beforeEach(async () => {
    caller = OWNER;
    await q("DELETE FROM claw_answer_feedback");
    await q("DELETE FROM claw_sessions");
    for (const [sid, uid, deleted] of [
      ["s1", "u1", null], ["s2", "u1", null], ["s-other", "u2", null], ["s-gone", "u1", "now"], ["s-legacy", null, null],
    ] as Array<[string, string | null, string | null]>) {
      await q(
        "INSERT INTO claw_sessions (session_id, name, user_id, mode, deleted_at) VALUES ($1, 't', $2, 'claw', CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END)",
        [sid, uid, deleted],
      );
    }
  });

  describe("V1 voting", () => {
    test("a vote is stored for the caller, and the reply is exactly ok", async () => {
      const res = await put("s1", { message_id: "claw-100", vote: "up" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      assert.deepEqual(await votes(), [{ message_id: "claw-100", user_id: "u1", vote: "up", reason: null }]);
    });

    test("a repeat replaces the vote, reason included, and leaves one row", async () => {
      await put("s1", { message_id: "claw-100", vote: "up", reason: "first" });
      const again = await put("s1", { message_id: "claw-100", vote: "down", reason: "changed my mind" });
      assert.equal(again.statusCode, 200);
      assert.deepEqual(await votes(), [{ message_id: "claw-100", user_id: "u1", vote: "down", reason: "changed my mind" }]);
      // PUT replaces rather than merges: no reason sent is no reason kept.
      await put("s1", { message_id: "claw-100", vote: "down" });
      assert.deepEqual(await votes(), [{ message_id: "claw-100", user_id: "u1", vote: "down", reason: null }]);
    });

    test("the same request twice is the same state", async () => {
      const body = { message_id: "claw-100", vote: "up", reason: "good" };
      assert.equal((await put("s1", body)).statusCode, 200);
      assert.equal((await put("s1", body)).statusCode, 200);
      assert.deepEqual(await votes(), [{ message_id: "claw-100", user_id: "u1", vote: "up", reason: "good" }]);
    });

    test("different messages, and the same message id in different sessions, are different votes", async () => {
      await put("s1", { message_id: "claw-100", vote: "up" });
      await put("s1", { message_id: "claw-200", vote: "down" });
      await put("s2", { message_id: "claw-100", vote: "down" });
      assert.deepEqual((await votes("s1")).map((v) => [v.message_id, v.vote]), [["claw-100", "up"], ["claw-200", "down"]]);
      assert.deepEqual((await votes("s2")).map((v) => [v.message_id, v.vote]), [["claw-100", "down"]]);
    });

    test("a reason of up to the longest length is stored whole", async () => {
      const reason = "é".repeat(FEEDBACK_REASON_MAX_CHARS);
      assert.equal((await put("s1", { message_id: "claw-100", vote: "down", reason })).statusCode, 200);
      assert.equal((await votes())[0].reason, reason);
    });
  });

  describe("V2 taking a vote back", () => {
    test("deletes that vote and no other", async () => {
      await put("s1", { message_id: "claw-100", vote: "up" });
      await put("s1", { message_id: "claw-200", vote: "up" });
      await put("s2", { message_id: "claw-100", vote: "up" });
      const res = await del("s1", "claw-100");
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      assert.deepEqual((await votes("s1")).map((v) => v.message_id), ["claw-200"]);
      assert.deepEqual((await votes("s2")).map((v) => v.message_id), ["claw-100"]);
    });

    test("another user's vote on the same message is not taken back", async () => {
      await q("INSERT INTO claw_answer_feedback (session_id, message_id, user_id, vote) VALUES ('s1', 'claw-100', 'u2', 'down')");
      await put("s1", { message_id: "claw-100", vote: "up" });
      assert.equal((await del("s1", "claw-100")).statusCode, 200);
      assert.deepEqual((await votes()).map((v) => [v.user_id, v.vote]), [["u2", "down"]]);
    });

    test("taking back a vote that is not there is ok", async () => {
      const res = await del("s1", "claw-404");
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
    });

    test("a vote can be cast again after it was taken back", async () => {
      await put("s1", { message_id: "claw-100", vote: "up" });
      await del("s1", "claw-100");
      assert.deepEqual(await votes(), []);
      await put("s1", { message_id: "claw-100", vote: "down" });
      assert.deepEqual((await votes()).map((v) => v.vote), ["down"]);
    });

    test("an id of the longest length that was cast can be taken back", async () => {
      const id = "m".repeat(100);
      assert.equal((await put("s1", { message_id: id, vote: "up" })).statusCode, 200);
      assert.equal((await del("s1", id)).statusCode, 200);
      assert.deepEqual(await votes(), []);
    });

    test("an id that is not valid is refused, and the vote under a look-alike id stays", async () => {
      await put("s1", { message_id: "claw-100", vote: "up" });
      assert.equal((await del("s1", "claw%20100")).json().error, "invalid_message_id");
      assert.equal((await del("s1", "claw%20100")).statusCode, 400);
      assert.equal((await votes()).length, 1);
    });
  });

  describe("O1 whose session it is", () => {
    // Each of these is the owner's request made by someone who may not, and each
    // is answered exactly as a session that was never there.
    const SESSIONS: Array<[string, string, ReturnType<typeof user>]> = [
      ["another user's", "s-other", OWNER],
      ["a deleted", "s-gone", OWNER],
      ["an ownerless legacy", "s-legacy", OWNER],
      ["a session that does not exist", "s-never", OWNER],
      ["a user's own, asked as an administrator", "s1", ADMIN],
      ["a user's own, asked by another user", "s1", OTHER],
    ];
    for (const [name, sessionId, who] of SESSIONS) {
      test(`PUT on ${name} session is 404 and writes nothing`, async () => {
        caller = who;
        const res = await put(sessionId, { message_id: "claw-100", vote: "up" });
        assert.equal(res.statusCode, 404);
        assert.equal(res.json().error, "not_found");
        assert.equal(await total(), 0);
      });
      test(`DELETE on ${name} session is 404 and deletes nothing`, async () => {
        await q("INSERT INTO claw_answer_feedback (session_id, message_id, user_id, vote) VALUES ($1, 'claw-100', $2, 'up')", [sessionId, who.userId]);
        caller = who;
        const res = await del(sessionId, "claw-100");
        assert.equal(res.statusCode, 404);
        assert.equal(await total(), 1);
      });
    }

    test("a refusal does not say whether the session exists", async () => {
      caller = OWNER;
      const other = await put("s-other", { message_id: "claw-100", vote: "up" });
      const never = await put("s-never", { message_id: "claw-100", vote: "up" });
      assert.deepEqual(other.json(), never.json());
    });

    test("the ownership check comes before the body: a bad body to another's session is still 404", async () => {
      assert.equal((await put("s-other", { vote: "sideways" })).statusCode, 404);
      assert.equal((await put("s1", { vote: "sideways" })).statusCode, 400);
    });

    test("the owner, asking the same way, succeeds", async () => {
      assert.equal((await put("s1", { message_id: "claw-100", vote: "up" })).statusCode, 200);
      assert.equal((await del("s1", "claw-100")).statusCode, 200);
    });
  });

  describe("R1 refused requests", () => {
    const BAD: Array<[string, unknown, string]> = [
      ["no message_id", { vote: "up" }, "invalid_message_id"],
      ["a message_id that cannot be a path segment", { message_id: "a/b", vote: "up" }, "invalid_message_id"],
      ["a vote that is not up or down", { message_id: "claw-1", vote: "meh" }, "invalid_vote"],
      ["a reason over the bound", { message_id: "claw-1", vote: "down", reason: "r".repeat(FEEDBACK_REASON_MAX_CHARS + 1) }, "invalid_reason"],
      ["a NUL in the reason", { message_id: "claw-1", vote: "down", reason: "a\u0000b" }, "invalid_reason"],
      ["a body that is not an object", [1], "invalid_body"],
    ];
    for (const [name, payload, error] of BAD) {
      test(`${name} is 400 ${error} and writes nothing`, async () => {
        const res = await put("s1", payload);
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().error, error);
        assert.equal(await total(), 0);
      });
    }

    test("a refused repeat leaves the earlier vote as it was", async () => {
      await put("s1", { message_id: "claw-1", vote: "up", reason: "kept" });
      assert.equal((await put("s1", { message_id: "claw-1", vote: "nope" })).statusCode, 400);
      assert.deepEqual(await votes(), [{ message_id: "claw-1", user_id: "u1", vote: "up", reason: "kept" }]);
    });

    test("without a user the answer is 401 for both routes", async () => {
      caller = null;
      assert.equal((await put("s1", { message_id: "claw-1", vote: "up" })).statusCode, 401);
      assert.equal((await del("s1", "claw-1")).statusCode, 401);
      assert.equal(await total(), 0);
    });
  });

  describe("L1 the bound per session", () => {
    const fill = (sessionId: string, n: number) => q(
      `INSERT INTO claw_answer_feedback (session_id, message_id, user_id, vote)
       SELECT $1, 'fill-' || g, 'u1', 'up' FROM generate_series(1, $2::int) g`,
      [sessionId, n],
    );

    test("a new vote past the bound is 409 and writes nothing", async () => {
      await fill("s1", FEEDBACK_MAX_VOTES_PER_SESSION);
      const res = await put("s1", { message_id: "claw-new", vote: "up" });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, "feedback_limit_reached");
      assert.equal((await votes("s1")).length, FEEDBACK_MAX_VOTES_PER_SESSION);
    });

    test("the last slot under the bound is still given", async () => {
      await fill("s1", FEEDBACK_MAX_VOTES_PER_SESSION - 1);
      assert.equal((await put("s1", { message_id: "claw-new", vote: "up" })).statusCode, 200);
      assert.equal((await votes("s1")).length, FEEDBACK_MAX_VOTES_PER_SESSION);
    });

    test("at the bound, a replacement of an existing vote is still accepted", async () => {
      await fill("s1", FEEDBACK_MAX_VOTES_PER_SESSION);
      const res = await put("s1", { message_id: "fill-7", vote: "down", reason: "changed" });
      assert.equal(res.statusCode, 200);
      const row = (await votes("s1")).find((v) => v.message_id === "fill-7");
      assert.deepEqual([row?.vote, row?.reason], ["down", "changed"]);
      assert.equal((await votes("s1")).length, FEEDBACK_MAX_VOTES_PER_SESSION);
    });

    test("another user's votes on the session do not count against this user's bound", async () => {
      await q(
        `INSERT INTO claw_answer_feedback (session_id, message_id, user_id, vote)
         SELECT 's1', 'other-' || g, 'u2', 'up' FROM generate_series(1, $1::int) g`,
        [FEEDBACK_MAX_VOTES_PER_SESSION],
      );
      assert.equal((await put("s1", { message_id: "claw-new", vote: "up" })).statusCode, 200);
    });

    test("taking one back frees a slot, and another session is not counted", async () => {
      await fill("s1", FEEDBACK_MAX_VOTES_PER_SESSION);
      assert.equal((await put("s2", { message_id: "claw-new", vote: "up" })).statusCode, 200);
      assert.equal((await put("s1", { message_id: "claw-new", vote: "up" })).statusCode, 409);
      await del("s1", "fill-1");
      assert.equal((await put("s1", { message_id: "claw-new", vote: "up" })).statusCode, 200);
    });
  });

  describe("S1 the table", () => {
    test("running the migration again keeps the votes", async () => {
      await put("s1", { message_id: "claw-1", vote: "up", reason: "kept" });
      await dbModule.initDb();
      assert.deepEqual(await votes(), [{ message_id: "claw-1", user_id: "u1", vote: "up", reason: "kept" }]);
    });

    test("one row per (session, message, user): another user may vote on the same message, the same user may not twice", async () => {
      const insert = (uid: string) => q(
        "INSERT INTO claw_answer_feedback (session_id, message_id, user_id, vote) VALUES ('s1', 'claw-1', $1, 'up')", [uid],
      );
      await insert("u1");
      await insert("u2");
      await assert.rejects(insert("u1"), (err: { code?: string }) => err.code === "23505");
    });

    test("every release-gate manifest row for the table is in the schema initDb built", async () => {
      // The release gate checks the manifest against a migrated database, but
      // only where a container runtime is available; this asks the same
      // question here, so a row that names a column or index the migration
      // does not create fails in the ordinary test run.
      const manifest = readFileSync(
        new URL("../../../../scripts/release-tests/db-schema-manifest.tsv", import.meta.url), "utf8",
      );
      const rows = manifest.split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split("\t"))
        .filter(([, name]) => name.startsWith("claw_answer_feedback"));
      assert.ok(rows.length >= 5, `expected the table's rows in the manifest, found ${rows.length}`);
      for (const [kind, name, member] of rows) {
        const found = kind === "table"
          ? await q("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2", [name, member])
          : await q("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1", [name]);
        assert.equal(found.rowCount, 1, `manifest names ${kind} ${name} ${member}, which the migration did not create`);
      }
    });

    test("the table refuses a vote that is not up or down, whatever wrote it", async () => {
      await assert.rejects(
        q("INSERT INTO claw_answer_feedback (session_id, message_id, user_id, vote) VALUES ('s1', 'claw-1', 'u1', 'sideways')"),
        (err: { code?: string }) => err.code === "23514",
      );
    });
  });
});
