// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The caller's keys on a session row, sealed.
 *
 * `claw_sessions.config` is read by every API replica, copied into backups and
 * returned (redacted) to clients, so the LLM and platform keys it carries are
 * written as one blob sealed with the same envelope a queued turn uses
 * (`sealRunCredentials`), never as plain fields.
 *
 * Kept apart from `session-credentials.ts` because `initDb` runs the backfill
 * below and that module imports the database pool.
 */
import type pg from "pg";

import { openRunCredentials, sealRunCredentials } from "../tasks/run-secrets.js";

export interface TrustedSessionCredentials {
  platformKey: string;
  llmApiKey: string;
}

/** Where the sealed keys live in `config`. */
export const SEALED_CREDENTIALS_FIELD = "sealed_credentials";

/** The plain fields earlier builds wrote the keys to. Read only until the backfill has sealed them. */
export const PLAINTEXT_CREDENTIAL_FIELDS = ["platform_key", "llm_api_key", "virtual_key"] as const;

const NONE: TrustedSessionCredentials = { platformKey: "", llmApiKey: "" };

/** The config fields that record a session's keys: the sealed blob and the marker that this service wrote it. */
export function sealedCredentialFields(creds: TrustedSessionCredentials): Record<string, unknown> {
  return {
    [SEALED_CREDENTIALS_FIELD]: sealRunCredentials({ llm_api_key: creds.llmApiKey, platform_key: creds.platformKey }),
    _server_managed_credentials: true,
  };
}

function plaintextCredentials(cfg: Record<string, unknown>): TrustedSessionCredentials | null {
  // Present, not merely a string: an earlier build clears a revoked key by writing null.
  if (!PLAINTEXT_CREDENTIAL_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(cfg, f))) return null;
  return {
    platformKey: typeof cfg.platform_key === "string" ? cfg.platform_key : "",
    llmApiKey: typeof cfg.llm_api_key === "string"
      ? cfg.llm_api_key
      : (typeof cfg.virtual_key === "string" ? cfg.virtual_key : ""),
  };
}

/**
 * Read only credentials this service previously stamped.
 *
 * Session config also contains caller-controlled fields, so checking for strings
 * alone turns arbitrary JSON into a bearer token. Keep the trust decision in one
 * helper so dispatch, platform backfill, and teardown cannot drift.
 *
 * Plain fields win over the blob, nulls included: a stamp from this build
 * removes them, so when both are present the plain ones were written later, by a
 * replica of the previous build during a rollout. A blob that will not open reads as no keys,
 * which every caller already refuses on, as it does for a session never stamped.
 */
export function readTrustedSessionCredentials(config: unknown): TrustedSessionCredentials {
  if (!config || typeof config !== "object" || Array.isArray(config)) return NONE;
  const cfg = config as Record<string, unknown>;
  if (cfg._server_managed_credentials !== true) return NONE;
  const plain = plaintextCredentials(cfg);
  if (plain) return plain;
  const blob = cfg[SEALED_CREDENTIALS_FIELD];
  if (typeof blob !== "string" || !blob) return NONE;
  try {
    const opened = openRunCredentials(blob);
    return { platformKey: opened.platform_key, llmApiKey: opened.llm_api_key };
  } catch {
    return NONE;
  }
}

/**
 * Seal the keys sessions stamped by earlier builds still hold in plain fields, and remove those fields.
 *
 * Runs from `initDb` on every start and matches nothing once done. Only rows this
 * service stamped (`_server_managed_credentials`) are sealed; a row whose config
 * changed between the read and the write is left for the next start rather than
 * overwritten. Returns how many rows it sealed.
 */
export async function sealPlaintextSessionCredentials(client: pg.ClientBase, batch = 500): Promise<number> {
  let sealed = 0;
  let after = "";
  for (;;) {
    const rows = (await client.query(
      `SELECT session_id, config FROM claw_sessions
        WHERE session_id > $1
          AND config->'_server_managed_credentials' = 'true'::jsonb
          AND config ?| $2::text[]
        ORDER BY session_id
        LIMIT $3`,
      [after, PLAINTEXT_CREDENTIAL_FIELDS, batch],
    )).rows as Array<{ session_id: string; config: Record<string, unknown> }>;
    if (rows.length === 0) return sealed;
    for (const row of rows) {
      after = row.session_id;
      const fields = sealedCredentialFields(plaintextCredentials(row.config) ?? NONE);
      const r = await client.query(
        `UPDATE claw_sessions
            SET config = (config - $3::text[]) || $4::jsonb
          WHERE session_id = $1 AND config = $2::jsonb`,
        [row.session_id, JSON.stringify(row.config), PLAINTEXT_CREDENTIAL_FIELDS, JSON.stringify(fields)],
      );
      sealed += r.rowCount ?? 0;
    }
  }
}
