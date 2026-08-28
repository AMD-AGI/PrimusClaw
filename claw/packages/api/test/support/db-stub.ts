// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A database that records what was asked of it, including inside transactions.
 *
 * Stubbing `db.query` alone stopped being enough once anything used
 * `inTransaction`: that takes its own connection from the pool, so its
 * statements go out through a path a `db.query` stub never sees -- a test would
 * watch a transaction it had replaced nothing of, and the writes it asserts on
 * would be missing rather than wrong. Both paths are recorded here, and which
 * connection each statement went out on is recorded with it, because "these ran
 * together" is the only property a transaction has that separate statements do
 * not.
 */
import { db } from "../../src/infra/db.js";

export interface SeenQuery {
  sql: string;
  params: unknown[];
  /** The connection it went out on: `null` for a pooled `db.query`. */
  conn: number | null;
}

/**
 * How a test answers a statement: rows to return, or a throw to fail it with.
 * Returning nothing is an empty result, which is what most statements here are
 * asked for.
 */
export type Answer = (sql: string, params: unknown[]) => unknown[] | void;

export interface DbStub {
  /** Every statement, in order, from both paths. */
  seen: SeenQuery[];
  /** Just the SQL, for the common assertion. */
  sql(): string[];
  /** Whether any statement matches. */
  ran(re: RegExp): boolean;
  /** How many connections the run took, which is how a transaction is spotted. */
  connections: number;
  restore(): void;
}

/**
 * Replace both database paths for the length of a test.
 *
 * The stub connection's `release` does nothing on purpose: a test that asserted
 * on it would be asserting on node-postgres rather than on the code under test,
 * and the property that matters -- one connection for the whole sequence -- is
 * already visible in the `conn` of each statement.
 */
export function stubDb(answer: Answer = () => []): DbStub {
  const seen: SeenQuery[] = [];
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  let connections = 0;

  const record = async (conn: number | null, text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params, conn });
    const rows = answer(sql, params) ?? [];
    return { rows, rowCount: rows.length };
  };

  db.query = ((text: string, params?: unknown[]) =>
    record(null, text, params)) as typeof db.query;

  db.pool.connect = (async () => {
    const id = ++connections;
    return {
      query: (text: string, params?: unknown[]) => record(id, text, params),
      release: () => {},
    };
  }) as unknown as typeof db.pool.connect;

  return {
    seen,
    sql: () => seen.map((q) => q.sql),
    ran: (re: RegExp) => seen.some((q) => re.test(q.sql)),
    get connections() { return connections; },
    restore() {
      db.query = originalQuery;
      db.pool.connect = originalConnect;
    },
  };
}
