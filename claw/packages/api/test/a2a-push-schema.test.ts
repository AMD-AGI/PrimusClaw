// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The push tables, and the move from the first shape (a config keyed by its id
 * alone, so one caller's id blocked every other caller's) to the shape keyed by
 * (task, id). Against a private database; the migration runs on a database that
 * already holds the old shape and rows.
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import type pg from "pg";

import { ensureA2aPushSchema } from "../src/notifications/a2a-push-schema.js";
import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const OLD_SHAPE = `
  CREATE TABLE claw_a2a_push_configs (
    config_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, owner TEXT NOT NULL,
    url TEXT NOT NULL, token_enc TEXT, auth_scheme TEXT, auth_credentials_enc TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE claw_a2a_push_outbox (
    id BIGSERIAL PRIMARY KEY,
    config_id TEXT NOT NULL REFERENCES claw_a2a_push_configs(config_id) ON DELETE CASCADE,
    dedupe_key TEXT NOT NULL, payload JSONB NOT NULL, final BOOLEAN NOT NULL DEFAULT FALSE,
    attempts INT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ, dropped_at TIMESTAMPTZ, last_status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (config_id, dedupe_key)
  )`;

describe("the push tables", { skip: postgresSkipReason() }, () => {
  let cluster: PgCluster;
  let client: pg.Client;
  const ensure = () => ensureA2aPushSchema(client as unknown as pg.PoolClient);
  const insertConfig = (task: string, id: string) => client.query(
    "INSERT INTO claw_a2a_push_configs (config_id, task_id, session_id, owner, url) VALUES ($1, $2, 's', 'o', 'https://h.example.com')",
    [id, task],
  );

  before(async () => {
    cluster = await startPgCluster();
    client = await cluster.connect();
  });
  after(async () => { await cluster?.end(); });

  test("a database holding the first shape is moved in place, keeping its rows", async () => {
    await client.query(OLD_SHAPE);
    await client.query("INSERT INTO claw_a2a_push_configs (config_id, task_id, session_id, owner, url) VALUES ('old', 't-1', 's', 'o', 'https://h.example.com')");
    await client.query("INSERT INTO claw_a2a_push_outbox (config_id, dedupe_key, payload) VALUES ('old', 'k', '{}')");
    await assert.rejects(insertConfig("t-2", "old"), /duplicate key/, "the old shape does refuse another task's id");

    await ensure();

    assert.deepEqual((await client.query("SELECT task_id, config_id FROM claw_a2a_push_outbox")).rows, [{ task_id: "t-1", config_id: "old" }]);
    await insertConfig("t-2", "old");
    await assert.rejects(insertConfig("t-2", "old"), /duplicate key/, "within one task an id is still taken once");
    // The outbox follows the config it names: removing t-1's takes its rows and t-2's config stays.
    await client.query("DELETE FROM claw_a2a_push_configs WHERE task_id = 't-1' AND config_id = 'old'");
    assert.equal((await client.query("SELECT 1 FROM claw_a2a_push_outbox")).rowCount, 0);
    assert.equal((await client.query("SELECT 1 FROM claw_a2a_push_configs")).rowCount, 1);
  });

  test("running it again changes nothing", async () => {
    await ensure();
    await ensure();
    assert.equal((await client.query("SELECT 1 FROM claw_a2a_push_configs")).rowCount, 1);
    const pk = await client.query(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'claw_a2a_push_configs'::regclass AND i.indisprimary ORDER BY a.attname`,
    );
    assert.deepEqual(pk.rows.map((r) => r.attname), ["config_id", "task_id"]);
  });

  test("a fresh database gets the same shape", async () => {
    await client.query("DROP TABLE claw_a2a_push_outbox; DROP TABLE claw_a2a_push_configs");
    await ensure();
    await insertConfig("t-1", "webhook");
    await insertConfig("t-2", "webhook");
    await assert.rejects(insertConfig("t-1", "webhook"), /duplicate key/);
    await client.query("INSERT INTO claw_a2a_push_outbox (task_id, config_id, dedupe_key, payload) VALUES ('t-1', 'webhook', 'k', '{}')");
    await assert.rejects(
      client.query("INSERT INTO claw_a2a_push_outbox (task_id, config_id, dedupe_key, payload) VALUES ('t-3', 'webhook', 'k', '{}')"),
      /foreign key/, "an outbox row names a config that exists, by task and id",
    );
  });
});
