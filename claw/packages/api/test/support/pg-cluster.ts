// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A private database on the server `DATABASE_URL` names.
 *
 * PGlite cannot host the suites that need two connections at once, so those run
 * against a server. Isolation is a whole database, not a schema, and the reason
 * is `CREATE INDEX CONCURRENTLY`: it waits for every transaction open anywhere
 * in the database, whatever schema they touch. These suites exist precisely to
 * hold transactions open, so on a shared database one file's forced
 * interleaving stalls another file's migration until both time out -- and the
 * failure looks like a broken index rather than a fixture that cannot isolate.
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
  /** The database this file owns, also usable as its schema name. */
  schema: string;
  /** Its connection string, for code that builds its own pool. */
  url: string;
  connect(): Promise<pg.Client>;
  end(): Promise<void>;
}

export async function startPgCluster(): Promise<PgCluster> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("startPgCluster needs DATABASE_URL");
  const name = `claw_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  const own = url.toString();
  const clients: pg.Client[] = [];
  return {
    schema: name,
    url: own,
    async connect() {
      const client = new pg.Client({ connectionString: own });
      await client.connect();
      clients.push(client);
      return client;
    },
    async end() {
      for (const client of clients) await client.end().catch(() => {});
      // A database with a live backend cannot be dropped, and a leftover test
      // database is cheaper than a suite that fails on teardown.
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}
