// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Startup DDL that cannot stall the fleet behind a lock.
 *
 * Every API start runs `initDb`, and most of what it sends is DDL that is
 * already satisfied: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for a column
 * that has existed for months, `CREATE INDEX IF NOT EXISTS` for an index that
 * is there. Postgres takes the table lock before it looks: ADD COLUMN asks for
 * ACCESS EXCLUSIVE, CREATE INDEX for SHARE, and only then finds there is
 * nothing to do. With no `lock_timeout` the request waits for as long as any
 * open transaction holds the table, and while it waits every other statement on
 * that table -- the serving replicas' reads and writes included -- queues behind
 * it. One idle-in-transaction session turns a rolling restart into an outage of
 * the tables it touched, for as long as that session stays open.
 *
 * So the migration connection is wrapped:
 *  - A statement that a catalog read shows is already satisfied is not sent.
 *    Only the two single-action shapes whose outcome is a pure existence test
 *    are recognised; anything else is sent as before.
 *  - A DDL statement that is sent carries a short `lock_timeout` and is retried
 *    on lock_not_available (55P03) and deadlock_detected (40P01), with a pause
 *    between attempts so the traffic queued behind it can drain. Each retry is a
 *    whole statement outside any transaction, which Postgres rolled back for us.
 *
 * `CREATE INDEX CONCURRENTLY` is left alone: it legitimately waits out every
 * older transaction, and a lock timeout would turn that wait into a failure.
 */

import type pg from "pg";
import { pino } from "pino";

const logger = pino({ name: "db-migration" });

export interface MigrationLockPolicy {
  /** `lock_timeout` for one attempt of one DDL statement, ms. */
  lockTimeoutMs: number;
  /** Attempts per statement before its error is returned to the caller. */
  attempts: number;
  /** Pause before the first retry, doubled per retry up to `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
}

/** Postgres codes that mean "the lock was not granted this time". */
export const MIGRATION_RETRY_CODES = new Set(["55P03", "40P01"]);

/** Comments and leading whitespace removed; the statement text otherwise unchanged. */
function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl < 0 ? "" : s.slice(nl + 1);
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end < 0 ? "" : s.slice(end + 2);
      continue;
    }
    return s;
  }
}

/**
 * True when `body` holds a comma or semicolon outside parentheses and quotes:
 * a second action (`ADD COLUMN a ..., ADD COLUMN b ...`) or a second statement.
 * `NUMERIC(10,2)` and `DEFAULT 'a,b'` do not count.
 */
export function hasTopLevelSeparator(body: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  const text = body.replace(/;\s*$/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((c === "," || c === ";") && depth === 0) return true;
    else if (c === "$") return true; // dollar quoting: not a shape this parser vouches for
  }
  return false;
}

export type MigrationStatement =
  | { kind: "add_column"; table: string; column: string }
  | { kind: "create_index"; index: string }
  | { kind: "locking_ddl" }
  | { kind: "other" };

const IDENT = "([A-Za-z_][A-Za-z0-9_]*)";
const ADD_COLUMN = new RegExp(
  `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${IDENT}\\s+ADD\\s+(?:COLUMN\\s+)?IF\\s+NOT\\s+EXISTS\\s+${IDENT}\\s`,
  "i",
);
const CREATE_INDEX = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${IDENT}\\s+ON\\s`,
  "i",
);
// Statements that take a table lock before they can tell whether they have
// anything to do. A DO block is included because the ones in this codebase wrap
// ALTERs; it is atomic, so a retried DO block is a whole retry.
const LOCKING_DDL =
  /^(?:ALTER\s+TABLE|ALTER\s+INDEX|CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|DROP\s+TABLE|DROP\s+TRIGGER|CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER|DO\b)/i;

/** What the guard does with one statement. Unquoted identifiers fold to lower case, as Postgres folds them. */
export function classifyMigrationStatement(sql: string): MigrationStatement {
  const s = stripLeadingComments(sql);
  if (/\bCONCURRENTLY\b/i.test(s)) return { kind: "other" };
  const add = ADD_COLUMN.exec(s);
  if (add && !hasTopLevelSeparator(s.slice(add[0].length))) {
    return { kind: "add_column", table: add[1].toLowerCase(), column: add[2].toLowerCase() };
  }
  const idx = CREATE_INDEX.exec(s);
  if (idx && !hasTopLevelSeparator(s.slice(idx[0].length))) {
    return { kind: "create_index", index: idx[1].toLowerCase() };
  }
  if (LOCKING_DDL.test(s)) return { kind: "locking_ddl" };
  return { kind: "other" };
}

type QueryFn = (text: string, params?: unknown[]) => Promise<pg.QueryResult>;

const SKIPPED = (command: string): pg.QueryResult =>
  ({ command, rowCount: null, oid: 0, rows: [], fields: [] }) as unknown as pg.QueryResult;

/** Already satisfied according to the catalog, so sending it would only take a lock. */
async function alreadySatisfied(run: QueryFn, st: MigrationStatement): Promise<boolean> {
  if (st.kind === "add_column") {
    const r = await run(
      `SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass($1) AND attname = $2 AND attnum > 0 AND NOT attisdropped`,
      [st.table, st.column],
    );
    return (r.rowCount ?? 0) > 0;
  }
  if (st.kind === "create_index") {
    const r = await run("SELECT to_regclass($1) IS NOT NULL AS present", [st.index]);
    return r.rows[0]?.present === true;
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The migration client, with satisfied DDL skipped and the rest lock-bounded.
 * Everything other than `query(text, params)` with a string goes to the client
 * unchanged, so the wrapped client can be handed to any helper that takes a
 * `pg.PoolClient`.
 */
export function lockBoundedMigrationClient<C extends pg.ClientBase>(client: C, policy: MigrationLockPolicy): C {
  const raw: QueryFn = (text, params) => client.query(text, params as unknown[]);
  // Tracked here because a statement inside an explicit transaction cannot be
  // retried on its own: its failure has already aborted the transaction.
  let inTransaction = false;

  const guarded = async (text: string, params?: unknown[]): Promise<pg.QueryResult> => {
    const head = stripLeadingComments(text);
    if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(head)) {
      const r = await raw(text, params);
      inTransaction = true;
      return r;
    }
    if (/^(COMMIT|ROLLBACK|END|ABORT)\b/i.test(head)) {
      inTransaction = false;
      return raw(text, params);
    }
    const st = classifyMigrationStatement(text);
    if (st.kind === "other") return raw(text, params);
    if (await alreadySatisfied(raw, st)) {
      return SKIPPED(st.kind === "add_column" ? "ALTER" : "CREATE");
    }
    if (inTransaction) return raw(text, params);

    const prev = (await raw("SELECT current_setting('lock_timeout') AS v")).rows[0]?.v ?? "0";
    await raw("SELECT set_config('lock_timeout', $1, false)", [`${policy.lockTimeoutMs}ms`]);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await raw(text, params);
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (!code || !MIGRATION_RETRY_CODES.has(code) || attempt >= policy.attempts) throw err;
          const pause = Math.min(policy.backoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
          logger.warn(
            { attempt, of: policy.attempts, code, pauseMs: pause, statement: head.slice(0, 120).replace(/\s+/g, " ") },
            "db.migration_lock_busy",
          );
          await sleep(pause * (0.75 + Math.random() * 0.5));
        }
      }
    } finally {
      await raw("SELECT set_config('lock_timeout', $1, false)", [prev]);
    }
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (text: unknown, ...rest: unknown[]) =>
          typeof text === "string"
            ? guarded(text, rest[0] as unknown[] | undefined)
            : (target.query as (...a: unknown[]) => unknown)(text, ...rest);
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
