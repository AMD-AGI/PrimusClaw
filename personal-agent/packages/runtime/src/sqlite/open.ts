// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the worker opens its store at start: the SQLite store on the configured file, with the security-event log wired
 * in, and every stored secret moved to the first encryption key before anything is served (README, key rotation).
 */
import type { Clock, LinkLimits, Logger, Random } from "@primusclaw/personal-agent";

import type { SecurityEventSink } from "./context.js";
import { SqliteStore } from "./store.js";

/** The settings the store is opened with; the configuration's own fields (PA_DB_PATH, PA_ENCRYPTION_KEYS, the
 * PA_LINK_* limits), so a worker's settings object is passed as it is. */
export interface WorkerStoreSettings {
  readonly dbPath: string;
  readonly encryptionKeys: readonly string[];
  readonly linkLimits: LinkLimits;
}

export interface WorkerStoreDeps {
  /** The security-event log (`link_attempt`, `link_lockout`). */
  readonly securityEvent: SecurityEventSink;
  /** Where the re-encryption counts are logged. */
  readonly logger: Logger;
  /** Default: the system clock. */
  readonly clock?: Clock;
  /** Default: `node:crypto`. */
  readonly random?: Random;
}

export function openWorkerStore(settings: WorkerStoreSettings, deps: WorkerStoreDeps): SqliteStore {
  const store = new SqliteStore({
    path: settings.dbPath,
    encryptionKeys: settings.encryptionKeys,
    linkLimits: settings.linkLimits,
    securityEvent: deps.securityEvent,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.random ? { random: deps.random } : {}),
  });
  const moved = store.reencrypt();
  deps.logger.info("encryption keys: stored secrets re-encrypted to the first key", {
    rotated: moved.rotated,
    current: moved.current,
    undecryptable: moved.undecryptable,
  });
  return store;
}
