// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Everything on a run that must not sit in Postgres in the clear.
 *
 * Two reasons a field lands here, and they are different. The LLM and platform
 * keys cannot be fetched again -- SaFE verify needs the caller's credential,
 * not a user id, and the turn is no longer on an HTTP request -- so they have
 * to travel with the row, sealed. `session_env` and `mcp_servers` could in
 * principle be dropped and refused later, but they are sealed for the plainer
 * reason that they hold secrets: `session_env` is whatever the caller passed
 * as `env` on the message, and an MCP server entry routinely carries an
 * `Authorization` header. The fat path only ever put those on a NATS message;
 * writing them to a row that lives in the database, its replicas and its
 * backups is a new exposure, and the sealing is what keeps it from being one.
 *
 * `user_env` is the exception and is stripped rather than sealed: the vault is
 * readable by every API replica, so the claim re-reads it live.
 */

import {
  decryptUserEnvValue,
  encryptUserEnvValue,
} from "../crypto/user-env.js";

export interface RunCredentials {
  llm_api_key: string;
  platform_key: string;
  /** Per-message env from the request body. No vault to re-read it from. */
  session_env?: Record<string, string>;
  /** MCP server definitions, which carry their own auth headers. */
  mcp_servers?: unknown;
}

export function sealRunCredentials(creds: RunCredentials): string {
  return encryptUserEnvValue(JSON.stringify({
    llm_api_key: creds.llm_api_key ?? "",
    platform_key: creds.platform_key ?? "",
    ...(creds.session_env && Object.keys(creds.session_env).length
      ? { session_env: creds.session_env } : {}),
    ...(creds.mcp_servers !== undefined ? { mcp_servers: creds.mcp_servers } : {}),
  }));
}

/**
 * A sealed blob that will not open, whatever the reason.
 *
 * Every cause is permanent for the row that carries it: the field is gone, the
 * ciphertext is truncated, its version byte is one this build does not know,
 * the tag does not authenticate, or the plaintext is not the JSON we wrote.
 * They arrive as unrelated messages from three different layers, and matching
 * them by substring meant the list drifted out of step with the thrower --
 * `decryptUserEnvValue` raises "user-env value blob too short" and "...unknown
 * version 0x..", neither of which the first attempt at that list covered, so
 * the case the comment named as fixed was the one still looping.
 */
export class RunCredentialFault extends Error {
  constructor(cause: unknown) {
    super(`run.claim.credentials_unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RunCredentialFault";
  }
}

export function openRunCredentials(blob: string): RunCredentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decryptUserEnvValue(blob)) as Record<string, unknown>;
  } catch (err) {
    throw new RunCredentialFault(err);
  }
  const env = parsed.session_env;
  return {
    llm_api_key: typeof parsed.llm_api_key === "string" ? parsed.llm_api_key : "",
    platform_key: typeof parsed.platform_key === "string" ? parsed.platform_key : "",
    // Absent on a blob sealed before these two joined the envelope, which is
    // why both are optional rather than defaulted: a row mid-rollout must
    // hydrate without them rather than hydrate with empty ones and quietly
    // drop the caller's env.
    ...(env && typeof env === "object" && !Array.isArray(env)
      ? { session_env: env as Record<string, string> } : {}),
    ...(parsed.mcp_servers !== undefined ? { mcp_servers: parsed.mcp_servers } : {}),
  };
}

export function credentialsFromTask(task: Record<string, unknown>): RunCredentials {
  const env = task.session_env;
  return {
    llm_api_key: typeof task.llm_api_key === "string" ? task.llm_api_key : "",
    platform_key: typeof task.platform_key === "string" ? task.platform_key : "",
    ...(env && typeof env === "object" && !Array.isArray(env)
      ? { session_env: env as Record<string, string> } : {}),
    ...(task.mcp_servers !== undefined ? { mcp_servers: task.mcp_servers } : {}),
  };
}

/** What the pending-message row stores for a later drain to claim with. */
export function pendingSecretColumns(opts: {
  llmKey: string;
  platformKey: string;
  userEnv: Record<string, string>;
  doorbell: boolean;
}): {
  llm: string | null;
  platform: string | null;
  blob: string | null;
  userEnv: Record<string, string>;
} {
  if (!opts.doorbell) {
    return {
      llm: opts.llmKey || null,
      platform: opts.platformKey || null,
      blob: null,
      userEnv: opts.userEnv,
    };
  }
  // Both, for one release, and the blob is what the reader prefers.
  //
  // The drain runs on every API replica, and only a replica that knows about
  // `credentials_blob` reads it. Writing the blob alone means a pod from the
  // previous image -- during the rollout in which the flag first takes effect,
  // or for as long as a rollback lasts -- drains the row, finds NULL in the
  // key columns, and publishes a turn with no credentials that dies on its
  // first model call. The row is short-lived and these columns are what the
  // table held before the doorbell path existed, so restoring them costs the
  // window rather than the design.
  //
  // Remove once no replica without blob support can reach this table.
  return {
    llm: opts.llmKey || null,
    platform: opts.platformKey || null,
    blob: sealRunCredentials({ llm_api_key: opts.llmKey, platform_key: opts.platformKey }),
    userEnv: opts.userEnv,
  };
}

/** Open a sealed blob onto a fat execute request (flag-off drain of doorbell pending). */
export function applySealedCredentials(
  task: Record<string, unknown>,
  blob: unknown,
): void {
  if (typeof blob !== "string" || !blob) return;
  const creds = openRunCredentials(blob);
  task.llm_api_key = creds.llm_api_key;
  task.platform_key = creds.platform_key;
  if (creds.session_env) task.session_env = creds.session_env;
  if (creds.mcp_servers !== undefined) task.mcp_servers = creds.mcp_servers;
  delete task.credentials;
}
