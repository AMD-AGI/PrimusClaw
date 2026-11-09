// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one SQLite connection a store works on, with typed statement helpers. Opened as the Python worker opens it:
 * autocommit (`isolation_level=None`), WAL, and a 5 s busy timeout (`sqlite3.connect`'s default).
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqlValue = SQLInputValue;
export type Row = Readonly<Record<string, SqlValue>>;

/** Prepared statements are cached per SQL text; the store's statements are a closed set. */
export class Database {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(path: string) {
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    this.#db.exec("PRAGMA journal_mode=WAL");
  }

  /** Several statements, no parameters (DDL). */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /** Rows changed. */
  run(sql: string, ...params: readonly SqlValue[]): number {
    return Number(this.statement(sql).run(...params).changes);
  }

  /** The rowid of the row an INSERT made. */
  insert(sql: string, ...params: readonly SqlValue[]): number {
    return Number(this.statement(sql).run(...params).lastInsertRowid);
  }

  get(sql: string, ...params: readonly SqlValue[]): Row | undefined {
    return this.statement(sql).get(...params);
  }

  all(sql: string, ...params: readonly SqlValue[]): Row[] {
    return this.statement(sql).all(...params);
  }

  /** The column names of `table` (`PRAGMA table_info`). */
  columns(table: string): Set<string> {
    return new Set(
      this.#db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => String(r["name"])),
    );
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }

  private statement(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}

/** A column value as text: numbers in their decimal form, a BLOB as UTF-8, NULL as ''. */
function asText(value: SqlValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

/** A column value as a number: text is parsed as SQLite would compare it, NULL is 0. */
function asNumber(value: SqlValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

/** Typed reads of a column; a value of another type is a corrupt row, not a case to handle. */
export const col = {
  str: (row: Row, name: string): string => asText(row[name]),
  strOrNull: (row: Row, name: string): string | null =>
    row[name] === null || row[name] === undefined ? null : asText(row[name]),
  num: (row: Row, name: string): number => asNumber(row[name]),
  numOrNull: (row: Row, name: string): number | null =>
    row[name] === null || row[name] === undefined ? null : asNumber(row[name]),
  /** Python's truthiness of the value. */
  bool(row: Row, name: string): boolean {
    const value = row[name];
    if (value instanceof Uint8Array) return value.length > 0;
    return value !== null && value !== undefined && value !== 0 && value !== "" && value !== 0n;
  },
  bytes(row: Row, name: string): Uint8Array {
    const value = row[name];
    return value instanceof Uint8Array ? value : new TextEncoder().encode(asText(value));
  },
};

/** SQLite's integer for a flag. */
export const flag = (value: boolean): number => (value ? 1 : 0);
