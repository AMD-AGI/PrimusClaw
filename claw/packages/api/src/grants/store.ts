// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The grant Claw keeps for one app run: the id, the attestation, and the
 * role keys sealed so a retry or a takeover can inject them again.
 */
import type { Querier } from "../infra/db.js";

export type GrantRowState = "pending" | "active" | "revoked";

export interface StoredClaims {
  userId: string;
  userName: string;
  workspaces: string[];
  sessionId: string;
  kinds: string[];
  maxGpusPerSandbox: number;
}

export interface GrantRow {
  appRunId: string;
  grantId: string;
  userId: string;
  sessionId: string;
  expiresAt: Date;
  keysCiphertext: string;
  attestation: string;
  state: GrantRowState;
  claims: StoredClaims;
}

interface GrantRecord {
  app_run_id: string;
  grant_id: string;
  user_id: string;
  session_id: string;
  expires_at: Date | string;
  keys_ciphertext: string;
  attestation: string;
  state: GrantRowState;
  claims: StoredClaims | string;
}

/** Lock the app-run row. Missing rows return null. */
export async function lockGrant(query: Querier, appRunId: string): Promise<GrantRow | null> {
  const res = await query(
    `SELECT app_run_id, grant_id, user_id, session_id, expires_at,
            keys_ciphertext, attestation, state, claims
       FROM claw_app_run_grants
      WHERE app_run_id = $1
      FOR UPDATE`,
    [appRunId],
  );
  const row = res.rows[0] as GrantRecord | undefined;
  return row ? toRow(row) : null;
}

/** Insert a pending grant. The caller holds the transaction. */
export async function insertPending(
  query: Querier,
  row: { appRunId: string; grantId: string; claims: StoredClaims; expiresAt: Date },
): Promise<void> {
  await query(
    `INSERT INTO claw_app_run_grants
       (app_run_id, grant_id, user_id, session_id, expires_at, state, claims)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb)`,
    [row.appRunId, row.grantId, row.claims.userId, row.claims.sessionId, row.expiresAt, JSON.stringify(row.claims)],
  );
}

/** Record keys returned by a successful issue. */
export async function markActive(
  query: Querier,
  appRunId: string,
  patch: { grantId: string; expiresAt: Date; keysCiphertext: string; attestation: string; claims: StoredClaims },
): Promise<void> {
  await query(
    `UPDATE claw_app_run_grants
        SET grant_id = $2, expires_at = $3, keys_ciphertext = $4, attestation = $5,
            state = 'active', claims = $6::jsonb, user_id = $7, session_id = $8, updated_at = NOW()
      WHERE app_run_id = $1`,
    [
      appRunId, patch.grantId, patch.expiresAt, patch.keysCiphertext, patch.attestation,
      JSON.stringify(patch.claims), patch.claims.userId, patch.claims.sessionId,
    ],
  );
}

/** Move the expiry and store the replacement attestation. */
export async function markExtended(
  query: Querier,
  appRunId: string,
  expiresAt: Date,
  attestation: string,
): Promise<void> {
  await query(
    `UPDATE claw_app_run_grants
        SET expires_at = $2, attestation = $3, updated_at = NOW()
      WHERE app_run_id = $1 AND state = 'active'`,
    [appRunId, expiresAt, attestation],
  );
}

/** Mark the local row revoked. The remote revoke is a separate call. */
export async function markRevoked(query: Querier, appRunId: string): Promise<void> {
  await query(
    `UPDATE claw_app_run_grants
        SET state = 'revoked', keys_ciphertext = '', updated_at = NOW()
      WHERE app_run_id = $1`,
    [appRunId],
  );
}

function toRow(row: GrantRecord): GrantRow {
  const claims = typeof row.claims === "string" ? JSON.parse(row.claims) as StoredClaims : row.claims;
  return {
    appRunId: row.app_run_id,
    grantId: row.grant_id,
    userId: row.user_id,
    sessionId: row.session_id,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    keysCiphertext: row.keys_ciphertext,
    attestation: row.attestation,
    state: row.state,
    claims,
  };
}
