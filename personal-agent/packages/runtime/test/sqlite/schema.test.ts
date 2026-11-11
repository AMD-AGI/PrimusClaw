// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The storage format: a database this store makes, fresh or upgraded, has exactly the structure of the one the Python
// worker makes (test-support/data/store-structure.json, taken from a database the Python store created), so either
// worker can open what the other wrote; tables added since (group_context_off, bound_users) only extend it. Its SQL text counts
// too: SQLite keeps each ALTER in the table's stored SQL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Fernet, SqliteStore } from "@primusclaw/personal-agent-runtime";

import { storeStructure, tempDir, type StoreStructure, ignoreEvents } from "../../../../test-support/index.js";

const EXPECTED = JSON.parse(
  readFileSync(new URL("../../../../test-support/data/store-structure.json", import.meta.url), "utf8"),
) as { readonly fresh: StoreStructure; readonly from_v1_sessions: StoreStructure };

function structureAfter(prepare: (path: string) => void, opens = 1): StoreStructure {
  const dir = tempDir();
  try {
    const path = join(dir.path, "s.db");
    prepare(path);
    const key = Fernet.generateKey();
    for (let i = 0; i < opens; i++)
      new SqliteStore({ path, encryptionKeys: [key], securityEvent: ignoreEvents }).close();
    return storeStructure(path);
  } finally {
    dir.remove();
  }
}

test("a fresh database has the Python store's structure: 43 tables, their columns, indexes and SQL", () => {
  const actual = structureAfter(() => undefined);
  assert.equal(Object.keys(actual.tables).length, 43);
  assert.deepEqual(actual, EXPECTED.fresh);
});

test("opening it again changes nothing (the start-up migration is idempotent)", () => {
  assert.deepEqual(
    structureAfter(() => undefined, 3),
    EXPECTED.fresh,
  );
});

test("a database whose sessions were keyed by the person alone is rebuilt as the Python store rebuilds it", () => {
  let rows: unknown[];
  const actual = structureAfter((path) => {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE sessions (aad_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at REAL NOT NULL)");
    db.exec("INSERT INTO sessions VALUES ('aad-a', 's-1', 1.5)");
    db.close();
  });
  assert.deepEqual(actual, EXPECTED.from_v1_sessions);
  const dir = tempDir();
  try {
    const path = join(dir.path, "v1.db");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE sessions (aad_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, plugin_id TEXT, updated_at REAL NOT NULL)",
    );
    db.exec("INSERT INTO sessions VALUES ('aad-a', 's-1', 'p-1', 1.5)");
    db.close();
    const store = new SqliteStore({ path, encryptionKeys: [Fernet.generateKey()], securityEvent: ignoreEvents });
    assert.equal(store.sessions.getSession("aad-a"), "s-1");
    assert.equal(store.sessions.getSessionPlugin("aad-a"), "p-1");
    store.close();
    const raw = new DatabaseSync(path);
    rows = raw
      .prepare("SELECT * FROM sessions")
      .all()
      .map((r) => ({ ...r }));
    raw.close();
  } finally {
    dir.remove();
  }
  assert.deepEqual(rows, [
    { aad_id: "aad-a", scope: "", session_id: "s-1", updated_at: 1.5, plugin_id: "p-1", model: "", shared: 0 },
  ]);
});

test("the expected structure is the one schema.sql describes: every table it creates, nothing else", () => {
  const schema = readFileSync(new URL("../../src/sqlite/schema.sql", import.meta.url), "utf8");
  const created = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(created), new Set(Object.keys(EXPECTED.fresh.tables)));
  assert.match(schema, /DROP TABLE IF EXISTS link_codes;/);
});
