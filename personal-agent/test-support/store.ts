// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A real store for tests: the runtime's SQLite store on a database in memory (or in a temporary directory, for a test
 * that reopens the file), with a fake clock, seeded randomness and a fresh encryption key. Service tests use this
 * rather than a hand-written fake, so what they see is what the worker's store does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LinkLimits, Random } from "@primusclaw/personal-agent";
import { Fernet, SqliteStore, type SecurityEventSink } from "@primusclaw/personal-agent-runtime";

import { FakeClock } from "./clock.js";
import { SeededRandom } from "./random.js";

/** A security-event sink for tests that do not look at the events. */
export const ignoreEvents: SecurityEventSink = () => undefined;

export interface TestStoreOptions {
  readonly clock?: FakeClock;
  readonly random?: Random;
  readonly encryptionKeys?: readonly string[];
  readonly linkLimits?: LinkLimits;
  readonly securityEvent?: SecurityEventSink;
  /** The database file; default: in memory. */
  readonly path?: string;
}

export interface TestStore {
  readonly store: SqliteStore;
  readonly clock: FakeClock;
  readonly encryptionKeys: readonly string[];
}

/** A store and its clock (epoch 1000 s unless a clock is given). */
export function openTestStore(options: TestStoreOptions = {}): TestStore {
  const clock = options.clock ?? new FakeClock(1_000_000);
  const encryptionKeys = options.encryptionKeys ?? [Fernet.generateKey()];
  const store = new SqliteStore({
    path: options.path ?? ":memory:",
    encryptionKeys,
    clock,
    random: options.random ?? new SeededRandom(7),
    ...(options.linkLimits ? { linkLimits: options.linkLimits } : {}),
    securityEvent: options.securityEvent ?? ignoreEvents,
  });
  return { store, clock, encryptionKeys };
}

/** Move a fake clock's wall time by `seconds` (what the Python tests do with `clock.now += seconds`). */
export function advanceSeconds(clock: FakeClock, seconds: number): void {
  clock.setEpochMs(clock.epochMs() + seconds * 1000);
}

/** A fresh temporary directory and its removal. */
export function tempDir(): { readonly path: string; readonly remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), "pa-store-"));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/**
 * A store on a file in a fresh temporary directory, and a second, raw connection to that file for what a test must
 * read or write beneath the store's API (what the Python tests did through `store._db`). `close` removes it all.
 */
export interface FileTestStore extends TestStore {
  readonly path: string;
  readonly dir: string;
  readonly raw: DatabaseSync;
  /** Open another store on the same file (a restart, a second process), sharing the clock unless told otherwise. */
  reopen(options?: Omit<TestStoreOptions, "path">): SqliteStore;
  close(): void;
}

export function openFileTestStore(options: Omit<TestStoreOptions, "path"> = {}): FileTestStore {
  const dir = tempDir();
  const path = join(dir.path, "s.db");
  const opened = openTestStore({ ...options, path });
  const raw = new DatabaseSync(path, { timeout: 5000 });
  const others: SqliteStore[] = [];
  return {
    ...opened,
    path,
    dir: dir.path,
    raw,
    reopen: (more = {}) => {
      // Another process draws other random values (its boot id, its codes) than the first.
      const random = new SeededRandom(100 + others.length);
      const other = openTestStore({
        clock: opened.clock,
        encryptionKeys: opened.encryptionKeys,
        random,
        ...more,
        path,
      }).store;
      others.push(other);
      return other;
    },
    close: () => {
      for (const s of [opened.store, ...others]) s.close();
      raw.close();
      dir.remove();
    },
  };
}
