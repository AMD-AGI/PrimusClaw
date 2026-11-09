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
    return this.statement(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: readonly SqlValue[]): Row[] {
    return this.statement(sql).all(...params) as Row[];
  }

  /** The column names of `table` (`PRAGMA table_info`). */
  columns(table: string): Set<string> {
    return new Set(this.#db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r["name"])));
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

/** Typed reads of a column; a value of another type is a corrupt row, not a case to handle. */
export const col = {
  str(row: Row, name: string): string {
    const value = row[name];
    return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  },
  strOrNull(row: Row, name: string): string | null {
    const value = row[name];
    return value === null || value === undefined ? null : String(value);
  },
  num(row: Row, name: string): number {
    const value = row[name];
    return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  },
  numOrNull(row: Row, name: string): number | null {
    const value = row[name];
    return value === null || value === undefined ? null : col.num(row, name);
  },
  bool(row: Row, name: string): boolean {
    const value = row[name];
    return value !== null && value !== undefined && value !== 0 && value !== "" && value !== 0n;
  },
  bytes(row: Row, name: string): Uint8Array {
    const value = row[name];
    if (value instanceof Uint8Array) return value;
    return new TextEncoder().encode(typeof value === "string" ? value : "");
  },
};

/** SQLite's integer for a flag. */
export const flag = (value: boolean): number => (value ? 1 : 0);
