// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A private schema on the Postgres `DATABASE_URL` names.
 *
 * PGlite cannot host the suites that need two connections at once, so those run
 * against a server. Isolation is a schema rather than a database: node:test
 * gives each file its own process, and `search_path` keeps two files -- or two
 * runs on a shared developer cluster -- from migrating and truncating each
 * other's `claw_tasks`.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * Why a Postgres-backed suite cannot run, or `false` when it can.
 *
 * A suite that reports nothing when it skips is indistinguishable from one
 * that proved something, which is the whole failure mode this string exists to
 * make impossible.
 */
export function postgresSkipReason(): string | false {
  if (process.env.DATABASE_URL) return false;
  return "DATABASE_URL is not set, so there is no Postgres to prove anything against";
}

/** Whether this is an automated run, where a skipped proof is a lost proof. */
export function isCi(): boolean {
  return process.env.CI === "true" || process.env.CI === "1";
}

export interface PgCluster {
  schema: string;
  /** A fresh connection with `search_path` already pointed at the schema. */
  connect(): Promise<pg.Client>;
  end(): Promise<void>;
}

export async function startPgCluster(): Promise<PgCluster> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("startPgCluster needs DATABASE_URL");
  const schema = `claw_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const clients: pg.Client[] = [];
  return {
    schema,
    async connect() {
      const client = new pg.Client({ connectionString });
      await client.connect();
      await client.query(`SET search_path TO "${schema}"`);
      clients.push(client);
      return client;
    },
    async end() {
      for (const client of clients) await client.end().catch(() => {});
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}
