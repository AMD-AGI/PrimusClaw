// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * System-level env cache for Brain (system-env-design.md §5.2).
 *
 * The api process is the authority: it decrypts the global env map from
 * claw_system_env_vars and publishes it to the SYSTEM_ENV NATS KV bucket
 * (single key "current" = JSON map). Brain attaches read-only, seeds an
 * in-memory cache at boot, and watches the key for live updates. Brain never
 * holds the AES master key — it only ever sees the already-decrypted map.
 *
 * Fail-open everywhere: any KV / parse error keeps the last-known cache so a
 * NATS hiccup can never block sandbox creation. The cache is read
 * synchronously at sandbox-create time (getSystemEnv).
 */
import type { JetStreamClient } from "nats";
import pino from "pino";
import { SYSTEM_ENV_BUCKET } from "../config.js";

const logger = pino({ name: "system-env" });
const KV_KEY = "current";
const WATCH_RETRY_MS = 5000;

let cache: Record<string, string> = {};

/** Parse a published JSON map into the cache; keep stale cache on bad input. */
function applyValue(raw: string): void {
  if (!raw) {
    cache = {};
    return;
  }
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      cache = out;
    }
  } catch (e) {
    logger.warn({ err: e }, "system_env.parse_failed");
    // keep stale cache
  }
}

/**
 * Seed the cache from the SYSTEM_ENV bucket and start a background watch.
 * Safe to call once at brain boot (after the JetStream client is ready).
 *
 * `js.views.kv(name, opts)` is create-or-attach (mirrors how brain bootstraps
 * REGISTRY / CHECKPOINTS): this matters when brain boots BEFORE api has created
 * the bucket — without opts the attach would throw and the watch would never
 * start. api remains the authority and converges replicas/config later.
 *
 * Fail-open everywhere: the watch runs in a reconnecting loop so a NATS blip or
 * a not-yet-created bucket is retried; the last-known cache is preserved across
 * retries so sandbox creation is never blocked.
 */
export async function initSystemEnvCache(js: JetStreamClient): Promise<void> {
  try {
    const kvSysEnv = await js.views.kv(SYSTEM_ENV_BUCKET, { ttl: 0 });
    const cur = await kvSysEnv.get(KV_KEY);
    if (cur) applyValue(cur.string());
    logger.info({ keys: Object.keys(cache).length }, "system_env.cache_initialised");
  } catch (e) {
    logger.warn({ err: e }, "system_env.init_failed");
  }
  void watchLoop(js);
}

/**
 * Background watch with reconnect. kv.watch first replays the current value
 * (re-seeding the cache), then streams updates; if the iterator ends (NATS
 * reconnect / bucket recreate) we retry after a short backoff.
 */
async function watchLoop(js: JetStreamClient): Promise<void> {
  for (;;) {
    try {
      const kvSysEnv = await js.views.kv(SYSTEM_ENV_BUCKET, { ttl: 0 });
      const iter = await kvSysEnv.watch({ key: KV_KEY });
      for await (const e of iter) {
        applyValue(e.string());
      }
    } catch (e) {
      logger.warn({ err: e }, "system_env.watch_retry");
    }
    await new Promise((r) => setTimeout(r, WATCH_RETRY_MS));
  }
}

/** Synchronous read of the in-memory system-env cache. */
export function getSystemEnv(): Record<string, string> {
  return cache;
}
