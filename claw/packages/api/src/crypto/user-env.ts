// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * AES-256-GCM encryption helper for per-user environment variables.
 *
 * Storage format (base64):
 *   byte[0]       = version (0x01 for v1: AES-256-GCM)
 *   byte[1..13)   = 12-byte random nonce (per write)
 *   byte[13..-16) = ciphertext (variable length)
 *   byte[-16..)   = 16-byte GCM auth tag
 *
 * The version byte is reserved for future rotation (e.g. v2 with a new key
 * or algorithm); decrypt() routes on byte 0, so v1 rows remain readable
 * while v2 writes start as soon as it ships.
 *
 * Master key is loaded once at process boot from `USER_ENV_ENCRYPTION_KEY`
 * (base64 of 32 raw bytes). The process refuses to start if the env is
 * missing or decodes to anything other than 32 bytes — fail-fast prevents
 * silent storage of unencryptable rows.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const VERSION_V1 = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const ENV_VAR_NAME = "USER_ENV_ENCRYPTION_KEY";

let MASTER_KEY: Buffer | null = null;

/**
 * Load and validate the master key from process.env. Called once during API
 * boot (see api/src/index.ts). Throws when the key is missing or malformed;
 * the caller is expected to surface that as a startup failure.
 */
export function initUserEnvCrypto(): void {
  const raw = process.env[ENV_VAR_NAME];
  if (!raw) {
    throw new Error(
      `${ENV_VAR_NAME} is not set; user-env-vars feature cannot start. ` +
      `Generate with 'openssl rand -base64 32' and inject via K8s Secret.`,
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_LEN) {
    throw new Error(
      `${ENV_VAR_NAME} decoded length is ${decoded.length}, expected ${KEY_LEN} ` +
      `(32 raw bytes). Regenerate with 'openssl rand -base64 32'.`,
    );
  }
  MASTER_KEY = decoded;
}

/** Internal accessor; throws when initUserEnvCrypto has not been called. */
function getKey(): Buffer {
  if (!MASTER_KEY) {
    throw new Error(`${ENV_VAR_NAME} not initialised; call initUserEnvCrypto() at boot`);
  }
  return MASTER_KEY;
}

/**
 * Encrypt a plaintext value and return the base64-encoded storage blob.
 * Each call uses a fresh random nonce — never reuse for the same key.
 */
export function encryptUserEnvValue(plaintext: string): string {
  const key = getKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([Buffer.from([VERSION_V1]), nonce, ct, tag]);
  return blob.toString("base64");
}

/**
 * Decrypt a base64-encoded storage blob back to plaintext. Throws on:
 *   - unknown version byte (forward-compat: do not silently corrupt)
 *   - truncated blob
 *   - GCM auth-tag mismatch (tamper detection)
 */
export function decryptUserEnvValue(b64: string): string {
  const key = getKey();
  const blob = Buffer.from(b64, "base64");
  if (blob.length < 1 + NONCE_LEN + TAG_LEN) {
    throw new Error("user-env value blob too short");
  }
  const version = blob[0];
  if (version !== VERSION_V1) {
    throw new Error(`user-env value blob has unknown version 0x${version.toString(16)}`);
  }
  const nonce = blob.subarray(1, 1 + NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(1 + NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Mask a plaintext value for safe display in API responses / logs.
 *
 *   - length >= 8 : "<first3>***<last4>"  (e.g. "sk-1234567890ab" → "sk-***...90ab")
 *   - length 1-7  : "***"
 *   - length 0    : "***"
 */
export function maskUserEnvValue(v: string): string {
  if (v.length >= 8) {
    return `${v.slice(0, 3)}***${v.slice(-4)}`;
  }
  return "***";
}

/**
 * Load and decrypt all env vars for a user, returning a flat
 * `{ key_name: plaintext_value }` map suitable for embedding into a
 * pending_messages row or NATS task body.
 *
 * Decryption errors on individual rows are logged and skipped (the whole
 * map is not failed) so a single corrupted blob cannot wedge POST /messages
 * for the user. Returns `{}` when the user has no entries.
 *
 * Callers (routes/sessions.ts POST /messages, workbenches/routes.ts POST /runs)
 * pass `userId` derived from req.user.userId — never trust client-supplied
 * user_id for env loading.
 */
export async function loadUserEnvSnapshot(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  userId: string,
  logger?: { warn: (obj: unknown, msg: string) => void },
): Promise<Record<string, string>> {
  if (!userId || userId === "default") return {};
  const r = await db.query(
    `SELECT key_name, key_value_enc FROM claw_user_env_vars WHERE user_id = $1`,
    [userId],
  );
  const out: Record<string, string> = {};
  for (const raw of r.rows as Array<{ key_name: string; key_value_enc: string }>) {
    try {
      out[raw.key_name] = decryptUserEnvValue(raw.key_value_enc);
    } catch (e) {
      logger?.warn({ err: e, key_name: raw.key_name }, "user_env.snapshot_decrypt_failed");
    }
  }
  return out;
}

/**
 * Load and decrypt ALL system-level env vars (global, no user_id), returning a
 * flat `{ key_name: plaintext_value }` map. Mirrors loadUserEnvSnapshot but
 * against `claw_system_env_vars` and without a user filter.
 *
 * Used by the system-env API to recompute the decrypted map after any
 * PUT/DELETE and publish it to the SYSTEM_ENV NATS KV bucket, from which Brain
 * reads (Brain never holds the master key). Per-row decryption errors are
 * logged and skipped so one corrupted blob cannot wedge the whole publish.
 */
export async function loadSystemEnvSnapshot(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  logger?: { warn: (obj: unknown, msg: string) => void },
): Promise<Record<string, string>> {
  const r = await db.query(
    `SELECT key_name, key_value_enc FROM claw_system_env_vars`,
  );
  const out: Record<string, string> = {};
  for (const raw of r.rows as Array<{ key_name: string; key_value_enc: string }>) {
    try {
      out[raw.key_name] = decryptUserEnvValue(raw.key_value_enc);
    } catch (e) {
      logger?.warn({ err: e, key_name: raw.key_name }, "system_env.snapshot_decrypt_failed");
    }
  }
  return out;
}
