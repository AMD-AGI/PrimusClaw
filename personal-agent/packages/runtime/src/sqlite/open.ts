// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How the worker opens its store: the SQLite store, with every stored secret moved to the first encryption key. */
import type { Logger } from "@primusclaw/personal-agent";

import { SqliteStore, type SqliteStoreOptions } from "./store.js";

export function openWorkerStore(options: SqliteStoreOptions, logger: Logger): SqliteStore {
  const store = new SqliteStore(options);
  const moved = store.reencrypt();
  logger.info("encryption keys: stored secrets re-encrypted to the first key", {
    rotated: moved.rotated,
    current: moved.current,
    undecryptable: moved.undecryptable,
  });
  return store;
}
