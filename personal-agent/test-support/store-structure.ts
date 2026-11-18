// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The structure of a store database, as test-support/python/store_structure.py computes it: every `sqlite_master` row
 * and, per table, `PRAGMA table_info` and `PRAGMA index_list`. Two databases with equal structures are the same storage
 * format, whichever worker made them.
 */
import { DatabaseSync } from "node:sqlite";

export interface StoreStructure {
  readonly master: readonly Record<string, unknown>[];
  readonly tables: Readonly<Record<string, { readonly columns: unknown[]; readonly indexes: unknown[] }>>;
}

const plain = (row: Record<string, unknown>): Record<string, unknown> => ({ ...row });

export function storeStructure(path: string): StoreStructure {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const master = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all()
      .map(plain);
    const tables = Object.fromEntries(
      master
        .filter((row) => row["type"] === "table")
        .map((row) => {
          const name = String(row["name"]);
          const shape = {
            columns: db.prepare(`PRAGMA table_info(${name})`).all().map(plain),
            indexes: db.prepare(`PRAGMA index_list(${name})`).all().map(plain),
          };
          return [name, shape] as const;
        }),
    );
    return { master, tables };
  } finally {
    db.close();
  }
}
