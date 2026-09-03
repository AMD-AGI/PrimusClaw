// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Recording the caller's own credentials on the session their work runs under.
 *
 * A task is dispatched from a queue, long after the request that created it has
 * gone. The only thing carrying the caller's identity that far is the session
 * row, so whatever is not written there is not available later — and what the
 * dispatcher did instead was fall back to the cluster-wide `SAFE_PLATFORM_KEY`,
 * silently, so every workload created through the DAG path ran as a shared
 * identity.
 *
 * That is not only an attribution problem. SaFE takes the workload's
 * `user.id` label from the bearer's subject and grants update/delete/resume to
 * the owner, so the caller could not stop or delete their own run.
 *
 * One helper, used by every entry point that starts server-side work, because
 * the bug was precisely that one path stamped the key and another did not.
 */
import type { PoolClient } from "pg";
import { CLAW_DEPLOY_MODE } from "../config.js";
import { db } from "../infra/db.js";
import { resolveUserLlmKey } from "../llm/key-source.js";
import type { UserInfo } from "./models.js";

/** Raised when a caller has no platform key to record. */
export class MissingPlatformKeyError extends Error {
  constructor(context: string) {
    super(
      `${context}: the caller has no SaFE platform key. Refusing to continue — ` +
        "running this under the cluster's shared identity would make the workload " +
        "owned by nobody in particular, and its own submitter unable to stop it.",
    );
    this.name = "MissingPlatformKeyError";
  }
}

export interface TrustedSessionCredentials {
  platformKey: string;
  llmApiKey: string;
}

/**
 * Read only credentials this service previously stamped.
 *
 * Session config also contains caller-controlled fields, so checking for strings
 * alone turns arbitrary JSON into a bearer token. Keep the trust decision in one
 * helper so dispatch, platform backfill, and teardown cannot drift.
 */
export function readTrustedSessionCredentials(config: unknown): TrustedSessionCredentials {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { platformKey: "", llmApiKey: "" };
  }
  const cfg = config as Record<string, unknown>;
  if (cfg._server_managed_credentials !== true) {
    return { platformKey: "", llmApiKey: "" };
  }
  const platformKey = typeof cfg.platform_key === "string" ? cfg.platform_key : "";
  const llmApiKey = typeof cfg.llm_api_key === "string"
    ? cfg.llm_api_key
    : (typeof cfg.virtual_key === "string" ? cfg.virtual_key : "");
  return { platformKey, llmApiKey };
}

/**
 * The config fields a session must carry for its tasks to run as their submitter.
 *
 * `_server_managed_credentials` is the flag the dispatcher checks before trusting
 * anything else in here: config is caller-supplied JSON on some paths, so the
 * marker is what separates a key this service put there from one a request body
 * asked it to believe.
 */
export function sessionCredentialPatch(user: UserInfo): Record<string, unknown> {
  const llmKey = resolveUserLlmKey(user);
  return {
    // Explicit nulls clear a key from an earlier submission. Omitting the field
    // would leave session-level credentials at their previous value after a
    // caller rotated or revoked one.
    platform_key: user.platformKey || null,
    llm_api_key: llmKey || null,
    _server_managed_credentials: true,
  };
}

/** Refuse only the deployment mode that must authenticate to SaFE. */
export function assertSessionCredentialsForDispatch(
  sessionId: string,
  user: UserInfo,
): void {
  if (CLAW_DEPLOY_MODE !== "kubernetes" && !user.platformKey) {
    throw new MissingPlatformKeyError(`session ${sessionId}`);
  }
}

/**
 * Write the caller's credentials onto an existing session.
 *
 * Applied on every submission rather than only at session creation. Sessions
 * predate this fix, and one created before it carries no key at all: stamping on
 * each call is what lets the next submission through an existing session start
 * running as its submitter instead of failing forever.
 *
 * Merged with `||` rather than replacing config: the row holds unrelated
 * caller-owned fields, and a submission is not a reason to drop them.
 */
export async function stampSessionCredentials(
  sessionId: string,
  user: UserInfo,
  client?: PoolClient,
): Promise<void> {
  // Only the SaFE path needs a platform key: it is what creates the workload
  // and what the platform-facts read authenticates with. In kubernetes/BYOK
  // mode there is no SaFE workload and the caller's key is a virtual key, so
  // demanding a platform key rejected every task and batch on a deployment
  // whose own deploy.sh defaults CLAW_DEPLOY_MODE to "kubernetes" -- a 403 on
  // the default configuration, from a check written for the other one.
  assertSessionCredentialsForDispatch(sessionId, user);
  const runner = client ?? db;
  await runner.query(
    `UPDATE claw_sessions
        SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb
      WHERE session_id = $1`,
    [sessionId, JSON.stringify(sessionCredentialPatch(user))],
  );
}
