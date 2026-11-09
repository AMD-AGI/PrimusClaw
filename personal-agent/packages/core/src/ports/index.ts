// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every port core talks to the outside through. Ownership while the port is written (the Python module it follows):
 *   W0: Surface (messenger.py, activity.py), Clock, Random, Logger.
 *   W1: StorePort and the repositories (store.py), Crypto (store.py Fernet, link-code HMAC).
 *   W2: ClawPort (claw.py), Metrics (metrics.py), SecretSource (secret_source.py), Config (config.py).
 * Implementations live in the runtime package (Node) or a channel package; tests use `test-support/`.
 */
export * from "./clock.js";
export * from "./logger.js";
export * from "./random.js";
export * from "./surface.js";
export * from "./routing.js";
